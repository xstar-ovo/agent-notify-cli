/**
 * 文件功能：生成并安装 Pi 扩展（失败识别、耗时摘要、会话 key、取消待发通知）。
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
import { appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = ${JSON.stringify(CLI_PATH)};
const WAIT_TITLE = "需要你操作";
const ICON = "https://raw.githubusercontent.com/earendil-works/pi/main/apps/p2/public/icons/icon-192.png";
const LOG = path.join(os.homedir(), ".config", "agent-notify", "extension-error.log");
// 会话标识先用 pid 兜底，拿到 Pi 的会话 id 后换掉：崩溃残留的待发记录，恢复会话时也能撤销
let KEY = \`pi:\${process.pid}\`;
let ui: any = null;
let reported = false;
let startedAt = 0;
let outcome = "completed";
let summary = "";
let lastWaitAt = 0;

function report(msg: string) {
  try {
    appendFileSync(LOG, \`\${new Date().toISOString()} \${msg}\\n\`);
  } catch {}
  if (reported) return; // 只提示一次，避免每个事件都刷屏
  reported = true;
  ui?.notify?.(\`通知未发送：\${msg}\`, "error");
}

function notify(args: string[]) {
  if (!existsSync(CLI)) return report(\`找不到 \${CLI}，请重新运行 agent-notify setup\`);
  // 直接跑 node + 绝对路径：不经过 shell（否则 Windows 会起 cmd.exe 和 npm shim，可能闪黑框，Node 24 还会打 DEP0190 警告）。
  const child = spawn(process.execPath, [CLI, "--agent", "pi", ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err: any) => report(err?.message ?? String(err)));
  child.unref();
}

function cancelAll() {
  // 完成通知和“等你操作”通知是两个 key，一起撤销
  notify(["--cancel", "--session", KEY]);
  notify(["--cancel", "--session", \`\${KEY}:wait\`]);
}

// TUI 提示要用事件里的 ctx.ui（pi.ui 没有这个 API），顺手把会话 id 绑上
function adopt(ctx: any) {
  ui = ctx?.ui ?? ui;
  const id = ctx?.sessionManager?.getSessionId?.();
  if (id && KEY === \`pi:\${process.pid}\`) KEY = \`pi:\${id}\`;
}

export default function (pi: any) {
  // 用户回到终端敲字、任务重新开始、退出/切会话/重载：撤销还没发出的通知（否则人已经看过还得再收一次）
  pi.on("agent_start", (_event: any, ctx: any) => {
    adopt(ctx);
    startedAt = Date.now();
    outcome = "completed"; // 新 run 重置，否则上一轮的 error 会漏到这一轮
    summary = "";
    cancelAll();
  });
  pi.on("input", (_event: any, ctx: any) => {
    adopt(ctx);
    cancelAll();
  });
  pi.on("session_shutdown", (_event: any, ctx: any) => {
    adopt(ctx);
    cancelAll();
  });
  // 等用户操作（对话框/确认）时立即推送；用独立 key，免得取消时把完成通知一起删了
  pi.on("ui_prompt_start", (_event: any, ctx: any) => {
    adopt(ctx);
    if (Date.now() - lastWaitAt < 60_000) return; // 连弹几个确认框只提醒一次
    lastWaitAt = Date.now();
    notify(["--event", "notification", "--session", \`\${KEY}:wait\`, "--title", WAIT_TITLE, "--icon", ICON]);
  });
  pi.on("ui_prompt_end", () => notify(["--cancel", "--session", \`\${KEY}:wait\`]));
  // 本轮最后一条回复的前 60 字，作为推送正文的摘要
  pi.on("agent_end", (event: any, ctx: any) => {
    adopt(ctx);
    const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
    const text = (last?.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join(" ");
    summary = text.replace(/\\s+/g, " ").trim().slice(0, 60);
  });
  // 唯一带 outcome 的事件（completed / aborted / error）；被中断的 run 不会触发它
  pi.on("agent_before_settle", (event: any, ctx: any) => {
    adopt(ctx);
    outcome = event?.outcome ?? "completed";
  });
  pi.on("agent_settled", (event: any, ctx: any) => {
    adopt(ctx);
    if (event?.aborted) return; // 自己按 Esc 打断，人就在终端前，不必再推
    const failed = outcome === "error";
    const sec = Math.round((Date.now() - startedAt) / 1000);
    const span = startedAt ? (sec < 60 ? \`\${sec}秒\` : \`\${Math.floor(sec / 60)}分\${sec % 60}秒\`) : "";
    const message = [span && \`用时 \${span}\`, summary].filter(Boolean).join(" · ");
    // 标题由事件决定（任务完成 / 任务出错），不用任务名覆盖
    const args = ["--event", failed ? "error" : "settled", "--session", KEY, "--icon", ICON];
    if (message) args.push("--message", message);
    notify(args);
  });
  // 看完结果、不想继续：按 ctrl+shift+k 或输 /seen 撤掉还没发出的通知
  pi.registerShortcut("ctrl+shift+k", {
    description: "我看过了，取消待发通知",
    handler: async (ctx: any) => {
      cancelAll();
      ctx?.ui?.notify?.("已取消待发通知", "info");
    },
  });
  pi.registerCommand("seen", {
    description: "取消待发通知（我看过了，不用再推）",
    handler: async (_args: string, ctx: any) => {
      cancelAll();
      ctx?.ui?.notify?.("已取消待发通知", "info");
    },
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
