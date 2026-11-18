/**
 * 文件功能：以分离进程方式再启动本 CLI（延迟唤醒、后台补发）。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** 以分离进程再跑一次本 CLI（延迟唤醒、后台补发），永不抛异常；返回子进程 pid。 */
export function spawnSelf(args: string[]): number | undefined {
  try {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } catch {
    return undefined; // 后台调度尽力而为，失败就算了
  }
}
