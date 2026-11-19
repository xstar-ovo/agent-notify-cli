/**
 * 文件功能：Claude Code hook 的 stdin 解析和取消行为测试（真实调用编译后的 CLI）。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI = path.join(process.cwd(), "dist-test", "src", "cli.js");

function run(args: string[], input: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("claude stdin supplies session, message and cancel target", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-notify-claude-"));
  const state = path.join(dir, "state");
  const config = path.join(dir, "config.json");
  mkdirSync(path.dirname(state), { recursive: true });
  writeFileSync(config, JSON.stringify({
    bark: { enabled: true, endpoint: "http://127.0.0.1:1/{device_key}", deviceKey: "test" },
    delayMs: { stop: 60000, settled: 60000, error: 0, notification: 0, max: 600000 },
    stateDir: state,
  }));
  const env = { AGENT_NOTIFY_CONFIG: config, AGENT_NOTIFY_CONFIG_DIR: dir };

  try {
    const payload = JSON.stringify({
      session_id: "claude-test",
      cwd: process.cwd(),
      hook_event_name: "Stop",
      last_assistant_message: "hello from claude",
    });
    const result = run(["notify", "stop", "--agent", "claude", "--delay", "5", "--stdin-json"], payload, env);
    assert.equal(result.status, 0, result.stderr);

    const pending = path.join(state, "pending");
    const file = path.join(pending, "claude-test.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.event, "stop");
    assert.equal(record.agent, "claude");
    assert.equal(record.session, "claude-test");
    assert.equal(record.message, "hello from claude");

    const line = run(["_statusline"], JSON.stringify({ session_id: "claude-test" }), env);
    assert.equal(line.status, 0, line.stderr);
    assert.match(line.stdout, /消息通知时间 \d{2}:\d{2}:\d{2} · \d{2}:\d{2} 后/);

    const cancel = JSON.stringify({
      session_id: "claude-test",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    const cancelled = run(["cancel", "--agent", "claude", "--stdin-json"], cancel, env);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(cancelled.stdout.trim(), "");
    // 取消墓碑会留下（防止晚到的 notify 复活记录），但不该再有通知记录
    assert.deepEqual(readdirSync(pending).filter((f) => f.endsWith(".json")), []);

    const again = run(["notify", "stop", "--agent", "claude", "--delay", "5", "--stdin-json"], payload, env);
    assert.equal(again.status, 0, again.stderr);
    const ack = run(["cancel", "--agent", "claude", "--stdin-json"], JSON.stringify({
      session_id: "claude-test",
      hook_event_name: "UserPromptSubmit",
      prompt: "/ack",
    }), env);
    assert.equal(ack.status, 0, ack.stderr);
    assert.equal(JSON.parse(ack.stdout).decision, "block");
    // 取消墓碑会留下（防止晚到的 notify 复活记录），但不该再有通知记录
    assert.deepEqual(readdirSync(pending).filter((f) => f.endsWith(".json")), []);

    const empty = run(["_statusline"], JSON.stringify({ session_id: "claude-test" }), env);
    assert.equal(empty.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
