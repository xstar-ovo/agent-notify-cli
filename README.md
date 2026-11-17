# agent-notify

给 AI 编码 Agent 用的统一通知 CLI：任务结束 / 需要你操作 / 出错时推到手机，可设置延迟，离开电脑时不用一直盯着终端。

**当前支持：Claude Code + Pi + OpenCode V2 + Bark。** Telegram 渠道未实现。

## 安装

```bash
npm i -g agent-notify-cli   # 命令名仍是 agent-notify
```

或者从源码装（开发用）：

```bash
git clone https://github.com/xstar-ovo/agent-notify-cli.git
cd agent-notify-cli
npm install        # 会顺带 tsc 编译（prepare 脚本）
npm link           # 之后任意目录可用 an 或 agent-notify
```

两个名字等价（同一份 bin），下文统一写 `agent-notify`，敲 `an` 效果一样。

要求 Node ≥ 20：只用内置 `fetch`，无运行时依赖。

## 配置 Bark

```bash
agent-notify setup            # 交互式，会直接提示粘贴 key（推荐）
agent-notify key 你的BarkKey   # 也可以单独写
```

`setup` 结束时若配置文件里还没有有效 key，会提示粘贴：可贴 Bark App 首页那一串，也可贴整条 `https://api.day.app/<key>` 链接；直接回车则跳过，之后用 `agent-notify key` 补。已经配置过就只显示打码结果，不重复问。

key 直接写进配置文件，重启 / 关机后仍生效，不依赖环境变量。配置文件：`~/.config/agent-notify/config.json`（Windows: `C:\Users\<你>\.config\agent-notify\config.json`），也可以手改。

也可以不写进文件，用环境变量：把 `"deviceKey"` 改成 `"{env:BARK_DEVICE_KEY}"`。缺点明显——环境变量只对启动时已存在的进程有效，新开终端、重启 Pi 才继承，所以日常建议用 `agent-notify key`。

默认配置（`agent-notify key` 只替换 `bark.deviceKey`，其余字段原样保留）：

```json
{
  "bark": { "enabled": true, "endpoint": "https://api.day.app/{device_key}", "deviceKey": "{env:BARK_DEVICE_KEY}" },
  "events": { "stop": { "bark": true }, "notification": { "bark": true }, "error": { "bark": true }, "settled": { "bark": true } },
  "timeoutMs": 3000,
  "delayMs": { "stop": 300000, "settled": 300000, "error": 0, "notification": 0, "max": 600000 },
  "aggregateWindowMs": 5000
}
```

`bark.endpoint` 里的 `{device_key}` 会被替换成 key；换自建服务器就改这一行。`bark.icon` 可设全局默认图标，`delayMs` 是用户自定义通知时间的入口，单位是毫秒（命令行 `--delay` 是秒）。

## 接入 Agent

```bash
agent-notify setup            # 写入检测到的 Claude Code hooks、Pi 扩展和 OpenCode 插件，并提示粘贴 Bark key
agent-notify setup --dry-run  # 只看会写什么，不动文件
agent-notify uninstall        # 移除本工具写入的条目
```

同时检测到多个 Agent 时都会写入；`--dry-run` 会分别打印各自将写入的内容。Claude Code 会合并已有 `settings.json`，写入前备份，重复执行不会重复添加；状态栏会包装你原来的 statusLine，不会覆盖。

| Agent | 写入位置 | 生效方式 |
|---|---|---|
| Claude Code | `~/.claude/settings.json`（hooks + statusLine）+ `agent-notify-statusline.cjs` + `commands/ack.md` | 新会话自动生效；当前会话可在 `/hooks` 里检查 |
| Pi | `~/.pi/agent/extensions/agent-notify.ts` | 写完在 Pi 里 `/reload` |
| OpenCode | `~/.config/opencode/plugins/agent-notify/`（`index.ts` 服务端 + `tui.tsx` 终端界面） | 重启 OpenCode（插件在启动时加载）；需 2.x（V2 插件 API），1.x 的事件和插件格式不同，不支持 |

### Claude Code 行为

