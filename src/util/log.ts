/**
 * 文件功能：error.log 追加、大小轮转，永不抛异常。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { configDir, logPath } from "../config/paths.js";

const MAX_LOG_BYTES = 1024 * 1024;

/** 往 error.log 追加一行，永不抛异常。 */
export function appendLog(line: string): void {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line.replace(/\s*[\r\n]+\s*/g, " ")}\n`, { mode: 0o600 });
  } catch {
    /* 写日志绝不能把 CLI 弄崩 */
  }
}
