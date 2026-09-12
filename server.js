#!/usr/bin/env node
'use strict';
/**
 * Token Viewer — 通用 Agent Token 用量扫描与可视化服务
 *
 * 零依赖：只使用 Node 内置模块（http / fs / readline / node:sqlite）
 * 端口：3457（可用 TOKEN_VIEWER_PORT 覆盖）
 *
 * 接入数据源：
 *   Proma / Pi / oh-my-Pi / Claude Code / Claude Desktop /
 *   Codex / ZCode / DeepSeek Harness / OpenCode
 *
 * 用法：
 *   node server.js          启动服务（默认 http://127.0.0.1:3457）
 *   node server.js --once   只扫描一次并打印各数据源统计，然后退出
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');

const PORT = Number(process.env.TOKEN_VIEWER_PORT || 3457);
const HOME = os.homedir();
const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, '.scan-cache.json');
const PRICING_FILE = path.join(ROOT, 'pricing-config.json');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

/* ------------------------------------------------------------------ *
 * 跨平台应用数据目录
 * Windows 有 Roaming / Local 两套；macOS 用 ~/Library/Application Support；
 * Linux 用 ~/.local/share。桌面类应用往往不在 `~/.<产品名>` 里，
 * 而且目录名常常不含产品名（如 dsh-desktop、Claude-3p），所以统一用候选列表。
 * ------------------------------------------------------------------ */
const DATA_DIRS = (() => {
  if (process.platform === 'darwin') return [path.join(HOME, 'Library', 'Application Support'), APPDATA, LOCALAPPDATA];
  if (process.platform === 'win32') return [APPDATA, LOCALAPPDATA];
  return [path.join(HOME, '.local', 'share'), APPDATA, LOCALAPPDATA];
})();
const dataCandidates = (name) => DATA_DIRS.map((d) => path.join(d, name));
/** Claude Desktop（带 Agent / Cowork 模式的新版） */
const CLAUDE_DESKTOP_ROOTS = [...dataCandidates('Claude-3p'), ...dataCandidates('Claude')];
/** DeepSeek Harness 桌面版 */
const DSH_DESKTOP_ROOTS = [...dataCandidates('dsh-desktop'), ...dataCandidates('deepseek-harness-desktop')];
/** DeepSeek Harness CLI home（与上游 dsh-home-paths 一致，支持 DSH_HOME 覆盖） */
const DSH_CLI_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const PRESET_FILE = path.join(path.dirname(ROOT), 'pricing-presets.json');

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e14) return Math.round(v / 1000); // 微秒
    if (v > 1e12) return Math.round(v);        // 毫秒
    if (v > 1e9) return Math.round(v * 1000);  // 秒
    return 0;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'Crashpad', 'sentry', 'blob_storage', 'Shared Dictionary',
  'Partitions', 'vm_bundles', 'image-cache', 'outputs', 'uploads', 'uploads-tmp',
  'Service Worker', 'skills-plugin', 'configLibrary',
]);

/** 递归收集文件 */
async function walk(root, filter, depth = 0, maxDepth = 8, out = []) {
  if (!isDir(root)) return out;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(full, filter, depth + 1, maxDepth, out);
    } else if (e.isFile() && (!filter || filter(full, e.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 逐行读取，跳过坏行；preFilter 用于在 JSON.parse 前快速跳过无关行 */
async function readLines(file, onLine, preFilter) {
  let stream;
  try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const s = raw.trim();
      if (!s) continue;
      if (preFilter && !preFilter(s)) continue;
      try { onLine(s); } catch { /* 忽略单行异常 */ }
    }
  } catch { /* 忽略读取中断 */ }
  finally { rl.close(); stream.destroy(); }
}

/** 生成行级预过滤器：只要行内包含任一标记就送进解析 */
const hasAny = (tokens) => {
  const list = Array.isArray(tokens) ? tokens : [tokens];
  return (line) => { for (const t of list) if (line.indexOf(t) !== -1) return true; return false; };
};

/** 规范化记录：过滤 0 token，保证字段为数字 */
function norm(r) {
  const i = num(r.i), o = num(r.o), cr = num(r.cr), cw = num(r.cw), rr = num(r.r);
  if (i + o + cr + cw <= 0) return null;
  const rec = { t: num(r.t), m: r.m || 'unknown', i, o, cr, cw, r: rr, s: r.s || '' };
  if (r.c != null && Number.isFinite(Number(r.c)) && Number(r.c) > 0) rec.c = Number(r.c);
  return rec;
}

/* ------------------------------------------------------------------ */
/* 文件级增量缓存                                                       */
/* ------------------------------------------------------------------ */

let cache = {};
const scanCacheNext = {};

function loadCache() {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { cache = {}; }
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* 忽略写入失败 */ }
}

async function scanOneFile(file, handler, finish, preFilter) {
  const st = { file };
  const recs = [];
  await readLines(file, (line) => {
    const obj = tryJson(line);
    if (!obj) return;
    const res = handler(obj, st);
    if (!res) return;
    if (Array.isArray(res)) { for (const r of res) if (r) recs.push(r); }
    else recs.push(res);
  }, preFilter);
  if (finish) {
    const ex = finish(st, recs);
    if (Array.isArray(ex)) for (const r of ex) if (r) recs.push(r);
  }
  return recs;
}

