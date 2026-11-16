# agent-notify

给 AI 编码 Agent 用的统一通知 CLI：任务结束 / 需要你操作 / 出错时推到手机，可设置延迟，离开电脑时不用一直盯着终端。

**当前支持：Pi + Bark。** Claude Code、OpenCode 未内置自动安装，Telegram 渠道未实现。

## 安装

```bash
npm i -g agent-notify-cli   # 命令名仍是 agent-notify
```

或者从源码装（开发用）：

```bash
git clone https://github.com/xstar-ovo/agent-notify-cli.git
cd agent-notify-cli
npm install        # 会顺带 tsc 编译（prepare 脚本）
npm link           # 之后任意目录可用 agent-notify
```

要求 Node ≥ 20：只用内置 `fetch`，无运行时依赖。

## 配置 Bark

```bash
agent-notify key 你的BarkKey
```

key 直接写进配置文件，重启 / 关机后仍生效，不依赖环境变量。配置文件：`~/.config/agent-notify/config.json`（Windows: `C:\Users\<你>\.config\agent-notify\config.json`），也可以手改。

也可以不写进文件，用环境变量：把 `"deviceKey"` 改成 `"{env:BARK_DEVICE_KEY}"`。缺点明显——环境变量只对启动时已存在的进程有效，新开终端、重启 Pi 才继承，所以日常建议用 `agent-notify key`。

默认配置（`agent-notify key` 只替换 `bark.deviceKey`，其余字段原样保留）：

```json
{
  "bark": { "enabled": true, "endpoint": "https://api.day.app/{device_key}", "deviceKey": "{env:BARK_DEVICE_KEY}" },
  "events": { "stop": { "bark": true }, "notification": { "bark": true }, "error": { "bark": true }, "settled": { "bark": true } },
  "timeoutMs": 3000,
  "delayMs": { "stop": 180000, "settled": 180000, "error": 0, "notification": 0, "max": 300000 },
  "aggregateWindowMs": 5000
}
```

`bark.endpoint` 里的 `{device_key}` 会被替换成 key；换自建服务器就改这一行。`bark.icon` 可设全局默认图标，`delayMs` 单位是毫秒（命令行 `--delay` 是秒）。

## 接入 Pi

```bash
agent-notify setup            # 写入 ~/.pi/agent/extensions/agent-notify.ts
agent-notify setup --dry-run  # 只看会写什么，不动文件
agent-notify setup --uninstall
```

写完在 Pi 里 `/reload` 生效。扩展行为：

- `agent_start` 记开始时间，`agent_settled` 按配置延迟发送。
- 出错记为「任务出错」（读 `agent_before_settle` 的 `outcome`），不会误报「任务完成」；自己按 Esc 打断则不推。
- 正文带耗时和最后一条回复前 60 字的摘要，手机上能看出该不该回去看。
- `agent_start`、`input`、`session_shutdown`、`ui_prompt_end` 取消该会话的待发通知，避免人已经回来了还响。
- 连弹多个确认框 1 分钟内只提醒一次。
- 找不到 `dist/cli.js`（仓库挪了位置或没 build）时，TUI 会红字提示并写入 `~/.config/agent-notify/extension-error.log`，不再静默失效。

看完了结果但不想继续，按 `ctrl+shift+k` 或输 `/seen`，手机上还没发出去的那条通知就不会再推。

通知内容：**标题 = 事件**（任务完成 / 任务出错 / 等待处理），**副标题 = `pi · 项目目录`**，**正文 = 耗时 + 摘要**，**图标 = Pi logo**。都可覆盖：

```bash
agent-notify --event settled --title "重构 auth 模块" --message "改了 3 个文件" --icon https://example.com/x.png
```

终端上看是这样：

```
┌─────────────────────────────
│ 任务完成
│ pi · my-project
│ 用时 4分12秒 · 改完了 auth 中间件
└─────────────────────────────
```

## 事件语义

