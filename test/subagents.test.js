'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { foldSubagents, claudeSubagentId, ccLineHandler, codexSnapshotHandler } = require('../server.js');

const rec = (s, extra = {}) => ({ t: 1, m: 'm', i: 1, o: 1, cr: 0, cw: 0, r: 0, s, ...extra });

test('子会话沿 parent 并入根会话，并用 a 保留原会话 id', () => {
  const sessions = { root: { title: '主' }, child: { parent: 'root' }, grand: { parent: 'child' }, alone: { parent: 'gone' } };
  const records = foldSubagents([rec('root'), rec('child'), rec('grand'), rec('alone')], sessions);
  assert.deepEqual(records.map((r) => r.s), ['root', 'root', 'root', 'gone']);
  assert.deepEqual(records.map((r) => r.a), [undefined, 'child', 'grand', 'alone']);
});

test('已有子 Agent 标记不被覆盖，父子成环时不死循环', () => {
  const sessions = { a: { parent: 'b' }, b: { parent: 'a' }, main: {}, kid: { parent: 'main' } };
  const records = foldSubagents([rec('main', { a: 'agent-1' }), rec('kid', { a: 'agent-2' }), rec('a')], sessions);
  assert.equal(records[0].a, 'agent-1');
  assert.equal(records[1].s, 'main');
  assert.equal(records[1].a, 'agent-2');
  assert.ok(['a', 'b'].includes(records[2].s));
});

test('Claude 子 Agent 日志带 agent id，主会话日志没有', () => {
  const sid = '76dfc9fd-b315-4d62-9967-6b16add8d157';
  const sub = path.join('x', 'projects', 'p', sid, 'subagents', 'agent-a048e188.jsonl');
  const main = path.join('x', 'projects', 'p', sid + '.jsonl');
  assert.equal(claudeSubagentId(sub), 'agent-a048e188');
  assert.equal(claudeSubagentId(main), '');
  const line = { type: 'assistant', sessionId: sid, timestamp: '2026-11-01T00:00:00Z', message: { id: 'msg1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 4 } } };
  const fromSub = ccLineHandler(line, { file: sub });
  assert.equal(fromSub.a, 'agent-a048e188');
  assert.equal(fromSub.s, sid);
  assert.equal('a' in ccLineHandler(line, { file: main }), false);
});

test('Codex 子线程快照记录父线程与任务名，主线程不带', () => {
  const st = {};
  codexSnapshotHandler({ type: 'session_meta', payload: { id: 'kid', agent_nickname: 'Hypatia', source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/layout_inventory' } } } } }, st);
  const snap = codexSnapshotHandler({ type: 'event_msg', timestamp: '2026-11-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } } } }, st);
  assert.equal(snap.p, 'root');
  assert.equal(snap.at, 'layout_inventory · Hypatia');
  const plain = {};
  codexSnapshotHandler({ type: 'session_meta', payload: { id: 'root' } }, plain);
  const rootSnap = codexSnapshotHandler({ type: 'event_msg', timestamp: '2026-11-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } } }, plain);
  assert.equal('p' in rootSnap, false);
});
