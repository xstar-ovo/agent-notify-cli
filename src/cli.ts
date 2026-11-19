/**
 * 文件功能：CLI 入口：解析参数并把子命令分发到具体实现（事件入队 / 取消 / 补发 / setup / test / key）。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ensureConfigFile, loadConfig, parseBarkKeyInput, saveDeviceKey } from "./config/loader.js";
import { configPath } from "./config/paths.js";
import { clamp, DEFAULT_DELAY_MS, EVENTS, SUMMARY_CHARS, type AgentNotifyConfig, type NotifyEvent } from "./config/schema.js";
import { sendNow } from "./notify/index.js";
import { cancel, enqueue, listPending, pending, sendDue, superseded, sweepDue, wake, type PendingNotification } from "./notify/scheduler.js";
import { CLAUDE_SETTINGS_PATH, claudeHooksPreview, claudeHooksStatus, detectClaude, removeClaudeHooks, writeClaudeHooks } from "./setup/claude.js";
import { detectOpenCode, openCodePluginContent, openCodePluginStatus, openCodeTuiContent, OPENCODE_CLI_CONFIG_PATH, OPENCODE_CLI_PLUGIN, OPENCODE_PLUGIN_ROOT, removeOpenCodePlugin, writeOpenCodePlugin } from "./setup/opencode.js";
import { detectPi, piExtensionContent, piExtensionStatus, PI_EXTENSION_PATH, removePiExtension, writePiExtension } from "./setup/pi.js";
import { appendLog } from "./util/log.js";
import { redact } from "./util/redact.js";
import { readStdinJson } from "./util/stdin.js";
import { checkUpdate } from "./util/update.js";

const HELP = `an / agent-notify — unified agent notifications

发送
  an notify <stop|settled|notification|error> [--delay <sec>] [--session <id>]
     [--message <text>] [--agent <name>] [--icon <url>] [--stdin-json]
  an cancel [--session <id>]
  an flush

管理
  an            （终端里）交互菜单，数字选择
  an setup [--dry-run] [--yes]
  an uninstall
  an key <bark-key>

诊断
  an test
  an status
  an doctor

Config: ${configPath} (bark endpoint + {env:BARK_DEVICE_KEY})`;

const MENU = `an — agent-notify

  1. 写入 Bark key
  2. 查看状态
  3. 发送测试通知
  4. 安装 / 修复集成
  5. 体检诊断
  6. 卸载集成
  7. 手动触发通知（notify）
  8. 立即发送待发通知（flush）
  9. 取消待发通知（cancel）
  0. 退出菜单`;

/**
 * 逐行输入源。必须共用一个实例：管道喂多行时，反复 createInterface/close 会丢掉已缓冲的下一行，
 * 而连续调 rl.question 同样会漏行（第二行在第一次 question 注册前就已经被读完）。
 * 放在最上面：run() 在模块求值时就会执行，class 在下面会撞上 TDZ。
 */
