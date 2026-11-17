/**
 * 文件功能：标题/副标题/正文拼装、自定义标题与截断的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../src/notify/templates.js";

test("subtitle per event", () => {
  assert.match(build({ event: "stop" }).subtitle, /完成/);
  assert.match(build({ event: "error" }).subtitle, /出错/);
  assert.match(build({ event: "notification" }).subtitle, /等待/);
  assert.equal(build({ event: "settled" }).subtitle, build({ event: "stop" }).subtitle);
});

test("custom subtitle replaces the default, collapsed and capped at 60", () => {
  assert.equal(build({ event: "settled", title: "  fix\n\nblank title  " }).subtitle, "fix blank title");
  const long = build({ event: "settled", title: "x".repeat(100) }).subtitle;
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
  assert.equal(build({ event: "settled", title: "   " }).subtitle, build({ event: "settled" }).subtitle);
});

test("title carries agent and project directory", () => {
  assert.equal(build({ event: "settled", agent: "pi", cwd: "/home/u/my-project" }).title, "pi · my-project");
  assert.equal(build({ event: "settled" }).title, "agent");
});

test("body is just the message, truncated to 200", () => {
  assert.equal(build({ event: "settled", message: "改了 3 个文件" }).body, "改了 3 个文件");
  assert.equal(build({ event: "settled" }).body, "");
  const long = build({ event: "error", message: "x".repeat(500) }).body;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});
