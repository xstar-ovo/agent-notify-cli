/**
 * 文件功能：把 Claude Code 的 hooks、状态栏和 /ack 命令合并进 ~/.claude。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText } from "../util/atomic.js";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
export const CLAUDE_STATUSLINE_PATH = path.join(CLAUDE_DIR, "agent-notify-statusline.cjs");
export const CLAUDE_ACK_PATH = path.join(CLAUDE_DIR, "commands", "ack.md");
const CLAUDE_STATUSLINE_META_PATH = path.join(CLAUDE_DIR, "agent-notify-statusline.json");

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
// fnm/nvm 的 process.execPath 可能是临时 shell 路径；Claude Hook 在 shell 里执行，写稳定路径更可靠。
const NODE_PATH = process.env.AGENT_NOTIFY_NODE || (() => {
  if (!/^node(\.exe)?$/i.test(path.basename(process.execPath))) return "node";
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
})();

const STATUSLINE_MARKER = "由 agent-notify setup 生成，请勿手改";
const ACK_MARKER = "由 agent-notify setup 生成，请勿手改";

/** 通知图标（Bark 用）。 */
const ICON = "https://img.cdn1.vip/i/6afc6a1c7dec3_1794927132.png";

interface HookSpec {
  event: "Stop" | "Notification" | "UserPromptSubmit";
  args: string[];
  matcher?: string;
  timeout: number;
}

const SPECS: HookSpec[] = [
  { event: "Stop", args: ["notify", "stop", "--stdin-json", "--icon", ICON], timeout: 10 },
  {
    event: "Notification",
    matcher: "permission_prompt",
    args: ["notify", "notification", "--stdin-json", "--icon", ICON],
    timeout: 10,
  },
  { event: "UserPromptSubmit", args: ["cancel", "--stdin-json"], timeout: 5 },
];

type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function commandFor(spec: HookSpec): string {
  return `${quote(NODE_PATH)} ${quote(CLI_PATH)} --agent claude ${spec.args.join(" ")}`;
}

function signatureFor(spec: HookSpec): string {
  return `--agent claude ${spec.args.join(" ")}`;
}

/** 本工具的 hook 一定是 `node …/cli.js --agent claude …`；只认 cli.js 入口，不误伤别的工具或用户手写的 bin 调用。 */
function isOurs(command: unknown): boolean {
  return typeof command === "string" &&
    command.includes("--agent claude") && command.includes("--stdin-json") &&
    /cli\.js\b/.test(command);
}

/** 删掉本工具旧版本写下的 hooks（命令是本工具的但签名已过期）。 */
function dropStaleHooks(settings: JsonObject): void {
  const current = SPECS.map((spec) => signatureFor(spec));
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const next = [];
    for (const group of list) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter((hook) =>
        !(isObject(hook) && isOurs(hook.command) &&
          !current.some((sig) => hook.command.includes(sig))));
      if (hooks.length === group.hooks.length) next.push(group);
      else {
        changed = true;
        if (hooks.length > 0) next.push({ ...group, hooks });
      }
    }
    if (!changed) continue;
    if (next.length > 0) settings.hooks[event] = next;
    else delete settings.hooks[event];
  }
}

function refreshOurs(group: unknown, spec: HookSpec, command: string): { group: unknown; found: boolean } {
  if (!isObject(group) || !Array.isArray(group.hooks)) return { group, found: false };
  let found = false;
  const hooks = group.hooks.map((hook) => {
    if (!isObject(hook) || typeof hook.command !== "string" ||
        !hook.command.includes(signatureFor(spec))) return hook;
    found = true;
    return { ...hook, type: "command", command, timeout: spec.timeout };
  });
  const next: JsonObject = found ? { ...group, hooks } : group as JsonObject;
  // 旧版本可能没写 matcher；只有本工具一条时才补，避免影响同组的用户 hook。
  if (found && spec.matcher && group.hooks.length === 1) next.matcher = spec.matcher;
  return { group: next, found };
}

/** 合并 Claude Code hooks；输入对象不会被修改。 */
export function mergeClaudeHooks(settings: unknown): JsonObject {
  if (!isObject(settings)) throw new Error("settings.json 顶层不是对象");
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!isObject(hooks)) throw new Error("settings.json 的 hooks 不是对象");

  const next = { ...settings, hooks: { ...hooks } };
  dropStaleHooks(next);
  for (const spec of SPECS) {
    const existing = next.hooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`settings.json 的 hooks.${spec.event} 不是数组`);
    }
    let found = false;
    const command = commandFor(spec);
    const list = (Array.isArray(existing) ? existing : []).map((group) => {
      const refreshed = refreshOurs(group, spec, command);
      if (refreshed.found) found = true;
      return refreshed.group;
    });
    if (!found) {
      const handler = { type: "command", command, timeout: spec.timeout };
      list.push(spec.matcher ? { matcher: spec.matcher, hooks: [handler] } : { hooks: [handler] });
    }
    next.hooks[spec.event] = list;
  }
  return next;
}

