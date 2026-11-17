/**
 * 文件功能：通知的标题、副标题与正文拼装规则（含覆盖与长度截断）。
 */

import path from "node:path";
import { MAX_BODY, MAX_SUBTITLE, MAX_TITLE, TITLES, type NotifyEvent } from "../config/constant.js";

export interface NotifyRecord {
  event: NotifyEvent;
  agent?: string;
  cwd?: string;
  session?: string;
  message?: string;
  /** 覆盖该事件的默认文案（现在显示为副标题）。 */
  title?: string;
  /** 覆盖本条通知的 config.bark.icon。 */
  icon?: string;
}

export interface NotifyMessage {
  title: string;
  subtitle: string;
  body: string;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function build(rec: NotifyRecord): NotifyMessage {
  const project = rec.cwd ? path.basename(rec.cwd) : undefined;
  const custom = rec.title?.replace(/\s+/g, " ").trim();
  return {
    title: clamp([rec.agent ?? "agent", project].filter(Boolean).join(" · "), MAX_TITLE),
    subtitle: custom ? clamp(custom, MAX_SUBTITLE) : TITLES[rec.event],
    body: clamp(rec.message ?? "", MAX_BODY),
  };
}
