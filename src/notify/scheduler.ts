/**
 * 文件功能：延迟通知的磁盘队列、唤醒子进程、抢占式认领与同批聚合。
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { AgentNotifyConfig, NotifyEvent } from "../config/schema.js";
import { MAX_DELAY_CEILING_MS } from "../config/constant.js";
import { atomicWriteText, readJson } from "../util/atomic.js";
import { appendLog } from "../util/log.js";
import { spawnSelf } from "../util/spawn.js";
import { sendNow } from "./index.js";
import type { NotifyRecord } from "./templates.js";

export interface PendingNotification extends NotifyRecord {
  session: string;
  createdAt: number;
  dueAt: number;
  retries?: number;
}

// 必须大于一次发送的最坏耗时（config.timeoutMs 上限 30 秒），否则自己的锁会被当成过期而重发。
const STALE_LOCK_MS = 120_000;
const RETRY_MS = 30_000;
const MAX_RETRIES = 3;
// waker 最长会等 MAX_DELAY_CEILING_MS（30 分钟），再加几轮重试；超过这个时长的标记一定是残留。
const WAKER_TTL_MS = MAX_DELAY_CEILING_MS + RETRY_MS * MAX_RETRIES;

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

function wakerPath(stateDir: string, session: string): string {
  return path.join(pendingDir(stateDir), `${keyOf(session)}.waker`);
}

function cancelPath(stateDir: string, session: string): string {
  return path.join(pendingDir(stateDir), `${keyOf(session)}.cancel`);
}

interface WakerMark {
  pid: number;
  at: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // 活着但没权限
  }
}

/**
 * 每个 session 只留一个 waker：它每轮都会重读记录，也会跟上新写入的 dueAt。
 * 不去重的话密集触发会堆出几十个常驻 Node 进程（每个都是完整 V8）。
 * 标记写子进程 pid：发起入队的进程（hook）马上就退了，不能拿它做存活判据。
 * 带写入时刻：进程号会被系统复用，光看 pid 会把别人的进程当成自己的 waker。
 * force：重试时必须换新 waker，此时标记里的 pid 正是要退出的这个进程。
 */
function spawnWaker(rec: PendingNotification, cfg: AgentNotifyConfig, force = false): void {
  const marker = wakerPath(cfg.stateDir, rec.session);
  const mark = readJson<WakerMark>(marker);
  if (!force && mark && Date.now() - mark.at < WAKER_TTL_MS && alive(mark.pid)) return;
  const child = spawnSelf(["_wake", keyOf(rec.session)]);
  if (child) atomicWriteText(marker, JSON.stringify({ pid: child, at: Date.now() } satisfies WakerMark));
}

/** 该会话是否在 `at` 之后被取消过（/ack 或新任务）。 */
export function cancelledAfter(stateDir: string, session: string, at: number): boolean {
  const tomb = readJson<number>(cancelPath(stateDir, session));
  return typeof tomb === "number" && tomb > at;
}

/** 写入（或覆盖）待发记录，并确保有一个唤醒进程在等它。 */
export function enqueue(rec: PendingNotification, cfg: AgentNotifyConfig, forceWake = false): void {
  // shortcut: 同毫秒内 notify 会压过 cancel，靠人工操作间隔避开；要严格顺序需换单调序号。
  if (cancelledAfter(cfg.stateDir, rec.session, rec.createdAt)) return; // 取消比这条通知新：晚到的 notify 不能把它复活
  mkdirSync(pendingDir(cfg.stateDir), { recursive: true, mode: 0o700 });
  atomicWriteText(recordPath(cfg.stateDir, rec.session), JSON.stringify(rec));
  // 写完再确认：cancel 可能正好落在上面的检查和这次写之间，不然记录会绕过墓碑活下来
  if (cancelledAfter(cfg.stateDir, rec.session, rec.createdAt)) {
    rmSync(recordPath(cfg.stateDir, rec.session), { force: true });
    return;
  }
  spawnWaker(rec, cfg, forceWake);
}

