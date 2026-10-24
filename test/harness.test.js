'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { resolveDshHome, decodeZstdFrames, parseDshSession, dshHarnessSessions } = require('../server');
const header = (id, version = 4, extra = {}) => ({ type: 'session', id, version, ...extra });
const usage = (id, seq = 2, extra = {}) => ({ type: 'assistant/message', seq, time: 100, data: { message: { id, source: { model: 'fixture-model' } }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 2 }, ...extra } });
const jsonl = events => events.map(JSON.stringify).join('\n') + '\n';

test('Harness 官方桌面端与 CLI 共用 home，空覆盖与波浪号符合上游规则', () => {
  assert.equal(resolveDshHome('  '), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome('~/custom'), path.join(os.homedir(), 'custom'));
  assert.equal(resolveDshHome('~'), os.homedir());
});

test('跨 zstd 帧的 UTF-8 和 JSON 行保持完整，未写完的尾帧不影响已提交内容', () => {
  const bytes = Buffer.from(jsonl([header('会话'), usage('a')]));
  const cut = bytes.indexOf(Buffer.from('会话')) + 1;
  const frames = Buffer.concat([zlib.zstdCompressSync(bytes.subarray(0, cut)), zlib.zstdCompressSync(bytes.subarray(cut)), Buffer.from([0x28,0xb5,0x2f,0xfd,1])]);
  assert.equal(decodeZstdFrames(frames), bytes.toString());
  assert.equal(parseDshSession(decodeZstdFrames(frames), 'fallback').records.length, 1);
});

test('v4 正式用量含缓存写入、推理不重复累计，忽略流式回声与继承前缀', () => {
  const events = [header('child',4,{isSeeded:true}), usage('inherited'), {type:'session/end-seed',seq:3}, {type:'session/title',data:{title:'测试标题'}}, usage('new',4), {type:'assistant/chunk',data:{usage:{inputTokens:9999}}}, {type:'compaction/summary',seq:6,time:101,data:{compactionId:'c',model:'summary-model',usage:{inputTokens:5,outputTokens:2}}}];
  const parsed = parseDshSession(jsonl(events), 'folder');
  assert.equal(parsed.sid,'child'); assert.equal(parsed.meta.title,'测试标题');
  assert.equal(parsed.records.length,2);
  assert.equal(parsed.records[0].i+parsed.records[0].o+parsed.records[0].cr+parsed.records[0].cw,38);
  assert.equal(parsed.records[0].m,'fixture-model'); assert.equal(parsed.records[0].r,2);
  assert.equal(parseDshSession(jsonl([header('pending',4,{isSeeded:true}),usage('old')]),'folder').records.length,0);
  assert.equal(parseDshSession(jsonl([header('future',5),usage('new')]),'folder').unsupported,true);
});

test('扫描选择最新迁移代际，跨路径副本只计一次，保留旧 JSONL/gzip', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-fixture-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const a=path.join(dir,'official','project','session-a'), b=path.join(dir,'legacy','project','session-a'), c=path.join(dir,'official','project','session-c');
  await Promise.all([a,b,c].map(p=>fs.mkdir(p,{recursive:true})));
  await fs.writeFile(path.join(a,'session.jsonl'),jsonl([header('a',0),usage('old')]));
  await fs.writeFile(path.join(a,'session.v4.jsonl.zstd'),zlib.zstdCompressSync(Buffer.from(jsonl([header('a'),usage('new'),usage('new')]))));
  await fs.writeFile(path.join(a,'session.v4.jsonl.zstd.tmp'),Buffer.from('unfinished'));
  await fs.writeFile(path.join(b,'session.v3.jsonl'),jsonl([header('a',3),usage('new')]));
  await fs.writeFile(path.join(c,'session.jsonl.gz'),zlib.gzipSync(jsonl([header('c',0),usage('legacy',2,{usage:{inputTokens:2,cacheCreationTokens:4}})])));
  const stats={files:0,bytes:0};
  const parsed=await dshHarnessSessions(stats,[path.join(dir,'official'),path.join(dir,'legacy'),path.join(dir,'official')]);
  assert.equal(stats.files,3); assert.equal(parsed.records.length,2);
  assert.equal(parsed.records.reduce((sum,r)=>sum+r.i+r.o+r.cr+r.cw,0),44);
  assert.ok(parsed.records.every(r=>!('requestId' in r)));
});
