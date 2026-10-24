'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {fork} = require('node:child_process');
const {once} = require('node:events');

async function start(home, dataDir) {
  const child = fork(path.resolve(__dirname,'../server.js'), [], {
    env:{...process.env, USERPROFILE:home, HOME:home, APPDATA:path.join(home,'roaming'), LOCALAPPDATA:path.join(home,'local'),
      TOKEN_VIEWER_DATA_DIR:dataDir, TOKEN_VIEWER_PORT:'0', TOKEN_VIEWER_AUTH_TOKEN:'fixture-secret'},
    stdio:['ignore','ignore','pipe','ipc'], windowsHide:true,
  });
  let errors = '';
  child.stderr.on('data',(chunk)=>{errors+=chunk;});
  const ready = await new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>{child.kill();reject(new Error('后台启动超时'));},10000);
    child.once('error',(error)=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code)=>{clearTimeout(timer);reject(new Error(`后台退出 ${code}: ${errors}`));});
    child.on('message',(msg)=>{if(msg?.type==='ready'){clearTimeout(timer);resolve(msg);}});
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  const get = (route, options={}) => fetch(origin+route,{...options,headers:{'X-Token-Viewer-Auth':'fixture-secret',...options.headers}});
  for (let i=0;i<100;i++) {
    const status = await (await get('/api/status')).json();
    if(status.phase==='ready') return {child,origin,get,port:ready.port};
    assert.notEqual(status.phase,'error');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  child.kill();
  throw new Error('扫描未完成');
}

async function disconnect(child) {
  if(child.exitCode!==null) return;
  const exit = once(child,'exit');
  child.disconnect();
  await Promise.race([exit,new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('父进程断开后后台未退出'));},3000);
    exit.then(()=>{clearTimeout(timer);resolve();});
  })]);
}

test('桌面后台随机端口、API 隔离、独立目录保存计价，重启后仍生效且断开后退出', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'token-desktop-'));
  const home=path.join(dir,'home');
  const dataDir=path.join(dir,'profile');
  const sessions=path.join(home,'.pi/agent/sessions');
  await fs.mkdir(sessions,{recursive:true});
  await fs.writeFile(path.join(sessions,'fixture.jsonl'),[
    {type:'session',id:'s1'},
    {type:'message',message:{role:'user',content:'桌面测试会话'}},
    {type:'message',timestamp:'2026-10-01T00:00:00Z',message:{role:'assistant',model:'fixture-model',usage:{input:100,output:25}}},
  ].map(o=>JSON.stringify(o)).join('\n'));
  const running=[];
  t.after(async()=>{for(const c of running)if(c.exitCode===null)c.kill();await fs.rm(dir,{recursive:true,force:true});});
  const first=await start(home,dataDir); running.push(first.child);
  assert.ok(first.port>0);
  assert.equal((await fetch(first.origin+'/api/data')).status,401);
  assert.equal((await fetch(first.origin+'/api/pricing',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const html=await (await fetch(first.origin)).text();
  assert.ok(html.includes('renderDetail'));
  const data=await(await first.get('/api/data')).json();
  assert.equal(data.agents.pi.records.length,1);
  assert.equal(data.agents.pi.records[0].i,100);
  assert.equal(data.agents.pi.sessions.s1.title,'桌面测试会话');
  const pricing={'fixture-model':{input:1.25,output:2.5,cacheRead:0,cacheCreation:0}};
  assert.equal((await first.get('/api/pricing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pricing)})).status,200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir,'pricing-config.json'),'utf8')),pricing);
  assert.ok((await fs.stat(path.join(dataDir,'.scan-cache.json'))).size>0);
  await disconnect(first.child);
  const second=await start(home,dataDir);running.push(second.child);
  assert.deepEqual(await(await second.get('/api/pricing')).json(),pricing);
  await disconnect(second.child);
});
