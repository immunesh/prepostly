import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import '../helpers.js';

describe('API cost metering', () => {
  let usage;
  let db;
  before(async () => {
    usage = await import('../../server/usage.js');
    db = await import('../../server/db.js');
  });

  test('Claude cost uses per-model prices, cache multipliers and the longest prefix', () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    assert.equal(usage.claudeCost('claude-opus-5-5', u), 24);
    assert.equal(usage.claudeCost('claude-opus-5', u), 30);
    assert.equal(usage.claudeCost('claude-sonnet-5-5', u), 12);
    assert.equal(usage.claudeCost('claude-haiku-4-5-20251001', u), 6);
    // 1M cache reads bill at 10% of input, 1M cache writes at 125%.
    assert.equal(usage.claudeCost('claude-opus-5-5', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }), 0.4);
    assert.equal(usage.claudeCost('claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }), 5);
  });

  test('Haiku 5.5 switches to the long-context rate above 100K prompt tokens', () => {
    const short = usage.claudeCost('claude-haiku-5-5', { input: 100_000, output: 1000, cacheRead: 0, cacheWrite: 0 });
    const long = usage.claudeCost('claude-haiku-5-5', { input: 100_001, output: 1000, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(short - (100_000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
    assert.ok(Math.abs(long - (100_001 * 0.5 + 1000 * 2.5) / 1e6) < 1e-12);
  });

  test('HeyGen and OpenAI image costs', () => {
    assert.equal(usage.heygenCost(90), 1.5);
    assert.equal(usage.openaiImageCost({ input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }), (100 * 5 + 1000 * 40) / 1e6);
    assert.equal(usage.openaiImageCost(null), 0.25);
  });

  test('logged calls carry the meter of the job that made them', async () => {
    await usage.withMeter({ userId: 'u-meter', brandId: 'b-meter', job: 'generate:quote', ref: 'p1' }, async () => {
      await Promise.resolve();
      usage.logApiUsage({ provider: 'anthropic', model: 'claude-opus-5-5', feature: 'write_post', input: 10, output: 20, cost: 0.5 });
    });
    usage.logApiUsage({ provider: 'heygen', feature: 'avatar_video', cost: 1 }); // no meter: still recorded
    const rows = db.all('SELECT * FROM api_usage ORDER BY created_at');
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].user_id, rows[0].brand_id, rows[0].job, rows[0].ref, rows[0].input_tokens, rows[0].cost_usd], ['u-meter', 'b-meter', 'generate:quote', 'p1', 10, 0.5]);
    assert.equal(rows[1].user_id, null);
  });
});
