/**
 * 文件功能：OpenCode V2 插件生成内容的测试（运行方式、生命周期、等待操作、取消）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_CHARS } from "../../src/config/constant.js";
import { openCodePluginContent, openCodeTuiContent } from "../../src/setup/opencode.js";

/** 取两个标记之间的源码，用来断言某个事件分支真的干了活。 */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `未找到 ${from}`);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end < 0 ? src.length : end);
}

test("opencode plugin runs node + absolute cli.js without the @opencode/plugin import", () => {
  const src = openCodePluginContent();
  assert.match(src, /const CLI = "[^"]*cli\.js";/);
  assert.match(src, /spawn\(NODE, \[CLI, "--agent", "opencode", \.\.\.args\]/);
  assert.ok(!src.includes("shell:"), "no shell:true");
  assert.ok(!src.includes("@opencode/plugin"), "plain object export avoids local package resolution");
  assert.match(src, /export default \{\n  id: "agent-notify",/);
  assert.ok(!src.includes("spawn(process.execPath"), "OpenCode runs in Bun; must not use process.execPath");
  assert.match(src, /const NODE = process\.env\.AGENT_NOTIFY_NODE \|\| /);
});

test("opencode plugin subscribes to v2 events and cleans up", () => {
  const src = openCodePluginContent();
  assert.match(src, /ctx\.event\.subscribe\(\{ types: SUBSCRIBE, signal: abort\.signal \}\)/);
  assert.match(src, /return \(\) => abort\.abort\(\)/);
  assert.match(src, /ctx\.session\.hook\("prompt"/);
  assert.match(src, /ctx\?\.location\?\.directory/);
  assert.ok(!src.includes(".properties"), "V2 payload is in data, not properties");
});

test("opencode plugin maps v2 execution outcomes, not the unused idle events", () => {
  const src = openCodePluginContent();
  for (const type of ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    assert.ok(src.includes(`case "${type}"`), `缺少 ${type}`);
  }
  assert.ok(!src.includes('"session.idle"'), "V2 不发射 session.idle");
  assert.ok(!src.includes('"session.status"'), "V2 不发射 session.status");
  const failed = between(src, 'case "session.execution.failed"', 'case "session.execution.interrupted"');
  assert.match(failed, /"--event", "error"/);
  assert.match(failed, /cancelWait\(id, cwd\)/, "失败时先撤销还在延迟的等待提醒");
  assert.match(between(src, 'case "session.execution.succeeded"', 'case "session.execution.failed"'), /"--event", "settled"/);
  assert.ok(!failed.includes("data.error"), "不把 Provider 错误原文发到手机");
});

test("opencode plugin reports the last text and duration", () => {
  const src = openCodePluginContent();
  const text = between(src, 'case "session.text.ended"', 'case "session.execution.succeeded"');
  assert.match(text, /replace\(\/\\s\+\/g, " "\)/);
  assert.match(text, new RegExp(`slice\\(0, ${SUMMARY_CHARS}\\)`));
  const succeeded = between(src, 'case "session.execution.succeeded"', 'case "session.execution.failed"');
  assert.ok(succeeded.includes("用时"), "正文带耗时");
  assert.match(succeeded, /args\.push\("--message", message\)/);
  assert.match(succeeded, /cancelWait\(id, cwd\)/, "完成时先撤销还在延迟的等待提醒");
});

test("opencode plugin waits on permission and forms, then cancels on reply", () => {
  const src = openCodePluginContent();
  const wait = between(src, 'case "permission.asked"', 'case "permission.replied"');
  assert.match(wait, /waitFor\(id, cwd\)/, "权限请求复用节流逻辑");
  assert.ok(!wait.includes("question.asked"), "V2 不再处理 question.asked");
  const form = between(src, 'if (type === "form.created")', 'const id = data.sessionID');
  assert.match(form, /form\.sessionID/);
  assert.match(form, /waitFor\(id, cwd/);
  const replied = between(src, 'case "permission.replied"', "  }\n}");
  assert.ok(replied.includes("`${session}:wait`"), "回答后撤销等待通知");
  assert.match(replied, /"--cancel"/);
  assert.match(replied, /waitAt\.delete\(id\)/, "回答后释放节流状态");
  assert.ok(replied.includes('case "form.replied"'), "表单回答也撤销");
  assert.ok(replied.includes('case "form.cancelled"'), "表单取消也撤销");
});

test("opencode plugin cancels pending notifications on new activity and deletion", () => {
  const src = openCodePluginContent();
  const started = between(src, 'case "session.execution.started"', 'case "session.text.ended"');
  assert.match(started, /cancel\(id, cwd\)/);
  assert.match(started, /states\.set/);
  assert.match(between(src, 'await ctx.session.hook("prompt"', "void (async"), /cancel\(event\.sessionID, base\)/);
  const deleted = between(src, 'if (type === "session.deleted")', 'if (children.has(id))');
  assert.match(deleted, /cancel\(id, cwd\)/);
  assert.match(deleted, /states\.delete\(id\)/);
});

test("opencode plugin only handles events from its own location", () => {
  const src = openCodePluginContent();
  assert.match(src, /event\?\.location\?\.directory/);
  assert.match(src, /path\.resolve\(cwd\) !== path\.resolve\(base\)/);
  assert.match(src, /const SUBSCRIBE = \[/);
  assert.match(src, /types: SUBSCRIBE/);
});

test("opencode plugin suppresses subagent sessions", () => {
  const src = openCodePluginContent();
  assert.match(src, /data\.parentID/);
  assert.match(src, /children\.add\(data\.sessionID\)/);
  assert.match(src, /if \(children\.has\(id\)\) return/);
});

test("opencode plugin cancels pending reminders on interrupted runs", () => {
  const src = openCodePluginContent();
  const interrupted = between(src, 'case "session.execution.interrupted"', 'case "permission.asked"');
  assert.ok(!interrupted.includes("notify("), "用户 Esc / 关机不推送");
  assert.match(interrupted, /cancel\(id, cwd\)/, "撤销延迟中的旧提醒");
  assert.match(interrupted, /states\.delete\(id\)/);
  assert.match(interrupted, /waitAt\.delete\(id\)/);
});

test("opencode tui plugin shows the scheduled time at task end", () => {
  const src = openCodeTuiContent();
  assert.match(src, /child\.on\("error"/, "spawn 失败不能打崩 TUI");
  assert.match(src, /events\?\.\[event\]\?\.bark === false/, "关掉事件时不显示倒计时");
  assert.match(src, /bark\?\.enabled === false/, "关掉 Bark 时不显示倒计时");
  assert.match(src, /Object\.keys\(state\.due\)\.length === 0\) return/, "没有倒计时就不每秒重渲染");
  assert.match(src, /@opencode\/plugin\/tui/);
  assert.match(src, /session\.execution\.succeeded/);
  assert.match(src, /session\.execution\.failed/);
  assert.doesNotMatch(src, /ctx\.ui\.toast\.show/);
  assert.match(src, /ctx\.ui\.slot/);
  assert.match(src, /session\.composer\.top/);
  assert.match(src, /ctx\.storage\.memory/);
  assert.match(src, /消息通知时间 \{clock\(due\)\}/);
  assert.match(src, /delayMs/);
  assert.match(src, /draft\.due\[id\] = dueAt/);
  assert.match(src, /--cancel/);
  assert.match(src, /ctx\.keymap\.layer/);
  assert.match(src, /slash: \{ name: "ack" \}/);
  assert.match(src, /palette: true/);
  assert.match(src, /ctx\.keymap\.commands\(\)/);
  assert.doesNotMatch(src, /ctrl\+shift\+k|bindings:|slashName|namespace:/);
  assert.match(src, /ctx\.ui\.router\.current\(\)/);
  assert.match(src, /route\?\.type === "session"/);
  assert.match(src, /route\.sessionID/);
  assert.match(src, /const fallback = Object\.keys\(state\.due\)/);
  assert.match(src, /ctx\.ui\.toast\(\{/);
  assert.doesNotMatch(src, /ctx\.route\.current|ctx\.router\.current\(|ctx\.ui\.toast\.show/);
});

test("opencode tui plugin stays quiet for subagents and other locations", () => {
  const src = openCodeTuiContent();
  assert.match(src, /ctx\.data\.session\.root\(id\)/);
  assert.match(src, /root !== id/);
  assert.match(src, /path\.resolve\(cwd\) !== path\.resolve\(base\)/);
});

test("opencode plugin survives a moved or unbuilt cli path", () => {
  const src = openCodePluginContent();
  assert.match(src, /if \(!existsSync\(CLI\)\) return report\(/);
  assert.match(src, /child\.on\("error", \(err: any\) => report\(/);
  assert.match(src, /appendFileSync\(LOG/);
  assert.ok(!src.includes("reported"), "服务端没有 UI，不需要只提示一次的状态");
});
