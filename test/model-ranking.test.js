'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const section = name => html.split(`/* ${name}_START */`)[1].split(`/* ${name}_END */`)[0];
const context = vm.createContext({DAY:86400000});
const daily = html.split('// DAILY_INSIGHT_START')[1].split('// DAILY_INSIGHT_END')[0].replace(/^.*\r?\n/, '');
vm.runInContext(daily+'\n'+section('MODEL_RANKING'),context);
const rec=(m,i,t=100)=>({m,i,o:2,cr:3,cw:4,r:99,t});

test('跨 Agent 模型排名聚合同名模型、保留原始模型标识和来源，推理不重复计入',()=>{
  const rows=context.buildModelRanking([{id:'a',records:[rec('shared',10),rec('channel/shared',1)]},{id:'b',records:[rec('shared',20),rec('other',30)]}],{from:0,to:200});
  assert.equal(rows[0].name,'shared'); assert.equal(rows[0].value,48);
  assert.equal(rows[0].calls,2); assert.equal(rows[0].agents.get('a'),19); assert.equal(rows[0].agents.get('b'),29);
  assert.equal(rows.reduce((s,r)=>s+r.value,0),97); assert.equal(rows.length,3);
});
test('模型排名跟随时间边界，空数据不伪造排名，等量时稳定排序',()=>{
  const agents=[{id:'a',records:[rec('z',1,99),rec('b',2,100),rec('a',2,101),rec('outside',100,200)]}];
  const rows=context.buildModelRanking(agents,{from:100,to:199});
  assert.equal(rows.map(r=>r.name).join(','),'a,b');
  assert.equal(context.buildModelRanking(agents,{from:201,to:300}).length,0);
});
