# Bark 推送参数参考

来源：`Finb/Bark` 仓库 `docs/params.md`、`docs/tutorial.md`、`docs/API_V2.md`（master 分支，2026-11 核对）。
用于本项目的 `bark.params` 透传与每事件覆盖配置。

## 1. 请求方式

| 方式 | 示例 | 说明 |
|---|---|---|
| 路径带 key + JSON body | `POST https://api.day.app/{key}` | 本项目默认方式 |
| `/push` + body 带 key | `POST https://api.day.app/push` | v2 REST 推荐写法，body 里放 `device_key` |
| 路径拼接 | `GET https://api.day.app/{key}/{title}/{body}?group=x` | 手动拼接注意 URL 编码 |

请求头：`Content-Type: application/json; charset=utf-8`。

成功响应：

```json
{ "code": 200, "message": "success", "timestamp": 1700000000 }
```

失败时 `code` 为其他值（如 `400`），`message` 说明原因。**注意：HTTP 200 也可能是业务失败，必须判断 `code`。**

## 2. 全部消息体参数

参数名在 GET 查询串、POST 表单、JSON body 中完全一致。

### 内容

| 参数 | 类型 | 说明 |
|---|---|---|
| `title` | string | 标题，通知卡片第一行，字号大于正文 |
| `subtitle` | string | 副标题，标题下方、正文上方的较小字号位置（适合放来源、状态） |
| `body` | string | 正文 |
| `markdown` | string | Markdown 正文，支持粗体/斜体/删除线/链接/行内代码/代码块/1-6 级标题/引用/列表/任务列表；图片降级为链接文本；**传了会忽略 `body`** |

### 设备

| 参数 | 类型 | 说明 |
|---|---|---|
| `device_key` | string | 单设备 key，路径为 `/push` 时放 body 里 |
| `device_keys` | string[] | 批量推送，仅 JSON；公共服务器单次最多 10 台，自建无上限；需 bark-server ≥ 2.1.9 |

### 展示与分组

| 参数 | 类型 | 说明 |
|---|---|---|
| `group` | string | 消息分组，同组在通知中心和历史里归类，长按可对整组静音 |
| `icon` | string(URL) | 自定义通知图标，替换默认 Bark 图标；本机缓存，同 URL 只下一次，首次下载超 10s 回退默认；iOS 15+（watchOS 11+） |
| `image` | string(URL) | 推送大图，展开通知可见，也会进历史记录；同样缓存，超 10s 不带图显示 |
| `badge` | int | App 角标数字，直接赋值不累加；`0` 清角标并清掉通知中心里该 App 的通知 |

### 提醒与铃声

| 参数 | 类型 | 说明 |
|---|---|---|
| `level` | string | `active`（默认，立即亮屏）/ `timeSensitive`（时效性，专注模式也显示）/ `passive`（只进列表不亮屏）/ `critical`（重要警告，静音也响，需 App 内授权，未授权降级为普通通知） |
| `volume` | 0-10 | 仅 `level=critical` 生效的音量，默认 5 |
| `call` | `"1"` | 铃声循环播放 30 秒（默认只响一次） |
| `sound` | string | 铃声名，如 `minuet`；App 内置或自导入（`.caf`、≤30s）；名称不存在回退默认提示音 |
| `soundUrl` | string(URL) | 链接音频作铃声，仅 `.caf`、≤30s、≤6MB，需以 `.caf` 结尾或 `Content-Type: audio/x-caf`；下载超 10s 或失败回退 `sound`/默认；按完整链接缓存，30 天未用或总量超 20MB 时淘汰。适合 TTS 语音播报，建议用内容哈希命名链接避免重复合成 |

### 复制与跳转

| 参数 | 类型 | 说明 |
|---|---|---|
| `copy` | string | 复制推送时复制的内容（如只复制验证码）；不传则复制正文 |
| `url` | string | 点击跳转地址，支持 URL Scheme 和 Universal Link；http(s) 优先 Universal Link，失败用 Safari |
| `action` | string | `alert`：点击打开 App 并弹操作框（复制/分享）；`none`：点击只开 App 不跳转；其他值默认行为。同时有 `url` 时以 `url` 优先 |

