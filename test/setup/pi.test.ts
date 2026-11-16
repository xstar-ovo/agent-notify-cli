/**
 * 文件功能：Pi 扩展生成内容的测试（必须是 node + 绝对路径，不经 shell）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { piExtensionContent } from "../../src/setup/pi.js";

test("pi extension calls node + absolute cli.js, never the shell/cmd shim", () => {
  const src = piExtensionContent();
  assert.match(src, /const CLI = "[^"]*cli\.js";/);
  assert.match(src, /spawn\(process\.execPath, \[CLI, "--agent", "pi", \.\.\.args\]/);
  assert.ok(!src.includes("shell:"), "no shell:true (DEP0190 + cmd window)");
  assert.ok(!src.includes('spawn("agent-notify"'), "no .cmd shim spawn");
  assert.ok(!src.includes("__CLI__"), "placeholder replaced");
});

test("pi extension wires cancel, task title and icon", () => {
  const src = piExtensionContent();
  assert.match(src, /pi\.on\("agent_start"/);
  assert.match(src, /pi\.on\("agent_settled"/);
  assert.match(src, /before_agent_start/);
  assert.match(src, /getSessionName/);
});

test("pi extension cancels on user activity and notifies on waiting-for-user", () => {
  const src = piExtensionContent();
  // 用户敲字 / 退出 / 切会话 都撤销待发的完成通知
  for (const event of ["input", "session_shutdown"]) {
    assert.match(src, new RegExp(`pi\\.on\\s*\\(\\s*"${event}"[^;]*--cancel", "--session", KEY`));
  }
  // 等用户操作时立即推送，且用独立的 :wait key，避免 --cancel 误删完成通知
  assert.match(src, /pi\.on\("ui_prompt_start"[^;]*--event", "notification"/);
  assert.match(src, /\$\{KEY\}:wait/);
  assert.match(src, /pi\.on\("ui_prompt_end"[^;]*--cancel", "--session", \`\$\{KEY\}:wait\`/);
});
