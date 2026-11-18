/**
 * 文件功能：生成并安装 OpenCode V2 插件（执行完成/失败、等待操作、会话摘要与取消）。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_DELAY_MS,
  MAX_DELAY_CEILING_MS,
  MAX_DELAY_MS,
  SUMMARY_CHARS,
  WAIT_REMINDER_MS,
} from "../config/constant.js";
import { atomicWriteText } from "../util/atomic.js";

export const OPENCODE_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
export const OPENCODE_PLUGIN_DIR = path.join(OPENCODE_CONFIG_DIR, "plugins");
export const OPENCODE_PLUGIN_ROOT = path.join(OPENCODE_PLUGIN_DIR, "agent-notify");
export const OPENCODE_PLUGIN_PATH = path.join(OPENCODE_PLUGIN_ROOT, "index.ts");
export const OPENCODE_TUI_PATH = path.join(OPENCODE_PLUGIN_ROOT, "tui.tsx");
const OPENCODE_TUI_LEGACY_PATH = path.join(OPENCODE_PLUGIN_ROOT, "tui.ts");
const OPENCODE_LEGACY_PATH = path.join(OPENCODE_PLUGIN_DIR, "agent-notify.ts");
export const OPENCODE_CLI_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, "cli.json");
const OPENCODE_CLI_PLUGIN = pathToFileURL(OPENCODE_PLUGIN_ROOT).href;

const MARKER = "由 agent-notify setup 生成";
const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
// fnm/nvm 的 process.execPath 可能是临时 shell 路径，先解析成真实 node.exe；解析失败再用原路径。
const NODE_PATH = /^node(\.exe)?$/i.test(path.basename(process.execPath))
  ? (() => {
      try {
        return realpathSync(process.execPath);
      } catch {
        return process.execPath;
      }
    })()
  : "node";

const OPENCODE_TEMPLATE = `// ${MARKER}，请勿手改；重新运行 \`agent-notify setup\` 覆盖。
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = ${JSON.stringify(CLI_PATH)};
// OpenCode 跑在 Bun 里，process.execPath 不是 node；这里写死 setup 时的 node 绝对路径。
const NODE = process.env.AGENT_NOTIFY_NODE || ${JSON.stringify(NODE_PATH)};
const ICON = "https://opencode.ai/favicon.ico";
const LOG = path.join(os.homedir(), ".config", "agent-notify", "extension-error.log");

const states = new Map<string, { startedAt: number; summary: string }>();
const children = new Set<string>();
const waitAt = new Map<string, number>();

function report(msg: string) {
  try {
    appendFileSync(LOG, \`\${new Date().toISOString()} \${msg}\\n\`);
  } catch {}
}

function notify(args: string[], cwd: string) {
  if (!existsSync(CLI)) return report(\`找不到 \${CLI}，请重新运行 agent-notify setup\`);
  const child = spawn(NODE, [CLI, "--agent", "opencode", ...args], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err: any) => report(err?.message ?? String(err)));
  child.unref();
}

function key(id: string): string {
  return \`oc:\${id}\`;
}

function cancel(id: string, cwd: string) {
  notify(["cancel", "--session", key(id)], cwd);
  cancelWait(id, cwd);
}

function cancelWait(id: string, cwd: string) {
  notify(["cancel", "--session", \`\${key(id)}:wait\`], cwd);
}

function fmt(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? \`\${sec}秒\` : \`\${Math.floor(sec / 60)}分\${sec % 60}秒\`;
}

function waitFor(id: string, cwd: string, message?: string) {
  const last = waitAt.get(id) ?? 0;
  if (Date.now() - last < ${WAIT_REMINDER_MS}) return; // 连弹几个确认框只提醒一次
  waitAt.set(id, Date.now());
  const args = ["notify", "notification", "--session", \`\${key(id)}:wait\`, "--icon", ICON];
  if (message) args.push("--message", message);
  notify(args, cwd);
}

function handle(event: any, base: string) {
  const data = event?.data ?? {};
  const type = event?.type;
  const cwd = event?.location?.directory ?? base;
  // 本地插件每个 Location 一份，但事件流可能收到别的项目；只处理本目录。
  if (event?.location?.directory && path.resolve(cwd) !== path.resolve(base)) return;

  if (type === "session.created") {
    if (typeof data.sessionID === "string" && typeof data.parentID === "string" && data.parentID) {
      children.add(data.sessionID);
    }
    return;
  }

  // 表单（问题/登录等）没有顶层 sessionID，先单独取。
  if (type === "form.created") {
    const form = data.form ?? {};
    const id = typeof form.sessionID === "string" ? form.sessionID : undefined;
    if (!id || children.has(id)) return;
    waitFor(id, cwd, typeof form.title === "string" ? form.title : undefined);
    return;
  }

  const id = data.sessionID;
  if (typeof id !== "string") return;
  const session = key(id);

  if (type === "session.deleted") {
    children.delete(id);
    states.delete(id);
    waitAt.delete(id);
    cancel(id, cwd);
    return;
  }
  if (children.has(id)) return; // 子代理的通知会淹没主会话，交给父会话收尾

  switch (type) {
    case "session.execution.started":
      states.set(id, { startedAt: Date.now(), summary: "" });
      waitAt.delete(id);
      cancel(id, cwd); // 新一轮开始，旧 completion 和 waiting 都作废
      return;
    case "session.text.ended": {
      const state = states.get(id) ?? { startedAt: 0, summary: "" };
      state.summary = String(data.text ?? "").replace(/\\s+/g, " ").trim().slice(0, ${SUMMARY_CHARS});
      states.set(id, state);
      return;
    }
    case "session.execution.succeeded": {
      const state = states.get(id);
      const span = state?.startedAt ? fmt(Date.now() - state.startedAt) : "";
      const message = [span && \`用时 \${span}\`, state?.summary].filter(Boolean).join(" · ");
      cancelWait(id, cwd);
      const args = ["notify", "settled", "--session", session, "--icon", ICON];
      if (message) args.push("--message", message);
      notify(args, cwd);
      states.delete(id);
      waitAt.delete(id);
      return;
    }
    case "session.execution.failed": {
      cancelWait(id, cwd);
      notify(["notify", "error", "--session", session, "--icon", ICON], cwd);
      states.delete(id);
      waitAt.delete(id);
      return;
    }
    case "session.execution.interrupted":
      // 用户 Esc / 关机 / superseded / 不活跃：人就在终端前，不推送；撤掉可能还在延迟的旧提醒
      cancel(id, cwd);
      states.delete(id);
      waitAt.delete(id);
      return;
    case "permission.asked":
      waitFor(id, cwd);
      return;
    case "permission.replied":
    case "form.replied":
    case "form.cancelled":
      waitAt.delete(id);
      notify(["cancel", "--session", \`\${session}:wait\`], cwd);
      return;
  }
}

const SUBSCRIBE = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.ended",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
];

export default {
  id: "agent-notify",
  async setup(ctx: any) {
    const abort = new AbortController();
    const base = ctx?.location?.directory ?? process.cwd();

    // 用户敲下新提示词：撤销上一轮还没发出的完成通知
    await ctx.session.hook("prompt", (event: any) => {
      if (typeof event?.sessionID === "string") cancel(event.sessionID, base);
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: SUBSCRIBE, signal: abort.signal })) {
          try {
            handle(event, base);
          } catch (err: any) {
            report(err?.message ?? String(err));
          }
        }
      } catch (err: any) {
        if (!abort.signal.aborted) report(err?.message ?? String(err));
      }
    })();

    return () => abort.abort();
  },
};
`;

export function detectOpenCode(): string | undefined {
  return existsSync(OPENCODE_CONFIG_DIR) ? "~/.config/opencode" : undefined;
}

const OPENCODE_TUI_TEMPLATE = `// ${MARKER}，请勿手改；重新运行 \`agent-notify setup\` 覆盖。
import { Plugin } from "@opencode/plugin/tui";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = ${JSON.stringify(CLI_PATH)};
const NODE = process.env.AGENT_NOTIFY_NODE || ${JSON.stringify(NODE_PATH)};
const CONFIG = path.join(os.homedir(), ".config", "agent-notify", "config.json");
const LOG = path.join(os.homedir(), ".config", "agent-notify", "extension-error.log");
const DEFAULT_SETTLED = ${DEFAULT_DELAY_MS.settled};
const DEFAULT_ERROR = ${DEFAULT_DELAY_MS.error};
const MAX_DELAY = ${MAX_DELAY_MS};
const CEILING = ${MAX_DELAY_CEILING_MS};

function delayFor(event: "settled" | "error"): number | undefined {
  const fallback = event === "settled" ? DEFAULT_SETTLED : DEFAULT_ERROR;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
    if (cfg?.bark?.enabled === false || cfg?.events?.[event]?.bark === false) return;
    const max = Math.min(Number.isFinite(Number(cfg?.delayMs?.max)) ? Number(cfg.delayMs.max) : MAX_DELAY, CEILING);
    const raw = Number(cfg?.delayMs?.[event] ?? fallback);
    return Math.max(0, Math.min(Number.isFinite(raw) ? raw : fallback, max));
  } catch {
    return;
  }
}

function report(msg: string) {
  try {
    appendFileSync(LOG, \`\${new Date().toISOString()} \${msg}\\n\`);
  } catch {}
}

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

function cancel(id: string) {
  if (!existsSync(CLI)) return report(\`找不到 \${CLI}，请重新运行 agent-notify setup\`);
  for (const session of [\`oc:\${id}\`, \`oc:\${id}:wait\`]) {
    const child = spawn(NODE, [CLI, "cancel", "--session", session], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err: any) => report(err?.message ?? String(err)));
    child.unref();
  }
}

export default Plugin.define({
  id: "agent-notify-tui",
  setup(ctx: any) {
    const base = ctx?.location?.directory;
    report("tui setup");
    const [state, setState] = ctx.storage.memory("agent-notify", {
      initial: { due: {} as Record<string, number>, tick: 0 },
    });

    const idOf = (event: any): string | undefined => {
      const id = event?.data?.sessionID;
      if (typeof id !== "string") return;
      const cwd = event?.location?.directory;
      if (base && cwd && path.resolve(cwd) !== path.resolve(base)) return;
      return id;
    };

    const clear = (id: string) => {
      if (state.due[id] === undefined) return;
      setState((draft) => {
        delete draft.due[id];
        draft.tick += 1;
      });
    };

    const show = (event: any, eventName: "settled" | "error") => {
      const id = idOf(event);
      if (!id) return;
      let root = id;
      try {
        root = ctx.data.session.root(id);
      } catch {}
      if (root !== id) return; // 子代理不单独显示
      const delay = delayFor(eventName);
      if (delay === undefined) return; // 事件或 Bark 关掉时不显示空倒计时
      const dueAt = Date.now() + delay;
      setState((draft) => {
        draft.due[id] = dueAt;
        draft.tick += 1;
      });
    };

    const timer = setInterval(() => {
      if (Object.keys(state.due).length === 0) return;
      const now = Date.now();
      setState((draft) => {
        for (const id of Object.keys(draft.due)) {
          if (draft.due[id] <= now) delete draft.due[id];
        }
        draft.tick += 1;
      });
    }, 1000);

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "agent-notify.cancel",
          title: "取消待发通知",
          description: "我看过了，取消待发通知",
          group: "Agent Notify",
          palette: true,
          slash: { name: "ack" },
          run: () => {
            const route = ctx.ui.router.current();
            report(\`ack: fired route=\${route?.type}\`);
            const current = route?.type === "session" ? route.sessionID : undefined;
            // 命令面板/路由切换时 route 可能不是 session，退回最近一条待发记录
            const fallback = Object.keys(state.due).sort((a, b) => state.due[a] - state.due[b])[0];
            const id = current ?? fallback;
            if (!id) {
              report(\`ack: no pending session (route=\${route?.type})\`);
              ctx.ui.toast({ variant: "info", message: "没有待发通知" });
              return;
            }
            clear(id);
            cancel(id);
            ctx.ui.toast({ variant: "success", message: "已取消待发通知" });
          },
        },
      ],
    }));

    try {
      const cmds = ctx.keymap.commands();
      report("tui commands " + cmds.map((c: any) => c.id + ":" + (c.slash?.name ?? "")).join(","));
    } catch (err: any) {
      report("tui commands failed " + (err?.message ?? err));
    }

    const off = ctx.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }: any) => {
        void state.tick;
        const due = state.due[sessionID];
        if (!due) return null;
        const left = due - Date.now();
        if (left <= 0) return null;
        return <text>消息通知时间 {clock(due)} · {mmss(left)} 后</text>;
      },
    });

    const stop = ctx.data.on("session.execution.succeeded", (event: any) => show(event, "settled"));
    const stopError = ctx.data.on("session.execution.failed", (event: any) => show(event, "error"));
    const stopStarted = ctx.data.on("session.execution.started", (event: any) => {
      const id = idOf(event);
      if (id) clear(id);
    });
    const stopInterrupted = ctx.data.on("session.execution.interrupted", (event: any) => {
      const id = idOf(event);
      if (id) clear(id);
    });
    const stopDeleted = ctx.data.on("session.deleted", (event: any) => {
      const id = idOf(event);
      if (id) clear(id);
    });

    return () => {
      clearInterval(timer);
      off();
      stop();
      stopError();
      stopStarted();
      stopInterrupted();
      stopDeleted();
    };
  },
});
`;

export function openCodePluginContent(): string {
  return OPENCODE_TEMPLATE;
}

export function openCodeTuiContent(): string {
  return OPENCODE_TUI_TEMPLATE;
}

/** 插件文件是否为本工具生成的当前版本，供 doctor 用。 */
export function openCodePluginStatus(): "current" | "outdated" | "missing" {
  let state: "current" | "outdated" = "current";
  for (const [file, content] of [
    [OPENCODE_PLUGIN_PATH, OPENCODE_TEMPLATE],
    [OPENCODE_TUI_PATH, OPENCODE_TUI_TEMPLATE],
  ]) {
    if (!existsSync(file)) return "missing";
    try {
      const text = readFileSync(file, "utf8");
      if (!text.includes(MARKER)) return "missing";
      if (text !== content) state = "outdated";
    } catch {
      return "missing";
    }
  }
  return state;
}

