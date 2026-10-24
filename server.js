#!/usr/bin/env node
'use strict';
/**
 * Token Viewer — 通用 Agent Token 用量扫描与可视化服务
 *
 * 零依赖：只使用 Node 内置模块（http / fs / readline / node:sqlite）
 * 端口：3457（可用 TOKEN_VIEWER_PORT 覆盖）
 *
 * 接入数据源：
 *   Mirage / Pi / oh-my-Pi / Claude Code / Claude Desktop /
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
// 网页版仍写项目目录；桌面版使用 Electron 的可写用户数据目录。
const DATA_ROOT = process.env.TOKEN_VIEWER_DATA_DIR ? path.resolve(process.env.TOKEN_VIEWER_DATA_DIR) : ROOT;
const AUTH_TOKEN = process.env.TOKEN_VIEWER_AUTH_TOKEN || '';
const CACHE_FILE = path.join(DATA_ROOT, '.scan-cache.json');
// 解析规则改变后，历史文件也必须重读，不能只靠 mtime / size 判断。
const CACHE_VERSION = 5;
const PRICING_FILE = path.join(DATA_ROOT, 'pricing-config.json');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
function resolveHomePath(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return path.resolve(fallback);
  const selected = value.trim();
  return path.resolve(selected === '~' ? HOME : /^~[/\\]/.test(selected) ? path.join(HOME, selected.slice(2)) : selected);
}
/** Claude 可通过 CLAUDE_CONFIG_DIR 迁移配置、会话历史与插件目录。 */
const CLAUDE_CONFIG_HOME = resolveHomePath(process.env.CLAUDE_CONFIG_DIR, path.join(HOME, '.claude'));
const CLAUDE_PROJECTS_ROOT = path.join(CLAUDE_CONFIG_HOME, 'projects');
const CLAUDE_STATS_FILE = path.join(CLAUDE_CONFIG_HOME, 'stats-cache.json');

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
/** 官方桌面端与 CLI 共用 home；Electron 的 profiles/desktop 不保存会话。 */
function resolveDshHome(value = process.env.DSH_HOME) {
  const selected = value?.trim() ? value : path.join(HOME, '.dsh');
  return path.resolve(selected === '~' ? HOME : /^~[/\\]/.test(selected) ? path.join(HOME, selected.slice(2)) : selected);
}
const DSH_CLI_HOME = resolveDshHome();
/** Qoder：CLI 与桌面 App 共用 `~/.qoder`（支持 QODER_HOME 覆盖），App 是 Electron 壳 */
const QODER_CLI_HOME = process.env.QODER_HOME || path.join(HOME, '.qoder');
/** Qoder 桌面 App 的 userData 目录（Windows/Linux 命名差异见 dataCandidates） */
const QODER_APP_ROOTS = [...dataCandidates('com.qoder.app.stable'), ...dataCandidates('Qoder App'), ...dataCandidates('qoder')];
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
      try { if (onLine(s) === false) break; } catch { /* 忽略单行异常 */ }
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
  if (hit && hit.version === CACHE_VERSION && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Array.isArray(hit.records)) {
    scanCacheNext[file] = hit;
    stats.reused++;
    stats.records += hit.records.length;
    return hit.records;
  }
  const recs = await scanOneFile(file, handler, finish, preFilter);
  scanCacheNext[file] = { version: CACHE_VERSION, mtimeMs: st.mtimeMs, size: st.size, records: recs };
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

/** Claude 会话文件里的主会话 id；subagents 归到其父会话。 */
function claudeFileSessionId(file) {
  const parts = path.resolve(file).split(path.sep);
  const projectsAt = parts.lastIndexOf('projects');
  if (projectsAt >= 0) {
    const rel = parts.slice(projectsAt + 1);
    if (rel.length >= 3 && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(rel[1])) return rel[1];
  }
  return path.basename(file, '.jsonl');
}

/** Claude Code 格式行解析（CLI 与 Claude Desktop 沙箱共用） */
function ccLineHandler(o, st) {
  if (o.type !== 'assistant') return null;
  const u = o.message && o.message.usage;
  if (!u) return null;
  const id = (o.message && o.message.id) || o.requestId || o.uuid || '';
  const rec = norm({
    t: toMs(o.timestamp),
    m: (o.message && o.message.model) || 'unknown',
    i: num(u.input_tokens), o: num(u.output_tokens),
    cr: num(u.cache_read_input_tokens), cw: num(u.cache_creation_input_tokens), r: 0,
    s: o.sessionId || claudeFileSessionId(st.file),
  });
  return rec ? { ...rec, requestId: String(id) } : null;
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

/** 文件变化后重取元信息，避免把空标题或旧标题永久缓存。 */
const headMetaCache = new Map();

/**
 * 通用兜底：从会话文件本身提取标题（首条真实用户输入）与 cwd。
 * 用于没有独立标题索引的源（Claude Code / Pi / oh-my-Pi / Qoder）。
 * opts.sidOf(file, firstObj) → 该文件对应的会话 id，可返回一个或多个（必须与记录里的 rec.s 对得上）
 * opts.userTextOf(o)          → 该行是用户输入时返回文本，否则返回 ''
 * opts.skip(lineText)         → 判定为噪声（如隐藏宿主上下文）时跳过
 */
async function sessionMetaFromFiles(files, opts) {
  const out = {};
  for (const file of files) {
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    let hit = headMetaCache.get(file);
    if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) {
      hit = { title: '', cwd: '', size: stat.size, mtimeMs: stat.mtimeMs };
      let firstObj = null;
      // 流式找首条真实输入；宿主上下文可能超过 64KB，不能截断文件头。
      await readLines(file, (raw) => {
        if (firstObj && !/"(?:user|user_message|session_info|custom-title|summary)"/.test(raw)) return;
        const o = tryJson(raw);
        if (!o) return;
        if (!firstObj) firstObj = o;
        const cwd = o.cwd || (o.payload && o.payload.cwd);
        if (!hit.cwd && typeof cwd === 'string') hit.cwd = cwd;
        const named = o.type === 'session_info' ? o.name : o.type === 'custom-title' ? o.customTitle : '';
        if (typeof named === 'string' && named.trim()) hit.title = named.trim();
        if (!hit.title) {
          const text = opts.userTextOf(o);
          if (text && !isHostContext(text) && !(opts.skip && opts.skip(text))) hit.title = text.replace(/\s+/g, ' ').slice(0, 100);
        }
      });
      if (!hit.title && opts.fallbackTitleOf) hit.title = opts.fallbackTitleOf(firstObj) || '';
      hit.sid = opts.sidOf ? opts.sidOf(file, firstObj) : path.basename(file, '.jsonl');
      headMetaCache.set(file, hit);
    }
    if (!hit.sid) continue;
    for (const sid of [].concat(hit.sid)) {
      if (!sid) continue;
      const prev = out[sid];
      if (!prev || (!prev.title && hit.title)) out[sid] = { title: hit.title, cwd: hit.cwd };
    }
  }
  return out;
}