/** 单文件带缓存扫描 */
async function scanOneFileCached(file, handler, finish, stats, preFilter) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  stats.files++;
  stats.bytes += st.size;
  const hit = cache[file];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Array.isArray(hit.records)) {
    scanCacheNext[file] = hit;
    stats.reused++;
    stats.records += hit.records.length;
    return hit.records;
  }
  const recs = await scanOneFile(file, handler, finish, preFilter);
  scanCacheNext[file] = { mtimeMs: st.mtimeMs, size: st.size, records: recs };
  stats.parsed++;
  stats.records += recs.length;
  return recs;
}

/** 带缓存的批量扫描 */
async function scanWithCache(files, handler, finish, stats, preFilter) {
  const out = [];
  for (const file of files) {
    const recs = await scanOneFileCached(file, handler, finish, stats, preFilter);
    if (recs) out.push(...recs);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 各数据源适配器                                                       */
/* ------------------------------------------------------------------ */

/** Claude Code 格式行解析（CLI 与 Claude Desktop 沙箱共用） */
function ccLineHandler(o, st) {
  if (o.type !== 'assistant') return null;
  const u = o.message && o.message.usage;
  if (!u) return null;
  const id = (o.message && o.message.id) || o.uuid;
  if (id) {
    if (!st.seen) st.seen = new Set();
    if (st.seen.has(id)) return null;
    st.seen.add(id);
  }
  return norm({
    t: toMs(o.timestamp),
    m: (o.message && o.message.model) || 'unknown',
    i: num(u.input_tokens), o: num(u.output_tokens),
    cr: num(u.cache_read_input_tokens), cw: num(u.cache_creation_input_tokens), r: 0,
    s: o.sessionId || path.basename(st.file, '.jsonl'),
  });
}

/** Pi / oh-my-Pi 共用行解析 */
function piLineHandler(o, st) {
  if (o.type === 'session') { if (o.id) st.sid = o.id; return null; }
  if (o.type !== 'message') return null;
  const msg = o.message || {};
  if (msg.role !== 'assistant' || !msg.usage) return null;
  const u = msg.usage;
  return norm({
    t: toMs(o.timestamp) || toMs(msg.timestamp),
    m: msg.model || 'unknown',
    i: num(u.input), o: num(u.output), cr: num(u.cacheRead), cw: num(u.cacheWrite), r: num(u.reasoning),
    c: u.cost && num(u.cost.total),
    s: st.sid || path.basename(st.file, '.jsonl').split('_').pop(),
  });
}

/** 从各种形态里取出模型名字符串 */
function modelStr(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const cand = v.modelId || v.model || v.id || v.name || v.slug;
    if (typeof cand === 'string' && cand) return cand;
  }
  return null;
}

/** ZCode transcript / rollout 行解析 */
function zcodeLineHandler(o, st) {
  const sid = o.sessionId || o.session_id || (o.payload && o.payload.sessionId);
  if (sid && !st.sid) st.sid = sid;
  const m = modelStr(o.model) || modelStr(o.payload && o.payload.model) || modelStr(o.payload && o.payload.modelRef);
  if (m) st.model = m;

  const usage = (o.payload && o.payload.usage) || o.usage || (o.model_complete && o.model_complete.usage);
  if (!usage) return null;

  const i = num(usage.inputTokens != null ? usage.inputTokens : usage.input_tokens);
  const oo = num(usage.outputTokens != null ? usage.outputTokens : usage.output_tokens);
  const cr = num(usage.cacheReadTokens != null ? usage.cacheReadTokens : usage.cache_read_input_tokens);
  const cw = num(usage.cacheWriteTokens != null ? usage.cacheWriteTokens : usage.cache_creation_input_tokens);
  const rr = num(usage.reasoningTokens != null ? usage.reasoningTokens : usage.reasoning_output_tokens);

  let session = st.sid;
  if (!session) {
    const m = /sess[_-][0-9a-f-]+/.exec(st.file);
    session = m ? m[0] : path.basename(st.file, '.jsonl');
  }
  return norm({
    t: toMs(o.timestamp || o.ts || o.time),
    m: st.model || 'unknown',
    i, o: oo, cr, cw, r: rr,
    s: session,
  });
}

/** Proma 会话索引里的标题 */
async function promaSessionMeta() {
  const out = {};
  try {
    const d = JSON.parse(await fsp.readFile(path.join(HOME, '.proma', 'agent-sessions.json'), 'utf8'));
    const sess = d && d.sessions;
    if (Array.isArray(sess)) {
      for (const s of sess) {
        const id = s.sessionId || s.id;
        if (id) out[id] = { title: s.title || s.name || s.summary || '', cwd: s.cwd || '' };
      }
    } else if (sess && typeof sess === 'object') {
      for (const [id, s] of Object.entries(sess)) {
        if (s && typeof s === 'object') out[id] = { title: s.title || s.name || s.summary || '', cwd: s.cwd || '' };
      }
    }
  } catch { /* 索引不存在时忽略 */ }
  return out;
}

/** Claude Desktop 会话声明（用于跨源去重） */
async function collectClaims() {
  const roots = CLAUDE_DESKTOP_ROOTS.filter(isDir)
    .flatMap((b) => [path.join(b, 'local-agent-mode-sessions'), path.join(b, 'claude-code-sessions')]);
  const locals = [];
  for (const r of roots) locals.push(...(await walk(r, (p, n) => /^local_.+\.json$/.test(n), 0, 6)));
  const cliIds = new Set();
  const map = {};
  const meta = {};
  for (const f of locals) {
    try {
      const o = JSON.parse(await fsp.readFile(f, 'utf8'));
      if (!o || !o.sessionId) continue;
      map[o.sessionId] = o.cliSessionId || null;
      if (o.cliSessionId) cliIds.add(o.cliSessionId);
      meta[o.sessionId] = { title: o.title || '', cwd: o.cwd || '', model: o.model || '' };
    } catch { /* 忽略坏文件 */ }
  }
  return { cliIds, map, meta, roots, locals };
}

/** 打开只读 SQLite（需要 node:sqlite） */
function openSqlite(dbPath) {
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  if (!isFile(dbPath)) return null;
  try { return new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
}

function dayKeyLocal(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * Claude Code 自带的按天统计缓存。
 * 会话 jsonl 会被自动清理，但这个缓存里还留着每天每个模型的 token 合计，
 * 因此历史总量比扫文件完整得多。四类拆分按该模型的全局比例估算。
 */
async function claudeStatsRecords() {
  const out = { records: [], days: new Set() };
  let d;
  try { d = JSON.parse(await fsp.readFile(path.join(HOME, '.claude', 'stats-cache.json'), 'utf8')); }
  catch { return out; }
  const mu = d.modelUsage || {};
  const ratioOf = (model) => {
    const m = mu[model];
    if (!m) return null;
    const i = num(m.inputTokens), o = num(m.outputTokens), cr = num(m.cacheReadInputTokens), cw = num(m.cacheCreationInputTokens);
    const s = i + o + cr + cw;
    return s > 0 ? { i: i / s, o: o / s, cr: cr / s, cw: cw / s } : null;
  };
  for (const e of (d.dailyModelTokens || [])) {
    const day = e && e.date;
    if (!day) continue;
    out.days.add(day);
    const ts = Date.parse(day + 'T12:00:00');
    if (!Number.isFinite(ts)) continue;
    for (const [model, total] of Object.entries(e.tokensByModel || {})) {
      const t = num(total);
      if (t <= 0) continue;
      const r = ratioOf(model) || { i: 1, o: 0, cr: 0, cw: 0 };
      const rec = norm({
        t: ts, m: model,
        i: Math.round(t * r.i), o: Math.round(t * r.o),
        cr: Math.round(t * r.cr), cw: Math.round(t * r.cw), r: 0,
        s: 'claude-stats',
      });
      if (rec) out.records.push(rec);
    }
  }
  return out;
}

/** Codex 会话标题索引 */
async function codexTitles() {
  const out = {};
  const p = path.join(HOME, '.codex', 'session_index.jsonl');
  if (!isFile(p)) return out;
  await readLines(p, (line) => {
    const o = tryJson(line);
    if (o && o.id) out[o.id] = { title: o.thread_name || '' };
  });
  return out;
}

/** ZCode 主库 model_usage 表：应用自己的逐请求台账，比 transcript 完整 */
function zcodeModelUsage(stats) {
  const records = [];
  const sessions = {};
  const dbPath = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
  const db = openSqlite(dbPath);
  if (!db) return { records, sessions, ok: false };
  try {
    stats.files += 1;
    try { stats.bytes += fs.statSync(dbPath).size; } catch { /* 忽略 */ }
    for (const r of db.prepare(
      'select session_id, model_id, started_at, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens from model_usage'
    ).all()) {
      const rec = norm({
        t: num(r.started_at), m: r.model_id || 'unknown',
        i: num(r.input_tokens), o: num(r.output_tokens),
        cr: num(r.cache_read_input_tokens), cw: num(r.cache_creation_input_tokens),
        r: num(r.reasoning_tokens),
        s: r.session_id || 'zcode',
      });
      if (rec) records.push(rec);
    }
    try {
      for (const s of db.prepare('select id, title from session').all()) {
        if (s && s.id) sessions[s.id] = { title: s.title || '' };
      }
    } catch { /* 无 title 列则忽略 */ }
  } catch { /* 表缺失则回退到 transcript */ }
  finally { try { db.close(); } catch { /* 忽略 */ } }
  return { records, sessions, ok: true };
}

/**
 * DeepSeek Harness 会话日志为事件溯源 JSONL；桌面版把 home 指向
 * %APPDATA%/dsh-desktop/harness，并按追加写入产成多个 zstd 帧，需逐帧解压。
 * 用量在 assistant/message 的 data.usage（data.chunk.usage 是流式回声，不重复计）。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeZstdFrames(buf) {
  const offs = [];
  let i = 0;
  while (true) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 4;
  }
  if (!offs.length) return '';
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const seg = buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length);
    try { parts.push(zlib.zstdDecompressSync(seg).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('\n');
}

async function dshHarnessSessions(stats) {
  const records = [];
  const sessions = {};
  const roots = [
    // 桌面版：home 指向自己的应用数据目录，通常还多一层 harness
    ...DSH_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'harness', 'sessions'), path.join(b, 'sessions')]),
    path.join(DSH_CLI_HOME, 'sessions'), // CLI 默认 home（DSH_HOME 可覆盖）
  ];
  for (const root of roots) {
    if (!isDir(root)) continue;
    const files = await walk(root, (p, n) => /^session\.jsonl(\.zstd|\.gz)?$/.test(n), 0, 4);
    for (const f of files) {
      let text = '';
      try {
        const buf = await fsp.readFile(f);
        stats.files++;
        stats.bytes += buf.length;
        text = f.endsWith('.zstd') ? decodeZstdFrames(buf) : buf.toString('utf8');
      } catch { continue; }
      const sid = path.basename(path.dirname(f));
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const o = tryJson(line);
        if (!o) continue;
        const data = o.data || {};
        if (o.type === 'session/title' && data.title) sessions[sid] = { title: data.title };
        if (o.type === 'assistant/message' && data.usage) {
          const u = data.usage;
          const msg = data.message || {};
          const rec = norm({
            t: num(o.time),
            m: msg.model || (msg.source && msg.source.model) || data.model || 'unknown',
            i: num(u.inputTokens), o: num(u.outputTokens),
            cr: num(u.cacheReadTokens), cw: num(u.cacheCreationTokens),
            r: num(u.reasoningTokens),
            s: sid,
          });
          if (rec) records.push(rec);
        }
      }
    }
  }
  return { records, sessions };
}

const AGENT_DEFS = [
  {
    id: 'proma', name: 'Proma', color: '#38bdf8', subtitle: 'Proma 桌面端会话',
    roots: [path.join(HOME, '.proma', 'agent-sessions')],
    async scan(ctx) {
      const files = [];
      for (const d of [
        path.join(HOME, '.proma', 'agent-sessions'),
        path.join(HOME, '.proma', 'conversations'),
        path.join(HOME, '.proma-dev', 'agent-sessions'),
      ]) {
        files.push(...(await walk(d, (p, n) => n.endsWith('.jsonl'), 0, 2)));
      }
      const records = await scanWithCache(files, (o, st) => {
        if (o.type !== 'assistant') return null;
        const u = o.message && o.message.usage;
        if (!u) return null;
        const id = o.uuid || (o.message && o.message.id);
        if (id) {
          if (!st.seen) st.seen = new Set();
          if (st.seen.has(id)) return null;
          st.seen.add(id);
        }
        return norm({
          t: toMs(o._createdAt) || toMs(o.timestamp),
          m: o._channelModelId || (o.message && o.message.model) || 'unknown',
          i: num(u.input_tokens), o: num(u.output_tokens),
          cr: num(u.cache_read_input_tokens), cw: num(u.cache_creation_input_tokens), r: 0,
          s: o.session_id || path.basename(st.file, '.jsonl'),
        });
      }, null, ctx.stats, hasAny('"usage"'));
      return { records, sessions: await promaSessionMeta() };
    },
  },
  {
    id: 'pi', name: 'Pi', color: '#a78bfa', subtitle: 'Pi CLI 会话',
    roots: [path.join(HOME, '.pi', 'agent', 'sessions')],
    async scan(ctx) {
      const files = await walk(path.join(HOME, '.pi', 'agent', 'sessions'), (p, n) => n.endsWith('.jsonl'));
      return { records: await scanWithCache(files, piLineHandler, null, ctx.stats, hasAny(['"usage"', '"type":"session"'])), sessions: {} };
    },
  },
  {
    id: 'omp', name: 'oh-my-Pi', color: '#f472b6', subtitle: 'oh-my-Pi 会话',
    roots: [path.join(HOME, '.omp', 'agent', 'sessions')],
    async scan(ctx) {
      const files = await walk(path.join(HOME, '.omp', 'agent', 'sessions'), (p, n) => n.endsWith('.jsonl'));
      return { records: await scanWithCache(files, piLineHandler, null, ctx.stats, hasAny(['"usage"', '"type":"session"'])), sessions: {} };
    },
  },
  {
    id: 'claude-code', name: 'Claude Code', color: '#fb923c', subtitle: 'Claude Code CLI',
    roots: [path.join(HOME, '.claude', 'projects')],
    async scan(ctx) {
      const all = await walk(path.join(HOME, '.claude', 'projects'), (p, n) => n.endsWith('.jsonl'), 0, 6);
      const claimed = (ctx.claims && ctx.claims.cliIds) || new Set();
      const files = all.filter((f) => !claimed.has(path.basename(f, '.jsonl')));
      const fileRecs = await scanWithCache(files, ccLineHandler, null, ctx.stats, hasAny('"usage"'));
      // 合并 Claude Code 自带的按天统计（已清理的老会话只能从这里找回）
      const stats = await claudeStatsRecords();
      const extra = fileRecs.filter((r) => !stats.days.has(dayKeyLocal(r.t)));
      const records = [...stats.records, ...extra];
      return {
        records,
        sessions: {},
        note: stats.records.length
          ? `含 ${stats.days.size} 天的官方按天统计（早期会话文件已被自动清理；四类拆分为模型比例估算）`
          : '',
      };
    },
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop', color: '#fbbf24', subtitle: 'Claude Desktop / Cowork 账本',
    roots: CLAUDE_DESKTOP_ROOTS,
    async scan(ctx) {
      const sesRoots = CLAUDE_DESKTOP_ROOTS.filter(isDir)
        .flatMap((b) => [path.join(b, 'local-agent-mode-sessions'), path.join(b, 'claude-code-sessions')]);
      const ledgers = [];
      for (const r of sesRoots) ledgers.push(...(await walk(r, (p, n) => n.endsWith('.ndjson'), 0, 6)));

      const records = [];
      const ledgerLocalIds = new Set();
      ctx.stats.files += ledgers.length;
      for (const f of ledgers) {
        try { ctx.stats.bytes += (await fsp.stat(f)).size; } catch { /* 忽略 */ }
        await readLines(f, (line) => {
          const o = tryJson(line);
          if (!o || !o.models) return;
          if (o.sessionId) ledgerLocalIds.add(o.sessionId);
          const ts = toMs(o.ts);
          for (const [model, mu] of Object.entries(o.models)) {
            if (!mu || typeof mu !== 'object') continue;
            const rec = norm({
              t: ts, m: model,
              i: num(mu.inputTokens), o: num(mu.outputTokens),
              cr: num(mu.cacheReadTokens), cw: num(mu.cacheWriteTokens), r: 0,
              c: mu.cost && num(mu.cost.usd) ? num(mu.cost.usd) : undefined,
              s: o.sessionId || 'claude-desktop',
            });
            if (rec) records.push(rec);
          }
        }, hasAny('"models"'));
      }

      // 沙箱内 Claude Code 会话（账本已覆盖的跳过，避免重复）
      const map = (ctx.claims && ctx.claims.map) || {};
      const coveredCli = new Set([...ledgerLocalIds].map((id) => map[id]).filter(Boolean));
      const sandbox = [];
      for (const r of sesRoots) {
        const found = await walk(r, (p, n) => n.endsWith('.jsonl') && p.includes(`${path.sep}.claude${path.sep}`), 0, 8);
        for (const f of found) if (!coveredCli.has(path.basename(f, '.jsonl'))) sandbox.push(f);
      }
      const extra = await scanWithCache(sandbox, ccLineHandler, null, ctx.stats, hasAny('"usage"'));
      records.push(...extra);

      return { records, sessions: (ctx.claims && ctx.claims.meta) || {} };
    },
  },
  {
    id: 'codex', name: 'Codex', color: '#34d399', subtitle: 'Codex CLI / Desktop rollout',
    roots: [path.join(HOME, '.codex', 'sessions'), path.join(HOME, '.codex', 'archived_sessions')],
    async scan(ctx) {
      const files = [];
      for (const r of [path.join(HOME, '.codex', 'sessions'), path.join(HOME, '.codex', 'archived_sessions')]) {
        files.push(...(await walk(r, (p, n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))));
      }
      // 先按文件采集「累计用量快照」，再按会话取最完整的一份（续聊重开文件会重放历史，直接累加会重复计数）
      const perSession = new Map();
      for (const file of files) {
        const snaps = await scanOneFileCached(file, codexSnapshotHandler, null, ctx.stats,
          hasAny(['"token_count"', '"session_meta"', '"turn_context"', '"token_usage_record"']));
        if (!snaps || !snaps.length) continue;
        const last = snaps[snaps.length - 1];
        const cur = perSession.get(last.s);
        if (!cur || last.ct > cur.total) perSession.set(last.s, { total: last.ct, snaps });
      }
      // 累计值转逐轮增量，保证合计与末次累计一致，同时保留时间分布
      const records = [];
      for (const [sid, s] of perSession) {
        let pi = 0, po = 0, pcr = 0, pcw = 0, pr = 0;
        for (const snap of s.snaps) {
          const rec = norm({
            t: snap.t, m: snap.m, s: sid,
            i: Math.max(0, snap.i - pi), o: Math.max(0, snap.o - po),
            cr: Math.max(0, snap.cr - pcr), cw: Math.max(0, snap.cw - pcw), r: Math.max(0, snap.r - pr),
          });
          pi = Math.max(pi, snap.i); po = Math.max(po, snap.o);
          pcr = Math.max(pcr, snap.cr); pcw = Math.max(pcw, snap.cw); pr = Math.max(pr, snap.r);
          if (rec) records.push(rec);
        }
      }
      return { records, sessions: await codexTitles() };
    },
  },
  {
    id: 'zcode', name: 'ZCode', color: '#22d3ee', subtitle: 'ZCode 主库 model_usage',
    roots: [path.join(HOME, '.zcode', 'cli')],
    async scan(ctx) {
      // 首选：应用自带的逐请求台账
      const primary = zcodeModelUsage(ctx.stats);
      if (primary.ok && primary.records.length) return { records: primary.records, sessions: primary.sessions };
      // 回退：旧版只有 subagent transcript 与 rollout
      const files = [];
      for (const r of [path.join(HOME, '.zcode', 'cli', 'agents'), path.join(HOME, '.zcode', 'cli', 'rollout')]) {
        if (r.endsWith('agents')) {
          files.push(...(await walk(r, (p, n) => n === 'transcript.jsonl', 0, 4)));
        } else {
          files.push(...(await walk(r, (p, n) => n.endsWith('.jsonl'), 0, 2)));
        }
      }
      const records = await scanWithCache(files, zcodeLineHandler, null, ctx.stats,
        hasAny(['"usage"', '"model_request"', '"model_network_status"']));
      return { records, sessions: primary.sessions, note: '未能读取 model_usage 表，已回退到 transcript' };
    },
  },
  {
    id: 'dsh', name: 'DeepSeek Harness', color: '#60a5fa', subtitle: 'DSH 事件流（含桌面版）',
    roots: [...DSH_DESKTOP_ROOTS, DSH_CLI_HOME],
    async scan(ctx) {
      const found = await dshHarnessSessions(ctx.stats);
      if (found.records.length) return { records: found.records, sessions: found.sessions };
      // 兼容：早期 CLI 的 storages JSON
      const files = await walk(path.join(DSH_CLI_HOME, 'storages'), (p, n) => /\.(jsonl|ndjson|json)$/.test(n) && n !== 'workspace.json', 0, 6);
      const records = await scanWithCache(files, dshLineHandler, null, ctx.stats);
      return { records, sessions: found.sessions };
    },
  },
  {
    id: 'opencode', name: 'OpenCode', color: '#e879f9', subtitle: 'OpenCode SQLite 数据库',
    roots: [path.join(HOME, '.local', 'share', 'opencode'), ...dataCandidates('opencode')],
    async scan(ctx) {
      const records = [];
      const sessions = {};
      let DatabaseSync = null;
      try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 版本过低 */ }
      if (!DatabaseSync) return { records, sessions, note: '当前 Node 不支持 node:sqlite，无法读取 OpenCode 数据库' };

      const dbDirs = [...new Set([path.join(HOME, '.local', 'share', 'opencode'), ...dataCandidates('opencode')])];
      for (const dir of dbDirs) for (const name of ['opencode.db', 'opencode-local.db']) {
        const dbPath = path.join(dir, name);
        if (!isFile(dbPath)) continue;
        let db = null;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
          ctx.stats.files += 1;
          try { ctx.stats.bytes += (await fsp.stat(dbPath)).size; } catch { /* 忽略 */ }

          let rows = [];
          for (const sql of ['SELECT id, session_id, data FROM message', 'SELECT id, session_id, data FROM messages']) {
            try { rows = db.prepare(sql).all(); break; } catch { /* 换下一个表名 */ }
          }
          for (const r of rows) {
            const raw = typeof r.data === 'string' ? r.data : (r.data && r.data.toString ? r.data.toString('utf8') : '');
            const d = tryJson(raw);
            if (!d || d.role !== 'assistant' || !d.tokens) continue;
            const tk = d.tokens || {};
            const cache = tk.cache || {};
            const rec = norm({
              t: num(d.time && d.time.created), m: d.modelID || 'unknown',
              i: num(tk.input),
              // OpenCode 的 total = input + output + reasoning + cache，reasoning 是独立项
              o: num(tk.output) + num(tk.reasoning), r: num(tk.reasoning),
              cr: num(cache.read), cw: num(cache.write),
              c: num(d.cost),
              s: r.session_id || 'opencode',
            });
            if (rec) records.push(rec);
          }

          try {
            const srows = db.prepare('SELECT id, title, model, agent FROM session').all();
            for (const s of srows) {
              let model = '';
              try { model = s.model ? (JSON.parse(s.model).id || '') : ''; } catch { model = s.model || ''; }
              sessions[s.id] = { title: s.title || '', model, agent: s.agent || '' };
            }
          } catch { /* 表结构不同则忽略 */ }
        } catch { /* 数据库无法打开则跳过 */ }
        finally { try { if (db) db.close(); } catch { /* 忽略 */ } }
      }
      return { records, sessions };
    },
  },
];