- `Stop` 每轮回答结束都会触发，按 `delayMs.stop` 延迟推送；用户提交新提示词时由 `UserPromptSubmit` 撤销，不会每轮都响。
- `Notification` 只匹配 `permission_prompt`，等待权限确认时立即提醒；不接 `idle_prompt`，避免和 `Stop` 重复。
- `UserPromptSubmit` 调用 `cancel --stdin-json`，按 Claude 的 `session_id` 撤销待发通知；不接 `SessionEnd`，否则 `claude -p` 这类短会话会在延迟到点前被取消，永远收不到完成通知。
- 状态栏包装原来的 statusLine，每秒刷新；有待发通知时在一行末尾追加 `消息通知时间 HH:mm:ss · MM:SS 后`。
- 输入 `/ack` 时，`UserPromptSubmit` hook 先取消当前会话待发通知，并返回 `decision: block`；Claude 不会生成回复。`disable-model-invocation: true` 禁止模型自动调用。
- 卸载会恢复原 statusLine，并删除本工具生成的 `/ack`。
- 正文优先取 `Notification` 的 `message`，其次取 `Stop` 的 `last_assistant_message`，截到 50 字；`--message` 仍然优先。
- hook 命令使用 setup 时的 node 绝对路径和 `dist/cli.js` 绝对路径；换 node 版本或移动仓库后重跑 `agent-notify setup`。
- 修改的是用户级 `~/.claude/settings.json`，只追加本工具的 hook 和状态栏包装；`agent-notify uninstall` 只删除这些条目并恢复原状态栏。
- Claude Code 没有逐键输入事件；开始输入不会像 Pi/OpenCode 那样自动取消，提交时由 `UserPromptSubmit` 撤销。

### Pi 行为

- `agent_start` 记开始时间，`agent_settled` 按配置延迟发送。
- 出错记为「任务出错」（读 `agent_before_settle` 的 `outcome`），不会误报「任务完成」；自己按 Esc 打断则不推。
- 正文带耗时和最后一条回复前 50 字的摘要，手机上能看出该不该回去看。
- `agent_start`、`input`、`session_shutdown`、`ui_prompt_end` 取消该会话的待发通知，避免人已经回来了还响。
- 连弹多个确认框 1 分钟内只提醒一次。
- 等待期间底部状态栏显示「通知 2分41秒 后推送 · /ack 取消」，倒数到 1 秒内自动消失。
- 倒计时期间开始往输入框打字，会自动取消待发通知；这是尽力判断，最多延迟约 1 秒。
- 找不到 `dist/cli.js`（仓库挪了位置或没 build）时，TUI 会红字提示并写入 `~/.config/agent-notify/extension-error.log`，不再静默失效。

看完了结果但不想继续，输 `/ack`，手机上还没发出去的那条通知就不会再推。

### OpenCode 行为

- `session.execution.succeeded` / `failed` 推送完成 / 出错；`interrupted`（自己按 Esc、关机、被新任务取代、长时间不活跃）不推。
- 正文带耗时和最后一段回复前 50 字的摘要。
- 收到新提示词或新执行开始时，撤销该会话还没发出的通知；`session.deleted` 也会清理。
- `permission.asked` / `form.created` 立即提醒「需要你操作」，1 分钟内只提醒一次；`permission.replied` / `form.replied` / `form.cancelled` 后撤销。
- 子代理（subagent）的会话不单独推送，也不显示 TUI 倒计时，避免一个任务弹一串通知。
- 插件分两部分：服务端 `index.ts` 负责 Bark 推送，TUI 部分 `tui.tsx` 在任务结束 / 出错时于 OpenCode 输入框上方常驻显示 `消息通知时间 11:34:21 · 04:32 后` 倒计时，到点后消失。
- 倒计时按配置的 `delayMs` 计算实际推送时间；对应事件或 Bark 总开关关闭时不显示。输入 `/ack` 可取消当前会话待发通知；服务端自动钩子也会取消。
- 插件用 setup 时的 node 绝对路径启动 CLI（OpenCode 本身跑在 Bun 里）。如果之后用 nvm 换了 node 路径，重跑一次 `agent-notify setup`，或设置环境变量 `AGENT_NOTIFY_NODE` 指向 node。
- 找不到 `dist/cli.js` 时写 `~/.config/agent-notify/extension-error.log`，不打断 OpenCode。