function isHostContext(text) {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<INSTRUCTIONS>|\[QODER_LIVE_VOICE_CONTEXT\])/i.test(text.trim());
}

/** Pi 家族（Pi / oh-my-Pi）的会话 id：主取 session 行的 id，同时登记文件名与其 uuid 后缀作别名 */
function piSidOf(file, first) {
  const base = path.basename(file, '.jsonl');
  const ids = [base];
  if (first && first.type === 'session' && first.id) ids.unshift(first.id);
  const tail = base.split('_').pop();
  if (tail && tail !== base) ids.push(tail);
  return ids;
}

/** Claude Code 风格行：首条真正的用户输入（排除 tool_result 回传） */
function firstUserInputText(o) {
  if (o.type !== 'user') return '';
  const c = (o.message || {}).content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  if (c.some((p) => p && p.type === 'tool_result')) return '';
  return c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n').trim();
}

/** Pi / oh-my-Pi 风格行：type:"message" + role:"user"（工具结果单独是 type:"toolResult"） */
function piUserInputText(o) {
  if (o.type !== 'message') return '';
  const m = o.message || {};
  if (m.role !== 'user') return '';
  const c = m.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n').trim();
}

/** Mirage 会话文件→session_id 集合的缓存（与 headMetaCache 分开，值类型不同） */
const mirageSidByFile = new Map();
const MIRAGE_HOME = path.join(HOME, '.mirage');

function dedupeMirageRecords(records) {
  const unique = new Map();
  for (const r of records) {
    const key = r.requestId || JSON.stringify([r.s, r.t, r.m, r.i, r.o, r.cr, r.cw]);
    const prev = unique.get(key);
    if (!prev || r.i + r.o + r.cr + r.cw > prev.i + prev.o + prev.cr + prev.cw) unique.set(key, r);
  }
  return [...unique.values()].map(({ requestId, ...r }) => r);
}
/** 从原始行里快速抽 session_id，避开整行 JSON.parse */
const SID_RE = /"session_id"\s*:\s*"([^"]+)"/;

/**
 * Mirage 会话标题。
 * 关键：会话 jsonl 里的 `session_id` 是索引条目的 **`sdkSessionId`**，不是 `id`；
 * 只按 `id` 建索引会一条也匹不上。另有少量会话的 `sdkSessionId` 没写回索引，
 * 但文件名就是它的 `id`，所以再用「文件名 → 索引 id」读一次首行补映射。
 */
async function mirageSessionMeta(home = path.join(HOME, '.mirage')) {
  const out = {};
  let list = [];
  try {
    const d = JSON.parse(await fsp.readFile(path.join(home, 'agent-sessions.json'), 'utf8'));
    const sess = d && d.sessions;
    if (Array.isArray(sess)) list = sess;
    else if (sess && typeof sess === 'object') list = Object.values(sess);
  } catch { /* 索引不存在时忽略 */ }

  const byId = {};
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const meta = { title: s.title || s.name || s.summary || '', cwd: s.cwd || '' };
    // 主键：SDK 会话 id（与记录里的 session_id 同一体系）；别名：Mirage 内部 id
    if (s.sdkSessionId) out[s.sdkSessionId] = meta;
    if (s.id) { byId[s.id] = meta; if (!out[s.id]) out[s.id] = meta; }
  }

  // 补漏：索引里没登记 sdkSessionId 的会话，用文件名（= 内部 id）反查条目。
  // 一个文件可能因续聊/恢复出现**多个** session_id，所以必须全文收集，不能只看头部。
  const files = await walk(path.join(home, 'agent-sessions'), (p, n) => n.endsWith('.jsonl'), 0, 2);
  for (const file of files) {
    const fname = path.basename(file, '.jsonl');
    const meta = byId[fname];
    if (!meta) continue;
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) continue;
    let hit = mirageSidByFile.get(file);
    if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) {
      hit = { ids: new Set(), size: stat.size, mtimeMs: stat.mtimeMs };
      // 只跑一次正则，不做 JSON.parse：这里要扫全部会话文件，成本敏感
      await readLines(file, (line) => {
        const m = SID_RE.exec(line);
        if (m) hit.ids.add(m[1]);
      }, hasAny('"session_id"'));
      mirageSidByFile.set(file, hit);
    }
    for (const sid of hit.ids) if (!out[sid]) out[sid] = meta;
  }
  return out;
}

