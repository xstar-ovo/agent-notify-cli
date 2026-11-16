/**
 * 文件功能：读取仓库根目录的 .env，取测试用的 Bark key。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FALLBACK = "TESTKEYnotARealKey0123";

function loadDotEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    // 已存在的环境变量优先，不覆盖
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();

/** 测试用 key：.env / 环境变量里有就用，否则用假 key（不会真的推送）。 */
export function testBarkKey(): string {
  return (process.env.BARK_TEST_KEY || process.env.BARK_DEVICE_KEY || FALLBACK).trim();
}
