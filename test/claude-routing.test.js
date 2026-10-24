'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanClaudeUsage } = require('../server');

const stamp = '2026-10-01T12:00:00.000Z';
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});
const tokens = (record) => record.i + record.o + record.cr + record.cw;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-routing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    projectsRoot: path.join(dir, 'projects'),
    statsFile: path.join(dir, 'stats-cache.json'),
    desktopRoots: [],
  };
}

async function putJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value) + '\n');
}

async function putJsonl(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

function message(sessionId, id, model, input, output, cacheRead = 0, cacheWrite = 0, timestamp = stamp) {
  return {
    type: 'assistant', sessionId, timestamp, uuid: `uuid-${id}`,
    message: { id, model, usage: usage(input, output, cacheRead, cacheWrite) },
  };
}

function claimPath(root, kind, folder, localId) {
  return path.join(root, kind, folder, `${localId}.json`);
}

async function putClaim(root, kind, folder, localId, cliSessionId, title = '合成会话') {
  await putJson(claimPath(root, kind, folder, localId), {
    sessionId: localId,
    ...(cliSessionId ? { cliSessionId } : {}),
    title,
  });
}

async function putLedger(root, folder, rows, fileName = 'x.ndjson') {
  const file = path.join(root, 'local-agent-mode-sessions', folder, 'usage-ledger', fileName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function ledgerRow(sessionId, surface, model, input, output, cacheRead = 0, cacheWrite = 0, ts = stamp, cost = 0) {
  return {
    v: 1, sessionId, ts, surface,
    models: {
      [model]: {
        inputTokens: input, outputTokens: output,
        cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        cost: { usd: cost },
      },
    },
  };
}

async function scan(options) {
  assert.equal(typeof scanClaudeUsage, 'function', 'server.js 应导出 scanClaudeUsage');
  return scanClaudeUsage(options, { files: 0, bytes: 0, reused: 0, parsed: 0 });
}

function total(records, predicate = () => true) {
  return records.filter(predicate).reduce((sum, record) => sum + tokens(record), 0);
}

function fields(records, predicate = () => true) {
  return records.filter(predicate).reduce((sum, record) => ({
    i: sum.i + record.i,
    o: sum.o + record.o,
    cr: sum.cr + record.cr,
    cw: sum.cw + record.cw,
  }), { i: 0, o: 0, cr: 0, cw: 0 });
}

test('桌面 Code 与 CLI 请求都归入 Claude Code，并按声明关联 canonical session', async (t) => {
  const f = await fixture(t);
  const desktop = path.join(f.dir, 'desktop');
  f.desktopRoots.push(desktop);
  await putClaim(desktop, 'claude-code-sessions', 'profile-a', 'local_x', 'cli-x');
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'cli-x.jsonl'), [
    message('cli-x', 'cli-request', 'fixture-model', 10, 2, 3, 1),
  ]);
  await putJsonl(path.join(desktop, 'claude-code-sessions', 'profile-a', '.claude', 'projects', 'project-a', 'cli-x.jsonl'), [
    message('cli-x', 'desktop-request', 'fixture-model', 20, 4, 6, 2),
  ]);

  const result = await scan(f);
  assert.equal(total(result.code.records, (record) => record.s === 'cli-x'), 48);
  assert.equal(total(result.desktop.records), 0);
});

test('Code 与 Cowork 台账按 surface 分流；canonical session 的整桶覆盖不相加', async (t) => {
  const f = await fixture(t);
  const desktop = path.join(f.dir, 'desktop');
  f.desktopRoots.push(desktop);
  await putClaim(desktop, 'claude-code-sessions', 'code', 'local_x', 'cli-x');
  await putClaim(desktop, 'claude-code-sessions', 'code', 'local_p', 'cli-p');
  await putClaim(desktop, 'local-agent-mode-sessions', 'cowork', 'local_y', null);
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'cli-x.jsonl'), [
    message('cli-x', 'small-raw', 'fixture-model', 7, 3),
  ]);
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'cli-p.jsonl'), [
    message('cli-p', 'larger-raw', 'fixture-model', 20, 5, 4, 1),
  ]);
  await putLedger(desktop, 'ledger', [
    ledgerRow('local_x', 'code', 'fixture-model', 20, 10, 5, 5),
    ledgerRow('local_p', 'code', 'fixture-model', 10, 2),
    ledgerRow('local_y', 'cowork', 'fixture-model', 3, 2, 1, 1, stamp, 0.004),
  ]);

  const result = await scan(f);
  assert.equal(total(result.code.records, (record) => record.s === 'cli-x'), 40);
  assert.equal(total(result.code.records, (record) => record.s === 'cli-p'), 30);
  assert.equal(total(result.desktop.records, (record) => record.s === 'local_y'), 7);
});

