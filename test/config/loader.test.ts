/**
 * 文件功能：配置文件读取、默认生成与 Bark key 持久化的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseBarkKeyInput, saveDeviceKey } from "../../src/config/loader.js";
import { testBarkKey } from "../helpers/env.js";

const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), "an-cfg-")), "config.json");

test("writes the key into a fresh config file", () => {
  const file = tmp();
  const key = testBarkKey();
  saveDeviceKey(` ${key} `, file);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.bark.deviceKey, key);
  assert.equal(raw.bark.enabled, true);
  assert.ok(raw.delayMs.stop > 0);
});

test("replaces the {env:...} placeholder and keeps other settings", () => {
  const file = tmp();
  writeFileSync(file, JSON.stringify({ bark: { deviceKey: "{env:BARK_DEVICE_KEY}", level: "passive" }, timeoutMs: 1500 }));
  saveDeviceKey("newkey123", file);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.bark.deviceKey, "newkey123");
  assert.equal(raw.bark.level, "passive");
  assert.equal(raw.timeoutMs, 1500);
});

test("reports keys the current schema no longer reads, but keeps old values working", () => {
  const file = tmp();
  writeFileSync(
    file,
    JSON.stringify({
      bogus: 1,
      bark: { foo: true, deviceKey: "k" },
      delayMs: { stop: 60, stale: 5 },
      events: { stop: { bark: false, legacy: 1 } },
    }),
  );
  const { config, warnings } = loadConfig(file);
  assert.equal(config.delayMs.stop, 60, "没改名的旧字段照常生效");
  assert.equal(config.events.stop.bark, false, "第三层有效字段也要生效");
  const drift = warnings.find((w) => w.includes("unknown keys")) ?? "";
  assert.match(drift, /\bbogus\b/);
  assert.match(drift, /bark\.foo/);
  assert.match(drift, /delayMs\.stale/);
  assert.match(drift, /events\.stop\.legacy/, "嵌套三层的残留也要报");
  assert.ok(!drift.includes("delayMs.stop"), "有效字段不能报成残留");
  assert.ok(!drift.includes("events.stop.bark"), "有效字段不能报成残留");
});

test("refuses to clobber an unparsable config", () => {
  const file = tmp();
  writeFileSync(file, "{ not json");
  assert.throws(() => saveDeviceKey("k", file), /合法 JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("rejects empty or whitespace keys", () => {
  const file = tmp();
  assert.throws(() => saveDeviceKey("   ", file), /不能为空/);
  assert.throws(() => saveDeviceKey("a b", file), /不能为空/);
});

test("setup 粘贴输入：去掉空白/引号，整条 Bark URL 取路径里的 key", () => {
  assert.equal(parseBarkKeyInput("  abc123XYZ  "), "abc123XYZ");
  assert.equal(parseBarkKeyInput('"abc123XYZ"'), "abc123XYZ");
  assert.equal(parseBarkKeyInput("https://api.day.app/abc123XYZ"), "abc123XYZ");
  assert.equal(parseBarkKeyInput("https://bark.example.com:8080/abc123XYZ/"), "abc123XYZ");
  assert.equal(parseBarkKeyInput("   "), "");
});
