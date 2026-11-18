/**
 * 文件功能：setup / uninstall 端到端往返测试——真实 spawn，真实写入临时 HOME 下的
 * ~/.claude、~/.pi、~/.config/opencode，验证"保留用户原有配置"和可完整回滚。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHooksPreview } from "../../src/setup/claude.js";

const CLI = path.join(process.cwd(), "dist-test", "src", "cli.js");

interface Box {
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

function box(): Box {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-setup-"));
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  return {
    dir,
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_NOTIFY_CONFIG_DIR: path.join(dir, "cfg"),
      AGENT_NOTIFY_CONFIG: path.join(dir, "cfg", "config.json"),
      BARK_DEVICE_KEY: "",
    },
  };
}

function run(args: string[], b: Box, input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: b.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin?.end(input);
  });
}

const USER_HOOK = { type: "command", command: "echo USER-STOP-HOOK" };
const USER_STATUSLINE = { type: "command", command: "echo ORIGINAL", padding: 0 };

/** 造一个"已经用了很久"的用户环境：每个 Agent 都有内容，setup 必须原样保留。 */
function seed(b: Box): void {
  mkdirSync(path.join(b.home, ".claude"), { recursive: true });
  writeFileSync(
    path.join(b.home, ".claude", "settings.json"),
    JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: { Stop: [{ hooks: [USER_HOOK] }] },
        statusLine: USER_STATUSLINE,
      },
      null,
      2,
    ),
  );
  mkdirSync(path.join(b.home, ".pi", "agent"), { recursive: true });
  mkdirSync(path.join(b.home, ".config", "opencode"), { recursive: true });
  writeFileSync(path.join(b.home, ".config", "opencode", "cli.json"), JSON.stringify({ plugins: ["other-plugin"] }));
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function ourHookCommands(settings: any): string[] {
  const out: string[] = [];
  for (const list of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const group of list as any[]) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command === "string" && hook.command.includes("cli.js")) out.push(hook.command);
      }
    }
  }
  return out;
}

test("setup keeps user config, and uninstall restores it exactly", async () => {
  const b = box();
  try {
    seed(b);
    const settingsFile = path.join(b.home, ".claude", "settings.json");

    const setup = await run(["setup", "--yes"], b);
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /已写入 Claude Code hooks/);
    assert.match(setup.stdout, /未写入 Bark key/, "非交互环境不阻塞在提示符上");

    const settings = readJson(settingsFile);
    // 用户原有内容一个都不能丢
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
    const stopCommands = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.ok(stopCommands.includes(USER_HOOK.command), "用户自己的 Stop hook 必须保留");
    // 所有事件都写入了本工具的命令
    const preview = JSON.parse(claudeHooksPreview());
    for (const event of Object.keys(preview.hooks)) {
      assert.ok(settings.hooks[event], `缺少 ${event} hook`);
    }
    assert.equal(ourHookCommands(settings).length, Object.keys(preview.hooks).length);
    // 状态栏被包装，原命令记进 meta
    assert.match(settings.statusLine.command, /agent-notify-statusline\.cjs/);
    const wrapper = path.join(b.home, ".claude", "agent-notify-statusline.cjs");
    assert.ok(existsSync(wrapper));
    assert.match(readFileSync(wrapper, "utf8"), /ORIGINAL/);
    assert.deepEqual(readJson(path.join(b.home, ".claude", "agent-notify-statusline.json")).original, USER_STATUSLINE);
    // /ack 命令
    assert.match(readFileSync(path.join(b.home, ".claude", "commands", "ack.md"), "utf8"), /agent-notify/);
    // 其他 agent
    assert.ok(existsSync(path.join(b.home, ".pi", "agent", "extensions", "agent-notify.ts")));
    const pluginRoot = path.join(b.home, ".config", "opencode", "plugins", "agent-notify");
    assert.ok(existsSync(path.join(pluginRoot, "index.ts")));
    assert.ok(existsSync(path.join(pluginRoot, "tui.tsx")));
    const cliJson = readJson(path.join(b.home, ".config", "opencode", "cli.json"));
    assert.ok(cliJson.plugins.includes("other-plugin"), "用户原有插件必须保留");
    assert.ok(cliJson.plugins.some((p: string) => p.includes("agent-notify")));

    // 幂等：再跑一次不改任何字节
    const before = readFileSync(settingsFile, "utf8");
    const cfgBefore = readFileSync(path.join(b.dir, "cfg", "config.json"), "utf8");
    const again = await run(["setup", "--yes"], b);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Claude Code 集成已是最新/);
    assert.match(again.stdout, /已是最新 Pi 扩展/);
    assert.match(again.stdout, /已是最新 OpenCode 插件/);
    assert.equal(readFileSync(settingsFile, "utf8"), before);
    assert.equal(readFileSync(path.join(b.dir, "cfg", "config.json"), "utf8"), cfgBefore, "重跑 setup 不能动用户配置");

    // 生成的包装脚本真的能跑：先输出原状态栏，再追加待发时间
    const cfgFile = path.join(b.dir, "cfg", "config.json");
    const cfg = readJson(cfgFile);
    const state = path.join(b.dir, "cfg", "state");
    writeFileSync(
      cfgFile,
      JSON.stringify({ ...cfg, stateDir: state, bark: { ...cfg.bark, enabled: true, deviceKey: "KEY123" } }),
    );
    mkdirSync(path.join(state, "pending"), { recursive: true });

    const doctor = await run(["doctor"], b);
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /Claude Code\s+已接入，最新/);
    assert.match(doctor.stdout, /Pi\s+已接入，最新/);
    assert.match(doctor.stdout, /OpenCode\s+已接入，最新/);
    const dueAt = Date.now() + 600_000;
    writeFileSync(
      path.join(state, "pending", "sess-9.json"),
      JSON.stringify({ session: "sess-9", event: "stop", agent: "claude", cwd: b.dir, createdAt: Date.now(), dueAt }),
    );
    const script = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [wrapper], { env: b.env });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin?.end(JSON.stringify({ session_id: "sess-9" }));
    });
    assert.equal(script.status, 0);
    assert.match(script.stdout, /ORIGINAL/, "原状态栏输出必须透传");
    assert.match(script.stdout, /消息通知时间/);

    const uninstall = await run(["uninstall"], b);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const after = readJson(settingsFile);
    assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(after.statusLine, USER_STATUSLINE, "原状态栏结构原样恢复");
    const leftOver = after.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(leftOver, [USER_HOOK.command]);
    assert.equal(ourHookCommands(after).length, 0);
    assert.ok(!existsSync(wrapper));
    assert.ok(!existsSync(path.join(b.home, ".claude", "commands", "ack.md")));
    assert.ok(!existsSync(path.join(b.home, ".pi", "agent", "extensions", "agent-notify.ts")));
    assert.ok(!existsSync(pluginRoot));
    const restoredCli = readJson(path.join(b.home, ".config", "opencode", "cli.json"));
    assert.ok(!restoredCli.plugins.some((p: string) => String(p).includes("agent-notify")));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("setup refuses to touch an unparsable settings.json", async () => {
  const b = box();
  try {
    mkdirSync(path.join(b.home, ".claude"), { recursive: true });
    const settingsFile = path.join(b.home, ".claude", "settings.json");
    writeFileSync(settingsFile, "{ broken");
    const setup = await run(["setup", "--yes"], b);
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /解析失败，未修改/);
    assert.equal(readFileSync(settingsFile, "utf8"), "{ broken");
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});
