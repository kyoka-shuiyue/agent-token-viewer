'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AGENT_DEFS, codexSnapshotHandler, codexDeltas, selectCodexSessions, codexUserInputText, codexAgentTitle, dedupeMirageRecords, sessionMetaFromFiles, codexTitles, piSidOf, piUserInputText } = require('../server');
const time = '2026-10-01T00:00:00Z';

test('仅注册 Mirage 来源，不读取 Proma 路径', () => {
  assert.equal(AGENT_DEFS.some((a) => a.id === 'proma'), false);
  const mirage = AGENT_DEFS.find((a) => a.id === 'mirage');
  assert.ok(mirage);
  assert.ok(mirage.roots.every((r) => r.includes(`${path.sep}.mirage${path.sep}`)));
});

test('同一个 rollout 包含不同线程时分开选取，续接副本只取最大累计', () => {
  const sessions = new Map();
  selectCodexSessions(sessions, [{s:'a',ct:10}, {s:'b',ct:20}]);
  selectCodexSessions(sessions, [{s:'a',ct:5}]);
  assert.equal(sessions.size, 2);
  assert.equal([...sessions.values()].reduce((n,s) => n+s.total,0),30);
  assert.ok(sessions.get('a').snaps.every((s) => s.s === 'a'));
});

test('新版 Codex 用量识别线程累计值，兼容仅有 payload.id 的元信息', () => {
  const st = { file: 'rollout.jsonl', model: 'fixture' };
  codexSnapshotHandler({ type: 'session_meta', payload: { id: 'thread-a' } }, st);
  const snap = codexSnapshotHandler({ type: 'token_usage_record', timestamp: time, payload: {
    thread_id: 'thread-a', thread_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 },
    usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
  } }, st);
  assert.ok(snap);
  assert.equal(snap.s, 'thread-a');
  assert.equal(snap.ct, 120);
  assert.equal(snap.i + snap.o + snap.cr + snap.cw, 120);
});

test('新旧 Codex 快照与历史回声不重复，缓存占比变动不虚增输入', () => {
  const records = codexDeltas([
    { t: 1, m: 'fixture', ct: 110, i: 80, cr: 20, o: 10, r: 0 },
    { t: 1, m: 'fixture', ct: 110, i: 80, cr: 20, o: 10, r: 0 },
    { t: 2, m: 'fixture', ct: 165, i: 50, cr: 100, o: 15, r: 0 },
    { t: 3, m: 'fixture', ct: 110, i: 80, cr: 20, o: 10, r: 0 },
  ], 's1');
  assert.equal(records.length, 2);
  assert.equal(records.reduce((n, r) => n + r.i + r.o + r.cr + r.cw, 0), 165);
  assert.equal(records[1].cr, 50);
});

test('Codex 子线程使用真实 id，并排除边界之前复制的父线程用量', () => {
  const st = { file: 'child.jsonl' };
  codexSnapshotHandler({ type: 'session_meta', payload: { id: 'child', session_id: 'parent', subagent_history_start_ordinal: 20 } }, st);
  const event = (ordinal, input, output) => ({ type: 'event_msg', ordinal, timestamp: time, payload: {
    type: 'token_count', info: { total_token_usage: {input_tokens:input,output_tokens:output} },
  } });
  assert.equal(codexSnapshotHandler(event(10, 100, 20), st), null);
  const snap = codexSnapshotHandler(event(30, 150, 30), st);
  assert.equal(snap.s, 'child');
  assert.equal(snap.ct, 60);
});

test('Mirage 同源副本按请求去重，保留完整用量及新请求', () => {
  const one = { requestId: 'uuid1', s: 's1', t: 1, m: 'fixture', i: 10, o: 2, cr: 0, cw: 0 };
  const records = dedupeMirageRecords([one, { ...one }, { ...one, o: 5 }, { ...one, requestId: 'uuid2' }]);
  assert.equal(records.length, 2);
  assert.equal(records[0].o, 5);
  assert.equal(records.reduce((n, r) => n + r.i + r.o + r.cr + r.cw, 0), 27);
  assert.equal('requestId' in records[0], false);
});

test('标题位于长宿主上下文之后，追加及重命名后刷新缓存', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-meta-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const opts = { sidOf: piSidOf, userTextOf: piUserInputText };
  await fs.writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: '/project', context: 'x'.repeat(70000) }) + '\n');
  assert.equal((await sessionMetaFromFiles([file], opts)).s1.title, '');
  await fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: '修复 Token 识别' } }) + '\n');
  assert.equal((await sessionMetaFromFiles([file], opts)).s1.title, '修复 Token 识别');
  await fs.appendFile(file, JSON.stringify({ type: 'session_info', name: '新的对话名字' }) + '\n');
  assert.equal((await sessionMetaFromFiles([file], opts)).s1.title, '新的对话名字');
});

test('Codex 状态库补全索引缺失的标题，不依赖索引文件存在', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-titles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('s1', '数据库中的对话名字', '/project');
  db.close();
  assert.equal((await codexTitles(dir)).s1.title, '数据库中的对话名字');
});

test('Codex 无索引时可读取 user_message 与 input_text，标题不包含 JSON 元数据', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-codex-meta-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = ['event', 'response'].map((name) => path.join(dir, name + '.jsonl'));
  const events = [
    { type: 'event_msg', payload: { type: 'user_message', message: '整理对话标题' } },
    { type: 'response_item', payload: { role: 'user', content: [{type:'input_text',text:'优化 Token 查看器'}] } },
  ];
  for (const [i, file] of files.entries()) {
    await fs.writeFile(file, [
      {type:'session_meta', payload:{id:'s' + i}},
      {type:'response_item', payload:{role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\n' + 'x'.repeat(70000)}]}},
      events[i],
    ].map((o) => JSON.stringify(o)).join('\n'));
  }
  const sessions = await sessionMetaFromFiles(files, {
    sidOf: (f, o) => o.payload.id, userTextOf: codexUserInputText,
  });
  assert.equal(sessions.s0.title, '整理对话标题');
  assert.equal(sessions.s1.title, '优化 Token 查看器');
});

test('Codex 子 Agent 没有用户消息时显示任务与昵称，不把宿主上下文用作标题', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-subagent-meta-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'child.jsonl');
  const host = {type:'response_item', payload:{role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\n宿主上下文'}]}};
  await fs.writeFile(file, [
    {type:'session_meta',payload:{id:'child',agent_nickname:'Ada',agent_path:'/root/check_usage'}},
    host,
  ].map((o) => JSON.stringify(o)).join('\n'));
  const opts = {sidOf:(f,o)=>o.payload.id,userTextOf:codexUserInputText,fallbackTitleOf:codexAgentTitle};
  assert.equal((await sessionMetaFromFiles([file],opts)).child.title, 'check_usage · Ada');
  assert.equal(codexUserInputText(host), '');
  assert.equal(codexUserInputText({type:'response_item',payload:{role:'user',content:[...host.payload.content,{type:'input_text',text:'真正的用户输入'}]}}), '真正的用户输入');
  await fs.appendFile(file, '\n' + JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'继续核对用量'}}));
  assert.equal((await sessionMetaFromFiles([file],opts)).child.title, '继续核对用量');
});
