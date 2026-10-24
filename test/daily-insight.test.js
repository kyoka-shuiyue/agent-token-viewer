'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const helpers = html.split('// DAILY_INSIGHT_START')[1].split('// DAILY_INSIGHT_END')[0].replace(/^.*\r?\n/, '');
const context = vm.createContext({ Date, Map });
vm.runInContext(helpers + '\nthis.daily={dayKey,localDayStart,shiftCalendarDay,calendarRange,recordInPeriod,buildDailyInsight};', context);
const { dayKey, calendarRange, recordInPeriod, buildDailyInsight } = context.daily;
const at = text => new Date(text).getTime();
const rec = (time, total, extra = {}) => ({ t: at(time), i: total, o: 0, cr: 0, cw: 0, s: 'fixture', ...extra });
const agents = records => [{ id: 'fixture-agent', records }];

test('单文件页面脚本语法正确', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, script] of scripts) new vm.Script(script);
});

test('今日与昨天同期遵循本地日历，午夜前后和未来记录不会混入', () => {
  const now = at('2026-10-16T10:15:00');
  const range = calendarRange('today', now);
  assert.equal(range.from, at('2026-10-16T00:00:00'));
  assert.equal(range.to, now);
  const result = buildDailyInsight(agents([
    rec('2026-10-15T23:59:59', 800), rec('2026-10-15T09:00:00', 25),
    rec('2026-10-16T00:00:00', 100), rec('2026-10-16T10:15:00', 40), rec('2026-10-16T10:15:01', 900),
  ]), now);
  assert.equal(result.current, 140);
  assert.equal(result.previous, 25);
  assert.equal(result.days[6].tokens, 140);
  assert.equal(result.days[5].tokens, 825);
});

test('仅按日统计在上午仍计入今日总量，但不冒充精确到小时的同期数据', () => {
  const now = at('2026-10-16T09:00:00');
  const todayDaily = rec('2026-10-16T12:00:00', 700, { s: 'claude-stats' });
  const result = buildDailyInsight(agents([
    todayDaily, rec('2026-10-15T12:00:00', 400, { s: 'claude-stats' }),
    rec('2026-10-16T08:00:00', 100), rec('2026-10-15T08:00:00', 50),
  ]), now);
  assert.equal(recordInPeriod(todayDaily, calendarRange('today', now)), true);
  assert.equal(result.current, 100);
  assert.equal(result.previous, 50);
  assert.equal(result.days[6].tokens, 800);
  assert.equal(result.dailyOnly, true);
  assert.equal(recordInPeriod(todayDaily, { from: at('2026-10-17T00:00:00'), to: at('2026-10-17T23:59:59') }), false);
});

test('七个连续自然日补零，四类Token不重算推理或遗漏缓存，成本只按传入计价计算', () => {
  const result = buildDailyInsight(agents([
    rec('2026-10-10T10:00:00', 1),
    rec('2026-10-12T10:00:00', 100, { o: 20, cr: 300, cw: 40, r: 15, c: .42 }),
    rec('2026-10-16T08:00:00', 8),
  ]), at('2026-10-16T09:00:00'), r => r.c || 0);
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].key, '2026-10-10');
  assert.equal(result.days[6].key, '2026-10-16');
  assert.equal(result.days[1].tokens, 0);
  assert.equal(result.days[2].tokens, 460);
  assert.equal(result.days[2].cost, .42);
  assert.equal(result.days[6].cost, 0);
});

test('跨年、零基数和空数据有确定结果，不改变原始记录', () => {
  const records = Object.freeze([Object.freeze(rec('2025-12-31T08:00:00', 50)), Object.freeze(rec('2026-01-01T08:00:00', 100))]);
  const now = at('2026-01-01T09:00:00');
  const result = buildDailyInsight(agents(records), now);
  assert.equal(result.previous, 50);
  assert.equal(result.current, 100);
  assert.equal(dayKey(calendarRange('7d', now).from), '2025-12-26');
  const empty = buildDailyInsight([], now);
  assert.equal(empty.previous, 0);
  assert.equal(empty.current, 0);
  assert.ok(empty.days.every(d => d.tokens === 0 && d.cost === 0));
});

test('夏令时切换按自然日回溯，昨天同期保持本地时钟', () => {
  const output = execFileSync(process.execPath, ['-e', helpers + `
    const now = new Date('2026-03-08T15:00:00').getTime();
    const previous = shiftCalendarDay(now, -1);
    const range = calendarRange('today', now);
    console.log(JSON.stringify({hour:new Date(previous).getHours(), elapsed:(now-previous)/3600000, startHour:new Date(range.from).getHours(), day:dayKey(previous)}));
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { hour: 15, elapsed: 23, startHour: 0, day: '2026-03-07' });
});
