/**
 * 文件功能：配置结构定义、默认值，以及把用户输入归一化的规则（含延迟上限截断）。
 */

import path from "node:path";
import { DEFAULT_DELAY_MS, EVENTS, MAX_DELAY_CEILING_MS, MAX_DELAY_MS, type NotifyEvent } from "./constant.js";
import { configDir } from "./paths.js";

export * from "./constant.js";

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
    timeoutMs: clamp(num(r.timeoutMs, 10_000), 200, 30_000),
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
  timeoutMs: 10_000,
  delayMs: {
    ...DEFAULT_DELAY_MS,
    max: MAX_DELAY_MS,
  },
  aggregateWindowMs: 5000,
};