/** 按规范化真实路径去重，避免重叠 roots / junction 把同一日志读两次。 */
async function uniqueRealFiles(files) {
  const out = [], seen = new Set();
  for (const file of files) {
    let key;
    try { key = await fsp.realpath(file); } catch { continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** Claude Desktop 的 local_* 声明：两个目录分别代表 Cowork 与桌面 Code 标签页。 */
async function collectClaims(desktopRoots = CLAUDE_DESKTOP_ROOTS) {
  const scopes = [];
  for (const base of desktopRoots || []) {
    scopes.push({ root: path.join(base, 'claude-code-sessions'), kind: 'code' });
    scopes.push({ root: path.join(base, 'local-agent-mode-sessions'), kind: 'cowork' });
  }
  const claimFiles = [];
  for (const scope of scopes) {
    if (!isDir(scope.root)) continue;
    const files = await walk(scope.root, (p, n) => /^local_.+\.json$/i.test(n), 0, 3);
    for (const file of files) claimFiles.push({ file, kind: scope.kind });
  }
  const unique = await uniqueRealFiles(claimFiles.map((x) => x.file));
  const uniqueSet = new Set(unique);
  const candidates = [];
  for (const item of claimFiles) {
    if (!uniqueSet.has(item.file)) continue;
    uniqueSet.delete(item.file);
    try {
      const [text, stat] = await Promise.all([fsp.readFile(item.file, 'utf8'), fsp.stat(item.file)]);
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object') continue;
      const localId = o.sessionId || path.basename(item.file, '.json');
      if (!localId) continue;
      candidates.push({
        localId, cliId: typeof o.cliSessionId === 'string' && o.cliSessionId ? o.cliSessionId : '',
        kind: item.kind, mtimeMs: stat.mtimeMs, file: item.file,
        meta: { title: o.title || '', cwd: o.cwd || '', model: o.model || '' },
      });
    } catch { /* 忽略坏文件 */ }
  }
  // 旧副本可能在目录迭代中更晚出现，按 mtime 应用，确保新声明的标题与映射获胜。
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  const byLocal = new Map();
  for (const candidate of candidates) byLocal.set(candidate.localId, candidate);

  const localToCli = new Map(), kindById = new Map(), meta = {}, cliIds = new Set();
  const cliWinners = new Map();
  for (const claim of byLocal.values()) {
    if (claim.cliId) {
      localToCli.set(claim.localId, claim.cliId);
      const prior = cliWinners.get(claim.cliId);
      if (!prior || claim.mtimeMs >= prior.mtimeMs) cliWinners.set(claim.cliId, claim);
      cliIds.add(claim.cliId);
    } else localToCli.set(claim.localId, '');
    kindById.set(claim.localId, claim.kind);
    meta[claim.localId] = { ...claim.meta };
  }
  for (const [cliId, claim] of cliWinners) {
    kindById.set(cliId, claim.kind);
    meta[cliId] = { ...claim.meta };
  }
  return { cliIds, localToCli, kindById, meta, scopes: scopes.map((s) => s.root), locals: [...byLocal.values()] };
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

const CLAUDE_STAT_KEYS = ['files', 'bytes', 'reused', 'parsed'];
const emptyClaudeStats = () => ({ files: 0, bytes: 0, reused: 0, parsed: 0, records: 0 });
function addClaudeStats(target, source) {
  for (const key of Object.keys(emptyClaudeStats())) target[key] = (target[key] || 0) + (source[key] || 0);
}
function claudeStatsView(stats) {
  return Object.fromEntries(CLAUDE_STAT_KEYS.map((key) => [key, stats[key] || 0]));
}

function claudeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value || '');
}

/** 仅匹配 projects 下的会话文件及已知的 session/subagents 层级。 */
function isClaudeProjectJsonl(file, projectsRoot) {
  if (!file.toLowerCase().endsWith('.jsonl')) return false;
  const rel = path.relative(projectsRoot, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.length === 2) return true; // <project>/<session>.jsonl
  if (parts.length === 3 && claudeUuid(parts[1])) return true; // <project>/<session>/<session-data>.jsonl
  return parts.length === 4 && claudeUuid(parts[1]) && parts[2] === 'subagents';
}

async function claudeProjectFiles(projectsRoots) {
  const found = [];
  for (const root of projectsRoots) {
    if (!isDir(root)) continue;
    const files = await walk(root, (p, n) => n.toLowerCase().endsWith('.jsonl'), 0, 8);
    for (const file of files) if (isClaudeProjectJsonl(file, root)) found.push({ file, kindHint: 'code' });
  }
  return found;
}

function sandboxProjectsRoot(file) {
  const full = path.resolve(file);
  const { root } = path.parse(full);
  const parts = full.slice(root.length).split(path.sep);
  const claudeAt = parts.lastIndexOf('.claude');
  if (claudeAt < 0 || parts[claudeAt + 1] !== 'projects') return '';
  return path.join(root, ...parts.slice(0, claudeAt + 2));
}

async function claudeSandboxFiles(desktopRoots) {
  const found = [];
  for (const base of desktopRoots || []) {
    for (const scope of [
      { root: path.join(base, 'claude-code-sessions'), kind: 'code' },
      { root: path.join(base, 'local-agent-mode-sessions'), kind: 'cowork' },
    ]) {
      if (!isDir(scope.root)) continue;
      const files = await walk(scope.root, (p, n) => n.toLowerCase().endsWith('.jsonl'), 0, 10);
      for (const file of files) {
        const projectsRoot = sandboxProjectsRoot(file);
        if (!projectsRoot || !isClaudeProjectJsonl(file, projectsRoot)) continue;
        found.push({ file, kindHint: scope.kind });
      }
    }
  }
  return found;
}

async function uniqueClaudeEntries(entries) {
  const uniqueFiles = await uniqueRealFiles(entries.map((entry) => entry.file));
  const allowed = new Set(uniqueFiles);
  const seen = new Set();
  return entries.filter((entry) => {
    if (!allowed.has(entry.file) || seen.has(entry.file)) return false;
    seen.add(entry.file);
    return true;
  });
}

function claudeCanonicalSession(id, claims) {
  return claims.localToCli.get(id) || id;
}

function claudeKindForSession(id, claims, fallback = 'code') {
  return claims.kindById.get(id) || claims.kindById.get(claudeCanonicalSession(id, claims)) || fallback;
}

function claudeOutputKind(kind) { return kind === 'cowork' ? 'desktop' : 'code'; }

function claudeGroupKey(kind, rec, session = rec.s) {
  return JSON.stringify([kind, session, dayKeyLocal(rec.t), rec.m]);
}

function claudeTokenTotal(rec) { return rec.i + rec.o + rec.cr + rec.cw; }

function splitClaudeInteger(total, modelUsage) {
  const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
  const raw = fields.map((field) => num(modelUsage && modelUsage[field]));
  const denominator = raw.reduce((sum, value) => sum + value, 0);
  const ratios = denominator > 0 ? raw.map((value) => value / denominator) : [1, 0, 0, 0];
  const parts = ratios.map((ratio) => Math.floor(total * ratio));
  let remaining = total - parts.reduce((sum, value) => sum + value, 0);
  const order = ratios.map((ratio, index) => ({ index, remainder: total * ratio - parts[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) parts[order[i % order.length].index]++;
  return parts;
}

/** Claude Code 的日缓存只补逐请求来源未覆盖的正差额。 */
async function claudeStatsRecords(statsFile, actualRecords) {
  const out = { records: [], days: new Set(), latestDay: '' };
  let data;
  try { data = JSON.parse(await fsp.readFile(statsFile, 'utf8')); }
  catch { return out; }
  if (!data || typeof data !== 'object') return out;
  const actual = new Map();
  for (const rec of actualRecords) {
    const key = JSON.stringify([dayKeyLocal(rec.t), rec.m]);
    actual.set(key, (actual.get(key) || 0) + claudeTokenTotal(rec));
  }
  const usage = data.modelUsage || {};
  const days = Array.isArray(data.dailyModelTokens) ? data.dailyModelTokens : [];
  const cachedByDayModel = new Map();
  for (const entry of days) {
    const day = entry && typeof entry.date === 'string' ? entry.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const ts = Date.parse(day + 'T12:00:00');
    if (!Number.isFinite(ts)) continue;
    out.days.add(day);
    if (day > out.latestDay) out.latestDay = day;
    for (const [model, totalValue] of Object.entries(entry.tokensByModel || {})) {
      const key = JSON.stringify([day, model]);
      const previous = cachedByDayModel.get(key);
      cachedByDayModel.set(key, { day, ts, model, total: (previous?.total || 0) + num(totalValue) });
    }
  }
  for (const { day, ts, model, total: cachedTotal } of cachedByDayModel.values()) {
    const total = Math.max(0, Math.round(cachedTotal));
    const known = actual.get(JSON.stringify([day, model])) || 0;
    const remainder = Math.max(0, total - Math.round(known));
    if (!remainder) continue;
    const [i, o, cr, cw] = splitClaudeInteger(remainder, usage[model]);
    const rec = norm({ t: ts, m: model, i, o, cr, cw, r: 0, s: 'claude-stats' });
    if (rec) out.records.push(rec);
  }
  return out;
}

/**
 * Claude Code + Claude Desktop 单次扫描。共享 projects 日志归 Code，Cowork 声明的 cliSessionId
 * 归 Desktop；raw 与 usage-ledger 按会话/日期/模型挑总量较完整的一组，永不相加。
 */
async function scanClaudeUsage({
  projectsRoot = CLAUDE_PROJECTS_ROOT,
  desktopRoots = CLAUDE_DESKTOP_ROOTS,
  statsFile = CLAUDE_STATS_FILE,
} = {}, stats) {
  const projectRoots = [].concat(projectsRoot || []).filter(Boolean);
  const roots = [].concat(desktopRoots || []).filter(Boolean);
  const claims = await collectClaims(roots);
  const codeStats = emptyClaudeStats(), desktopStats = emptyClaudeStats();
  const outStats = { code: codeStats, desktop: desktopStats };

  const sourceFiles = await uniqueClaudeEntries([
    ...(await claudeProjectFiles(projectRoots)),
    ...(await claudeSandboxFiles(roots)),
  ]);
  const rawRequests = new Map();
  for (const entry of sourceFiles) {
    const fileStats = emptyClaudeStats();
    const recs = await scanOneFileCached(entry.file, ccLineHandler, null, fileStats, hasAny('"usage"')) || [];
    const fileKinds = new Set();
    for (const rec of recs) {
      const kind = claudeKindForSession(rec.s, claims, entry.kindHint);
      fileKinds.add(kind);
      const session = claudeCanonicalSession(rec.s, claims);
      const key = rec.requestId
        ? `request:${rec.requestId}`
        : `fingerprint:${JSON.stringify([session, rec.t, rec.m, rec.i, rec.o, rec.cr, rec.cw])}`;
      const prior = rawRequests.get(key);
      if (!prior || claudeTokenTotal(rec) > claudeTokenTotal(prior.rec)) {
        rawRequests.set(key, { kind, session, rec });
      }
    }
    if (!fileKinds.size) fileKinds.add(claudeKindForSession(claudeFileSessionId(entry.file), claims, entry.kindHint));
    for (const kind of fileKinds) addClaudeStats(outStats[claudeOutputKind(kind)], fileStats);
  }

  const rawBuckets = new Map();
  for (const value of rawRequests.values()) {
    const rec = { ...value.rec, s: value.session };
    const key = claudeGroupKey(value.kind, rec, value.session);
    if (!rawBuckets.has(key)) rawBuckets.set(key, { kind: value.kind, session: value.session, records: [], total: 0 });
    const bucket = rawBuckets.get(key);
    bucket.records.push(rec);
    bucket.total += claudeTokenTotal(rec);
  }

  const scopes = [];
  for (const base of roots) {
    scopes.push({ root: path.join(base, 'claude-code-sessions'), kind: 'code' });
    scopes.push({ root: path.join(base, 'local-agent-mode-sessions'), kind: 'cowork' });
  }
  const ledgerEntries = [];
  for (const scope of scopes) {
    if (!isDir(scope.root)) continue;
    const files = await walk(scope.root, (p, n) => n.toLowerCase().endsWith('.ndjson'), 0, 7);
    for (const file of files) {
      if (file.split(path.sep).some((part) => part.toLowerCase() === 'usage-ledger')) ledgerEntries.push({ file, kindHint: scope.kind });
    }
  }
  const uniqueLedgers = await uniqueClaudeEntries(ledgerEntries);
  const ledgerRows = new Map();
  for (const entry of uniqueLedgers) {
    const fileStats = emptyClaudeStats();
    try { fileStats.bytes = (await fsp.stat(entry.file)).size; } catch { continue; }
    fileStats.files = 1;
    fileStats.parsed = 1;
    const fileKinds = new Set();
    await readLines(entry.file, (line) => {
      const obj = tryJson(line);
      if (!obj || !obj.models || typeof obj.models !== 'object') return;
      const localId = obj.sessionId || entry.file.split(path.sep).reverse().find((part) => /^local_.+$/i.test(part)) || 'claude-desktop';
      const fallback = claudeKindForSession(localId, claims, entry.kindHint);
      const surface = String(obj.surface || '').toLowerCase();
      const kind = surface === 'code' ? 'code' : surface === 'cowork' ? 'cowork' : fallback;
      fileKinds.add(kind);
      const session = claudeCanonicalSession(localId, claims);
      const ts = toMs(obj.ts || obj.timestamp || obj.time);
      for (const [model, modelUsage] of Object.entries(obj.models)) {
        if (!modelUsage || typeof modelUsage !== 'object') continue;
        const costValue = modelUsage.cost && typeof modelUsage.cost === 'object'
          ? (modelUsage.cost.usd ?? modelUsage.cost.total)
          : modelUsage.cost;
        const rec = norm({
          t: ts, m: model,
          i: num(modelUsage.inputTokens), o: num(modelUsage.outputTokens),
          cr: num(modelUsage.cacheReadTokens), cw: num(modelUsage.cacheWriteTokens), r: 0,
          c: num(costValue), s: session,
        });
        if (!rec) continue;
        const fp = JSON.stringify([kind, session, rec.t, rec.m, rec.i, rec.o, rec.cr, rec.cw, rec.c || 0]);
        if (!ledgerRows.has(fp)) ledgerRows.set(fp, { kind, rec });
      }
    }, hasAny('"models"'));
    if (!fileKinds.size) fileKinds.add(entry.kindHint);
    for (const kind of fileKinds) addClaudeStats(outStats[claudeOutputKind(kind)], fileStats);
  }

  const ledgerBuckets = new Map();
  for (const value of ledgerRows.values()) {
    const key = claudeGroupKey(value.kind, value.rec);
    if (!ledgerBuckets.has(key)) ledgerBuckets.set(key, { kind: value.kind, session: value.rec.s, records: [], total: 0 });
    const bucket = ledgerBuckets.get(key);
    bucket.records.push(value.rec);
    bucket.total += claudeTokenTotal(value.rec);
  }

  const selected = [];
  const allBucketKeys = new Set([...rawBuckets.keys(), ...ledgerBuckets.keys()]);
  for (const key of allBucketKeys) {
    const raw = rawBuckets.get(key), ledger = ledgerBuckets.get(key);
    const chosen = !raw ? ledger : !ledger || raw.total >= ledger.total ? raw : ledger;
    if (chosen) selected.push({ kind: chosen.kind, records: chosen.records });
  }

  const sessions = { code: {}, desktop: {} };
  const fileMeta = await sessionMetaFromFiles(sourceFiles.map((entry) => entry.file), {
    sidOf: (file, first) => first && first.sessionId ? first.sessionId : claudeFileSessionId(file),
    userTextOf: firstUserInputText,
  });
  for (const [id, metadata] of Object.entries(fileMeta)) {
    const canonical = claudeCanonicalSession(id, claims);
    const kind = claudeKindForSession(id, claims, 'code');
    sessions[claudeOutputKind(kind)][canonical] = metadata;
  }
  for (const [id, metadata] of Object.entries(claims.meta)) {
    const kind = claims.kindById.get(id) || 'code';
    sessions[claudeOutputKind(kind)][id] = { ...metadata };
  }

  const selectedRecords = selected.flatMap((bucket) => bucket.records);
  const statsHistory = await claudeStatsRecords(statsFile, selectedRecords);
  const codeRecords = selected.filter((bucket) => bucket.kind === 'code').flatMap((bucket) => bucket.records);
  const desktopRecords = selected.filter((bucket) => bucket.kind === 'cowork').flatMap((bucket) => bucket.records);
  for (const bucket of selected) {
    const target = sessions[claudeOutputKind(bucket.kind)];
    for (const rec of bucket.records) {
      if (!target[rec.s]) target[rec.s] = claims.meta[rec.s] || fileMeta[rec.s] || { title: '' };
    }
  }
  codeRecords.push(...statsHistory.records);
  if (statsHistory.records.length) {
    sessions.code['claude-stats'] = { title: `Claude Code 历史日统计（截至 ${statsHistory.latestDay}；四类拆分为估算）` };
  }

  const coverageNote = '逐请求日志与 usage-ledger 按来源、会话、本地日和模型选用总量较完整的一组；消息数与台账轮次不代表精确请求数。';
  const codeNote = [coverageNote, statsHistory.records.length
    ? `stats-cache 截至 ${statsHistory.latestDay}；仅补已知 Code/Cowork 实际记录扣除后的历史日差额，四类按 modelUsage 全期比例估算。`
    : ''].filter(Boolean).join(' ');
  const desktopNote = coverageNote;

  if (stats && typeof stats === 'object') {
    for (const key of ['code', 'desktop']) {
      const target = stats[key] && typeof stats[key] === 'object' ? stats[key] : stats;
      addClaudeStats(target, outStats[key]);
    }
  }
  const cleanRecords = (records) => records.map(({ requestId, ...rec }) => rec).sort((a, b) => a.t - b.t);
  return {
    code: { records: cleanRecords(codeRecords), sessions: sessions.code, note: codeNote, stats: claudeStatsView(codeStats) },
    desktop: { records: cleanRecords(desktopRecords), sessions: sessions.desktop, note: desktopNote, stats: claudeStatsView(desktopStats) },
  };
}

/** Codex 会话标题索引 */
async function codexTitles(home = path.join(HOME, '.codex')) {
  const out = {};
  const p = path.join(home, 'session_index.jsonl');
  await readLines(p, (line) => {
    const o = tryJson(line);
    if (o && o.id) out[o.id] = { title: o.thread_name || '' };
  });
  // Desktop 的权威标题可能只保存在状态库；只读打开，兼容不同版本。
  const dbs = (await fsp.readdir(home).catch(() => []))
    .filter((n) => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const name of dbs) {
    const db = openSqlite(path.join(home, name));
    if (!db) continue;
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name));
      const fields = ['id', 'title', 'cwd', 'model', 'first_user_message'].filter((k) => columns.has(k));
      if (!columns.has('id')) continue;
      for (const row of db.prepare(`SELECT ${fields.join(', ')} FROM threads`).all()) {
        const prev = out[row.id] || {};
        out[row.id] = {
          ...prev, cwd: row.cwd || prev.cwd || '', model: row.model || prev.model || '',
          title: row.title && row.title.trim() ? row.title.trim() : prev.title ||
            (row.first_user_message && !isHostContext(row.first_user_message) ? row.first_user_message.replace(/\s+/g, ' ').slice(0, 100) : ''),
        };
      }
    } catch { /* 旧版没有这些列或表 */ }
    finally { db.close(); }
  }
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
    try { parts.push(zlib.zstdDecompressSync(seg)); } catch { /* 跳过尚未写完的尾帧 */ }
  }
  // 帧边界可能落在一行或 UTF-8 字符中间，必须先拼字节再解码。
  return Buffer.concat(parts).toString('utf8');
}

function parseDshSession(text, fallbackSid) {
  const events = text.split('\n').map(tryJson).filter(Boolean);
  const header = events.find(o => o.type === 'session') || {};
  const sid = header.id || fallbackSid;
  const records = [];
  const meta = { title: '', ...(header.cwd ? { cwd: header.cwd } : {}) };
  if (num(header.version) > 4) return { sid, records, meta, unsupported: true };
  // 子会话复制的历史不产生新请求；上游以最后一个 end-seed 标出继承边界。
  const seedEnd = events.findLastIndex(o => o.type === 'session/end-seed');
  const start = seedEnd >= 0 ? seedEnd + 1 : header.isSeeded ? events.length : 0;
  for (const [index, o] of events.entries()) {
    const data = o.data || {};
    if (o.type === 'session/title' && data.title) meta.title = data.title;
    if (index < start || !data.usage || !['assistant/message', 'compaction/summary'].includes(o.type)) continue;
    const u = data.usage, msg = data.message || {};
    const rec = norm({
      t: num(o.time), m: msg.model || msg.source?.model || data.model || 'unknown',
      i: num(u.inputTokens), o: num(u.outputTokens), cr: num(u.cacheReadTokens),
      cw: num(u.cacheWriteTokens ?? u.cacheCreationTokens), r: num(u.reasoningTokens), s: sid,
    });
    if (rec) records.push({ ...rec, requestId: msg.id || data.compactionId || `${o.type}:${o.seq ?? index}` });
  }
  return { sid, records, meta };
}

async function dshHarnessSessions(stats, sessionRoots) {
  const records = [];
  const sessions = {};
  const roots = sessionRoots || [
    // 桌面版：home 指向自己的应用数据目录，通常还多一层 harness
    ...DSH_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'harness', 'sessions'), path.join(b, 'sessions')]),
    path.join(DSH_CLI_HOME, 'sessions'), // 官方桌面端与 CLI（DSH_HOME 可覆盖）
  ];
  const requests = new Map();
  let unsupported = 0;
  const seenFiles = new Set();
  for (const root of new Set(roots)) {
    if (!isDir(root)) continue;
    const files = await walk(root, (p, n) => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd|\.gz)?$/.test(n), 0, 4);
    // 每个目录只读最高代际的已提交文件，迁移保留的旧日志不能再累计一次。
    const latest = new Map();
    for (const file of files.sort()) {
      const version = Number(path.basename(file).match(/\.v(\d+)\./)?.[1] || 0);
      const dir = path.dirname(file), prior = latest.get(dir);
      if (!prior || version > prior.version) latest.set(dir, { file, version });
    }
    for (const { file: f } of latest.values()) {
      let text = '';
      try {
        const real = await fsp.realpath(f);
        if (seenFiles.has(real)) continue;
        seenFiles.add(real);
        const buf = await fsp.readFile(f);
        stats.files++;
        stats.bytes += buf.length;
        text = f.endsWith('.zstd') ? decodeZstdFrames(buf) : f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      } catch { continue; }
      const parsed = parseDshSession(text, path.basename(path.dirname(f)));
      if (parsed.unsupported) { unsupported++; continue; }
      sessions[parsed.sid] = parsed.meta;
      for (const rec of parsed.records) {
        const key = `${parsed.sid}:${rec.requestId}`;
        const prior = requests.get(key);
        if (!prior || rec.i + rec.o + rec.cr + rec.cw > prior.i + prior.o + prior.cr + prior.cw) requests.set(key, rec);
      }
    }
  }
  for (const { requestId, ...rec } of requests.values()) records.push(rec);
  return { records, sessions, ...(unsupported ? { note: `${unsupported} 个会话使用更新的未知格式，未计入用量` } : {}) };
}

