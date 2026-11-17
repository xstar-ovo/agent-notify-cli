/**
 * 文件功能：Pi 扩展生成内容的测试（运行方式、事件接线、失败与摘要、手动取消）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { piExtensionContent } from "../../src/setup/pi.js";

/** 取出某个事件的处理器源码（到下一个 pi.on 为止），用来断言它真的干了活。 */
function handlerOf(src: string, event: string): string {
  const start = src.indexOf(`pi.on("${event}"`);
  assert.ok(start >= 0, `未注册 ${event}`);
  const next = src.indexOf("pi.on(", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

test("pi extension calls node + absolute cli.js, never the shell/cmd shim", () => {
  const src = piExtensionContent();
  assert.match(src, /const CLI = "[^"]*cli\.js";/);
  assert.match(src, /spawn\(process\.execPath, \[CLI, "--agent", "pi", \.\.\.args\]/);
  assert.ok(!src.includes("shell:"), "no shell:true (DEP0190 + cmd window)");
  assert.ok(!src.includes('spawn("agent-notify"'), "no .cmd shim spawn");
  assert.ok(!src.includes("__CLI__"), "placeholder replaced");
});

test("pi extension wires cancel, icon and event-based titles", () => {
  const src = piExtensionContent();
  assert.match(src, /pi\.on\("agent_start"/);
  assert.match(src, /pi\.on\("agent_settled"/);
  assert.match(handlerOf(src, "agent_settled"), /--icon", ICON/);
  assert.ok(!src.includes("--title"), "不再支持标题覆盖");
});

test("pi extension cancels on user activity and notifies on waiting-for-user", () => {
  const src = piExtensionContent();
  // 任务重新开始 / 用户敲字 / 退出、切会话、重载 都撤销待发的完成通知
  for (const event of ["agent_start", "input", "session_shutdown"]) {
    assert.match(handlerOf(src, event), /cancelAll\(\)/, `${event} 应撤销待发通知`);
  }
  // 完成通知和 :wait 通知是两个 key，取消时都要删
  const body = src.slice(src.indexOf("function cancelAll"), src.indexOf("export default"));
  assert.ok(body.includes('"cancel", "--session", KEY'), "cancelAll 取消完成通知");
  assert.ok(body.includes('"cancel", "--session", `${KEY}:wait`'), "cancelAll 取消 :wait 通知");
  // 等用户操作时立即推送，且用独立的 :wait key，避免 cancel 误删完成通知
  const wait = handlerOf(src, "ui_prompt_start");
  assert.ok(wait.includes('"notify", "notification"'), "等操作时立即推 notification");
  assert.ok(wait.includes("`${KEY}:wait`"), "等操作通知用独立的 :wait key");
  assert.match(handlerOf(src, "ui_prompt_end"), /"cancel", "--session", `\$\{KEY\}:wait`/);
});

test("pi extension throttles repeated waiting-for-user prompts", () => {
  const wait = handlerOf(piExtensionContent(), "ui_prompt_start");
  assert.match(wait, /lastWaitAt/, "同一分钟内连弹多个确认框只提醒一次");
});

test("pi extension reports failures instead of reporting a finished task", () => {
  const src = piExtensionContent();
  // 只有 agent_before_settle 带 outcome（completed / aborted / error）
  assert.match(handlerOf(src, "agent_before_settle"), /outcome\s*=\s*event\?\.outcome/);
  assert.match(handlerOf(src, "agent_settled"), /outcome === "error"/);
  // 新 run 重置，否则上一轮的 error 会漏到这一轮
  assert.match(handlerOf(src, "agent_start"), /outcome = "completed"/);
});

test("pi extension stays quiet when the user aborted the run themselves", () => {
  assert.match(handlerOf(piExtensionContent(), "agent_settled"), /event\?\.aborted\) return/);
});

test("pi extension adds duration and a reply summary to the body", () => {
  const src = piExtensionContent();
  assert.match(handlerOf(src, "agent_end"), /role === "assistant"/);
  assert.match(handlerOf(src, "agent_end"), /summary = text/);
  const settled = handlerOf(src, "agent_settled");
  assert.ok(settled.includes("用时"), "正文带耗时");
  assert.ok(settled.includes('args.push("--message", message)'), "耗时和摘要合成一条 --message");
});

test("pi extension survives a moved or unbuilt cli path", () => {
  const src = piExtensionContent();
  assert.match(src, /if \(!existsSync\(CLI\)\) return report\(/, "路径不存在要说出来");
  assert.match(src, /child\.on\("error", \(err: any\) => report\(/, "spawn 失败要留痕");
  assert.match(src, /appendFileSync\(LOG/, "错误写进 extension-error.log");
  assert.match(src, /if \(reported\) return/, "只提示一次，避免刷屏");
});

test("pi extension keys notifications by session id, not by pid", () => {
  const src = piExtensionContent();
  assert.match(src, /getSessionId/, "用会话 id 做 key，崩溃残留才能被下个会话撤销");
  assert.match(src, /if \(id && KEY === `pi:\$\{process\.pid\}`\) KEY = `pi:\$\{id\}`/, "拿到 id 后替换 pid 兜底");
});

test("pi extension shows a countdown for the pending notification", () => {
  const src = piExtensionContent();
  const settled = handlerOf(src, "agent_settled");
  assert.ok(settled.includes("countdown(Date.now() + delay)"), "入队后开始倒计时");
  assert.match(settled, /if \(delay > 0\)/, "延迟为 0 时不倒计时");
  assert.match(src, /ui\?\.setStatus\?\.\("agent-notify", `通知/, "底部状态栏显示剩余时间");
  assert.match(src, /if \(ticker\) clearInterval\(ticker\)/, "倒计时可停止");
  // 取消的每条路都要同时抹掉状态栏，否则撤销了还在倒数
  const body = src.slice(src.indexOf("function cancelAll"), src.indexOf("function fmt"));
  assert.match(body, /clearCountdown\(\)/, "cancelAll 清掉倒计时");
  assert.match(handlerOf(src, "ui_prompt_start"), /clearCountdown\(\)/, "立即推送时不再倒计时");
});

test("pi extension uses the same delay defaults and caps as the cli", () => {
  const src = piExtensionContent();
  assert.match(src, /const DEFAULT_DELAYS = /);
  assert.match(src, /const MAX_DELAY = /);
  assert.match(src, /const CEILING = /);
  assert.match(src, /DEFAULT_DELAYS\[event\]/);
  assert.match(src, /cfg\?\.delayMs\?\.max/);
  assert.match(src, /Math\.min\([^;]*CEILING\)/);
  assert.ok(!src.includes("FALLBACK_DELAY_MS"), "不再用 3 分钟硬编码兜底");
});

test("pi extension lets the user cancel pending notifications with /ack", () => {
  const src = piExtensionContent();
  assert.match(src, /pi\.registerCommand\("ack"/);
  assert.doesNotMatch(src, /registerShortcut|ctrl\+shift\+k/);
  // 命令要真的调 cancelAll（只注册不干活就是静默失效）：3 个事件 + 1 个手动入口 + 1 个轮询 + 1 处定义
  assert.equal((src.match(/cancelAll/g) ?? []).length, 6);
});

test("pi extension cancels a pending notification when the user starts typing", () => {
  const src = piExtensionContent();
  assert.match(src, /function editorText\(\)/);
  assert.match(src, /const seen = editorText\(\)/);
  assert.match(src, /seen !== undefined && editorText\(\) !== seen/);
  assert.match(src, /return cancelAll\(\)/);
});
