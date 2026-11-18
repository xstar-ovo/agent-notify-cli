/**
 * 文件功能：读写配置文件：解析 `{env:VAR}`、缺失时生成默认配置、持久化 Bark key。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteText } from "../util/atomic.js";
import { configDir, configPath, expandHome } from "./paths.js";
import { DEFAULT_CONFIG_JSON, normalize, type AgentNotifyConfig } from "./schema.js";

const ENV_RE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** 把 `{env:VAR}` 换成对应环境变量的值；取不到时变成 undefined。 */
export function resolveEnv(value: unknown): unknown {
  if (typeof value === "string") {
    const m = ENV_RE.exec(value);
    return m ? process.env[m[1]!] : value;
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnv(v)]),
    );
  }
  return value;
}

export function loadConfig(file: string = configPath): { config: AgentNotifyConfig; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    warnings.push((err as NodeJS.ErrnoException).code === "ENOENT" ? "config missing" : "config invalid");
  }
  const stale = staleKeys(raw);
  if (stale.length > 0) {
    warnings.push(`config has unknown keys: ${stale.join(", ")} (renamed in an upgrade? safe to delete)`);
  }
  const config = normalize(resolveEnv(raw), warnings);
  config.stateDir = expandHome(config.stateDir);
  return { config, warnings };
}

/**
 * 找出配置里已不再生效的字段（旧版本残留 / 拼错）。只报告不删除：配置文件是用户数据，
 * 真要改名时由那个版本的迁移逻辑显式搬字段，不能拿"清理未知键"当通用手段。
 */
function staleKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const out: string[] = [];
  walk(raw, normalize({}) as unknown as Record<string, unknown>, "", out);
  return out;
}

function walk(value: Record<string, unknown>, known: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in known)) {
      out.push(path);
    } else if (isRecord(known[key]) && isRecord(child)) {
      walk(child, known[key], path, out);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 只在配置文件缺失时创建，真正写入了才返回 true。 */
export function ensureConfigFile(): boolean {
  if (existsSync(configPath)) return false;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG_JSON, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/**
 * 把用户粘贴的内容归一成 Bark key：可能是整条 URL、带引号，或前后带空白。
 */
export function parseBarkKeyInput(input: string): string {
  const t = input.trim().replace(/^["']+|["']+$/g, "").trim();
  const m = /^https?:\/\/[^/\s]+\/([^/?#\s]+)/.exec(t);
  return m ? m[1]! : t;
}

/**
 * 把 Bark key 写进配置文件，重启、换终端后依然有效。
 * 配置文件无法解析时直接报错，绝不覆盖（避免静默丢数据）。
 */
export function saveDeviceKey(key: string, file: string = configPath): void {
  const trimmed = key.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error("Bark key 不能为空或包含空白字符");

  let raw: Record<string, any>;
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`配置文件不是合法 JSON，请先手动修复：${file}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`配置文件结构不正确，请先手动修复：${file}`);
    }
  } else {
    raw = JSON.parse(JSON.stringify(DEFAULT_CONFIG_JSON)) as Record<string, any>;
  }

  raw.bark = { enabled: true, ...(raw.bark ?? {}), deviceKey: trimmed };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteText(file, JSON.stringify(raw, null, 2) + "\n");
}
