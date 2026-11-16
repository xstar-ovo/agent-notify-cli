/**
 * 文件功能：延迟队列入队、抢占、聚合与唤醒的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize } from "../../src/config/schema.js";
import { enqueue, recordPath, sendDue, wake, type PendingNotification } from "../../src/notify/scheduler.js";
import type { NotifyRecord } from "../../src/notify/templates.js";

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
  assert.match(sent[0]!.message ?? "", /另有 1 个任务/);
  assert.match(sent[0]!.message ?? "", /boom/);
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

test("a fresh lock blocks claiming (no duplicate send)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "an-"));
  const cfg = cfgFor(dir);
  enqueue(rec("locked", Date.now() - 1), cfg);
  writeFileSync(path.join(dir, "pending", "locked.lock"), "");
  const sent: NotifyRecord[] = [];

  assert.equal(await sendDue(cfg, 0, async (r) => void sent.push(r)), 0);
  assert.equal(sent.length, 0);
});
