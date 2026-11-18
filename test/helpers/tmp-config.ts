/**
 * 文件功能：把 HOME 与配置/日志目录指向临时目录；必须排在所有被测模块之前 import，
 * 因为 config/setup 的路径常量在 import 时求值（Node 24 上 HOME 被忽略，Windows 读 USERPROFILE，两个都设）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "an-tmp-"));

process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.AGENT_NOTIFY_CONFIG_DIR = dir;
process.env.AGENT_NOTIFY_CONFIG = path.join(dir, "config.json");

/** 临时根目录（= 本进程的 HOME / configDir / logPath 所在目录）。 */
export const tmpRoot = dir;

after(() => rmSync(dir, { recursive: true, force: true }));
