/**
 * 文件功能：延迟通知的磁盘队列、唤醒子进程、抢占式认领与同批聚合。
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { AgentNotifyConfig, NotifyEvent } from "../config/schema.js";
import { atomicWriteText, readJson } from "../util/atomic.js";
import { appendLog } from "../util/log.js";
import { spawnSelf } from "../util/spawn.js";
import { sendNow } from "./index.js";
import type { NotifyRecord } from "./templates.js";

export interface PendingNotification extends NotifyRecord {
  session: string;
  createdAt: number;
  dueAt: number;
}

const STALE_LOCK_MS = 60_000;

export function keyOf(session: string): string {
  const key = session.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return key || "default";
}

export function pendingDir(stateDir: string): string {
  return path.join(stateDir, "pending");
}

export function recordPath(stateDir: string, session: string): string {
  return path.join(pendingDir(stateDir), `${keyOf(session)}.json`);
}

function lockPath(stateDir: string, session: string): string {
  return path.join(pendingDir(stateDir), `${keyOf(session)}.lock`);
}

/** 写入（或覆盖）待发记录，并确保有一个唤醒进程在等它。 */
export function enqueue(rec: PendingNotification, cfg: AgentNotifyConfig): void {
  mkdirSync(pendingDir(cfg.stateDir), { recursive: true, mode: 0o700 });
  atomicWriteText(recordPath(cfg.stateDir, rec.session), JSON.stringify(rec));
  spawnSelf(["__wake", keyOf(rec.session)]);
}

export function cancel(cfg: AgentNotifyConfig, session: string): void {
  // 只删记录，不删别人正在持有的锁；否则并发的 sendDue 会重新认领旧记录。
  try {
    rmSync(recordPath(cfg.stateDir, session), { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 只读待发记录，给状态栏/诊断用；不认领、不删除。 */
export function pending(cfg: AgentNotifyConfig, session: string): PendingNotification | undefined {
  return readJson<PendingNotification>(recordPath(cfg.stateDir, session));
}

function claim(session: string, stateDir: string): boolean {
  const lock = lockPath(stateDir, session);
  try {
    closeSync(openSync(lock, "wx", 0o600));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lock);
        closeSync(openSync(lock, "wx", 0o600));
        return true;
      }
    } catch {
      /* 锁刚好被别人删掉了，当作竞争失败处理 */
    }
    return false;
  }
}

function removeLock(stateDir: string, session: string): void {
  try {
    rmSync(lockPath(stateDir, session), { force: true });
  } catch {
    /* 忽略 */
  }
}

function cleanup(stateDir: string, session: string): void {
  for (const file of [recordPath(stateDir, session), lockPath(stateDir, session)]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function mergeAggregate(recs: PendingNotification[]): PendingNotification {
  const first = recs[0]!;
  const messages = recs.map((r) => r.message).filter(Boolean);
  const extra = `另有 ${recs.length - 1} 个任务`;
  return { ...first, message: [...messages, extra].join("\n") };
}

/** 发送所有 `windowMs` 内到期（含已过期）的记录；按事件分组，发送前先逐条认领。 */
export async function sendDue(
  cfg: AgentNotifyConfig,
  windowMs = 0,
  sender: (rec: NotifyRecord, cfg: AgentNotifyConfig) => Promise<void> = sendNow,
): Promise<number> {
  const dir = pendingDir(cfg.stateDir);
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  const due: PendingNotification[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const rec = readJson<PendingNotification>(path.join(dir, file));
    if (rec && rec.dueAt <= now + windowMs) due.push(rec);
  }
  if (due.length === 0) return 0;

  const groups = new Map<NotifyEvent, PendingNotification[]>();
  for (const rec of due) {
    const list = groups.get(rec.event) ?? [];
    list.push(rec);
    groups.set(rec.event, list);
  }

  let sent = 0;
  for (const [event, recs] of groups) {
    const claimed: PendingNotification[] = [];
    for (const rec of recs) {
      if (!claim(rec.session, cfg.stateDir)) continue;
      const current = readJson<PendingNotification>(recordPath(cfg.stateDir, rec.session));
      if (!current) {
        removeLock(cfg.stateDir, rec.session); // 认领后被 cancel 删除，不能发旧副本
        continue;
      }
      claimed.push(current);
    }
    if (claimed.length === 0) continue;
    const merged = claimed.length === 1 ? claimed[0]! : mergeAggregate(claimed);
    try {
      await sender({ ...merged, event }, cfg);
    } catch {
      appendLog(`level=error event=${event} msg="all channels failed"`);
    }
    for (const rec of claimed) cleanup(cfg.stateDir, rec.session);
    sent += claimed.length;
  }
  return sent;
}

/** 阻塞到记录到期，再交给 sendDue（聚合也在那里做）。 */
export async function wake(sessionKey: string, cfg: AgentNotifyConfig): Promise<void> {
  for (;;) {
    const rec = readJson<PendingNotification>(recordPath(cfg.stateDir, sessionKey));
    if (!rec) return;
    const wait = rec.dueAt - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, Math.min(wait, 2_147_483_647)));
      continue;
    }
    await sendDue(cfg, cfg.aggregateWindowMs);
    return;
  }
}

/** 兜底恢复：已经有到期记录时，在后台补发一次。 */
export function sweepDue(cfg: AgentNotifyConfig): void {
  const dir = pendingDir(cfg.stateDir);
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const rec = readJson<PendingNotification>(path.join(dir, file));
    if (rec && rec.dueAt <= now) {
      spawnSelf(["flush"]);
      return;
    }
  }
}
