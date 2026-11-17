/**
 * 文件功能：CLI 入口：解析参数并把子命令分发到具体实现（事件入队 / 取消 / 补发 / setup / test / key）。
 */

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ensureConfigFile, loadConfig, saveDeviceKey } from "./config/loader.js";
import { configPath } from "./config/paths.js";
import { clamp, DEFAULT_DELAY_MS, EVENTS, SUMMARY_CHARS, type AgentNotifyConfig, type NotifyEvent } from "./config/schema.js";
import { sendNow } from "./notify/index.js";
import { cancel, enqueue, pending, sendDue, sweepDue, wake, type PendingNotification } from "./notify/scheduler.js";
import { CLAUDE_SETTINGS_PATH, claudeHooksPreview, detectClaude, removeClaudeHooks, writeClaudeHooks } from "./setup/claude.js";
import { detectOpenCode, openCodePluginContent, openCodeTuiContent, OPENCODE_PLUGIN_ROOT, removeOpenCodePlugin, writeOpenCodePlugin } from "./setup/opencode.js";
import { detectPi, piExtensionContent, PI_EXTENSION_PATH, removePiExtension, writePiExtension } from "./setup/pi.js";
import { appendLog } from "./util/log.js";
import { redact } from "./util/redact.js";
import { readStdinJson } from "./util/stdin.js";

const HELP = `an / agent-notify — unified agent notifications

Usage:
  an --event <stop|notification|error|settled> [--delay <sec>] [--session <id>]
     [--message <text>] [--agent <name>] [--stdin-json]
  an --cancel [--session <id>]
  an flush
  an test
  an key <bark-key>
  an setup [--dry-run] [--uninstall] [--yes]

Config: ${configPath} (bark endpoint + {env:BARK_DEVICE_KEY})`;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function hookMessage(stdin: Record<string, any> | undefined): string | undefined {
  const raw = typeof stdin?.message === "string"
    ? stdin.message
    : typeof stdin?.last_assistant_message === "string"
      ? stdin.last_assistant_message
      : "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, SUMMARY_CHARS) : undefined;
}

export async function main(): Promise<void> {
  process.exitCode = await run().catch(() => 0);
}

// 让 `node dist/cli.js …` 可直接运行（分离的唤醒进程依赖这一点）；bin 里也会调用 main()。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