### 通知格式

只有标题和正文两行，没有副标题。标题是 Agent 名（如 `claude` / `pi` / `opencode`），正文以事件文案（任务完成 / 任务出错 / 等待处理）开头，后接「耗时 + 摘要」；附加信息在正文里用 ` · ` 接在事件文案后面。摘要按**第一句的句号或换行**截断，找不到句号才按 120 字硬截断。图标按 Agent 区分：

- Claude Code：标题 = `claude`
- Pi：标题 = `pi`，图标 = Pi logo
- OpenCode：标题 = `opencode`，图标 = OpenCode logo

`--message` 改附加信息，`--icon` 改图标，可以组合使用：

```bash
agent-notify notify settled --message "改了 3 个文件。" --icon https://example.com/x.png
```

终端上看是这样（Pi）：

```
┌─────────────────────────────
│ pi
│ 任务完成 · 用时 4分12秒 · 改完了 auth 中间件。
└─────────────────────────────
```

## 事件语义

| 事件 | 含义 | 默认正文前缀 | 默认延迟 |
|---|---|---|---|
| `settled` | Agent 任务真正结束（Pi 的 `agent_settled` / OpenCode 的 `session.execution.succeeded`） | 任务完成 | 5 分钟 |
| `stop` | Claude Code Stop hook：一轮回答结束 | 任务完成 | 5 分钟 |
| `notification` | 需要你操作（等确认 / 等输入） | 等待处理 | 立即 |
| `error` | 任务出错 | 任务出错 | 立即 |

`--message` 覆盖附加信息；事件文案固定由事件类型决定。哪个渠道收哪个事件由 `events.<事件>.bark` 控制。

## 延迟通知

任务结束后隔一段时间再提醒，避免你正好在看屏幕时被推一次、走了反而没提醒。

- 按事件配置：`delayMs.stop` / `delayMs.settled` / `delayMs.error` / `delayMs.notification`（毫秒）。
- 单次覆盖：`--delay <秒>`，`0` = 立即；超过 `delayMs.max`（默认 600000，可调，上限 1800000）会被截断。
- 同一 session 在延迟期内再次触发会**覆盖**上一条，任务重新开始就不会误报完成。
- `agent-notify cancel --session <id>` 撤销；`agent_start` 等钩子会自动撤销。
- 多条同时到期聚合成一条（`aggregateWindowMs`，默认 5 秒），不刷屏。
- 待发通知落盘在 `~/.config/agent-notify/state/pending/*.json`，每条一个独立 waker 子进程；Hook 主进程从不 sleep，1 秒内返回。
- 取舍：关机 / 休眠会杀掉 waker，待发通知在下次任何事件、`flush` 或下次打开会话时补发（可能迟到）。

## 命令

发送：

| 命令 | 说明 |
|---|---|
| `agent-notify notify <stop\|settled\|notification\|error>` | 触发一次通知（Agent 钩子就是这么调的） |
| `agent-notify cancel [--session <id>]` | 取消该 session 的待发通知 |
| `agent-notify flush` | 立即发送所有已到期的待发通知 |

管理：

| 命令 | 说明 |
|---|---|
| `agent-notify setup [--dry-run] [--yes]` | 写入检测到的 Claude Code hooks、Pi 扩展和 OpenCode 插件；交互运行时还会提示粘贴 Bark key |
| `agent-notify uninstall` | 移除本工具写入的 hooks / 扩展 / 插件，并恢复原状态栏 |
| `agent-notify key <bark-key>` | 把 Bark key 写入配置文件（持久化） |

诊断：

| 命令 | 说明 |
|---|---|
| `agent-notify test` | 发一条测试通知（退出码 1 = 失败） |
| `agent-notify status` | 当前配置和待发通知（还剩多久）；有新版本时提示升级（结果缓存 24 小时） |
| `agent-notify doctor` | 自查：配置、key、node / CLI 路径、各 Agent 的接入状态（退出码 1 = 有硬错误）；同样带新版本提示 |
| `agent-notify --help` | 用法 |

