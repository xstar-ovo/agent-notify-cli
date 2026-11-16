/**
 * 文件功能：生成并安装 Pi 扩展（agent_start 取消待发、agent_settled 发通知）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText } from "../util/atomic.js";

export const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const PI_EXTENSION_DIR = path.join(PI_AGENT_DIR, "extensions");
export const PI_EXTENSION_PATH = path.join(PI_EXTENSION_DIR, "agent-notify.ts");

const MARKER = "由 agent-notify setup 生成";
const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

const PI_TEMPLATE = `// ${MARKER}，请勿手改；重新运行 \`agent-notify setup\` 覆盖。
import { spawn } from "node:child_process";

const CLI = ${JSON.stringify(CLI_PATH)};
const KEY = \`pi:\${process.pid}\`;
const WAIT_TITLE = "需要你操作";
const ICON = "https://raw.githubusercontent.com/earendil-works/pi/main/apps/p2/public/icons/icon-192.png";
let task = "";

function notify(args: string[]) {
  // 直接跑 node + 绝对路径：不经过 shell（否则 Windows 会起 cmd.exe 和 npm shim，可能闪黑框，Node 24 还会打 DEP0190 警告）。
  const child = spawn(process.execPath, [CLI, "--agent", "pi", ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

export default function (pi: any) {
  pi.on("before_agent_start", (event: any) => {
    if (event?.messageType === "user" && typeof event.prompt === "string") task = event.prompt.trim();
  });
  pi.on("agent_start", () => notify(["--cancel", "--session", KEY]));
  // 用户回到终端敲字，或退出/切会话/重载：撤销还没发出的完成通知（否则人已经看过还得再收一次）
  pi.on("input", () => notify(["--cancel", "--session", KEY]));
  pi.on("session_shutdown", () => notify(["--cancel", "--session", KEY]));
  // 等用户操作（对话框/确认）时立即推送；用独立 key，免得取消时把完成通知一起删了
  pi.on("ui_prompt_start", () =>
    notify(["--event", "notification", "--session", \`\${KEY}:wait\`, "--title", WAIT_TITLE, "--icon", ICON]),
  );
  pi.on("ui_prompt_end", () => notify(["--cancel", "--session", \`\${KEY}:wait\`]));
  pi.on("agent_settled", (event: any) => {
    const name = pi.getSessionName?.() || task.split("\\n")[0];
    const args = ["--event", event?.aborted ? "notification" : "settled", "--session", KEY, "--icon", ICON];
    if (name) args.push("--title", name);
    notify(args);
  });
}
`;

export function detectPi(): string | undefined {
  return existsSync(PI_AGENT_DIR) ? "~/.pi/agent" : undefined;
}

export function piExtensionContent(): string {
  return PI_TEMPLATE;
}

export function writePiExtension(): "written" | "unchanged" {
  if (existsSync(PI_EXTENSION_PATH)) {
    try {
      if (readFileSync(PI_EXTENSION_PATH, "utf8") === PI_TEMPLATE) return "unchanged";
    } catch {
      /* 读不了就当作需要重写 */
    }
  }
  mkdirSync(PI_EXTENSION_DIR, { recursive: true });
  atomicWriteText(PI_EXTENSION_PATH, PI_TEMPLATE);
  return "written";
}

/** 仅当扩展是本工具生成的时候才删除。 */
export function removePiExtension(): boolean {
  if (!existsSync(PI_EXTENSION_PATH)) return false;
  try {
    if (!readFileSync(PI_EXTENSION_PATH, "utf8").includes(MARKER)) return false;
  } catch {
    return false;
  }
  rmSync(PI_EXTENSION_PATH, { force: true });
  return true;
}
