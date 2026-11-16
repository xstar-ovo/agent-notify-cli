/**
 * 文件功能：通知的标题、副标题与正文拼装规则（含覆盖与长度截断）。
 */

import path from "node:path";
import type { NotifyEvent } from "../config/schema.js";

export interface NotifyRecord {
  event: NotifyEvent;
  agent?: string;
  cwd?: string;
  session?: string;
  message?: string;
  /** 覆盖该事件的默认标题。 */
  title?: string;
  /** 覆盖本条通知的 config.bark.icon。 */
  icon?: string;
}

export interface NotifyMessage {
  title: string;
  subtitle: string;
  body: string;
}

const TITLES: Record<NotifyEvent, string> = {
  stop: "任务完成",
  settled: "任务完成",
  notification: "等待处理",
  error: "任务出错",
};

const MAX_TITLE = 60;
const MAX_SUBTITLE = 60;
const MAX_BODY = 200;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function build(rec: NotifyRecord): NotifyMessage {
  const project = rec.cwd ? path.basename(rec.cwd) : undefined;
  const custom = rec.title?.replace(/\s+/g, " ").trim();
  return {
    title: custom ? clamp(custom, MAX_TITLE) : TITLES[rec.event],
    subtitle: clamp([rec.agent ?? "agent", project].filter(Boolean).join(" · "), MAX_SUBTITLE),
    body: clamp(rec.message ?? "", MAX_BODY),
  };
}