const AGENT_DEFS = [
  {
    id: 'mirage', name: 'Mirage', color: '#38bdf8', subtitle: '桌面端会话',
    roots: [path.join(MIRAGE_HOME, 'agent-sessions'), path.join(MIRAGE_HOME, 'conversations')],
    async scan(ctx) {
      const files = [];
      for (const d of this.roots) {
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
        const rec = norm({
          t: toMs(o._createdAt) || toMs(o.timestamp),
          m: o._channelModelId || (o.message && o.message.model) || 'unknown',
          i: num(u.input_tokens), o: num(u.output_tokens),
          cr: num(u.cache_read_input_tokens), cw: num(u.cache_creation_input_tokens), r: 0,
          s: o.session_id || path.basename(st.file, '.jsonl'),
        });
        return rec ? { ...rec, requestId: id || '' } : null;
      }, null, ctx.stats, hasAny('"usage"'));
      const sessions = await sessionMetaFromFiles(files, { userTextOf: firstUserInputText });
      for (const [sid, meta] of Object.entries(await mirageSessionMeta())) {
        sessions[sid] = { ...sessions[sid], ...meta, title: meta.title || sessions[sid]?.title || '' };
      }
      return { records: dedupeMirageRecords(records), sessions };
    },
  },
  {
    id: 'pi', name: 'Pi', color: '#a78bfa', subtitle: 'Pi CLI 会话',
    roots: [path.join(HOME, '.pi', 'agent', 'sessions')],
    async scan(ctx) {
      const files = await walk(path.join(HOME, '.pi', 'agent', 'sessions'), (p, n) => n.endsWith('.jsonl'));
      return {
        records: await scanWithCache(files, piLineHandler, null, ctx.stats, hasAny(['"usage"', '"session"'])),
        sessions: await sessionMetaFromFiles(files, { sidOf: piSidOf, userTextOf: piUserInputText }),
      };
    },
  },
  {
    id: 'omp', name: 'oh-my-Pi', color: '#f472b6', subtitle: 'oh-my-Pi 会话',
    roots: [path.join(HOME, '.omp', 'agent', 'sessions')],
    async scan(ctx) {
      const files = await walk(path.join(HOME, '.omp', 'agent', 'sessions'), (p, n) => n.endsWith('.jsonl'));
      return {
        records: await scanWithCache(files, piLineHandler, null, ctx.stats, hasAny(['"usage"', '"session"'])),
        sessions: await sessionMetaFromFiles(files, { sidOf: piSidOf, userTextOf: piUserInputText }),
      };
    },
  },
  {
    id: 'claude-code', name: 'Claude Code', color: '#fb923c', subtitle: 'Claude Code CLI / Claude Desktop Code 标签页',
    roots: [CLAUDE_PROJECTS_ROOT, ...CLAUDE_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'claude-code-sessions'), path.join(b, 'local-agent-mode-sessions')])],
    async scan(ctx) {
      const result = await ctx.getClaudeUsage();
      addClaudeStats(ctx.stats, result.code.stats);
      return result.code;
    },
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop', color: '#fbbf24', subtitle: 'Claude Desktop Cowork',
    roots: CLAUDE_DESKTOP_ROOTS,
    async scan(ctx) {
      const result = await ctx.getClaudeUsage();
      addClaudeStats(ctx.stats, result.desktop.stats);
      return result.desktop;
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
        selectCodexSessions(perSession, snaps);
      }
      // 累计值转逐轮增量，保证合计与末次累计一致，同时保留时间分布
      const records = [];
      for (const [sid, s] of perSession) {
        records.push(...codexDeltas(s.snaps, sid));
      }
      const sessions = await codexTitles();
      const missingFiles = files.filter((f) => {
        const snaps = scanCacheNext[f]?.records || [];
        return snaps.some((snap) => !sessions[snap.s]?.title);
      });
      const fallback = await sessionMetaFromFiles(missingFiles, {
        sidOf: (f, o) => o?.payload?.id || o?.payload?.session_id || codexIdFromPath(f),
        userTextOf: codexUserInputText,
        fallbackTitleOf: codexAgentTitle,
      });
      for (const [sid, meta] of Object.entries(fallback)) {
        const current = sessions[sid] || {};
        sessions[sid] = { ...meta, ...current, title: current.title || meta.title, cwd: current.cwd || meta.cwd };
      }
      return { records, sessions };
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
    id: 'dsh', name: 'DeepSeek Harness', color: '#60a5fa', subtitle: '官方桌面端 / CLI / 旧桌面版',
    roots: [...DSH_DESKTOP_ROOTS, DSH_CLI_HOME],
    async scan(ctx) {
      const found = await dshHarnessSessions(ctx.stats);
      if (found.records.length || found.note) return found;
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
  {
    id: 'qoder', name: 'Qoder', color: '#818cf8', subtitle: 'Qoder CLI / App 会话（token 为文本估算）',
    roots: [path.join(QODER_CLI_HOME, 'projects'), ...QODER_APP_ROOTS],
    async scan(ctx) {
      const files = await walk(path.join(QODER_CLI_HOME, 'projects'), (p, n) => n.endsWith('.jsonl'), 0, 3);
      // 预过滤必须把 user / attachment 行也放进来（它们只用于累积上下文），
      // 且不能依赖 `"role":"user"` 这种紧凑写法：部分版本会序列化出空格，所以只匹配关键词
      const records = await scanWithCache(files, qoderLineHandler, null, ctx.stats,
        hasAny(['usage', '"user"', '"attachment"']));
      const sessions = await qoderSessionMeta(ctx.stats);
      return {
        records, sessions,
        note: records.length
          ? 'Qoder 本地不落 token 数（usage 四个字段恒为 0，服务端只回 credits 与上下文占比），'
            + '此处 token 按消息文本长度估算，多轮重发的历史已计入输入，与官方账单不是同一口径'
          : '',
      };
    },
  },
];

