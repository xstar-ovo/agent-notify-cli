/**
 * 文件功能：配置归一化、默认值与延迟截断规则的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, clamp, DEFAULT_DELAY_MS, MAX_DELAY_MS, MAX_DELAY_CEILING_MS } from "../../src/config/schema.js";
import { resolveEnv } from "../../src/config/loader.js";

test("defaults fill in documented delays and max", () => {
  const c = normalize({});
  assert.equal(c.delayMs.stop, DEFAULT_DELAY_MS.stop);
  assert.equal(c.delayMs.notification, 0);
  assert.equal(c.delayMs.max, MAX_DELAY_MS);
  assert.equal(c.timeoutMs, 3000);
  assert.equal(c.bark.enabled, true);
});

test("per-event delay is clamped to [0, max]", () => {
  const c = normalize({ delayMs: { stop: -5, error: 999_999, max: 60_000 } });
  assert.equal(c.delayMs.stop, 0);
  assert.equal(c.delayMs.error, 60_000);
  assert.equal(c.delayMs.settled, 60_000); // 默认 3 分钟超过 max，会被截断
});

test("delay max itself is capped", () => {
  assert.equal(normalize({ delayMs: { max: 9_999_999 } }).delayMs.max, MAX_DELAY_CEILING_MS);
  assert.equal(clamp(-1, 0, 10), 0);
});

test("events can be disabled per channel", () => {
  const c = normalize({ events: { stop: { bark: false } } });
  assert.equal(c.events.stop.bark, false);
  assert.equal(c.events.error.bark, true);
});

test("missing device key is reported", () => {
  const warnings: string[] = [];
  normalize({ bark: { enabled: true } }, warnings);
  assert.deepEqual(warnings, ["bark deviceKey unresolved"]);
});

test("env placeholders resolve recursively", () => {
  process.env.AN_TEST_KEY = "abc";
  assert.deepEqual(resolveEnv({ a: "{env:AN_TEST_KEY}", b: ["{env:NOPE_X}"] }), { a: "abc", b: [undefined] });
});
