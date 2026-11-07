'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migratePricing, DEFAULT_PRICING } = require('../server.js');

const legacy = (input, output, cacheRead, cacheCreation) => ({ input, output, cacheRead, cacheCreation });

test('内置价目含 Claude 5.5 家族与近两个月新模型，字段完整', () => {
  assert.deepEqual(DEFAULT_PRICING['claude-opus-5-5'], legacy(4, 20, 0.2, 5));
  assert.deepEqual(DEFAULT_PRICING['claude-sonnet-5-5'], legacy(2, 10, 0.1, 2.5));
  assert.deepEqual(DEFAULT_PRICING['claude-haiku-5-5'], legacy(0.1, 0.5, 0.01, 0.125));
  assert.deepEqual(DEFAULT_PRICING['claude-fable-5-1'], legacy(10, 50, 0.25, 12.5));
  for (const id of ['gpt-6.1-sol', 'gpt-6-luna', 'gemini-4-argon', 'grok-4.7', 'kimi-k3.1-pro', 'glm-5.3', 'deepseek-v4-pro', 'minimax-m3.1-flash']) {
    assert.ok(DEFAULT_PRICING[id], id);
  }
  for (const [id, p] of Object.entries(DEFAULT_PRICING)) {
    assert.deepEqual(Object.keys(p).sort(), ['cacheCreation', 'cacheRead', 'input', 'output'], id);
    for (const v of Object.values(p)) assert.ok(v === null || (Number.isFinite(v) && v >= 0), id);
  }
});

test('升级旧配置：未改动的旧默认换新价，用户改过的保留，缺失的新模型补入', () => {
  const current = {
    'claude-opus-5': legacy(15, 75, 1.5, 18.75),
    'claude-haiku-4-5': legacy(2, 5, 0.1, 1.25),
    'claude-sonnet-3.5': legacy(3, 15, 0.3, 3.75),
    'my-private-model': legacy(1, 2, null, null),
  };
  const { pricing, changed } = migratePricing(current);
  assert.deepEqual(pricing['claude-opus-5'], legacy(5, 25, 0.5, 6.25));
  assert.deepEqual(pricing['claude-haiku-4-5'], legacy(2, 5, 0.1, 1.25));
  assert.deepEqual(pricing['my-private-model'], legacy(1, 2, null, null));
  assert.equal(pricing['claude-sonnet-3.5'], undefined);
  assert.deepEqual(pricing['claude-opus-5-5'], legacy(4, 20, 0.2, 5));
  assert.ok(changed.added.includes('gpt-6.1-sol') && changed.updated.includes('claude-opus-5') && changed.removed.includes('claude-sonnet-3.5'));
  assert.deepEqual(current['claude-opus-5'], legacy(15, 75, 1.5, 18.75), '不修改入参');
});