/** Codex：输出累计用量快照（ct = 累计总量） */
function codexSnapshotHandler(o, st) {
  if (o.type === 'session_meta') {
    const meta = o.payload || {};
    st.sid = meta.id || meta.session_id || st.sid;
    st.historyStart = num(meta.subagent_history_start_ordinal);
    return null;
  }
  if (o.type === 'turn_context') { st.model = (o.payload && o.payload.model) || st.model; return null; }
  const payload = o.payload || {};
  let cum = null;
  if (payload.type === 'token_count') cum = (payload.info && payload.info.total_token_usage) || null;
  else if (o.type === 'token_usage_record') cum = payload.thread_token_usage || payload.total_token_usage || (payload.info && payload.info.total_token_usage) || null;
  if (!cum) return null;
  // 子 Agent 文件可能包含父线程历史。边界前的用量只作为旧式计数器基线。
  if (st.historyStart && Number.isFinite(o.ordinal) && o.ordinal < st.historyStart) {
    if (o.type !== 'token_usage_record') st.historyUsage = cum;
    return null;
  }
  let base = o.type === 'token_usage_record' ? null : st.historyUsage;
  if (base && num(cum.input_tokens) < num(base.input_tokens)) { st.historyUsage = null; base = null; }
  const input = Math.max(0, num(cum.input_tokens) - num(base?.input_tokens));
  const cached = Math.min(input, Math.max(0, num(cum.cached_input_tokens) - num(base?.cached_input_tokens)));
  const output = Math.max(0, num(cum.output_tokens) - num(base?.output_tokens));
  const ct = input + output;
  if (!ct) return null;
  return {
    t: toMs(o.timestamp), m: st.model || 'unknown', s: payload.thread_id || st.sid || payload.session_id || codexIdFromPath(st.file), ct,
    // Codex 的 input 包含缓存命中，这里拆成「非缓存输入 + 缓存命中」避免重复计数
    i: Math.max(0, input - cached), o: output, cr: cached, cw: 0,
    r: Math.max(0, num(cum.reasoning_output_tokens) - num(base?.reasoning_output_tokens)),
  };
}

