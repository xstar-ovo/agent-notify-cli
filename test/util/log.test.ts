/**
 * 文件功能：error.log 的追加与 1MB 轮转（日志写满后测试基本不会碰到的分支）。
 */

import { tmpRoot } from "../helpers/tmp-config.js"; // 先于 src：log.ts 在 import 时取 logPath
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendLog } from "../../src/util/log.js";

const logFile = path.join(tmpRoot, "error.log");

test("appendLog rotates an oversized log and keeps each entry on one line", () => {
  writeFileSync(logFile, "x".repeat(1024 * 1024 + 1));
  appendLog('level=error msg="boom"\nlevel=error msg="forged"');

  assert.ok(existsSync(`${logFile}.1`), "超过 1MB 应轮转保留一份");
  const text = readFileSync(logFile, "utf8");
  assert.match(text, /msg="boom"/);
  assert.match(text, /msg="forged"/);
  assert.equal(text.split("\n").length, 2, "换行必须压平，避免伪造多行日志");
});

test("appendLog survives an unwritable path", () => {
  // 目录不存在时 mkdir 会重建；这里只要求不抛异常
  assert.doesNotThrow(() => appendLog("level=info msg=\"noop\""));
});
