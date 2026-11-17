# npm 发布流程

本文记录 `agent-notify-cli` 的发布方式：首次发布做了什么，以及之后每次发版的日常流程（推 `main` 自动发）。

## 一、包的基本形态

| 项 | 值 |
| --- | --- |
| 包名 | `agent-notify-cli`（无 scope，默认 public） |
| 安装后命令 | `agent-notify` 和 `an`（`bin` 都指向 `bin/agent-notify.js`） |
| 入口 | `bin/agent-notify.js` → 动态 import `dist/cli.js` 并调用 `main()` |
| 发布内容 | `files` 白名单：`dist/`、`bin/`、`README.md`（+ 自动包含 `LICENSE`、`package.json`） |
| 编译 | `prepare` 脚本跑 `tsc -p tsconfig.json`，`npm install` / `npm publish` 前自动构建 |
| 运行时依赖 | 无（`devDependencies` 只有 typescript 和 @types/node，不进用户环境） |
| Node 要求 | `engines: >=20`；CI 与本地开发用 24 |

`dist/` 在 `.gitignore` 里，不进仓库——靠 `prepare` 在打包/安装时现编译，所以**不需要**手动提交编译产物。

发布前自检：

```powershell
npm install                 # 装依赖 + 触发 prepare 构建
npm test                    # 71 个用例应全绿
npm pack --dry-run          # 看 tarball 内容，确认只有 dist/bin/README/LICENSE/package.json
node bin/agent-notify.js --help
```

## 二、首次发布（已完成）

首次发布是手动做的，步骤留档：

```powershell
# 1. 确认包名可用（404 = 没被占）
npm view agent-notify-cli version

# 2. 登录 npm（有 2FA 会要 OTP）
npm login
npm whoami

# 3. 发布
npm publish

# 4. 验证
npm view agent-notify-cli version
npx agent-notify-cli --help
```

首次发布结果：`agent-notify-cli@0.1.0`，tarball 21 个文件、29.1 kB（解包 88.9 kB）。

## 三、日常发版（CI 自动发布）

### 一次性配置

1. **npm token**：npmjs.com → Access Tokens → Generate New Token → Granular Access Token
   - Permissions: `Read and write`
   - Packages: 选中 `agent-notify-cli`（或 All packages）
   - **必须勾选 `Bypass two-factor authentication`**，否则 CI 发布报 `EOTP`
   - 有效期建议 1 年，到期更换
2. **GitHub secret**：仓库 → Settings → Secrets and variables → Actions → New secret
   - Name: `NPM_TOKEN`
   - Value: 上面那个 `npm_` 开头的 token

### 发版三步

```powershell
npm test                                             # 1. 保险：71/71 全绿
npm version minor -m "chore(release): v%s"            # 2. 升版本（0.x 破坏性变更用 minor），自动 build + commit + 打 tag
git push origin main --follow-tags                    # 3. 推 commit 和 tag，CI 自动发布
```

版本号怎么选：破坏性变更（如命令面改动，旧 hooks 需要重跑 `an setup`）用 `minor`（0.x 下 `0.1.0 → 0.2.0`）；修 bug 用 `patch`；正式跨大版本用 `major`。

发布后确认：

```powershell
npm view agent-notify-cli version       # 应输出新版本号
npx agent-notify-cli@<新版本> doctor     # 或 an status
```

破坏性变更建议同时在 GitHub 发 Release，写清升级后要重跑 `an setup`。

推上去之后 GitHub Actions（`.github/workflows/ci.yml`）会：

1. `test` job：`npm ci` → `npm test`（PR 和所有分支也跑这个）
2. `publish` job（仅 `push` 到 `main` 且 `test` 通过）：
   - 读出 `package.json` 的版本号
   - `npm view agent-notify-cli@<版本>` 已存在 → 打印 skip，job 不红
   - 不存在 → `npm publish --access public`

注：仓库当前是 **private**，所以没有开 `--provenance`（来源签名要求仓库 public）。以后仓库转 public，可以把 job 的 `permissions` 加回 `id-token: write`，并在 publish 命令上加 `--provenance`。

### 版本号没改的情况

合并进 `main` 但没 `npm version`，publish job 会 skip，不会失败。要发版就必须升版本号——这是刻意的，避免同版本重复发布。

## 四、手动应急发布

CI 挂了但需要立刻发：

```powershell
npm login
npm version patch
npm publish                 # 本地发布，注意 token/2FA
git push origin main --follow-tags
```

需要来源签名：`--provenance` 只能在 public 仓库的 CI 里用（要 OIDC），本地和 private 仓库都要去掉。

## 五、排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `E403` 或 `EPUBLISHCONFLICT` | 包名被抢注。改用 scoped 名 `@xstar-ovo/agent-notify-cli`，同时 `npm publish --access public`，README 里的 `npm i -g` 也要改 |
| `EOTP` | token 没开 bypass 2FA。npmjs → Access Tokens → Generate New Token，勾上 **Bypass two-factor authentication**（Read and write + 选本包），再把新 token 写回 GitHub secret `NPM_TOKEN`。本地发布则带 `--otp <6位码>` |
| CI publish 报 provenance 错误 | 仓库是 private（当前就是），不要加 `--provenance`；转 public 后才加回，同时 job 需要 `id-token: write` 权限 |
| CI `npm ci` 报 lock 不同步 | 改过依赖没更新 `package-lock.json`，本地跑一次 `npm install` 再提交 |
| 用户装完命令跑不起来 | 检查 `bin/agent-notify.js` 的 shebang 和 `dist/cli.js` 是否导出 `main`；`npm pack --dry-run` 确认 dist 打进去了 |
| 发布后忘了推 tag | `git push --follow-tags`（`npm version` 会生成 `vX.Y.Z` tag） |

## 六、相关文件

- `package.json`：`name` / `version` / `bin` / `files` / `prepare`
- `.github/workflows/ci.yml`：test + publish 两个 job
- `tsconfig.json`：`src/` → `dist/`，`tsconfig.test.json`：`src/` + `test/` → `dist-test/`
