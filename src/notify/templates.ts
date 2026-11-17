/**
 * 文件功能：通知的标题与正文拼装规则（正文首句截断，含覆盖与长度截断）。
 */

import { MAX_BODY, TITLES, type NotifyEvent } from "../config/constant.js";

export interface NotifyRecord {
  event: NotifyEvent;
  agent?: string;
  cwd?: string;
  session?: string;
  message?: string;
  /** 覆盖本条通知的 config.bark.icon。 */
  icon?: string;
}

export interface NotifyMessage {
  title: string;
  body: string;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 优先截在首个句号或换行处，折叠空白；没有边界才按长度硬截断。 */
export function firstSentence(text: string, max: number): string {
  const boundary = /[。！？!?\n]|\.(?=\s|$)/.exec(text);
  const cut = boundary ? text.slice(0, boundary.index + boundary[0].length) : text;
  return clamp(cut.replace(/\s+/g, " ").trim(), max);
}

export function build(rec: NotifyRecord): NotifyMessage {
  const label = TITLES[rec.event];
  const summary = rec.message ? firstSentence(rec.message, Math.max(1, MAX_BODY - label.length - 3)) : "";
  const detail = summary ? ` · ${summary}` : "";
  return {
    title: rec.agent ?? "agent",
    body: label + detail,
  };
}