/** Codex：输出累计用量快照（ct = 累计总量） */
function codexSnapshotHandler(o, st) {
  if (o.type === 'session_meta') { st.sid = (o.payload && o.payload.session_id) || st.sid; return null; }
  if (o.type === 'turn_context') { st.model = (o.payload && o.payload.model) || st.model; return null; }
  const payload = o.payload || {};
  let cum = null;
  if (payload.type === 'token_count') cum = (payload.info && payload.info.total_token_usage) || null;
  else if (o.type === 'token_usage_record') cum = payload.total_token_usage || (payload.info && payload.info.total_token_usage) || null;
  if (!cum) return null;
  const input = num(cum.input_tokens), cached = num(cum.cached_input_tokens), output = num(cum.output_tokens);
  const ct = num(cum.total_tokens) || (input + output);
  if (!ct) return null;
  return {
    t: toMs(o.timestamp), m: st.model || 'unknown', s: st.sid || 'codex', ct,
    // Codex 的 input 包含缓存命中，这里拆成「非缓存输入 + 缓存命中」避免重复计数
    i: Math.max(0, input - cached), o: output, cr: cached, cw: 0, r: num(cum.reasoning_output_tokens),
  };
}

/** DeepSeek Harness：宽松解析（当前无数据，供后续使用） */
function dshLineHandler(o, st) {
  const usage = o.usage || (o.payload && o.payload.usage) || (o.message && o.message.usage);
  if (!usage) return null;
  const i = num(usage.input != null ? usage.input : usage.input_tokens != null ? usage.input_tokens : usage.inputTokens);
  const oo = num(usage.output != null ? usage.output : usage.output_tokens != null ? usage.output_tokens : usage.outputTokens);
  const cr = num(usage.cacheRead != null ? usage.cacheRead : usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : usage.cacheReadTokens);
  const cw = num(usage.cacheWrite != null ? usage.cacheWrite : usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : usage.cacheWriteTokens);
  return norm({
    t: toMs(o.timestamp || o.ts || (o.time && (o.time.created || o.time)) || st.firstTs),
    m: o.model || (o.message && o.message.model) || 'unknown',
    i, o: oo, cr, cw, r: num(usage.reasoning),
    s: o.sessionId || o.session_id || 'dsh',
  });
}