### 加密

| 参数 | 类型 | 说明 |
|---|---|---|
| `ciphertext` | string | 加密密文，服务器和 APNs 均不可见，只有本机 App 能解；密文内可含 `title`/`subtitle`/`body`/`sound`/`group`/`badge` 等；解密失败显示 `Decryption Failed` |
| `iv` | string | 加密随机 IV，随请求一起传 |

### 保存与管理

| 参数 | 类型 | 说明 |
|---|---|---|
| `isArchive` | `"1"` | 是否保存到 App 历史记录；不传按 App 设置（默认保存） |
| `ttl` | int(秒) | 已保存推送的有效期，过期自动删历史并移除通知中心通知；适合验证码、临时告警 |
| `id` | string | 通知唯一标识，相同 `id` 的新推送**原地替换**旧通知，适合进度/状态滚动更新；需 App ≥ 1.5.2、bark-server ≥ 2.2.5；**JSON 中必须是字符串，传数字不生效** |
| `delete` | `"1"` | 删除指定通知（通知中心 + 历史），需配合 `id`；走静默推送，需系统开启「后台 App 刷新」 |

### 已废弃 / 无效

| 参数 | 说明 |
|---|---|
| `autoCopy` | iOS 14.5 后系统禁止收到即复制；仅 API_V2 兼容层保留，新代码不要用 |
| `category` | 保留字段，暂未使用 |

## 3. 请求示例

```bash
# 路径带 key（本项目当前用法）
curl -X POST "https://api.day.app/your_key" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{
    "title": "任务完成",
    "subtitle": "pi · my-project",
    "body": "改了 3 个文件",
    "group": "agent-notify",
    "icon": "https://example.com/agent.png",
    "level": "timeSensitive",
    "sound": "minuet",
    "isArchive": "1",
    "ttl": 86400,
    "id": "pi:1234",
    "url": "cursor://file/src/cli.ts"
  }'

# v2 REST：key 放 body
curl -X POST "https://api.day.app/push" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"device_key":"your_key","title":"标题","body":"正文"}'
```

## 4. 限流与注意事项

- 公共服务器 5 分钟内错误请求超过 1000 次会封 IP 24 小时（来源：Bark FAQ），所以参数错误要当失败处理，不要盲目重试。
- 配置错误的 endpoint 不要拼 `/push`：路径式用 `/{key}`，REST 式才用 `/push` + `device_key`。
- `icon`/`image`/`soundUrl` 都在设备侧下载并缓存，URL 必须公网可达；内网地址在手机上大概率失败。
- `critical` 需用户在 App 内单独授权「重要警告」，否则静默降级。
- `id` / `delete` 依赖较新版本，公共 `api.day.app` 的实际版本未验证；不可用时表现为普通推送（不会报错）。

## 5. 本项目配置映射（建议方案，尚未实现）

```json
{
  "bark": {
    "endpoint": "https://api.day.app/{device_key}",
    "deviceKey": "{env:BARK_DEVICE_KEY}",
    "params": {
      "icon": "https://example.com/agent.png",
      "group": "agent-notify",
      "level": "timeSensitive",
      "isArchive": "1",
      "ttl": 86400
    },
    "events": {
      "stop":         { "subtitle": "任务完成", "sound": "minuet" },
      "settled":      { "subtitle": "任务完成" },
      "notification": { "level": "active", "call": "1" },
      "error":        { "level": "critical", "volume": 8, "call": "1", "subtitle": "任务出错" }
    }
  }
}
```

规则：

- 全局 `params` 与事件级覆盖合并（事件级优先），`title`/`body` 仍由模板生成，其余字段原样透传。
- 同 session 固定 `id = "agent-notify:" + session`：进度更新原地替换，不用清理旧通知。
- `--cancel` 时用 `delete=1` + `id` 删除手机上对应通知（失败静默忽略）。
- `markdown` 默认关闭：正文含路径、反引号，容易被 Markdown 解析吃掉。
