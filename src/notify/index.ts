/**
 * 文件功能：渠道分发入口：按事件把通知发给已启用的渠道。
 */

import type { AgentNotifyConfig } from "../config/schema.js";
import { appendLog } from "../util/log.js";
import { redact } from "../util/redact.js";
import { sendBark } from "./bark.js";
import { build, type NotifyRecord } from "./templates.js";

/** 该事件启用了渠道才发；失败写日志并向上抛。 */
export async function sendNow(rec: NotifyRecord, cfg: AgentNotifyConfig): Promise<void> {
  if (!(cfg.bark.enabled && cfg.events[rec.event]?.bark)) return;
  try {
    await sendBark(build(rec), cfg, rec.icon);
  } catch (err: unknown) {
    appendLog(`level=error event=${rec.event} channel=bark err="${redact(String(err))}"`);
    throw new Error("all channels failed");
  }
}
