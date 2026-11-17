/**
 * 文件功能：手动命令（status / doctor）检查 npm 上是否有新版本；结果缓存 24 小时，失败一律静默。
 * hook 路径不调用这里——每次停顿都发网络请求会拖慢通知。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config/paths.js";

const REGISTRY = "https://registry.npmjs.org/agent-notify-cli/latest";
const TTL_MS = 24 * 60 * 60 * 1000;
const cacheFile = path.join(configDir, "update-check.json");

/** 返回比当前版本新的最新版本号；已是最新、离线、超时都返回 undefined。 */
export async function checkUpdate(current = ownVersion()): Promise<string | undefined> {
  let latest = readCache();
  if (!latest) {
    latest = await fetchLatest();
    if (latest) writeCache(latest);
  }
  return latest && isNewer(latest, current) ? latest : undefined;
}

export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function readCache(): string | undefined {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { at?: number; latest?: unknown };
    return typeof cached.at === "number" && typeof cached.latest === "string" &&
      Date.now() - cached.at < TTL_MS ? cached.latest : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), latest }));
  } catch {
    // 缓存写不进去不影响主流程。
  }
}

async function fetchLatest(): Promise<string | undefined> {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const version = ((await res.json()) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** 从本包的 package.json 取版本号，dist 与 dist-test 两种布局都能往上找到。 */
function ownVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "agent-notify-cli" && pkg.version) return pkg.version;
    } catch {
      // 这一层没有 package.json，继续往上。
    }
    dir = path.dirname(dir);
  }
  return "0.0.0";
}