/** 移除本工具写入的 hooks；输入对象不会被修改，返回是否发生变化。 */
export function stripClaudeHooks(settings: unknown): { settings: JsonObject; changed: boolean } {
  if (!isObject(settings)) throw new Error("settings.json 顶层不是对象");
  if (!isObject(settings.hooks)) return { settings, changed: false };

  const hooks: JsonObject = { ...settings.hooks };
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;

    let eventChanged = false;
    const next = [];
    for (const group of list) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const kept = group.hooks.filter((hook) => !(isObject(hook) && isOurs(hook.command)));
      if (kept.length === group.hooks.length) {
        next.push(group);
      } else {
        eventChanged = true;
        changed = true;
        if (kept.length > 0) next.push({ ...group, hooks: kept });
      }
    }

    if (next.length === 0) {
      if (eventChanged) {
        delete hooks[event];
        changed = true;
      }
    } else if (eventChanged) {
      hooks[event] = next;
    }
  }

  const next = { ...settings };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return { settings: next, changed };
}

const STATUSLINE_COMMAND = `${quote(NODE_PATH)} ${quote(CLAUDE_STATUSLINE_PATH)}`;

export function isOurStatuslineCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(CLAUDE_STATUSLINE_PATH);
}

function statuslineMeta(): { original: JsonObject | null } | undefined {
  try {
    const data = JSON.parse(readFileSync(CLAUDE_STATUSLINE_META_PATH, "utf8"));
    if (isObject(data) && (data.original === null || isObject(data.original))) {
      return { original: data.original as JsonObject | null };
    }
  } catch {
    /* 没有或损坏时按没有原状态栏处理 */
  }
  return undefined;
}

function writeStatuslineMeta(original: JsonObject | null): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  atomicWriteText(CLAUDE_STATUSLINE_META_PATH, `${JSON.stringify({ original }, null, 2)}\n`);
}

/** 生成状态栏包装脚本：先跑原来的 statusLine，再追加 agent-notify 的待发提示。 */
export function claudeStatuslineContent(original?: string): string {
  return [
    `// ${STATUSLINE_MARKER}`,
    `const { spawnSync } = require("node:child_process");`,
    `const { readFileSync } = require("node:fs");`,
    `const ORIGINAL = ${JSON.stringify(original ?? null)};`,
    `let input = "";`,
    `try { input = readFileSync(0, "utf8"); } catch {}`,
    `const original = ORIGINAL ? spawnSync(ORIGINAL, { input, encoding: "utf8", timeout: 5000, windowsHide: true, shell: true }) : null;`,
    `const ours = spawnSync(${JSON.stringify(NODE_PATH)}, [${JSON.stringify(CLI_PATH)}, "_statusline"], { input, encoding: "utf8", timeout: 5000, windowsHide: true });`,
    `const originalText = original?.stdout ?? "";`,
    `const parts = [originalText, ours.status === 0 ? ours.stdout : ""].filter((part) => part && part.trim());`,
    `if (parts.length) process.stdout.write(parts.map((part) => part.trimEnd()).join("  "));`,
    "",
  ].join("\n");
}

function installStatusline(settings: JsonObject): JsonObject {
  const current = settings.statusLine;
  if (current !== undefined && !isObject(current)) return settings; // 用户用了非常规结构，别动

  const ours = isObject(current) && isOurStatuslineCommand(current.command);
  let original = ours ? (statuslineMeta()?.original ?? null) : (isObject(current) ? current : null);
  if (isObject(original) && typeof original.command === "string" &&
      original.command.includes(CLAUDE_STATUSLINE_PATH)) {
    original = null; // 防止包装脚本递归调用自己
  }

  if (!ours) writeStatuslineMeta(original);
  const originalCommand = isObject(original) && typeof original.command === "string"
    ? original.command
    : undefined;
  atomicWriteText(CLAUDE_STATUSLINE_PATH, claudeStatuslineContent(originalCommand));

  const statusLine: JsonObject = {
    type: "command",
    command: STATUSLINE_COMMAND,
    refreshInterval: 1,
  };
  if (isObject(original) && typeof original.padding === "number") statusLine.padding = original.padding;
  if (isObject(original) && original.hideVimModeIndicator === true) statusLine.hideVimModeIndicator = true;
  return { ...settings, statusLine };
}

function restoreStatusline(settings: JsonObject): { settings: JsonObject; changed: boolean } {
  if (!isObject(settings.statusLine) || !isOurStatuslineCommand(settings.statusLine.command)) {
    return { settings, changed: false };
  }
  const next = { ...settings };
  const original = statuslineMeta()?.original ?? null;
  if (isObject(original) && typeof original.command === "string" &&
      original.command.includes(CLAUDE_STATUSLINE_PATH)) {
    delete next.statusLine;
  } else if (isObject(original)) {
    next.statusLine = original;
  } else {
    delete next.statusLine;
  }
  return { settings: next, changed: true };
}