| 事件 | 含义 | 默认标题 | 默认延迟 |
|---|---|---|---|
| `settled` | Pi 任务真正结束（不会自动继续） | 任务完成 | 3 分钟 |
| `stop` | Claude Code Stop hook：一轮回答结束 | 任务完成 | 3 分钟 |
| `notification` | 需要你操作（等确认 / 等输入） | 等待处理 | 立即 |
| `error` | 任务出错 | 任务出错 | 立即 |

`--title` / `--message` 可覆盖标题和正文。哪个渠道收哪个事件由 `events.<事件>.bark` 控制。

## 延迟通知

任务结束后隔一段时间再提醒，避免你正好在看屏幕时被推一次、走了反而没提醒。

- 按事件配置：`delayMs.stop` / `delayMs.settled` / `delayMs.error` / `delayMs.notification`（毫秒）。
- 单次覆盖：`--delay <秒>`，超过 `delayMs.max`（默认 300000，可调，上限 600000）会被截断。
- 同一 session 在延迟期内再次触发会**覆盖**上一条，任务重新开始就不会误报完成。
- `--cancel --session <id>` 撤销；`agent_start` 等钩子会自动撤销。
- 多条同时到期聚合成一条（`aggregateWindowMs`，默认 5 秒），不刷屏。
- 待发通知落盘在 `~/.config/agent-notify/state/pending/*.json`，每条一个独立 waker 子进程；Hook 主进程从不 sleep，1 秒内返回。
- 取舍：关机 / 休眠会杀掉 waker，待发通知在下次任何事件、`flush` 或下次打开会话时补发（可能迟到）。

## 命令

子命令：

| 命令 | 说明 |
|---|---|
| `agent-notify test` | 发一条测试通知（退出码 1 = 失败） |
| `agent-notify flush` | 立即发送所有已到期的待发通知 |
| `agent-notify key <bark-key>` | 把 Bark key 写入配置文件（持久化） |
| `agent-notify setup [--dry-run] [--uninstall] [--yes]` | 写入 / 卸载 Pi 扩展 |
| `agent-notify --help` | 用法 |

选项（配合 `--event` 用，Agent 钩子也是这么调）：

| 选项 | 说明 |
|---|---|
| `--event <stop\|settled\|notification\|error>` | 触发哪个事件 |
| `--delay <秒>` | 覆盖该事件的延迟，`0` = 立即 |
| `--session <id>` | 去重 / 取消用的键，同 session 只留最新一条 |
| `--message <text>` | 附加到正文 |
| `--title <text>` / `--icon <url>` | 覆盖标题 / 图标 |
| `--agent <name>` | 正文前缀，默认 `agent`（读到 Claude hook JSON 时自动用 `claude`） |
| `--stdin-json` | 从 stdin 读 Agent 传入的 hook JSON（300ms 超时，不阻塞） |
| `--cancel` | 取消该 session 的待发通知 |

除 `test` 外永远 `exit 0`：通知失败只写 `~/.config/agent-notify/error.log`（已脱敏，>1MB 轮转），绝不打断 Agent。

## 自检

```bash
agent-notify test                          # 1) 渠道通不通
agent-notify --event stop --delay 0 --message "手动测试"   # 2) 整条链路通不通
```

## 没收到通知？

1. `agent-notify test` —— 报 key missing 就 `agent-notify key <key>`；报 HTTP 错误就看 `error.log`。Bark 返回 `{"code":200}` 才算成功，HTTP 200 也可能是业务失败。
2. `~/.config/agent-notify/state/pending/` —— 有 `.json` 说明还在等延迟，时间没到或 waker 被关机杀掉了，`agent-notify flush` 立即补发。
3. `~/.config/agent-notify/error.log` —— 最近失败原因（已脱敏，可直接贴出来）。

## 隐私与数据流

通知内容（Agent 名、项目目录名、任务名或消息摘要）经 `bark.endpoint` 转发到你的设备，默认是公共服务器 `api.day.app`；介意就自建 [bark-server](https://github.com/Finb/bark-server) 后改 `endpoint`。除这一个请求外没有遥测、没有其他出站连接。Bark key 只存本机配置文件，仓库和发布包里不含任何密钥。

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
