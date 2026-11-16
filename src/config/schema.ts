/**
 * 文件功能：配置结构定义、默认值，以及把用户输入归一化的规则（含延迟上限截断）。
 */

import path from "node:path";
import { configDir } from "./paths.js";

export const EVENTS = ["stop", "notification", "error", "settled"] as const;
export type NotifyEvent = (typeof EVENTS)[number];

export interface BarkConfig {
  enabled: boolean;
  endpoint: string;
  deviceKey?: string;
  group: string;
  level: string;
  icon?: string;
}

export interface AgentNotifyConfig {
  bark: BarkConfig;
  events: Record<NotifyEvent, { bark: boolean }>;
  timeoutMs: number;
  delayMs: Record<NotifyEvent | "max", number>;
  aggregateWindowMs: number;
  stateDir: string;
}

/**
 * 延迟常量：都写成 分钟 * 60 * 1000，改前面的分钟数就行。
 *
 * 为什么不是一个值：四个事件的心智不一样。
 * - 完成类（stop/settled）要缓一下：人大概率还在屏幕前，或者马上接着追问，
 *   立刻推就是噪音；缓 3 分钟还没动静，才是真的离开了。
 * - 出错和等你操作要立即：这两种是「不推就会浪费你的时间」——报错了你可能在白等，
 *   等你确认时任务已经卡死，缓 3 分钟毫无意义。
 */

/** Claude Code Stop hook 触发（一轮回答结束，可能还有后续）。 */
export const STOP_DELAY_MS = 3 * 60 * 1000;

/** Pi agent_settled 触发（任务真的结束，不会自动继续）。 */
export const SETTLED_DELAY_MS = 5 * 60 * 1000;

/** 任务出错，立即推。 */
export const ERROR_DELAY_MS = 0;

/** 需要你操作（等确认 / 等输入），立即推。 */
export const NOTIFICATION_DELAY_MS = 0;

/**
 * 延迟的上限，分两层：
 * - MAX_DELAY_MS 是默认值，用户可以改（--delay 或 config 的 delayMs.max），
 *   用来套住单条延迟，避免把通知拖到信息过期。
 * - MAX_DELAY_CEILING_MS 是代码里的硬上限，配置再怎么写也不会超过它，
 *   避免写错一个 0（比如 5 小时）就把 waker 子进程挂一整天。
 */
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const MAX_DELAY_CEILING_MS = 15 * 60 * 1000;

export const DEFAULT_DELAY_MS: Record<NotifyEvent, number> = {
  stop: STOP_DELAY_MS,
  settled: SETTLED_DELAY_MS,
  error: ERROR_DELAY_MS,
  notification: NOTIFICATION_DELAY_MS,
};

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function num(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

function str(v: unknown, def: string): string {
  return typeof v === "string" && v.length > 0 ? v : def;
}

export function normalize(raw: unknown, warnings: string[] = []): AgentNotifyConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const barkRaw = (r.bark && typeof r.bark === "object" ? r.bark : {}) as Record<string, any>;
  const max = clamp(num(r.delayMs?.max, MAX_DELAY_MS), 0, MAX_DELAY_CEILING_MS);

  const delayMs = {} as Record<NotifyEvent | "max", number>;
  for (const e of EVENTS) delayMs[e] = clamp(num(r.delayMs?.[e], DEFAULT_DELAY_MS[e]), 0, max);
  delayMs.max = max;

  const events = {} as Record<NotifyEvent, { bark: boolean }>;
  for (const e of EVENTS) events[e] = { bark: r.events?.[e]?.bark !== false };

  const deviceKey = typeof barkRaw.deviceKey === "string" ? barkRaw.deviceKey : undefined;
  if (barkRaw.enabled !== false && !deviceKey) warnings.push("bark deviceKey unresolved");

  return {
    bark: {
      enabled: barkRaw.enabled !== false,
      endpoint: str(barkRaw.endpoint, "https://api.day.app/{device_key}"),
      deviceKey,
      group: str(barkRaw.group, "agent-notify"),
      level: str(barkRaw.level, "active"),
      icon: str(barkRaw.icon, "") || undefined,
    },
    events,
    timeoutMs: clamp(num(r.timeoutMs, 3000), 200, 30_000),
    delayMs,
    aggregateWindowMs: clamp(num(r.aggregateWindowMs, 5000), 0, 60_000),
    stateDir: str(r.stateDir, path.join(configDir, "state")),
  };
}

/** 没有配置文件时，`setup` 写入的默认内容。 */
export const DEFAULT_CONFIG_JSON = {
  bark: {
    enabled: true,
    endpoint: "https://api.day.app/{device_key}",
    deviceKey: "{env:BARK_DEVICE_KEY}",
    group: "agent-notify",
    level: "active",
  },
  events: {
    stop: { bark: true },
    notification: { bark: true },
    error: { bark: true },
    settled: { bark: true },
  },
  timeoutMs: 3000,
  delayMs: {
    stop: STOP_DELAY_MS,
    settled: SETTLED_DELAY_MS,
    error: ERROR_DELAY_MS,
    notification: NOTIFICATION_DELAY_MS,
    max: MAX_DELAY_MS,
  },
  aggregateWindowMs: 5000,
};