`notify` 的选项：

| 选项 | 说明 |
|---|---|
| `--delay <秒>` | 覆盖该事件的延迟，详见「延迟通知」 |
| `--session <id>` | 去重 / 取消用的键，同 session 只留最新一条 |
| `--message <text>` | 附加到正文（首句截断） |
| `--icon <url>` | 覆盖图标 |
| `--agent <name>` | 标题前缀，默认 `agent`（读到 Claude hook JSON 时自动用 `claude`） |
| `--stdin-json` | 从 stdin 读 Agent 传入的 hook JSON（300ms 超时，不阻塞） |

`notify` / `cancel` / `flush` 永远 `exit 0`（未知命令、未知事件也只往 stderr 提示）：通知失败只写 `~/.config/agent-notify/error.log`（已脱敏，>1MB 轮转），绝不打断 Agent。`test` / `doctor` / `key` 会返回非 0 表示问题。

## 卸载

先移除已写入的条目，再卸载 npm 包。顺序反了，hooks 会指向已删除的 `dist/cli.js`，每次 Stop 都报 `Cannot find module`（`agent-notify doctor` 会提示）：

```bash
agent-notify uninstall          # 移除 hooks / 扩展 / 插件，恢复原状态栏
npm uninstall -g agent-notify-cli
```

CLI 已经删掉的话用 `npx -y agent-notify-cli uninstall` 兜底。`npm uninstall` 本身不会清理任何写入项。配置目录 `~/.config/agent-notify/`（含 Bark key、待发通知）不会删除，重装后还能用。

## 自检与排障

```bash
agent-notify doctor                        # 0) 配置 / key / 接入状态一次看完
agent-notify test                          # 1) 渠道通不通
agent-notify notify stop --delay 0 --message "手动测试"   # 2) 整条链路通不通
```

没收到通知时按顺序查：

1. `agent-notify test` —— 渠道通不通：报 key missing 就 `agent-notify key <key>`；报 HTTP 错误就看 `error.log`。Bark 返回 `{"code":200}` 才算成功，HTTP 200 也可能是业务失败。
2. `~/.config/agent-notify/state/pending/` —— 有 `.json` 说明还在等延迟，时间没到或 waker 被关机杀掉了，`agent-notify flush` 立即补发。
3. `~/.config/agent-notify/error.log` —— 最近失败原因（已脱敏，可直接贴出来）。

## 隐私与数据流

通知内容（Agent 名、事件文案或消息摘要）经 `bark.endpoint` 转发到你的设备，默认是公共服务器 `api.day.app`；介意就自建 [bark-server](https://github.com/Finb/bark-server) 后改 `endpoint`。除这一个请求外没有遥测、没有其他出站连接。Bark key 只存本机配置文件，仓库和发布包里不含任何密钥。

## 开发

测试在 `test/`（镜像 `src/` 的目录结构），`npm run build` 只编译 `src/` → `dist/`，发布包不含测试。

```bash
npm run build   # tsc -p tsconfig.json      → dist/
npm test        # tsc -p tsconfig.test.json → dist-test/ 然后跑 node --test
```

新增测试放 `test/<同样的子目录>/xxx.test.ts`，用 `../../src/...` 引用被测模块。

测试里需要 Bark key 的地方读 `test/helpers/env.ts` 的 `testBarkKey()`：优先 `.env`（复制 `.env.example` 后填 `BARK_TEST_KEY`，已被 git 忽略）或环境变量，都没有就用内置假 key，不会真的推送。

工具链：Node 24（`>=20` 即可跑）、TypeScript 6.0.3。注意 TS 6 不再自动加载 `@types`，`tsconfig.json` 必须保留 `"types": ["node"]`，否则全量报 `Cannot find name 'process'`。

> 为什么不用 TypeScript 7：7 是原生 Go 版，`node_modules/typescript/lib/` 只剩 5 个 shim 文件，没有 `lib.*.d.ts`、也没有 `tsserver.js`；编辑器拿它做语言服务会满屏 `Cannot find global type 'Array'` / `Cannot find name 'JSON'`。命令行 `tsc` 能用，但为了编辑器，锁 6.0.3。

## License

MIT