function codexIdFromPath(file = '') {
  return /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] || path.basename(file, '.jsonl');
}

function codexUserInputText(o) {
  if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
    return typeof o.payload.message === 'string' ? o.payload.message : '';
  }
  if (o.type !== 'response_item' || o.payload?.role !== 'user') return '';
  const content = o.payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && (p.type === 'input_text' || p.type === 'text') && typeof p.text === 'string' && !isHostContext(p.text))
    .map((p) => p.text).join('\n');
}

function codexAgentTitle(o) {
  if (o?.type !== 'session_meta') return '';
  const meta = o.payload || {};
  const spawn = meta.source?.subagent?.thread_spawn || {};
  const nickname = meta.agent_nickname || spawn.agent_nickname;
  const task = (meta.agent_path || spawn.agent_path || '').split('/').filter(Boolean).pop();
  return [task, nickname].filter(Boolean).join(' · ');
}

function codexDeltas(snaps, sid) {
  const records = [];
  let prev = { ct: 0, input: 0, o: 0, cr: 0, r: 0 };
  for (const snap of snaps) {
    // 新旧事件可能同时上报同一累计值；历史回声也不能再产生增量。
    if (snap.ct <= prev.ct) continue;
    const input = snap.i + snap.cr;
    const di = Math.max(0, input - prev.input);
    const cr = Math.min(di, Math.max(0, snap.cr - prev.cr));
    const rec = norm({ t: snap.t, m: snap.m, s: sid,
      i: di - cr, o: Math.max(0, snap.o - prev.o), cr, cw: 0, r: Math.max(0, snap.r - prev.r),
    });
    prev = { ct: snap.ct, input, o: snap.o, cr: snap.cr, r: snap.r };
    if (rec) records.push(rec);
  }
  return records;
}

