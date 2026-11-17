/**
 * 文件功能：Bark 推送渠道：POST JSON，按 code 判断成败。
 */

import type { AgentNotifyConfig } from "../config/schema.js";
import type { NotifyMessage } from "./templates.js";

export async function sendBark(
  msg: NotifyMessage,
  cfg: AgentNotifyConfig,
  icon?: string,
): Promise<void> {
  const key = cfg.bark.deviceKey;
  if (!key) throw new Error("bark deviceKey missing");

  const url = cfg.bark.endpoint.includes("{device_key}")
    ? cfg.bark.endpoint.replace("{device_key}", key)
    : `${cfg.bark.endpoint.replace(/\/+$/, "")}/${key}`;

  const image = icon ?? cfg.bark.icon;
  const payload = {
    title: msg.title,
    body: msg.body,
    group: cfg.bark.group,
    level: cfg.bark.level,
    ...(image ? { icon: image } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  if (!res.ok || (typeof data.code === "number" && data.code !== 200)) {
    throw new Error(`bark status=${res.status} code=${data.code ?? "-"} ${data.message ?? ""}`.trim());
  }
}
