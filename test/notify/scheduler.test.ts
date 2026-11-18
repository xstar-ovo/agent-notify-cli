/**
 * 文件功能：延迟队列入队、抢占、聚合与唤醒的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpRoot } from "../helpers/tmp-config.js"; // 必须在 src 之前：log.ts 在 import 时取 configDir
import { normalize } from "../../src/config/schema.js";
import { cancel, enqueue, recordPath, sendDue, wake, type PendingNotification } from "../../src/notify/scheduler.js";
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