async function run(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      event: { type: "string" },
      message: { type: "string" },
      title: { type: "string" },
      icon: { type: "string" },
      delay: { type: "string" },
      session: { type: "string" },
      agent: { type: "string" },
      "device-key": { type: "string" },
      "stdin-json": { type: "boolean" },
      cancel: { type: "boolean" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      "dry-run": { type: "boolean" },
      uninstall: { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  const cmd = positionals[0];

  if (cmd === "__wake") {
    const { config } = loadConfig();
    await wake(positionals[1] ?? "default", config);
    return 0;
  }

  const { config, warnings } = loadConfig();

  if (values.help || (!cmd && !values.event && !values.cancel)) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "flush") {
    await sendDue(config, 0);
    return 0;
  }
  if (cmd === "test") return testCommand(config, warnings);
  if (cmd === "statusline") return statuslineCommand(config);
  if (cmd === "key") return keyCommand(str(values["device-key"]) ?? positionals[1]);
  if (cmd === "setup") {
    return setupCommand(
      Boolean(values["dry-run"]),
      Boolean(values.uninstall),
      Boolean(values.yes),
    );
  }

  if (values.cancel) {
    const stdin = values["stdin-json"]
      ? ((await readStdinJson(1000)) as Record<string, any> | undefined)
      : undefined;
    const session =
      str(values.session) ??
      (typeof stdin?.session_id === "string" ? stdin.session_id : undefined) ??
      (values["stdin-json"] ? undefined : "default");
    if (!session) {
      appendLog("level=warn msg=\"cancel without session\"");
      return 0;
    }
    cancel(config, session);
    const prompt = typeof stdin?.prompt === "string" ? stdin.prompt.trim() : "";
    if (/^\/ack(?:\s|$)/.test(prompt)) {
      // UserPromptSubmit hook：拦下 /ack，别让 Claude 再生成一轮回复
      console.log(JSON.stringify({ decision: "block", reason: "已取消待发通知" }));
    }
    return 0;
  }

  // 取消要先于 sweep：/ack 不应该先把刚好到点的通知发出去。
  sweepDue(config);

  if (typeof values.event === "string") {
    return eventCommand(values, config);
  }

  console.log(HELP);
  return 0;
}

async function eventCommand(
  values: Record<string, string | boolean | undefined>,
  config: AgentNotifyConfig,
): Promise<number> {
  const event = values.event as NotifyEvent;
  if (!EVENTS.includes(event)) {
    appendLog(`level=error msg="unknown event" event="${String(values.event)}"`);
    return 0;
  }

  const stdin = values["stdin-json"]
    ? ((await readStdinJson()) as Record<string, any> | undefined)
    : undefined;

  const agent = str(values.agent) ?? (stdin?.hook_event_name ? "claude" : "agent");
  const session =
    str(values.session) ?? (typeof stdin?.session_id === "string" ? stdin.session_id : undefined) ??
    `${agent}:${path.basename(stdin?.cwd ?? process.cwd())}`;

  const seconds = values.delay !== undefined ? Number(values.delay) : config.delayMs[event] / 1000;
  const delayMs = clamp(Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000), 0, config.delayMs.max);

  const now = Date.now();
  const rec: PendingNotification = {
    session,
    event,
    agent,
    cwd: typeof stdin?.cwd === "string" ? stdin.cwd : process.cwd(),
    message: str(values.message) ?? hookMessage(stdin),
    title: str(values.title),
    icon: str(values.icon),
    createdAt: now,
    dueAt: now + delayMs,
  };

  if (delayMs > 0) {
    enqueue(rec, config);
  } else {
    cancel(config, session); // 立即通知时清掉同会话的旧待发记录，避免两条都到
    await sendNow(rec, config).catch(() => undefined);
  }
  return 0;
}

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function statuslineCommand(config: AgentNotifyConfig): Promise<number> {
  const stdin = (await readStdinJson()) as Record<string, any> | undefined;
  const session = typeof stdin?.session_id === "string" ? stdin.session_id : "";
  if (!session) return 0;
  const rec = pending(config, session);
  if (!rec || rec.dueAt <= Date.now()) return 0;
  if (!(config.bark.enabled && config.bark.deviceKey && config.events[rec.event]?.bark)) return 0;
  console.log(`消息通知时间 ${clock(rec.dueAt)} · ${mmss(rec.dueAt - Date.now())} 后`);
  return 0;
}

