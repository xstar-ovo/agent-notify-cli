/**
 * 文件功能：配置文件读取、默认生成与 Bark key 持久化的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBarkKeyInput, saveDeviceKey } from "../../src/config/loader.js";
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