function selectCodexSessions(perSession, snaps) {
  const groups = new Map();
  for (const snap of snaps) {
    if (!groups.has(snap.s)) groups.set(snap.s, []);
    groups.get(snap.s).push(snap);
  }
  for (const [sid, group] of groups) {
    const total = group.reduce((max, snap) => Math.max(max, snap.ct), 0);
    const current = perSession.get(sid);
    if (!current || total > current.total || (total === current.total && group.length > current.snaps.length)) {
      perSession.set(sid, { total, snaps: group });
    }
  }
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
/* Qoder：本地不落 token，改按消息文本估算                              */
/* ------------------------------------------------------------------ */

/**
 * 字符 → token 的粗估：CJK / 假名 / 韩文按一字一 token，其余按四字符一 token。
 * Qoder 使用的 qfmodel 词表不公开，该启发式与 Qoder 自己算 context_usage_ratio 时
 * 用的字符量同量级（本机实测二者 log-log 相关系数 0.94）。
 */
const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af\ufe30-\ufe4f\uff00-\uff6f]|[\u{20000}-\u{33fff}]/u;
function estTokens(s) {
  if (!s) return 0;
  let cjk = 0, other = 0;
  for (const ch of s) { if (CJK_RE.test(ch)) cjk += 1; else other += 1; }
  return cjk + Math.round(other / 4);
}

/** 把 Claude Code 风格的 content（字符串或部件数组）摊成纯文本 */
function flattenParts(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  let out = '';
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') { out += p + '\n'; continue; }
    if (p.type === 'text') out += (p.text || '') + '\n';
    else if (p.type === 'thinking') out += (p.thinking || p.text || '') + '\n';
    else if (p.type === 'tool_use') out += JSON.stringify(p.input || {}) + '\n';
    else if (p.type === 'tool_result') out += flattenParts(p.content) + '\n';
    else out += JSON.stringify(p) + '\n';
  }
  return out;
}

/** attachment 行形态多（skill_listing / hook_output / agent_listing_delta …），取正文后摊平 */
function attachmentText(a) {
  if (!a) return '';
  const parts = [a.content, a.output, a.text, a.prompt];
  const body = parts.filter((x) => typeof x === 'string' && x).join('\n');
  return body || flattenParts(a.addedLines || '') || JSON.stringify(a);
}

/**
 * Qoder CLI 会话行解析（`~/.qoder/projects/<项目>/<会话>.jsonl`，子代理在其 subagents/ 下）。
 * 格式是 Claude Code 事件流，但 `message.usage` 的四个 token 字段恒为 0：
 * Qoder 服务端只回 credits 与 context_usage_ratio，本地不落 token 数（App 侧也明确写
 * `tokenCountsAvailable:false`）。所以这里只能按文本估算：
 *   i = 本轮新增输入 + 之前累积的上下文（多轮会话每轮都要重发历史）
 *   o = 本轮 assistant 输出（thinking 一并计入，与各家口径一致）
 *   cr / cw 一律留 0 —— Qoder 未上报缓存，不虚构命中率
 * `context_usage_ratio` 相比上一轮回落视为发生过上下文压缩，按回落比例收缩累积值。
 */
