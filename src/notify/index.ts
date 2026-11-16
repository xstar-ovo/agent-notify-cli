/**
 * 文件功能：渠道分发入口：按事件把同一条通知发给所有已启用的渠道。
 */

import type { AgentNotifyConfig } from "../config/schema.js";
import { appendLog } from "../util/log.js";
import { redact } from "../util/redact.js";
import { sendBark } from "./bark.js";
import { build, type NotifyRecord } from "./templates.js";

/** 通过该事件启用的所有渠道发送；失败写日志，只有全失败才抛出。 */
export async function sendNow(rec: NotifyRecord, cfg: AgentNotifyConfig): Promise<void> {
  const msg = build(rec);
  const tasks: Promise<void>[] = [];

  if (cfg.bark.enabled && cfg.events[rec.event]?.bark) {
    tasks.push(
      sendBark(msg, cfg, rec.icon).catch((err: unknown) => {
        appendLog(`level=error event=${rec.event} channel=bark err="${redact(String(err))}"`);
        throw err;
      }),
    );
  }

  if (tasks.length === 0) return;
  const results = await Promise.allSettled(tasks);
  if (results.every((r) => r.status === "rejected")) throw new Error("all channels failed");
}
