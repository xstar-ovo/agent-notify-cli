/**
 * 文件功能：手动子命令的端到端测试（真实 spawn CLI）：退出码、输出契约与"绝不打断 agent"不变量。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const CLI = path.join(process.cwd(), "dist-test", "src", "cli.js");

interface Box {
  dir: string;
  home: string;
  config: string;
  state: string;
  env: NodeJS.ProcessEnv;
}

/** 每个测试一个沙箱：HOME、配置、日志、状态目录、版本缓存全在 tmp 里，不碰真实用户目录。 */
function box(config: Record<string, unknown> = {}): Box {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-cmd-"));
  const home = path.join(dir, "home");
  const state = path.join(dir, "state");
  const configFile = path.join(dir, "config.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ stateDir: state, ...config }));
  // status / doctor 会查 npm 版本：预置一小时内有效的缓存，避免测试真的联网。
  writeFileSync(path.join(dir, "update-check.json"), JSON.stringify({ at: Date.now(), latest: "0.0.1" }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_NOTIFY_CONFIG_DIR: dir,
    AGENT_NOTIFY_CONFIG: configFile,
    BARK_DEVICE_KEY: "",
  };
  return { dir, home, config: configFile, state, env };
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

/** 本地 Bark stub（spawn 是异步的，这里不能用 spawnSync，否则子进程的请求没人接）。 */
async function withBark(
  reply: () => { status: number; json: unknown },
  fn: (endpoint: string, seen: any[]) => Promise<void>,
): Promise<void> {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
      const { status, json } = reply();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/{device_key}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function pendingRecord(state: string, rec: Record<string, unknown>): void {
  mkdirSync(path.join(state, "pending"), { recursive: true });
  writeFileSync(path.join(state, "pending", `${rec.session}.json`), JSON.stringify(rec));
}

test("help, unknown command and unknown event all exit 0 with a hint", async () => {
  const b = box();
  try {
    const help = await run(["--help"], b);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /agent-notify/);
    assert.match(help.stdout, /flush/);

    const bare = await run([], b);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /发送/);

    const unknown = await run(["bogus"], b);
    assert.equal(unknown.status, 0, "未知命令不能打断 agent");
    assert.match(unknown.stderr, /未知命令：bogus/);

    const event = await run(["notify", "bogus"], b);
    assert.equal(event.status, 0);
    assert.match(event.stderr, /未知事件：bogus/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("key writes the bark key and refuses bad input", async () => {
  const b = box();
  try {
    const ok = await run(["key", "abc123XYZ"], b);
    assert.equal(ok.status, 0, ok.stdout);
    const raw = JSON.parse(readFileSync(b.config, "utf8"));
    assert.equal(raw.bark.deviceKey, "abc123XYZ");
    assert.equal(raw.bark.enabled, true);

    // 用户关掉的 Bark 不能被换 key 顺手打开
    writeFileSync(b.config, JSON.stringify({ bark: { enabled: false } }));
    assert.equal((await run(["key", "second0key"], b)).status, 0);
    assert.equal(JSON.parse(readFileSync(b.config, "utf8")).bark.enabled, false);

    const missing = await run(["key"], b);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /用法/);

    writeFileSync(b.config, "{ not json");
    const broken = await run(["key", "otherkey"], b);
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /不是合法 JSON/);
    assert.equal(readFileSync(b.config, "utf8"), "{ not json", "解析失败时绝不覆盖");
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("test command pushes through bark and reports failures as exit 1", async () => {
  const b = box({ bark: { enabled: true, deviceKey: "KEY123" } });
  try {
    await withBark(
      () => ({ status: 200, json: { code: 200 } }),
      async (endpoint, seen) => {
        const cfg = JSON.parse(readFileSync(b.config, "utf8"));
        writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, endpoint } }));
        const ok = await run(["test"], b);
        assert.equal(ok.status, 0, ok.stdout);
        assert.match(ok.stdout, /Bark 已发送/);
        assert.equal(seen[0].url, "/KEY123");
        assert.equal(seen[0].body.title, "agent-notify");
      },
    );

    await withBark(
      () => ({ status: 500, json: {} }),
      async (endpoint) => {
        const cfg = JSON.parse(readFileSync(b.config, "utf8"));
        writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, endpoint } }));
        const bad = await run(["test"], b);
        assert.equal(bad.status, 1);
        assert.match(bad.stdout, /Bark 发送失败/);
        assert.ok(!bad.stdout.includes("KEY123"), "报错里不能出现完整 key");
      },
    );

    const cfg = JSON.parse(readFileSync(b.config, "utf8"));
    writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, enabled: false } }));
    const disabled = await run(["test"], b);
    assert.equal(disabled.status, 1);
    assert.match(disabled.stdout, /Bark 未启用/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("doctor fails on a missing key and passes once configured", async () => {
  const b = box();
  try {
    const missing = await run(["doctor"], b);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /未配置 key/);
    assert.match(missing.stdout, /未检测到/, "没装 agent 时如实说明");

    const cfg = JSON.parse(readFileSync(b.config, "utf8"));
    writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, deviceKey: "abcdef123456" } }));
    const ok = await run(["doctor"], b);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /已配置 abcd…456/);
    assert.match(ok.stdout, /一切正常/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("status lists pending records with their due time", async () => {
  const b = box();
  try {
    const empty = await run(["status"], b);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /待发：0 条/);

    pendingRecord(b.state, {
      session: "sess-1",
      event: "stop",
      agent: "pi",
      cwd: "/tmp/proj",
      message: "改了三个文件",
      createdAt: Date.now(),
      dueAt: Date.now() + 60_000,
    });
    const one = await run(["status"], b);
    assert.equal(one.status, 0);
    assert.match(one.stdout, /待发：1 条/);
    assert.match(one.stdout, /sess-1\s+stop/);
    assert.match(one.stdout, /改了三个文件/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("flush sends due records only, and _wake drains a due record", async () => {
  const b = box({ bark: { enabled: true, deviceKey: "KEY123" } });
  try {
    const past = Date.now() - 1_000;
    pendingRecord(b.state, { session: "due", event: "stop", agent: "pi", cwd: "/p", createdAt: past, dueAt: past });
    pendingRecord(b.state, { session: "later", event: "stop", agent: "pi", cwd: "/p", createdAt: Date.now(), dueAt: Date.now() + 600_000 });

    await withBark(
      () => ({ status: 200, json: { code: 200 } }),
      async (endpoint, seen) => {
        const cfg = JSON.parse(readFileSync(b.config, "utf8"));
        writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, endpoint } }));
        const flush = await run(["flush"], b);
        assert.equal(flush.status, 0, flush.stderr);
        assert.equal(seen.length, 1, "只发到期的那条");
        const left = readFileSync(path.join(b.state, "pending", "later.json"), "utf8");
        assert.equal(JSON.parse(left).session, "later");
      },
    );

    const failed = readFileSync(path.join(b.state, "pending", "later.json"), "utf8");
    assert.equal(JSON.parse(failed).session, "later", "未到期的记录不能被删");

    // bark 已停用：_wake 照样把到期记录清掉并 exit 0
    const cfg = JSON.parse(readFileSync(b.config, "utf8"));
    writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, enabled: false } }));
    const wake = await run(["_wake", "due"], b);
    assert.equal(wake.status, 0, wake.stderr);
    assert.throws(() => readFileSync(path.join(b.state, "pending", "due.json")));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("乱序落地的 notify 不能复活已被 /ack 取消的通知", async () => {
  const b = box({ bark: { enabled: false } });
  try {
    // cancel 请求 (2000) 比 notify 请求 (1000) 新，即使 notify 进程晚跑完也不能写记录。
    await run(["cancel", "--session", "race", "--at", "2000"], b);
    await run(["notify", "settled", "--session", "race", "--at", "1000"], b);
    assert.equal(existsSync(path.join(b.state, "pending", "race.json")), false);

    // 反过来，更新的 notify 必须照常写入。
    await run(["notify", "settled", "--session", "race", "--at", "3000"], b);
    assert.equal(existsSync(path.join(b.state, "pending", "race.json")), true);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("立即通知也会被更新的 /ack 拦住", async () => {
  const b = box({ bark: { enabled: true, deviceKey: "KEY123" } });
  try {
    await withBark(
      () => ({ status: 200, json: { code: 200 } }),
      async (endpoint, seen) => {
        const cfg = JSON.parse(readFileSync(b.config, "utf8"));
        writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, endpoint } }));

        // /ack 请求 (2000) 比这条立即通知 (1000) 新：notify 子进程晚跑也不能推送。
        await run(["cancel", "--session", "imm", "--at", "2000"], b);
        await run(["notify", "notification", "--session", "imm", "--at", "1000"], b);
        assert.equal(seen.length, 0, "已被取消的立即通知不能推送");

        // 更新的立即通知照常推送。
        await run(["notify", "notification", "--session", "imm", "--at", "3000"], b);
        assert.equal(seen.length, 1);
      },
    );
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("晚到的旧立即通知既不删新记录也不再推送", async () => {
  const b = box({ bark: { enabled: true, deviceKey: "KEY123" } });
  const record = path.join(b.state, "pending", "lateimm.json");
  try {
    await withBark(
      () => ({ status: 200, json: { code: 200 } }),
      async (endpoint, seen) => {
        const cfg = JSON.parse(readFileSync(b.config, "utf8"));
        writeFileSync(b.config, JSON.stringify({ ...cfg, bark: { ...cfg.bark, endpoint } }));

        // 更新的延迟通知先落地（createdAt 4000）。
        await run(["notify", "settled", "--session", "lateimm", "--at", "4000"], b);
        assert.equal(existsSync(record), true);

        // 更旧的立即通知进程晚到（createdAt 1000）：新记录要留着，旧的立即通知不能发。
        await run(["notify", "notification", "--session", "lateimm", "--at", "1000"], b);
        assert.equal(seen.length, 0, "过期的立即通知不能推送");
        assert.equal(existsSync(record), true, "更新的待发记录不能被旧 cancel 删掉");

        // 真正更新的立即通知照常发，并清掉更旧的待发记录。
        await run(["notify", "notification", "--session", "lateimm", "--at", "5000"], b);
        assert.equal(seen.length, 1);
        assert.equal(existsSync(record), false);
      },
    );
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("setup without --yes in a non-tty prints the hint and writes nothing", async () => {
  const b = box();
  try {
    mkdirSync(path.join(b.home, ".claude"), { recursive: true });
    const result = await run(["setup"], b);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude Code/);
    assert.match(result.stdout, /非交互环境，请加 --yes/);
    assert.throws(() => readFileSync(path.join(b.home, ".claude", "settings.json")));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("setup --dry-run previews hooks without touching settings.json", async () => {
  const b = box();
  try {
    mkdirSync(path.join(b.home, ".claude"), { recursive: true });
    const result = await run(["setup", "--dry-run"], b);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--agent claude/);
    assert.match(result.stdout, /hooks/);
    assert.match(result.stdout, /dry-run，不写入/);
    assert.throws(() => readFileSync(path.join(b.home, ".claude", "settings.json")));
    assert.throws(() => readFileSync(path.join(b.home, ".config", "agent-notify", "config.json")));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("an menu 数字选择：报错项、执行命令、0 退出、EOF 不挂住", async () => {
  const b = box();
  try {
    const menu = await run(["menu"], b, "77\n0\n");
    assert.equal(menu.status, 0, menu.stderr);
    assert.match(menu.stdout, /1\. 写入 Bark key/);
    assert.match(menu.stdout, /Bark：未配置 key/);
    assert.match(menu.stdout, /没有这个选项。/);

    const status = await run(["menu"], b, "2\n0\n");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /待发：/);

    // 管道喂完没有 0：必须自己退出，不能卡在 question 上。
    const eof = await run(["menu"], b, "2\n");
    assert.equal(eof.status, 0, eof.stderr);

    // 7/8/9 覆盖 notify / flush / cancel。
    const rest = await run(["menu"], b, "7\nstop\n8\n9\ndefault\n0\n");
    assert.equal(rest.status, 0, rest.stderr);
    assert.match(rest.stdout, /已入队，5 分钟后通知。/);
    assert.match(rest.stdout, /没有已到期的待发通知。/);
    assert.match(rest.stdout, /已取消 default 的待发通知。/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("setup 在菜单里复用同一个 readline 实例，不另开一个抢 stdin", () => {
  // 静态护栏：两个 Lines 同时读 process.stdin 会把输入行路由错（key 被吞 / 菜单误读一行）。
  // 真正的路由只能靠真 TTY 验证，node:test 里造不出来，所以只锁调用点：setup 必须把共享实例传下去。
  const src = readFileSync(path.join(process.cwd(), "src", "cli.ts"), "utf8");
  assert.match(src, /await promptBarkKey\(lines\)/);
  assert.doesNotMatch(src, /await promptBarkKey\(\)/);
});