/* ------------------------------------------------------------------ */
/* 计价配置                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_PRICING = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-3.5': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  'claude-haiku-3.5': { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheCreation: null },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheCreation: null },
  'gpt-4-turbo': { input: 10, output: 30, cacheRead: null, cacheCreation: null },
  'deepseek-v4-flash': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheCreation: 0.28 },
  'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.055, cacheCreation: 0.55 },
  'big-pickle': { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  'minimax-m3-free': { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  'deepseek-v4-flash-free': { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
};

async function ensurePricingFile() {
  if (isFile(PRICING_FILE)) return;
  const merged = { ...DEFAULT_PRICING };
  try {
    const preset = JSON.parse(await fsp.readFile(PRESET_FILE, 'utf8'));
    for (const [k, v] of Object.entries(preset)) {
      if (!merged[k] && v && typeof v === 'object') merged[k] = v;
    }
  } catch { /* 无预设文件则只用内置默认 */ }
  try { await fsp.writeFile(PRICING_FILE, JSON.stringify(merged, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

function loadPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')) || {}; } catch { return {}; }
}

/* ------------------------------------------------------------------ */
/* 扫描编排                                                             */
/* ------------------------------------------------------------------ */

let scanState = { phase: 'idle', startedAt: 0, done: 0, total: AGENT_DEFS.length, message: '' };
let dataCache = null;
let scanning = null;

async function runScan() {
  const started = Date.now();
  scanState = { phase: 'scanning', startedAt: started, done: 0, total: AGENT_DEFS.length, current: '', message: '准备扫描…', agents: {} };
  for (const k of Object.keys(scanCacheNext)) delete scanCacheNext[k];

  let claims = { cliIds: new Set(), map: {}, meta: {} };
  try { claims = await collectClaims(); } catch { /* 忽略 */ }

  const agents = {};
  for (let idx = 0; idx < AGENT_DEFS.length; idx++) {
    const def = AGENT_DEFS[idx];
    scanState.current = def.id;
    scanState.message = `正在扫描 ${def.name} …`;
    const stats = { files: 0, bytes: 0, reused: 0, parsed: 0, records: 0 };
    let records = [];
    let sessions = {};
    let error = null;
    let note = '';
    try {
      const r = await def.scan({ claims, stats });
      records = r.records || [];
      sessions = r.sessions || {};
      note = r.note || '';
      records.sort((a, b) => a.t - b.t);
    } catch (e) {
      error = String((e && e.message) || e);
    }
    const existingRoots = def.roots.filter(isDir).length;
    const status = error ? 'error' : existingRoots === 0 ? 'missing' : records.length ? 'ok' : 'empty';
    agents[def.id] = {
      id: def.id, name: def.name, color: def.color, subtitle: def.subtitle,
      status, error, note, records, sessions,
      stats: { files: stats.files, bytes: stats.bytes, reused: stats.reused, parsed: stats.parsed },
    };
    scanState.agents[def.id] = { name: def.name, count: records.length, status };
    scanState.done = idx + 1;
  }

  cache = { ...scanCacheNext };
  saveCache();

  const durationMs = Date.now() - started;
  dataCache = { generatedAt: Date.now(), durationMs, agents, pricing: loadPricing() };
  scanState = { phase: 'ready', startedAt: started, finishedAt: Date.now(), durationMs, done: AGENT_DEFS.length, total: AGENT_DEFS.length, message: '扫描完成', agents: scanState.agents };
  return dataCache;
}

function ensureScan(force) {
  if (scanning) return scanning;
  scanning = (async () => {
    try { await runScan(); }
    catch (e) { scanState = { phase: 'error', message: String((e && e.message) || e), startedAt: Date.now() }; }
    finally { scanning = null; }
  })();
  return scanning;
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                            */
/* ------------------------------------------------------------------ */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  try {
    if (p === '/' || p === '/index.html') {
      const html = await fsp.readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (p === '/api/status') {
      sendJson(res, 200, scanState);
      return;
    }
    if (p === '/api/data') {
      if (!dataCache) {
        ensureScan(false);
        sendJson(res, 202, { phase: 'scanning', status: scanState });
        return;
      }
      sendJson(res, 200, dataCache);
      return;
    }
    if (p === '/api/refresh') {
      ensureScan(true);
      sendJson(res, 200, { ok: true, status: scanState });
      return;
    }
    if (p === '/api/pricing' && req.method === 'GET') {
      sendJson(res, 200, loadPricing());
      return;
    }
    if (p === '/api/pricing' && req.method === 'POST') {
      const body = await readBody(req);
      const obj = tryJson(body);
      if (!obj || typeof obj !== 'object') { sendJson(res, 400, { error: 'invalid json' }); return; }
      await fsp.writeFile(PRICING_FILE, JSON.stringify(obj, null, 2), 'utf8');
      if (dataCache) dataCache.pricing = obj;
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/**
 * 自检：逐项列出每个数据源在本机的候选路径、是否存在、实际读到多少记录。
 * 用于回答“为什么某个 Agent 没数据”——先看路径在不在，再看格式对不对。
 */
async function runDoctor() {
  const data = await runScan();
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
  const CANDIDATES = {
    proma: [path.join(HOME, '.proma', 'agent-sessions'), path.join(HOME, '.proma', 'conversations'), path.join(HOME, '.proma-dev', 'agent-sessions')],
    pi: [path.join(HOME, '.pi', 'agent', 'sessions')],
    omp: [path.join(HOME, '.omp', 'agent', 'sessions')],
    'claude-code': [path.join(HOME, '.claude', 'projects'), path.join(HOME, '.claude', 'stats-cache.json')],
    'claude-desktop': CLAUDE_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'local-agent-mode-sessions'), path.join(b, 'claude-code-sessions')]),
    codex: [path.join(HOME, '.codex', 'sessions'), path.join(HOME, '.codex', 'archived_sessions'), path.join(HOME, '.codex', 'session_index.jsonl')],
    zcode: [path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite'), path.join(HOME, '.zcode', 'cli', 'agents'), path.join(HOME, '.zcode', 'cli', 'rollout')],
    dsh: [...DSH_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'harness', 'sessions'), b]), path.join(DSH_CLI_HOME, 'sessions'), path.join(DSH_CLI_HOME, 'storages')],
    opencode: [...new Set([path.join(HOME, '.local', 'share', 'opencode'), ...dataCandidates('opencode')])].flatMap((d) => [path.join(d, 'opencode.db'), path.join(d, 'opencode-local.db')]),
  };
  console.log('\n数据源自检 · ' + os.platform() + ' · home=' + HOME + (process.env.DSH_HOME ? ' · DSH_HOME=' + process.env.DSH_HOME : ''));
  console.log('═'.repeat(72));
  for (const a of Object.values(data.agents)) {
    const mark = a.status === 'ok' ? '✓' : a.status === 'empty' ? '·' : a.status === 'missing' ? '✗' : '!';
    console.log(`${mark} ${a.name.padEnd(18, ' ')} ${String(a.records.length).padStart(6)} 条  ${(a.records.reduce((s, r) => s + r.i + r.o + r.cr + r.cw, 0)).toLocaleString('en-US').padStart(16)} tokens  [${a.status}]`);
    for (const p of (CANDIDATES[a.id] || [])) {
      const ok = exists(p);
      if (ok || a.status !== 'ok') console.log(`      ${ok ? '存在' : '缺失'}  ${p}`);
    }
    if (a.error) console.log('      错误: ' + a.error);
    if (a.note) console.log('      备注: ' + a.note);
  }
  console.log('═'.repeat(72));
  console.log('提示：标记为“缺失”只是说明本机没装该工具或未产生记录，不影响其他源。');
  console.log('若你确定某个工具用过但显示无数据，请对照 docs/data-sources.md 里的路径与格式。');
}

async function main() {
  const once = process.argv.includes('--once');
  loadCache();
  await ensurePricingFile();

  if (process.argv.includes('--doctor')) { await runDoctor(); return; }

  if (once) {
    const data = await runScan();
    console.log('\n数据源扫描结果');
    console.log('─'.repeat(64));
    let total = 0;
    for (const a of Object.values(data.agents)) {
      const sum = a.records.reduce((s, r) => s + r.i + r.o + r.cr + r.cw, 0);
      total += sum;
      console.log(
        `${a.name.padEnd(18, ' ')} ${String(a.records.length).padStart(6)} 条  ` +
        `${sum.toLocaleString('en-US').padStart(16)} tokens  ` +
        `${a.stats.files} 文件 / ${(a.stats.bytes / 1048576).toFixed(1)} MB  [${a.status}]` +
        (a.error ? ` 错误: ${a.error}` : '')
      );
      const byModel = new Map();
      for (const r of a.records) byModel.set(r.m, (byModel.get(r.m) || 0) + r.i + r.o + r.cr + r.cw);
      const top = [...byModel.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4)
        .map(([m, v]) => `${m} ${(v / 1e6).toFixed(1)}M`).join('  |  ');
      if (top) console.log(`                  └─ 模型: ${top}`);
    }
    console.log('─'.repeat(64));
    console.log(`合计 ${total.toLocaleString('en-US')} tokens，耗时 ${(data.durationMs / 1000).toFixed(1)}s`);
    return;
  }

  ensureScan(false);
  server.listen(PORT, '127.0.0.1', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Token Viewer · 通用 Agent Token 用量查看器');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  地址: http://127.0.0.1:${PORT}`);
    console.log(`  数据目录: ${HOME}`);
    console.log('  正在后台扫描各 Agent 数据源…');
    console.log('  按 Ctrl+C 停止');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

main().catch((e) => { console.error('启动失败:', e); process.exit(1); });

module.exports = { runScan, AGENT_DEFS };
