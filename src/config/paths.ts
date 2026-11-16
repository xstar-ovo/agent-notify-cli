/**
 * 文件功能：配置目录、配置文件、状态目录的路径常量。
 */

import os from "node:os";
import path from "node:path";

export const configDir =
  process.env.AGENT_NOTIFY_CONFIG_DIR ?? path.join(os.homedir(), ".config", "agent-notify");

export const configPath = process.env.AGENT_NOTIFY_CONFIG ?? path.join(configDir, "config.json");

export const logPath = path.join(configDir, "error.log");

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\")
    ? path.join(os.homedir(), p.slice(1))
    : p;
}