async function keyCommand(key: string | undefined): Promise<number> {
  if (!key) {
    console.log("用法：agent-notify key <你的 Bark key>");
    return 1;
  }
  try {
    saveDeviceKey(key);
  } catch (err) {
    console.log(`错误：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { config } = loadConfig();
  if (config.bark.deviceKey !== key.trim()) {
    console.log("错误：写入后校验失败，请检查 " + configPath);
    return 1;
  }
  const k = key.trim();
  console.log(`已写入 ${configPath}（key: ${k.slice(0, 4)}…${k.slice(-3)}）`);
  console.log("重启、关机再开机都生效，不依赖任何终端的环境变量。");
  return 0;
}

async function testCommand(config: AgentNotifyConfig, warnings: string[]): Promise<number> {
  for (const w of warnings) console.log(`警告：${w}`);
  if (!config.bark.enabled) {
    console.log("错误：Bark 未启用（config.bark.enabled = false）");
    return 1;
  }
  if (!config.bark.deviceKey) {
    console.log("错误：未找到 Bark device key：请运行 agent-notify key <你的BarkKey>");
    return 1;
  }
  const started = Date.now();
  try {
    await sendNow(
      { event: "stop", agent: "agent-notify", cwd: process.cwd(), message: "测试通知" },
      { ...config, delayMs: { ...config.delayMs } },
    );
    console.log(`Bark 已发送（${Date.now() - started}ms）`);
    return 0;
  } catch (err) {
    console.log(`错误：Bark 发送失败：${redact(String(err))}`);
    return 1;
  }
}

async function setupCommand(dryRun: boolean, uninstall: boolean, yes: boolean): Promise<number> {
  const claude = detectClaude();
  const pi = detectPi();
  const opencode = detectOpenCode();

  if (uninstall) {
    const claudeResult = removeClaudeHooks();
    console.log(claudeResult === "removed"
      ? `已移除 Claude Code hooks、状态栏和 /ack（${CLAUDE_SETTINGS_PATH}）`
      : claudeResult === "invalid"
        ? `Claude Code: ${CLAUDE_SETTINGS_PATH} 解析失败，未修改`
        : "未找到本工具生成的 Claude hooks/状态栏");
    console.log(removePiExtension() ? `已移除 ${PI_EXTENSION_PATH}` : "未找到本工具生成的 Pi 扩展");
    console.log(removeOpenCodePlugin() ? `已移除 ${OPENCODE_PLUGIN_ROOT}` : "未找到本工具生成的 OpenCode 插件");
    return 0;
  }

  console.log("正在检测本机 Agent...\n");
  console.log(claude ? `  [1] Claude Code (${claude})` : "  （未检测到 Claude Code）");
  console.log(pi ? `  [2] Pi (${pi})` : "  （未检测到 Pi）");
  console.log(opencode ? `  [3] OpenCode V2 (${opencode})` : "  （未检测到 OpenCode）");
  if (!claude && !pi && !opencode) return 0;

  console.log(`\n将执行以下修改：`);
  if (claude) console.log(`  • Claude Code: 写入 ${CLAUDE_SETTINGS_PATH}（hooks + 状态栏 + /ack）`);
  if (pi) console.log(`  • Pi: 写入 ${PI_EXTENSION_PATH}`);
  if (opencode) console.log(`  • OpenCode: 写入 ${OPENCODE_PLUGIN_ROOT}（服务端 index.ts + TUI tui.tsx）`);
  console.log(`  • 配置: ${configPath}${dryRun ? "（dry-run，不写入）" : ensureConfigFile() ? "（已创建默认配置）" : "（已存在，不修改）"}`);
  console.log(`\n通知默认延迟：stop/settled ${DEFAULT_DELAY_MS.stop / 60_000} 分钟，error/notification 立即（可在配置 delayMs 调整）`);

  if (dryRun) {
    if (claude) console.log(`\n--- ${CLAUDE_SETTINGS_PATH} 将添加的 hooks ---\n${claudeHooksPreview()}`);
    if (pi) console.log(`\n--- ${PI_EXTENSION_PATH} ---\n${piExtensionContent()}`);
    if (opencode) console.log(`\n--- ${OPENCODE_PLUGIN_ROOT}/index.ts ---\n${openCodePluginContent()}\n\n--- ${OPENCODE_PLUGIN_ROOT}/tui.tsx ---\n${openCodeTuiContent()}`);
    return 0;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log("\n非交互环境，请加 --yes 确认写入。");
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\n确认写入？(y/N): ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("已取消。");
      return 0;
    }
  }

  if (claude) {
    try {
      const result = writeClaudeHooks();
      console.log(result === "written"
        ? `已写入 Claude Code hooks、状态栏和 /ack：${CLAUDE_SETTINGS_PATH}`
        : result === "invalid"
          ? `Claude Code: ${CLAUDE_SETTINGS_PATH} 解析失败，未修改`
          : "Claude Code 集成已是最新");
    } catch (err) {
      console.log(`Claude Code: 写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pi) console.log(`\n${writePiExtension() === "written" ? "已写入" : "已是最新"} Pi 扩展`);
  if (opencode) console.log(`${writeOpenCodePlugin() === "written" ? "已写入" : "已是最新"} OpenCode 插件`);
  console.log("\n下一步：写入 Bark 凭据（持久化，重启后仍生效）");
  console.log("  agent-notify key <你的BarkKey>");
  console.log("  然后 agent-notify test");
  if (claude) console.log("\nClaude Code 新会话自动加载 hooks；当前会话可重启或输入 /hooks 检查。状态栏显示待发时间，输入 /ack 取消。");
  if (pi) console.log("Pi 正在运行时执行 /reload 以加载扩展。");
  if (opencode) console.log("OpenCode 重启后自动加载插件。");
  return 0;
}
