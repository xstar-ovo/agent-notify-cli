# 本地开发与测试

本文记录「改了仓库代码，怎么让它立刻在你自己的 Claude Code / Pi / OpenCode 里生效」，以及怎么不打扰手机。

日常跑测试（不碰你的真实环境）见 `README.md` 的开发小节；本文只讲**跑在真实宿主里**的那条链路。

## 一、原理

`setup` 写进集成的是**当前这份 `cli.js` 的绝对路径**：

```ts
// src/setup/claude.ts:17、src/setup/pi.ts:23、src/setup/opencode.ts:38
const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
```

由此得出三条事实，方案的取舍都基于它们：

1. **用哪份跑 `setup`，集成就指向哪份。** 仓库的 `dist/cli.js` 和全局安装的那份是两个目录，切换就是重跑一次 `setup`。
2. **每次触发都是新起一个 node 进程。** 重建 `dist/` 之后，下一次事件立即用新代码，不用重启 Claude / Pi / OpenCode。
3. **`setup` 会覆盖我们自己的 hook。** `refreshOurs()` 命中命令签名就整条替换，所以来回切换是幂等的，不会堆出两份 hook。

注意：`doctor` 的集成状态**故意路径无关**（换安装路径后命令仍然可用，不该报 outdated），所以**不能用 doctor 验证指向**，必须 grep 文件。

## 二、让集成指向仓库（一次性）

```powershell
cd D:\Desktop\agent_notify_cli
npm run build                      # 约 2 秒
node dist/cli.js setup --yes       # 把 Claude hooks / statusLine / Pi / OpenCode 全部改指仓库
```

验证四条，都应命中 `agent_notify_cli`：

```powershell
Select-String "$env:USERPROFILE\.claude\settings.json" -Pattern "agent_notify_cli"          # 3 处
Select-String "$env:USERPROFILE\.claude\agent-notify-statusline.cjs" -Pattern "agent_notify_cli"
Select-String "$env:USERPROFILE\.pi\agent\extensions\agent-notify.ts" -Pattern "agent_notify_cli"
Select-String "$env:USERPROFILE\.config\opencode\plugins\agent-notify\index.ts" -Pattern "agent_notify_cli"
```

之后日常循环只有一步：**改完 `npm run build`**，下一个事件就是新代码。

> ⚠️ 别在终端里敲 `an setup` / `agent-notify setup`。那两个命令指向全局安装那份，会把集成改回全局路径。开发期一律用 `node dist/cli.js setup --yes`。

## 三、保存即生效（可选）

```powershell
# 终端 1
npm run build -- --watch
# 终端 2 干活：保存 .ts → dist 自动更新
```

`tsc --watch` 是逐文件重写的，极端情况下 hook 可能读到半写的 `cli.js`（有 10 秒 timeout 兜底，`doctor` 也会报 `broken`）。想绝对稳就手动 `npm run build`，2 秒。

不要为了省这 2 秒让集成直接跑 `node src/cli.ts`：`engines` 是 `>=20`，类型剥离在旧版本上不可用，且 hook 命令模板固定是 `node <…/cli.js>`。

## 四、开发期别打扰手机

集成由宿主进程 spawn，**不继承你终端的环境变量**，所以 `AGENT_NOTIFY_CONFIG` / `AGENT_NOTIFY_CONFIG_DIR` 只对手动命令有效，对真实链路无效。三条可行做法：

### 1. 直接关掉推送

`~/.config/agent-notify/config.json` 里 `"bark": { "enabled": false }`。验证靠 `node dist/cli.js status`（看 `pending/`）和 `~/.config/agent-notify/error.log`。

### 2. 指向本地 stub（推荐，能看到真实 payload）

```powershell
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(new Date().toISOString(),q.url,b);s.end('{\"code\":200}')})}).listen(8787)"
```

config 里改成：

```json
"bark": { "enabled": true, "endpoint": "http://127.0.0.1:8787/{device_key}" }
```

测完改回 `https://api.day.app/{device_key}`。

### 3. 换独立 key / group

仍然会真推，只是手机上一眼能认出是测试。