function removeStatuslineFiles(): void {
  for (const file of [CLAUDE_STATUSLINE_PATH, CLAUDE_STATUSLINE_META_PATH]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 生成 /ack 命令文件；实际取消由 UserPromptSubmit hook 拦截完成。 */
export function claudeAckContent(): string {
  return [
    "---",
    `# ${ACK_MARKER}`,
    "description: 取消当前会话还没发出的通知",
    "disable-model-invocation: true",
    "---",
    "取消待发通知。",
    "",
  ].join("\n");
}

function writeClaudeAck(): "written" | "unchanged" | "exists" {
  const content = claudeAckContent();
  if (existsSync(CLAUDE_ACK_PATH)) {
    try {
      const text = readFileSync(CLAUDE_ACK_PATH, "utf8");
      if (text === content) return "unchanged";
      if (!text.includes(ACK_MARKER)) return "exists";
    } catch {
      return "exists";
    }
  }
  mkdirSync(path.dirname(CLAUDE_ACK_PATH), { recursive: true });
  atomicWriteText(CLAUDE_ACK_PATH, content);
  return "written";
}

function removeClaudeAck(): boolean {
  if (!existsSync(CLAUDE_ACK_PATH)) return false;
  try {
    if (!readFileSync(CLAUDE_ACK_PATH, "utf8").includes(ACK_MARKER)) return false;
    rmSync(CLAUDE_ACK_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readSettings(): { text?: string; data?: JsonObject; invalid?: boolean } {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return { data: {} };
  try {
    const text = readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
    const data = JSON.parse(text);
    return isObject(data) ? { text, data } : { text, invalid: true };
  } catch {
    return { invalid: true };
  }
}

function writeSettings(next: JsonObject): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    const backup = `${CLAUDE_SETTINGS_PATH}.bak.${Date.now()}`;
    copyFileSync(CLAUDE_SETTINGS_PATH, backup);
    try {
      chmodSync(backup, 0o600);
    } catch {
      /* Windows 上可能不支持，忽略 */
    }
  }
  atomicWriteText(CLAUDE_SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

export function detectClaude(): string | undefined {
  return existsSync(CLAUDE_DIR) ? "~/.claude/settings.json" : undefined;
}

function hookCommands(settings: JsonObject): string[] {
  const out: string[] = [];
  const hooks = settings.hooks;
  if (!isObject(hooks)) return out;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isObject(hook) && typeof hook.command === "string") out.push(hook.command);
      }
    }
  }
  return out;
}

/** hooks 是否为当前签名；旧版本写入的算 outdated，供 doctor 提示重跑 setup。 */
export function claudeHooksStatus(settings?: unknown): "current" | "outdated" | "missing" | "invalid" {
  if (settings !== undefined) return statusOf(settings);
  const current = readSettings();
  if (current.invalid) return "invalid";
  return statusOf(current.data ?? {});
}

function statusOf(settings: unknown): "current" | "outdated" | "missing" {
  if (!isObject(settings)) return "missing";
  const commands = hookCommands(settings);
  // 只比参数签名：换 node 版本 / 安装路径后命令仍能用，不该报 outdated。
  if (SPECS.every((spec) => commands.some((cmd) => cmd.includes(signatureFor(spec))))) return "current";
  return commands.some(isOurs) ? "outdated" : "missing";
}

/** dry-run 只展示将添加的 hooks 和状态栏入口，不展示用户 settings 里的凭据。 */
export function claudeHooksPreview(): string {
  try {
    return JSON.stringify({
      hooks: mergeClaudeHooks({}).hooks,
      statusLine: { type: "command", command: STATUSLINE_COMMAND, refreshInterval: 1 },
      ack: "~/.claude/commands/ack.md",
    }, null, 2);
  } catch {
    return "（无法生成 Claude hooks 预览）";
  }
}

export function writeClaudeHooks(): "written" | "unchanged" | "invalid" {
  const current = readSettings();
  if (current.invalid) return "invalid";
  const next = installStatusline(mergeClaudeHooks(current.data ?? {}));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const ack = writeClaudeAck();
  if (current.text === text && ack === "unchanged") return "unchanged";
  if (current.text !== text) writeSettings(next);
  return "written";
}

export function removeClaudeHooks(): "removed" | "absent" | "invalid" {
  const current = readSettings();
  if (current.invalid) return "invalid";
  const stripped = stripClaudeHooks(current.data ?? {});
  const restored = restoreStatusline(stripped.settings);
  const changed = stripped.changed || restored.changed;
  const ackRemoved = removeClaudeAck();
  removeStatuslineFiles();
  if (!changed && !ackRemoved) return "absent";
  if (changed) writeSettings(restored.settings);
  return "removed";
}
