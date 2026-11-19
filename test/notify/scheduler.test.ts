/**
 * 文件功能：延迟队列入队、抢占、聚合与唤醒的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { tmpRoot } from "../helpers/tmp-config.js"; // 必须在 src 之前：log.ts 在 import 时取 configDir
import { normalize } from "../../src/config/schema.js";
import { cancel, enqueue, recordPath, sendDue, stillLive, superseded, wake, type PendingNotification } from "../../src/notify/scheduler.js";
import { build, type NotifyRecord } from "../../src/notify/templates.js";

function cfgFor(dir: string) {
  return normalize({ stateDir: dir, bark: { enabled: false } });
}

const rec = (session: string, dueAt: number, event: NotifyRecord["event"] = "stop"): PendingNotification => ({
  session,
  event,
  agent: "pi",
  cwd: "/tmp/proj",
  createdAt: Date.now(),
  dueAt,
});

test("due record is claimed, sent once and removed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("a", Date.now() - 1), cfg);
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.session, "a");
  assert.equal(existsSync(recordPath(dir, "a")), false);
  assert.equal(await sendDue(cfg, 0, async () => undefined), 0);
});

test("future record waits, unless inside the aggregation window", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("later", Date.now() + 60_000), cfg);
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 0);
  assert.equal(await sendDue(cfg, 5_000, async (r) => void sent.push(r)), 0);
  assert.equal(sent.length, 0);
  assert.ok(existsSync(recordPath(dir, "later")));
});

test("same-event records aggregate into one notification", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  const past = Date.now() - 1;
  enqueue(rec("s1", past), cfg);
  enqueue({ ...rec("s2", past), message: "boom" }, cfg);
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 2);
  assert.equal(sent.length, 1);
  // 关键断言在最终正文：build() 只取首句，条数必须能穿过去。
  const body = build(sent[0]!).body;
  assert.match(body, /另有 1 个任务/);
  assert.match(body, /boom/);
});

test("a live waker marker is reused, a dead or stale one is replaced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  const marker = path.join(dir, "pending", "w1.waker");
  const mark = () => JSON.parse(readFileSync(marker, "utf8")) as { pid: number; at: number };
  enqueue(rec("w1", Date.now() + 60_000), cfg);
  assert.ok(mark().pid > 0, "标记存的是 waker 子进程的 pid，不是发起入队的 hook 进程");

  const alive = JSON.stringify({ pid: process.pid, at: Date.now() }); // 假装已有一个活着的 waker 在等
  writeFileSync(marker, alive);
  enqueue(rec("w1", Date.now() + 60_000), cfg);
  assert.equal(readFileSync(marker, "utf8"), alive, "已有 waker 就不再拉新进程");

  writeFileSync(marker, JSON.stringify({ pid: 999999999, at: Date.now() })); // 被杀掉的进程留下的标记
  enqueue(rec("w1", Date.now() + 60_000), cfg);
  assert.notEqual(mark().pid, 999999999, "死掉的 waker 要重新拉起");

  writeFileSync(marker, JSON.stringify({ pid: process.pid, at: Date.now() - 3 * 60 * 60 * 1000 })); // pid 被复用
  enqueue(rec("w1", Date.now() + 60_000), cfg);
  assert.notEqual(mark().pid, process.pid, "超过 waker 最长等待的标记一律当残留");
});

test("a failed send from wake() hands the retry to a fresh waker", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = normalize({
    stateDir: dir,
    // 真的会失败的发送： endpoint 指向必然拒绝连接的本地端口（bark 关着时 sendNow 会直接 return，走不到失败分支）
    bark: { enabled: true, deviceKey: "K", endpoint: "http://127.0.0.1:1", timeoutMs: 500 },
  });
  const marker = path.join(dir, "pending", "w9.waker");
  enqueue(rec("w9", Date.now() - 10), cfg);
  writeFileSync(marker, JSON.stringify({ pid: process.pid, at: Date.now() })); // 我自己就是那个即将退出的 waker

  await wake("w9", cfg);

  const after = JSON.parse(readFileSync(recordPath(dir, "w9"), "utf8")) as PendingNotification;
  assert.equal(after.retries, 1);
  assert.ok(after.dueAt > Date.now());
  assert.equal(
    (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid !== process.pid,
    true,
    "重试必须换成新的 waker：标记还是自己就说明 30 秒后没人等这条记录",
  );
});

test("wake 退出前会给发送途中替换的新记录接力一个 waker", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  mkdirSync(path.join(dir, "pending"), { recursive: true });
  const marker = path.join(dir, "pending", "handoff.waker");
  writeFileSync(recordPath(dir, "handoff"), JSON.stringify({ ...rec("handoff", Date.now() - 1), message: "OLD" }));
  writeFileSync(marker, JSON.stringify({ pid: process.pid, at: Date.now() })); // 假装我就是那个 waker

  const server = createServer((_req, res) => {
    // 发送进行中：同会话写入更新的记录，再让这次发送失败
    writeFileSync(recordPath(dir, "handoff"), JSON.stringify({
      ...rec("handoff", Date.now() + 60_000),
      message: "NEW",
      createdAt: Date.now() + 5,
    }));
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const cfg = normalize({
      stateDir: dir,
      bark: { enabled: true, deviceKey: "K", endpoint: `http://127.0.0.1:${port}`, timeoutMs: 500 },
    });

    await wake("handoff", cfg);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const after = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
  assert.notEqual(after.pid, process.pid, "新记录不能沿用即将退出的 waker");
  assert.equal(
    (JSON.parse(readFileSync(recordPath(dir, "handoff"), "utf8")) as PendingNotification).message,
    "NEW",
  );
});

test("a send cancelled mid-flight is not resurrected by the retry", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("race", Date.now() - 1), cfg);

  await sendDue(cfg, 0, async () => {
    cancel(cfg, "race"); // 用户正好在发送窗口里按了 /ack
    throw new Error("network gone");
  });

  assert.equal(existsSync(recordPath(dir, "race")), false, "已取消的通知不能被重试复活");
  assert.equal(existsSync(path.join(dir, "pending", "race.lock")), false, "也不能留下挡路的老锁");
});

test("a retry never overwrites a newer notification of the same session", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("twin", Date.now() - 1), cfg);

  await sendDue(cfg, 0, async () => {
    cancel(cfg, "twin");
    enqueue({ ...rec("twin", Date.now() + 60_000), message: "NEW", createdAt: Date.now() }, cfg); // 用户开了新任务
    throw new Error("network gone");
  });

  const cur = JSON.parse(readFileSync(recordPath(dir, "twin"), "utf8")) as PendingNotification;
  assert.equal(cur.message, "NEW", "旧快照不能把新通知顶掉");
  assert.ok(cur.dueAt > Date.now() + 50_000);
});

test("enqueue overwrites the same session (debounce)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("dup", Date.now() + 10_000), cfg);
  enqueue({ ...rec("dup", Date.now() - 1), message: "second" }, cfg);
  const sent: NotifyRecord[] = [];

  assert.equal(readdirSync(path.join(dir, "pending")).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 1);
  assert.equal(sent[0]!.message, "second");
});

test("wake sends immediately when already due", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("w", Date.now() - 1), cfg);
  await wake("w", cfg);
  assert.equal(existsSync(recordPath(dir, "w")), false);
});

test("cancel removes the record but leaves a sender's lock in place", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("cancelled", Date.now() + 60_000), cfg);
  const lock = path.join(dir, "pending", "cancelled.lock");
  writeFileSync(lock, "");

  cancel(cfg, "cancelled");
  assert.equal(existsSync(recordPath(dir, "cancelled")), false);
  assert.equal(existsSync(lock), true, "不能删掉别的 sender 持有的锁");
});

test("a fresh lock blocks claiming (no duplicate send)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("locked", Date.now() - 1), cfg);
  writeFileSync(path.join(dir, "pending", "locked.lock"), "");
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 0);
  assert.equal(sent.length, 0);
});

test("a stale lock from a killed process is reclaimed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("stale", Date.now() - 1), cfg);
  const lock = path.join(dir, "pending", "stale.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 1);
  assert.equal(sent.length, 1, "否则崩溃一次后这条通知永远发不出去");
  assert.equal(existsSync(recordPath(dir, "stale")), false);
});

test("send failure retries, then gives up after MAX_RETRIES", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("fail", Date.now() - 1), cfg);
  const boom = async () => {
    throw new Error("offline");
  };

  // 重试是排到 30 秒后的，用窗口把它含进来
  for (let i = 0; i < 4; i++) await sendDue(cfg, 60_000, boom);
  assert.equal(existsSync(recordPath(dir, "fail")), false, "4 次都失败才放弃");
  assert.equal(existsSync(path.join(dir, "pending", "fail.lock")), false, "不能留下挡住重试的锁");
  assert.match(readFileSync(path.join(tmpRoot, "error.log"), "utf8"), /all channels failed/);
});

test("a failed record survives and goes out once the network recovers", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("recover", Date.now() - 1), cfg);

  assert.equal(
    await sendDue(cfg, 0, async () => {
      throw new Error("offline");
    }),
    1,
  );
  const pending = JSON.parse(readFileSync(recordPath(dir, "recover"), "utf8"));
  assert.equal(pending.retries, 1);
  assert.ok(pending.dueAt > Date.now(), "改到未来，等下次唤醒");

  const sent: NotifyRecord[] = [];
  assert.equal(await sendDue(cfg, 60_000, async (r) => void sent.push(r)), 1);
  assert.equal(sent.length, 1);
  assert.equal(existsSync(recordPath(dir, "recover")), false);
});

test("wake sleeps until the record is due", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  // enqueue 会拉子进程（Windows 上几十毫秒），起点必须放在它之前，否则等的时长会被它吃掉。
  const started = Date.now();
  enqueue(rec("sleepy", started + 80), cfg);

  await wake("sleepy", cfg);
  assert.ok(Date.now() - started >= 60, "必须真的等到到期");
  assert.equal(existsSync(recordPath(dir, "sleepy")), false);
});

test("取消比通知新时，晚到的 notify 不能把记录写回来", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  cancel(cfg, "late", 2000);
  enqueue({ ...rec("late", Date.now() + 60_000), createdAt: 1000 }, cfg);
  assert.equal(existsSync(recordPath(dir, "late")), false, "cancel 先落、notify 进程后跑，通知也不能复活");
});

test("取消之后的新通知仍然照常写入", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  cancel(cfg, "fresh", 1000);
  enqueue({ ...rec("fresh", Date.now() + 60_000), createdAt: 2000 }, cfg);
  assert.equal(existsSync(recordPath(dir, "fresh")), true);
});

test("认领后被 /ack 撤销或被新通知替换的记录不会被发送", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  const old = rec("ackmid", Date.now() + 60_000);
  enqueue(old, cfg);
  assert.equal(stillLive(dir, old), true);

  cancel(cfg, "ackmid", Date.now() + 10);
  assert.equal(stillLive(dir, old), false, "/ack 删掉记录后旧快照作废");

  enqueue({ ...old, createdAt: old.createdAt + 20 }, cfg);
  assert.equal(stillLive(dir, old), false, "同会话的新通知不能让旧快照复活");
});

test("墓碑只增不减：旧的 cancel 不能覆盖新的", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  cancel(cfg, "mono", 5000);
  cancel(cfg, "mono", 1000); // 乱序落地的旧 cancel 进程
  enqueue({ ...rec("mono", Date.now() + 60_000), createdAt: 3000 }, cfg);
  assert.equal(existsSync(recordPath(dir, "mono")), false, "墓碑退回到 1000 就会放行 3000 的通知");
});

test("发送成功途中写入的新通知不会被 cleanup 删掉", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue({ ...rec("succ", Date.now() - 1), message: "OLD" }, cfg);

  await sendDue(cfg, 0, async () => {
    enqueue({ ...rec("succ", Date.now() + 60_000), message: "NEW", createdAt: Date.now() + 5 }, cfg);
  });

  const cur = JSON.parse(readFileSync(recordPath(dir, "succ"), "utf8")) as PendingNotification;
  assert.equal(cur.message, "NEW", "发送成功后只能清理自己的旧记录");
});

test("发送途中写入的新记录会被补一个 waker", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue({ ...rec("kick", Date.now() + 30_000), message: "OLD" }, cfg);
  const marker = path.join(dir, "pending", "kick.waker");
  const first = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;

  await sendDue(cfg, 60_000, async () => {
    enqueue({ ...rec("kick", Date.now() + 60_000), message: "NEW", createdAt: Date.now() + 5 }, cfg);
  });

  const after = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;
  assert.notEqual(after, first, "不能让新记录沿用即将退出的旧 waker");
  assert.equal(
    (JSON.parse(readFileSync(recordPath(dir, "kick"), "utf8")) as PendingNotification).message,
    "NEW",
  );
});

test("晚到的旧 cancel 不会删掉更新的记录", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue({ ...rec("young", Date.now() + 60_000), createdAt: 5000 }, cfg);

  cancel(cfg, "young", 1000); // 旧 cancel 进程晚到
  assert.equal(existsSync(recordPath(dir, "young")), true, "比取消请求新的记录要留着");

  cancel(cfg, "young", 6000); // 请求更晚的 cancel 才算数
  assert.equal(existsSync(recordPath(dir, "young")), false);
});

test("墓碑比记录新时，残留记录也不会被发送", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  const r = rec("tomb", Date.now() + 30_000);
  enqueue(r, cfg);
  cancel(cfg, "tomb", r.createdAt + 10); // 正常会连同记录一起删掉
  writeFileSync(recordPath(dir, "tomb"), JSON.stringify(r)); // 模拟删除失败留下的残记录

  const sent: NotifyRecord[] = [];
  assert.equal(await sendDue(cfg, 60_000, async (x) => void sent.push(x)), 0);
  assert.equal(sent.length, 0, "有更新的墓碑时，残留记录也不能发");
  assert.equal(existsSync(recordPath(dir, "tomb")), false, "作废的残记录要清掉，否则 sweep 会反复拉起 flush");

  // 清理残记录时必须一起放开认领的锁，否则同会话下一条会被挡到锁过期。
  writeFileSync(recordPath(dir, "tomb"), JSON.stringify({ ...rec("tomb", Date.now() - 1), createdAt: r.createdAt + 20 }));
  assert.equal(await sendDue(cfg, 0, async (x) => void sent.push(x)), 1, "残记录清理后，同一会话的新通知要能发");
});

test("立即通知只在取消或排队记录更新时才作废", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  mkdirSync(path.join(dir, "pending"), { recursive: true });
  // 晚到的旧 notify 短暂落盘（createdAt 比立即通知旧）：不能拦住这条立即通知
  writeFileSync(recordPath(dir, "imm"), JSON.stringify({ ...rec("imm", Date.now() + 60_000), createdAt: 1000 }));
  assert.equal(superseded(cfg, "imm", 2000), false);

  // 排队记录比立即通知新：这条作废
  writeFileSync(recordPath(dir, "imm"), JSON.stringify({ ...rec("imm", Date.now() + 60_000), createdAt: 3000 }));
  assert.equal(superseded(cfg, "imm", 2000), true);

  // 取消比立即通知新：这条作废
  cancel(cfg, "imm", 4000);
  assert.equal(superseded(cfg, "imm", 2000), true);
});
