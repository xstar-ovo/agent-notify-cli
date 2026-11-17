/**
 * 文件功能：标题/正文拼装、事件文案前缀、首句截断与覆盖规则的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { build, firstSentence } from "../../src/notify/templates.js";

test("event label prefixes the body", () => {
  assert.match(build({ event: "stop" }).body, /^任务完成/);
  assert.match(build({ event: "error" }).body, /^任务出错/);
  assert.match(build({ event: "notification" }).body, /^等待处理/);
  assert.equal(build({ event: "settled" }).body, build({ event: "stop" }).body);
});

test("title carries only the agent name", () => {
  assert.equal(build({ event: "settled", agent: "pi", cwd: "/home/u/my-project" }).title, "pi");
  assert.equal(build({ event: "settled" }).title, "agent");
  const long = "a".repeat(100);
  assert.equal(build({ event: "settled", agent: long }).title, long, "标题不再截断");
});

test("message is appended after the label, cut at the first sentence", () => {
  assert.equal(build({ event: "settled", message: "改了 3 个文件。剩下的不看" }).body, "任务完成 · 改了 3 个文件。");
  assert.equal(build({ event: "settled", message: "第一行\n第二行" }).body, "任务完成 · 第一行");
  assert.equal(build({ event: "settled", message: "Done. Tests pass." }).body, "任务完成 · Done.");
  assert.equal(build({ event: "settled", message: "   " }).body, "任务完成");
  assert.equal(build({ event: "settled" }).body, "任务完成");
});

test("firstSentence hard-truncates as fallback and collapses whitespace", () => {
  assert.equal(firstSentence("  a  b  c ", 200), "a b c");
  const long = "x".repeat(500);
  const cut = firstSentence(long, 50);
  assert.equal(cut.length, 50);
  assert.ok(cut.endsWith("…"));
});

test("firstSentence keeps the period and drops trailing sentences", () => {
  assert.equal(firstSentence("第一句。第二句。", 200), "第一句。");
  assert.equal(firstSentence("Done. Tests pass.", 200), "Done.");
});

test("firstSentence cuts at ellipsis, colons and closing quotes", () => {
  assert.equal(firstSentence("稍等…我看看后面", 200), "稍等…");
  assert.equal(firstSentence("稍等……我看看", 200), "稍等……");
  assert.equal(firstSentence("Done... Tests pass.", 200), "Done...");
  assert.equal(firstSentence("他说：“好。”然后走了", 200), "他说：“好。”");
  assert.equal(firstSentence("结果如下：后面还有", 200), "结果如下：");
  assert.equal(firstSentence("error: ENOENT", 200), "error:");
  // 半角冒号 / 句号后面不是空白时不截，避免切断路径、URL、版本号。
  assert.equal(firstSentence("路径 C:\\Users\\me", 200), "路径 C:\\Users\\me");
  assert.equal(firstSentence("见 http://a.b/c", 200), "见 http://a.b/c");
});

test("firstSentence strips markdown heading markers", () => {
  assert.equal(firstSentence("## 结论\n细节很多", 200), "结论");
  assert.equal(firstSentence("# 标题", 200), "标题");
  // 正文中间的 #（如 issue 号）不当边界。
  assert.equal(firstSentence("修复了 #123 的问题。", 200), "修复了 #123 的问题。");
});
