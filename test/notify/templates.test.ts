/**
 * 文件功能：标题/正文拼装、自定义任务名与截断的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../src/notify/templates.js";

test("title per event", () => {
  assert.match(build({ event: "stop" }).title, /完成/);
  assert.match(build({ event: "error" }).title, /出错/);
  assert.match(build({ event: "notification" }).title, /等待/);
  assert.equal(build({ event: "settled" }).title, build({ event: "stop" }).title);
});

test("custom title (task name) replaces the default, collapsed and capped at 60", () => {
  assert.equal(build({ event: "settled", title: "  fix\n\nblank title  " }).title, "fix blank title");
  const long = build({ event: "settled", title: "x".repeat(100) }).title;
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
  assert.equal(build({ event: "settled", title: "   " }).title, build({ event: "settled" }).title);
});

test("body carries agent, project, short session and message", () => {
  const { body } = build({
    event: "stop",
    agent: "pi",
    cwd: "/home/u/proj",
    session: "pi:1234567890abcdef",
    message: "done",
  });
  assert.equal(body, "pi · proj #pi:1234567\ndone");
});

test("body is truncated to 200 chars", () => {
  const { body } = build({ event: "error", message: "x".repeat(500) });
  assert.equal(body.length, 200);
  assert.ok(body.endsWith("…"));
});