test('相同 message.id 的流式副本只保留最大完整 usage', async (t) => {
  const f = await fixture(t);
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'cli-x.jsonl'), [
    message('cli-x', 'shared-message', 'fixture-model', 4, 1, 1, 0),
  ]);
  await putJsonl(path.join(f.projectsRoot, 'project-b', 'copied-session.jsonl'), [
    message('cli-x', 'shared-message', 'fixture-model', 12, 3, 8, 5),
  ]);

  const result = await scan(f);
  const sameRequest = (record) => record.s === 'cli-x' && record.m === 'fixture-model';
  assert.deepEqual(fields(result.code.records, sameRequest), { i: 12, o: 3, cr: 8, cw: 5 });
});

test('同源目录副本中的 JSONL 请求与台账行各只计一次', async (t) => {
  const f = await fixture(t);
  const roots = [path.join(f.dir, 'desktop-a'), path.join(f.dir, 'desktop-b')];
  f.desktopRoots.push(...roots);
  const row = ledgerRow('local-y', 'cowork', 'ledger-model', 4, 2, 1, 1, stamp, 0.006);
  for (const [index, desktop] of roots.entries()) {
    await putClaim(desktop, 'claude-code-sessions', 'profile', 'local_x', 'cli-x');
    await putClaim(desktop, 'local-agent-mode-sessions', 'profile', 'local_y', null);
    await putJsonl(path.join(desktop, 'claude-code-sessions', 'profile', '.claude', 'projects', 'project-a', 'cli-x.jsonl'), [
      message('cli-x', 'copied-request', 'copy-model', 8, 2, 1, 1),
    ]);
    await putLedger(desktop, `profile-${index}`, [row], `copy-${index}.ndjson`);
  }

  const result = await scan(f);
  assert.equal(total(result.code.records, (record) => record.s === 'cli-x' && record.m === 'copy-model'), 12);
  assert.equal(total(result.desktop.records, (record) => record.s === 'local-y' && record.m === 'ledger-model'), 8);
});

test('Cowork 声明的共享 projects 请求归入 Desktop，且不再重复计入 Code', async (t) => {
  const f = await fixture(t);
  const desktop = path.join(f.dir, 'desktop');
  f.desktopRoots.push(desktop);
  await putClaim(desktop, 'local-agent-mode-sessions', 'profile', 'local_y', 'shared-cli');
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'shared-cli.jsonl'), [
    message('shared-cli', 'cowork-shared-request', 'shared-model', 15, 5, 4, 2),
  ]);

  const result = await scan(f);
  assert.equal(total(result.code.records, (record) => record.m === 'shared-model'), 0);
  assert.equal(total(result.desktop.records, (record) => record.s === 'shared-cli'), 26);
});

test('日缓存按 day 与 model 补剩余量，保留同日新模型并守恒拆分四类 token', async (t) => {
  const f = await fixture(t);
  await putJson(f.statsFile, {
    modelUsage: {
      'covered-model': { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 40 },
      'cache-only-model': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    },
    dailyModelTokens: [{ date: '2026-10-01', tokensByModel: { 'covered-model': 100, 'cache-only-model': 40 } }],
  });
  await putJsonl(path.join(f.projectsRoot, 'project-a', 'cli-x.jsonl'), [
    message('cli-x', 'known-covered', 'covered-model', 10, 2, 4, 4),
    message('cli-x', 'same-day-new-model', 'same-day-new-model', 4, 3),
  ]);

  const result = await scan(f);
  const cached = result.code.records.filter((record) => record.s === 'claude-stats');
  assert.equal(total(result.code.records, (record) => record.m === 'same-day-new-model'), 7);
  assert.deepEqual(fields(cached, (record) => record.m === 'covered-model'), { i: 24, o: 8, cr: 16, cw: 32 });
  assert.deepEqual(fields(cached, (record) => record.m === 'cache-only-model'), { i: 4, o: 8, cr: 12, cw: 16 });
  assert.equal(total(cached), 120);
});

test('扫描不改写任何合成声明、JSONL、台账或 stats-cache fixture', async (t) => {
  const f = await fixture(t);
  const desktop = path.join(f.dir, 'desktop');
  f.desktopRoots.push(desktop);
  const declaration = claimPath(desktop, 'local-agent-mode-sessions', 'profile', 'local_y');
  const transcript = path.join(f.projectsRoot, 'project-a', 'cli-y.jsonl');
  const ledger = path.join(desktop, 'local-agent-mode-sessions', 'profile', 'usage-ledger', 'x.ndjson');
  await putClaim(desktop, 'local-agent-mode-sessions', 'profile', 'local_y', 'cli-y');
  await putJsonl(transcript, [message('cli-y', 'read-only-request', 'fixture-model', 5, 2)]);
  await putLedger(desktop, 'profile', [ledgerRow('local_y', 'cowork', 'ledger-model', 3, 1)]);
  await putJson(f.statsFile, { modelUsage: {}, dailyModelTokens: [] });
  const files = [declaration, transcript, ledger, f.statsFile];
  const hash = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = await Promise.all(files.map(hash));

  await scan(f);

  assert.deepEqual(await Promise.all(files.map(hash)), before);
});