class Lines {
  private readonly rl: Interface;
  private readonly it: AsyncIterator<string>;
  constructor() {
    // terminal: false：不接管回显与方向键，TTY 与管道行为一致。
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    this.it = this.rl[Symbol.asyncIterator]();
  }
  /** 写提示并等一行；流结束（管道喂完 / Ctrl+D）返回 undefined。 */
  async ask(prompt: string): Promise<string | undefined> {
    process.stdout.write(prompt);
    const { value, done } = await this.it.next();
    if (done) {
      process.stdout.write("\n");
      return undefined;
    }
    return value;
  }
  close(): void {
    this.rl.close();
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** 请求发出的时刻。扩展 spawn 进程会晚几毫秒，统一按请求时刻排队才能让 /ack 稳赢乱序的 notify。 */
function requestAt(values: Record<string, string | boolean | undefined>): number {
  const at = Number(values.at);
  return Number.isFinite(at) && at > 0 ? at : Date.now();
}

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
  // hook 路径仍需 exit 0，但内部错误不能一声不响地截断输出。
  process.exitCode = await run().catch((err) => {
    console.error(`agent-notify 内部错误：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  });
}

// 让 `node dist/cli.js …` 可直接运行（分离的唤醒进程依赖这一点）；bin 里也会调用 main()。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

async function run(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      message: { type: "string" },
      icon: { type: "string" },
      delay: { type: "string" },
      session: { type: "string" },
      at: { type: "string" },
      agent: { type: "string" },
      "stdin-json": { type: "boolean" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  const cmd = positionals[0];

  if (cmd === "_wake") {
    const { config } = loadConfig();
    await wake(positionals[1] ?? "default", config);
    return 0;
  }

  const { config, warnings } = loadConfig();

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  // 裸 `an`：终端里给数字菜单；管道/CI 仍打印原 help，不阻塞、不变退出码。
  if (!cmd) {
    if (!process.stdin.isTTY) {
      console.log(HELP);
      return 0;
    }
    return await menuCommand();
  }

  switch (cmd) {
    case "notify":
      return notifyCommand(positionals[1], values, config);
    case "cancel":
      return cancelCommand(values, config);
    case "flush":
      await sendDue(config, 0);
      return 0;
    case "test":
      return testCommand(config, warnings);
    case "status":
      return await statusCommand(config, warnings);
    case "doctor":
      return await doctorCommand(config, warnings);
    case "_statusline":
      return statuslineCommand(config);
    case "key":
      return keyCommand(positionals[1]);
    case "menu":
      return await menuCommand();
    case "setup":
      return setupCommand(Boolean(values["dry-run"]), Boolean(values.yes), config);
    case "uninstall":
      return uninstallCommand();
    default:
      // 未知命令（例如升级后仍装在 Agent 里的旧 hook）只提示，绝不打断 Agent。
      console.error(`未知命令：${cmd}；agent-notify --help`);
      return 0;
  }
}

/** 取消不 sweep：/ack 不应该先把刚好到点的通知发出去。 */
async function cancelCommand(
  values: Record<string, string | boolean | undefined>,
  config: AgentNotifyConfig,
): Promise<number> {
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
  cancel(config, session, requestAt(values));
  const prompt = typeof stdin?.prompt === "string" ? stdin.prompt.trim() : "";
  if (/^\/ack(?:\s|$)/.test(prompt)) {
    // UserPromptSubmit hook：拦下 /ack，别让 Claude 再生成一轮回复
    console.log(JSON.stringify({ decision: "block", reason: "已取消待发通知" }));
  }
  return 0;
}

async function notifyCommand(
  name: string | undefined,
  values: Record<string, string | boolean | undefined>,
  config: AgentNotifyConfig,
): Promise<number> {
  const event = name as NotifyEvent;
  if (!name || !EVENTS.includes(event)) {
    appendLog(`level=error msg="unknown event" event="${String(name)}"`);
    console.error(`未知事件：${name ?? "(空)"}；可用：${EVENTS.join(" / ")}`);
    return 0;
  }

  sweepDue(config);

  const stdin = values["stdin-json"]
    ? ((await readStdinJson()) as Record<string, any> | undefined)
    : undefined;

  const agent = str(values.agent) ?? (stdin?.hook_event_name ? "claude" : "agent");
  const session =
    str(values.session) ?? (typeof stdin?.session_id === "string" ? stdin.session_id : undefined) ??
    `${agent}:${path.basename(stdin?.cwd ?? process.cwd())}`;

  const seconds = values.delay !== undefined ? Number(values.delay) : config.delayMs[event] / 1000;
  const delayMs = clamp(Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000), 0, config.delayMs.max);

  const createdAt = requestAt(values);
  const rec: PendingNotification = {
    session,
    event,
    agent,
    cwd: typeof stdin?.cwd === "string" ? stdin.cwd : process.cwd(),
    message: str(values.message) ?? hookMessage(stdin),
    icon: str(values.icon),
    createdAt,
    dueAt: Date.now() + delayMs,
  };

  if (delayMs > 0) {
    enqueue(rec, config);
  } else {
    cancel(config, session, createdAt); // 立即通知时清掉同会话更旧的待发记录，避免两条都到
    // 取消请求或排队记录比这条新：已经过期，别再推。晚到的旧 notify 短暂落盘不算。
    if (!superseded(config, session, createdAt)) {
      await sendNow(rec, config).catch(() => undefined);
    }
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

async function statusCommand(config: AgentNotifyConfig, warnings: string[]): Promise<number> {
  for (const w of warnings) console.log(`警告：${w}`);
  console.log(`配置：${configPath}`);
  console.log(`Bark：${config.bark.enabled ? "启用" : "停用"}，key ${config.bark.deviceKey ? maskKey(config.bark.deviceKey) : "未配置"}`);
  const recs = listPending(config);
  console.log(`待发：${recs.length} 条`);
  for (const rec of recs) {
    const left = rec.dueAt - Date.now();
    const when = left > 0 ? `${clock(rec.dueAt)}（${mmss(left)} 后）` : `${clock(rec.dueAt)}（已到点，等 flush）`;
    const text = rec.message ? rec.message.replace(/\s+/g, " ").slice(0, 40) : "";
    console.log(`  ${rec.session}  ${rec.event}  ${when}${text ? `  ${text}` : ""}`);
  }
  await printUpdateHint();
  return 0;
}

/** 只给手动命令用；hook 路径不查版本，避免每次停顿都发网络请求。 */
async function printUpdateHint(): Promise<void> {
  const newer = await checkUpdate();
  if (newer) console.log(`\n新版 ${newer} 可用：npm i -g agent-notify-cli@latest`);
}

async function doctorCommand(config: AgentNotifyConfig, warnings: string[]): Promise<number> {
  let bad = false;
  for (const w of warnings) console.log(`警告：${w}`);

  const row = (label: string, text: string, ok = true) => {
    if (!ok) bad = true;
    console.log(`${label.padEnd(12)} ${text}`);
  };

  row("配置", configPath, true);
  row(
    "Bark",
    config.bark.enabled
      ? config.bark.deviceKey ? `已配置 ${maskKey(config.bark.deviceKey)}` : "未配置 key（an key <key>）"
      : "已停用（config.bark.enabled = false）",
    config.bark.enabled ? Boolean(config.bark.deviceKey) : true,
  );
  row("Node", process.execPath, existsSync(process.execPath));
  row("CLI", fileURLToPath(import.meta.url), existsSync(fileURLToPath(import.meta.url)));

  const agentRow = (name: string, detected: string | undefined, status: string) => {
    if (!detected) return row(name, "未检测到");
    if (status === "current") return row(name, `已接入，最新（${detected}）`);
    if (status === "invalid") return row(name, `已接入，但 settings.json 解析失败`, false);
    if (status === "broken") return row(name, `已接入，但 hooks 指向已删除的安装路径（运行 an setup 或 an uninstall）`, false);
    if (status === "outdated") return row(name, `已接入，但写入的是旧版本（运行 an setup 更新）`);
    if (status === "unregistered") return row(name, `插件已写入，但未注册（把 ${OPENCODE_CLI_PLUGIN} 加进 ${OPENCODE_CLI_CONFIG_PATH} 的 plugins）`, false);
    return row(name, `检测到 ${detected}，但未接入（运行 an setup）`);
  };
  agentRow("Claude Code", detectClaude(), claudeHooksStatus());
  agentRow("Pi", detectPi(), piExtensionStatus());
  agentRow("OpenCode", detectOpenCode(), openCodePluginStatus());

  await printUpdateHint();
  if (bad) return 1;
  console.log(config.bark.enabled ? "\n一切正常；an test 可验证推送。" : "\n一切正常（Bark 已停用，an test 会失败）。");
  return 0;
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

/** 输出里只显示 key 头尾，避免整串进日志/截图。 */
function maskKey(key: string): string {
  return key.length <= 8 ? `${key.slice(0, 1)}…` : `${key.slice(0, 4)}…${key.slice(-3)}`;
}

async function keyCommand(raw: string | undefined): Promise<number> {
  const key = raw ? parseBarkKeyInput(raw) : "";
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
  if (config.bark.deviceKey !== key) {
    console.log("错误：写入后校验失败，请检查 " + configPath);
    return 1;
  }
  console.log(`已写入 ${configPath}（key: ${maskKey(key)}）`);
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

/** 数字菜单：终端里裸跑 `an` 进入；`an menu` 也能用（可管道喂数字，便于测试）。 */
async function menuCommand(): Promise<number> {
  const lines = new Lines();
  try {
    for (;;) {
      const { config, warnings } = loadConfig();
      const key = config.bark.deviceKey;
      const bark = !config.bark.enabled
        ? "已停用（config.bark.enabled = false）"
        : key ? `已配置 ${maskKey(key)}` : "未配置 key";
      console.log(`${MENU}\n`);
      console.log(`Bark：${bark}\n配置：${configPath}\n`);

      const answer = await lines.ask("选择命令对应的数字： ");
      if (answer === undefined) return 0;
      switch (answer.trim()) {
        case "1": {
          const k = await promptBarkKey(lines);
          if (k) await keyCommand(k);
          else console.log("未输入 key，已跳过。");
          break;
        }
        case "2":
          await statusCommand(config, warnings);
          break;
        case "3":
          await testCommand(config, warnings);
          break;
        case "4":
          await setupCommand(false, false, config, lines);
          break;
        case "5":
          await doctorCommand(config, warnings);
          break;
        case "6":
          uninstallCommand();
          break;
        case "7": {
          // 和 notify 子命令等价：回车用 stop，走默认延迟。
          const ev = (await lines.ask(`事件（${EVENTS.join(" / ")}，回车 = stop）: `))?.trim();
          await notifyCommand(ev || "stop", {}, config);
          if ((ev || "stop") === "stop") console.log(`已入队，${config.delayMs.stop / 60_000} 分钟后通知。`);
          break;
        }
        case "8": {
          const sent = await sendDue(config, 0);
          console.log(sent > 0 ? `已发送 ${sent} 条待发通知。` : "没有已到期的待发通知。");
          break;
        }
        case "9": {
          const session = (await lines.ask("要取消的 session（回车 = default）: "))?.trim() || "default";
          await cancelCommand({ session }, config);
          console.log(`已取消 ${session} 的待发通知。`);
          break;
        }
        case "0":
        case "q":
          return 0;
        default:
          console.log("没有这个选项。");
      }
      console.log("---");
    }
  } finally {
    lines.close();
  }
}

/** 交互式收集 Bark key；非 TTY（脚本 / CI）直接跳过，不阻塞。 */
async function promptBarkKey(lines?: Lines): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const own = lines ?? new Lines();
  const answer = await own.ask("\n请粘贴 Bark key（Bark App 首页那一串，直接回车跳过）: ");
  if (!lines) own.close();
  return parseBarkKeyInput(answer ?? "") || undefined;
}

function uninstallCommand(): number {
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

async function setupCommand(dryRun: boolean, yes: boolean, config: AgentNotifyConfig, lines?: Lines): Promise<number> {
  const claude = detectClaude();
  const pi = detectPi();
  const opencode = detectOpenCode();

  console.log("正在检测本机 Agent...\n");
  console.log(claude ? `  [1] Claude Code (${claude})` : "  （未检测到 Claude Code）");
  console.log(pi ? `  [2] Pi (${pi})` : "  （未检测到 Pi）");
  console.log(opencode ? `  [3] OpenCode V2 (${opencode})` : "  （未检测到 OpenCode）");
  if (!claude && !pi && !opencode) return 0;

  console.log(`\n将执行以下修改：`);
  if (claude) console.log(`  • Claude Code: 写入 ${CLAUDE_SETTINGS_PATH}（hooks + 状态栏 + /ack）`);
  if (pi) console.log(`  • Pi: 写入 ${PI_EXTENSION_PATH}`);
  if (opencode) console.log(`  • OpenCode: 写入 ${OPENCODE_PLUGIN_ROOT}（服务端 index.ts + TUI tui.tsx）`);
  const created = dryRun ? false : ensureConfigFile();
  console.log(`  • 配置: ${configPath}${dryRun ? "（dry-run，不写入）" : created ? "（已创建默认配置）" : "（已存在，不修改）"}`);
  // 默认配置带 {env:BARK_DEVICE_KEY}，必须重新加载才能看到环境变量提供的 key。
  if (created) config = loadConfig().config;
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
    const own = lines ?? new Lines();
    const answer = (await own.ask("\n确认写入？(y/N): ")) ?? "";
    if (!lines) own.close();
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
  if (opencode) {
    const result = writeOpenCodePlugin();
    if (result === "unregistered") {
      console.log("已写入 OpenCode 插件，但无法自动注册（cli.json 带注释/尾逗号或不是合法 JSON）");
      console.log(`  请手动把 "${OPENCODE_CLI_PLUGIN}" 加进 ${OPENCODE_CLI_CONFIG_PATH} 的 plugins 数组，否则 OpenCode 不会加载`);
    } else {
      console.log(`${result === "written" ? "已写入" : "已是最新"} OpenCode 插件`);
    }
  }
  console.log("\n配置 Bark 凭据（持久化，重启后仍生效）");
  if (config.bark.deviceKey) {
    console.log(`  已配置：${maskKey(config.bark.deviceKey)}（更换：agent-notify key <你的BarkKey>）`);
  } else {
    const pasted = await promptBarkKey(lines);
    if (!pasted) {
      console.log("  未写入 Bark key。稍后运行 agent-notify key <你的BarkKey>");
    } else {
      try {
        saveDeviceKey(pasted);
        console.log(`  已写入 ${configPath}（key: ${maskKey(pasted)}）`);
      } catch (err) {
        console.log(`  写入失败：${err instanceof Error ? err.message : String(err)}`);
        console.log("  请手动运行 agent-notify key <你的BarkKey>");
      }
    }
  }
  console.log("  然后 agent-notify test");
  if (claude) console.log("\nClaude Code 新会话自动加载 hooks；当前会话可重启或输入 /hooks 检查。状态栏显示待发时间，输入 /ack 取消。");
  if (pi) console.log("Pi 正在运行时执行 /reload 以加载扩展。");
  if (opencode) console.log("OpenCode 重启后自动加载插件。");
  return 0;
}