## 五、端到端自检（不用等真实任务结束）

```powershell
'{"session_id":"dev1"}' | node dist/cli.js --agent claude notify stop --stdin-json
node dist/cli.js status                     # 应看到 dev1 待发
node dist/cli.js flush                      # 立即发，走第四节选定的出口
echo '{"session_id":"dev1"}' | node "$env:USERPROFILE\.claude\agent-notify-statusline.cjs"
```

`notify stop` 默认有延迟（`config.delayMs.stop`，默认 5 分钟），想立刻看到效果就加 `--delay 0`。

## 六、切回发布版

前提：发布版里要有你刚测的改动。注册表上的版本是上次 CI 发的，**没发版就直接切回去等于回退**。先 `npm version minor && git push` 让 CI 发版，或者接受丢掉本地改动。

```powershell
# 1. 摘掉全局的目录链接（只删链接，不碰仓库）
cmd /c rmdir "$(Join-Path (npm root -g) 'agent-notify-cli')"

# 2. 装注册表版本
npm i -g agent-notify-cli@latest

# 3. 让集成改回安装目录路径（这步不能省）
agent-notify setup --yes

# 4. 核对
npm list -g --depth=0          # 不该再有 ->
an doctor                      # CLI 行应指向 ...\node_modules\agent-notify-cli\dist\cli.js
```

### 为什么不能先 `npm i -g` / 不能 `Remove-Item -Recurse`

`npm i -g .` 在全局建立的不是副本，而是**指向仓库的目录链接**（junction，`npm list -g` 里显示 `agent-notify-cli@0.3.1 -> D:\Desktop\agent_notify_cli`）。对着链接用 `Move-Item` 或 `Remove-Item -Recurse`，PowerShell 会把它当普通目录递归进去，**删除/搬走的是仓库里的真实文件**（`Move-Item` 还会先搬内容再删链接，失败时表现为「仓库被清空」）。摘链接只能用 `cmd /c rmdir`：不递归、只解引用。

万一已经踩了：文件通常整批在目标位置（如 `%TEMP%\an-dev-link-backup`），用 `robocopy <备份> D:\Desktop\agent_notify_cli /MOVE /E` 搬回来，再 `git log -1` + `npm test` 核对。

## 七、关于 `npm link`

`npm link` **只影响 `an` / `agent-notify` 两个命令**，不影响集成（集成里存的是绝对路径）。所以：

- 想让命令行也跑仓库代码：`npm link`，之后 `an` 直接是仓库 `dist/cli.js`（同样要 `npm run build`）；
- 别让「link 出来的条目」和「真实安装的 `agent-notify-cli`」长期并存——两者都声明 `an` + `agent-notify` 两个 bin，`npm ls -g` 会出现名字不一致的重复条目，只会让人困惑；
- 只想让集成生效、不在乎 `an` 指向哪份：**不需要 link**，第二节的 `node dist/cli.js setup --yes` 就够了。

## 八、排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `doctor` 报 `broken` | 集成指向的 `cli.js` 不存在（通常是 `clean` 掉了 `dist/`，或仓库被移动） | `npm run build` 后重跑 `setup` |
| 改了代码但行为没变 | 没 build；或集成被改回了全局那份 | `npm run build`，grep 一遍第二节的四条路径 |
| `doctor` 说「已接入，最新」但集成指向全局 | 状态判断与路径无关，属预期 | 用 grep 验证，别信 status |
| Pi / OpenCode 报「写入的是旧版本」 | 扩展模板变了（`setup` 升级后） | 重跑 `node dist/cli.js setup --yes` |
| 手机收到一堆测试推送 | 用了真实 Bark key | 第四节方式 1 或 2 |

## 九、边界

- 集成里存的是**快照路径**：仓库目录改名/移动后必须重跑 `setup`（`doctor` 会报 `broken` 提示）。
- 切换期间 `pending/` 里的记录格式兼容（`retries` 是可选字段），不会丢。
- `~/.config/agent-notify/extension-error.log` 会随开发期触发持续增长（每行 `ack: fired`），没有自动轮转，必要时手动清空。