function qoderLineHandler(o, st) {
  if (o.type === 'user' || o.type === 'attachment') {
    const text = o.type === 'user' ? flattenParts((o.message || {}).content) : attachmentText(o.attachment);
    st.pend = num(st.pend) + estTokens(text);
    return null;
  }
  if (o.type !== 'assistant') return null;
  const m = o.message || {};
  const u = m.usage;
  if (!u) return null; // 流式中间块（thinking / content_block_start）不带 usage
  const id = o.uuid || m.id;
  if (id) {
    if (!st.seen) st.seen = new Set();
    if (st.seen.has(id)) return null;
    st.seen.add(id);
  }
  const inc = num(st.pend); st.pend = 0;
  const out = estTokens(flattenParts(m.content));
  const ctx = num(st.ctx);
  const rec = norm({
    t: toMs(o.timestamp),
    m: modelStr(m.model) || modelStr(o.model) || 'unknown',
    i: ctx + inc, o: out, cr: 0, cw: 0, r: 0,
    s: o.sessionId || path.basename(st.file, '.jsonl'),
  });
  let next = ctx + inc + out;
  const ratio = num(u.context_usage_ratio);
  if (ratio > 0 && num(st.ratio) > ratio) next = Math.round(next * (ratio / num(st.ratio)));
  if (ratio > 0) st.ratio = ratio;
  st.ctx = next;
  return rec;
}

/**
 * Qoder 会话标题与 cwd。两个来源，都不产出用量记录（App 与 CLI 是同一批 session id，
 * 取用量会重复计数）：
 *   1. 桌面 App 的 main.sqlite 表 chat_sessions（有正经标题）
 *   2. 回退：CLI 会话文件里的首条用户输入与 cwd 字段
 */
async function qoderSessionMeta(stats) {
  const out = {};
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 版本过低 */ }
  if (DatabaseSync) {
    for (const root of QODER_APP_ROOTS) {
      const dbPath = path.join(root, 'main.sqlite');
      if (!isFile(dbPath)) continue;
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        stats.files += 1;
        try { stats.bytes += (await fsp.stat(dbPath)).size; } catch { /* 忽略 */ }
        for (const s of db.prepare('SELECT session_id, title, cwd, model FROM chat_sessions').all()) {
          if (s.session_id) out[s.session_id] = { title: s.title || '', cwd: s.cwd || '', model: s.model || '' };
        }
      } catch { /* App 未装或表结构不同 */ }
      finally { try { if (db) db.close(); } catch { /* 忽略 */ } }
    }
  }

  // 回退补充：从会话文件本身取 cwd 与首条用户输入当标题
  const files = await walk(path.join(QODER_CLI_HOME, 'projects'), (p, n) => n.endsWith('.jsonl'), 0, 3);
  const local = await sessionMetaFromFiles(files, {
    userTextOf: firstUserInputText,
    skip: (t) => t.startsWith('[QODER_LIVE_VOICE_CONTEXT]'),
  });
  for (const [sid, meta] of Object.entries(local)) {
    const prev = out[sid];
    if (!prev) { out[sid] = meta; continue; }
    if (!prev.title && meta.title) prev.title = meta.title;
    if (!prev.cwd && meta.cwd) prev.cwd = meta.cwd;
  }
  return out;
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
  // Qoder 的 qfmodel 不公开美元单价（按官方 credits 套餐计费），留空让用户自己按套餐折算
  'qfmodel': { input: null, output: null, cacheRead: null, cacheCreation: null },
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

  const agents = {};
  let claudeUsagePromise = null;
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
      const ctx = {
        stats,
        getClaudeUsage() {
          if (!claudeUsagePromise) claudeUsagePromise = scanClaudeUsage();
          return claudeUsagePromise;
        },
      };
      const r = await def.scan(ctx);
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

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  ...(!AUTH_TOKEN ? { 'Access-Control-Allow-Origin': '*' } : {}),
};

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

  if (AUTH_TOKEN && p.startsWith('/api/') && req.headers['x-token-viewer-auth'] !== AUTH_TOKEN) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

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
    mirage: [path.join(MIRAGE_HOME, 'agent-sessions'), path.join(MIRAGE_HOME, 'conversations')],
    pi: [path.join(HOME, '.pi', 'agent', 'sessions')],
    omp: [path.join(HOME, '.omp', 'agent', 'sessions')],
    'claude-code': [CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_ROOT, CLAUDE_STATS_FILE,
      ...CLAUDE_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'claude-code-sessions'), path.join(b, 'local-agent-mode-sessions')])],
    'claude-desktop': CLAUDE_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'local-agent-mode-sessions'), path.join(b, 'claude-code-sessions')]),
    codex: [path.join(HOME, '.codex', 'sessions'), path.join(HOME, '.codex', 'archived_sessions'), path.join(HOME, '.codex', 'session_index.jsonl')],
    zcode: [path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite'), path.join(HOME, '.zcode', 'cli', 'agents'), path.join(HOME, '.zcode', 'cli', 'rollout')],
    dsh: [...DSH_DESKTOP_ROOTS.flatMap((b) => [path.join(b, 'harness', 'sessions'), b]), path.join(DSH_CLI_HOME, 'sessions'), path.join(DSH_CLI_HOME, 'storages')],
    opencode: [...new Set([path.join(HOME, '.local', 'share', 'opencode'), ...dataCandidates('opencode')])].flatMap((d) => [path.join(d, 'opencode.db'), path.join(d, 'opencode-local.db')]),
    qoder: [path.join(QODER_CLI_HOME, 'projects'), ...QODER_APP_ROOTS.map((b) => path.join(b, 'main.sqlite'))],
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
  await fsp.mkdir(DATA_ROOT, { recursive: true });
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
    const port = server.address().port;
    if (process.send) process.send({ type: 'ready', port });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Token Viewer · 通用 Agent Token 用量查看器');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  地址: http://127.0.0.1:${port}`);
    console.log(`  数据目录: ${HOME}`);
    console.log('  正在后台扫描各 Agent 数据源…');
    console.log('  按 Ctrl+C 停止');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

// Electron 父进程关闭或崩溃后，专属扫描服务随之退出。
if (process.send) process.once('disconnect', () => { server.close(); process.exit(0); });

if (require.main === module) main().catch((e) => { console.error('启动失败:', e); process.exit(1); });

module.exports = { runScan, AGENT_DEFS, scanClaudeUsage, codexSnapshotHandler, codexDeltas, selectCodexSessions, codexUserInputText, codexAgentTitle, dedupeMirageRecords, sessionMetaFromFiles, codexTitles, piSidOf, piUserInputText, resolveDshHome, decodeZstdFrames, parseDshSession, dshHarnessSessions };