export function cancel(cfg: AgentNotifyConfig, session: string, at = Date.now()): void {
  // 墓碑记下取消时刻：notify/cancel 各是一条独立子进程，可能乱序执行。晚到的 notify
  // 拿自己的请求时刻 (--at) 比对，发现比墓碑早就不再落记录。
  try {
    mkdirSync(pendingDir(cfg.stateDir), { recursive: true, mode: 0o700 });
    const prev = readJson<number>(cancelPath(cfg.stateDir, session));
    const stamp = typeof prev === "number" && prev > at ? prev : at; // 只增不减，旧的 cancel 不能覆盖新的
    atomicWriteText(cancelPath(cfg.stateDir, session), String(stamp));
  } catch {
    /* 墓碑写不进去也不能耽误取消 */
  }
  // 只删不比这次取消新的记录：进程乱序时，晚到的旧 cancel 不能把新通知删掉。
  // 锁不删：否则并发的 sendDue 会重新认领旧记录。
  const rec = readJson<PendingNotification>(recordPath(cfg.stateDir, session));
  if (!(rec && rec.createdAt > at)) {
    for (const file of [recordPath(cfg.stateDir, session), wakerPath(cfg.stateDir, session)]) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 只读待发记录，给状态栏/诊断用；不认领、不删除。 */
export function pending(cfg: AgentNotifyConfig, session: string): PendingNotification | undefined {
  return readJson<PendingNotification>(recordPath(cfg.stateDir, session));
}

/** 立即通知是否已被更新的 /ack 或排队记录取代；晚到的旧记录不算。 */
export function superseded(cfg: AgentNotifyConfig, session: string, at: number): boolean {
  if (cancelledAfter(cfg.stateDir, session, at)) return true;
  const queued = pending(cfg, session);
  return Boolean(queued && queued.createdAt > at);
}

/** 认领之后记录是否还在（没被 /ack 删掉、也没被同会话的新通知替换）。 */
export function stillLive(stateDir: string, rec: PendingNotification): boolean {
  const cur = readJson<PendingNotification>(recordPath(stateDir, rec.session));
  return Boolean(cur && cur.createdAt === rec.createdAt);
}

/** 所有会话的待发记录（只读），按到期时间排序。 */
export function listPending(cfg: AgentNotifyConfig): PendingNotification[] {
  const dir = pendingDir(cfg.stateDir);
  if (!existsSync(dir)) return [];
  const recs: PendingNotification[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const rec = readJson<PendingNotification>(path.join(dir, file));
    if (rec) recs.push(rec);
  }
  return recs.sort((a, b) => a.dueAt - b.dueAt);
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
  for (const file of [recordPath(stateDir, session), lockPath(stateDir, session), wakerPath(stateDir, session)]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function mergeAggregate(recs: PendingNotification[]): PendingNotification {
  const first = recs[0]!;
  const rest = recs.length - 1;
  const detail = recs.find((r) => r.message)?.message;
  // 条数放在最前面、用逗号连接：build() 只取首句，全角冒号也会被当作句末截掉。
  const message = detail ? `另有 ${rest} 个任务，${detail}` : `另有 ${rest} 个任务`;
  return { ...first, message };
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
    // 认领到真正发之间可能正好按了 /ack：再确认一次，别拿旧快照去发。
    // 同时看墓碑：cancel 删记录失败（如 Windows 文件占用）留下的残记录也不能发。
    const live = claimed.filter((rec) => {
      if (!stillLive(cfg.stateDir, rec)) {
        removeLock(cfg.stateDir, rec.session); // 认领后被 cancel 删除或被新通知替换
        return false;
      }
      if (cancelledAfter(cfg.stateDir, rec.session, rec.createdAt)) {
        // 已作废的残记录直接清掉（记录、锁、waker 标记一起），别让 sweep 反复拉 flush
        cleanup(cfg.stateDir, rec.session);
        return false;
      }
      return true;
    });
    if (live.length === 0) continue;
    const merged = live.length === 1 ? live[0]! : mergeAggregate(live);
    let failed = false;
    try {
      await sender({ ...merged, event }, cfg);
    } catch {
      failed = true;
      appendLog(`level=error event=${event} msg="all channels failed"`);
    }
    for (const rec of live) {
      if (!failed) {
        // 发送途中同会话可能写入了新通知：只清自己那份，别把新的删了。
        const cur = pending(cfg, rec.session);
        if (cur && cur.createdAt === rec.createdAt) {
          cleanup(cfg.stateDir, rec.session);
        } else {
          removeLock(cfg.stateDir, rec.session);
          // 新记录的 enqueue 可能复用了当前这个即将退出的 waker：强制补一个，别让它没人等
          if (cur) spawnWaker(cur, cfg, true);
        }
        continue;
      }
      // 发送途中被 cancel（/ack、新任务），或同会话已写入新通知：不能用旧快照复活/覆盖，锁也要解开。
      const cur = readJson<PendingNotification>(recordPath(cfg.stateDir, rec.session));
      if (!cur || cur.createdAt !== rec.createdAt) {
        removeLock(cfg.stateDir, rec.session);
        continue;
      }
      const retries = (rec.retries ?? 0) + 1;
      if (retries > MAX_RETRIES) {
        cleanup(cfg.stateDir, rec.session);
        continue;
      }
      // 自己的锁老了但还没过 STALE_LOCK_MS，不主动解就会挡住自己的重试。
      removeLock(cfg.stateDir, rec.session);
      // force：标记里是当前这个正要退出的 waker 的 pid，不去重就会留下没人等的记录。
      enqueue({ ...rec, retries, dueAt: Date.now() + RETRY_MS }, cfg, true);
    }
    sent += live.length;
  }
  return sent;
}

/** 刷新自己标记的时间戳：waker 会跟着新 dueAt 一直等下去，长期活跃的会话不能因此被判成残留。 */
function touchWaker(stateDir: string, session: string): void {
  const marker = wakerPath(stateDir, session);
  const mark = readJson<WakerMark>(marker);
  if (mark?.pid === process.pid) atomicWriteText(marker, JSON.stringify({ pid: process.pid, at: Date.now() }));
}

/** 阻塞到记录到期，再交给 sendDue（聚合也在那里做）。 */
export async function wake(sessionKey: string, cfg: AgentNotifyConfig): Promise<void> {
  try {
    for (;;) {
      touchWaker(cfg.stateDir, sessionKey);
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
  } finally {
    // 只动自己的标记：重试已经换成了新的 waker，删掉它就没人等这条记录了。
    const marker = wakerPath(cfg.stateDir, sessionKey);
    if (readJson<WakerMark>(marker)?.pid === process.pid) {
      rmSync(marker, { force: true });
      // 先删标记再看记录：并发的 enqueue 要么看到标记已删、自己拉 waker，要么复用本 waker
      // 但记录已落盘、这里能看到。sendDue 的替换/失败分支不补 waker 时，靠这里接力。
      const rec = readJson<PendingNotification>(recordPath(cfg.stateDir, sessionKey));
      if (rec) spawnWaker(rec, cfg);
    }
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