function removeMarked(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    if (!readFileSync(file, "utf8").includes(MARKER)) return false;
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

function updateOpenCodeCliConfig(add: boolean): boolean {
  let data: any = {};
  if (existsSync(OPENCODE_CLI_CONFIG_PATH)) {
    try {
      data = JSON.parse(readFileSync(OPENCODE_CLI_CONFIG_PATH, "utf8"));
    } catch {
      return false; // 不覆盖用户手写的 JSONC / 非法配置
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const plugins = Array.isArray(data.plugins) ? data.plugins.slice() : [];
  const index = plugins.indexOf(OPENCODE_CLI_PLUGIN);
  if (add && index < 0) plugins.push(OPENCODE_CLI_PLUGIN);
  else if (!add && index >= 0) plugins.splice(index, 1);
  else return false;
  if (plugins.length > 0) data.plugins = plugins;
  else delete data.plugins;
  atomicWriteText(OPENCODE_CLI_CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

export function writeOpenCodePlugin(): "written" | "unchanged" {
  mkdirSync(OPENCODE_PLUGIN_ROOT, { recursive: true });
  let changed = false;
  for (const [file, content] of [
    [OPENCODE_PLUGIN_PATH, OPENCODE_TEMPLATE],
    [OPENCODE_TUI_PATH, OPENCODE_TUI_TEMPLATE],
  ]) {
    try {
      if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
    } catch {
      /* 读不了就当作需要重写 */
    }
    atomicWriteText(file, content);
    changed = true;
  }
  const removed = removeMarked(OPENCODE_LEGACY_PATH) || removeMarked(OPENCODE_TUI_LEGACY_PATH);
  const registered = updateOpenCodeCliConfig(true);
  return removed || changed || registered ? "written" : "unchanged";
}

/** 仅当插件是本工具生成的时候才删除。 */
export function removeOpenCodePlugin(): boolean {
  const unregistered = updateOpenCodeCliConfig(false);
  let removed = removeMarked(OPENCODE_LEGACY_PATH) || removeMarked(OPENCODE_TUI_LEGACY_PATH);
  for (const file of [OPENCODE_PLUGIN_PATH, OPENCODE_TUI_PATH]) {
    if (!existsSync(file)) continue;
    try {
      if (!readFileSync(file, "utf8").includes(MARKER)) continue;
    } catch {
      continue;
    }
    rmSync(file, { force: true });
    removed = true;
  }
  try {
    // rmSync 对目录要 recursive:true（会误删用户文件），空目录只能用 rmdirSync。
    rmdirSync(OPENCODE_PLUGIN_ROOT);
  } catch {
    /* 目录非空就保留 */
  }
  return removed || unregistered;
}
