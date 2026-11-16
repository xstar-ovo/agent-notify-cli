/**
 * 文件功能：通知的标题与正文拼装规则（含任务名覆盖与长度截断）。
 */

import path from "node:path";
import type { NotifyEvent } from "../config/schema.js";

export interface NotifyRecord {
  event: NotifyEvent;
  agent?: string;
  cwd?: string;
  session?: string;
  message?: string;
  /** 覆盖该事件的默认标题（例如当前任务名）。 */
  title?: string;
  /** 覆盖本条通知的 config.bark.icon。 */
  icon?: string;
}

const TITLES: Record<NotifyEvent, string> = {
  stop: "任务完成",
  settled: "任务完成",
  notification: "等待处理",
  error: "任务出错",
};

const MAX_BODY = 200;
const MAX_TITLE = 60;

export function build(rec: NotifyRecord): { title: string; body: string } {
  const project = rec.cwd ? path.basename(rec.cwd) : undefined;
  const who = [rec.agent ?? "agent", project].filter(Boolean).join(" · ");
  const sid = rec.session ? ` #${rec.session.slice(0, 10)}` : "";
  const body = [who + sid, rec.message].filter(Boolean).join("\n");
  const custom = rec.title?.replace(/\s+/g, " ").trim();
  const title = custom
    ? custom.length > MAX_TITLE
      ? `${custom.slice(0, MAX_TITLE - 1)}…`
      : custom
    : TITLES[rec.event];
  return { title, body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body };
}
