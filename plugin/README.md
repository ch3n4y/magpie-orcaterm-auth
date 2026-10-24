# opencode-orcaterm-auth

Magpie / OpenCode v1 供应商插件：把 **OrcaTerm 内置 AI（`lightai.cloud.tencent.com/assistant`）** 的多个模型接成标准供应商。

协议来自客户端逆向 + 实网验证。

## 模型

| 供应商下的模型名 | 上游 model id |
|---|---|
| `orcaterm/deepseek-v4-pro` | `TokenHub/deepseek-v4-pro` |
| `orcaterm/deepseek-v4-flash` | `TokenHub/deepseek-v4-flash` |
| `orcaterm/deepseek-v4.1-flash` | `TokenHub/deepseek-v4.1-flash` |
| `orcaterm/glm-5.3` | `TokenHub/glm-5.3` |
| `orcaterm/glm-5.3-flash` | `TokenHub/glm-5.3-flash` |
| `orcaterm/glm-5.2` | `TokenHub/glm-5.2` |
| `orcaterm/kimi` | `TokenHub/kimi-k3` |
| `orcaterm/hunyuan` | `Hunyuan3/hy3` |
| `orcaterm/hunyuan4` | `Hunyuan3/hy4-preview` |

权限按账号走：无权限的模型上游返回 `[LLM_ERROR]: 401 token无访问此模型权限`。

## 安装与登录

```bash
magpie plugin add ./plugin
登录提供三种方式：

### 1. 微信扫码登录

插件走 OrcaTerm 自己的 OAuth：

1. `GET https://orcaterm.com/oauth/wechat/config` → `{appid, redirect_uri, state, scope}`
2. 拼出微信扫码页 `https://open.weixin.qq.com/connect/qrconnect?...`，magpie 打开它
3. 用微信扫码；微信回跳 `https://orcaterm.com/oauth/wechat/bridge?code=…&state=…`
   （那是个 postMessage 桥页，桌面端用 iframe 接；插件这边请把地址栏完整 URL 贴回来）
4. 插件 `POST /oauth/wechat/exchange {code, state}` 换到 accessToken

错误码与客户端一致：`STATE_EXPIRED` / `STATE_MISMATCH` / `INVALID_REQUEST` / `PROVIDER_DISABLED` / `INTERNAL_ERROR`。

```bash
node test/run.mjs wechat                       # 只打印二维码 URL
node test/run.mjs wechat "https://orcaterm.com/oauth/wechat/bridge?code=…&state=…"
```

### 2. 自动读取本机登录态

直接读 OrcaTerm 桌面端的持久化 store：

```
~/Library/Application Support/com.orcaterm-desktop.app/data.bin
```

取 `oauth_access_token` / `oauth_expires_at` / `userId`。用 `ORCATERM_STORE` 可指向别的路径。
token 已过期时登录会直接失败，提示先去 OrcaTerm 里刷新。

### 3. 粘贴 token

手动粘贴 `oauth_access_token`，并选 assistant / mode / 可选 cookie 与 baseUrl。
插件会用 JWT 的 `exp` 先做一次过期预检。

**续期**：上游没有可用的 refresh 端点（桌面端在 Rust 侧续 token 并回写 `data.bin`）。
只有「自动读取本机登录态」方式支持续期（重读 store）；扫码 / 手动粘贴的账号过期后需重新登录。

上游限制 **每账号 10 请求 / 60 秒**（`X-RateLimit-Limit` / `-Remaining` / `-Reset`），
打满后返回的是 **HTTP 200 + `application/json`**：

```json
{"code":429,"data":null,"message":"Rate limit exceeded: chat-rpm"}
```

插件的处理：

- **主动控速**：滑动窗口 pace，默认 10/60s，可用选项 `rateLimitPerMinute` 调低；
- **被动退避**：遇到 429 记录冷却时间，指数退避重试（最多 2 次）；
- **响应头校准**：每次响应都用 `X-RateLimit-*` 校正窗口；
- **串行**：`package.json` 里 `magpie.maxConcurrency = 1`，避免并发穿透限流。

## 参数校验

实测服务端只硬校验三条，插件在发出前就守住（避免无谓消耗配额）：

| 字段 | 规则 | 不守的后果 |
|---|---|---|
| `input.id` | UUID v4 | `[LLM_ERROR]: Invalid inputId` |
| `conversationId` | 非空、非 `"unknown"` | `[LLM_ERROR]: Invalid conversationId: unknown.` |
| `mode` | `0` / `1` / `2` | 服务端 handler 分派崩溃 `code:500` |

其余字段（`user` / `setting` / `input.input`）服务端容错，但缺了会按它自己的会话状态乱答。
另外 `name` 必须真实存在（否则 SSE `[ERROR]: 服务繁忙`），`model` 必须已注册（否则 `LLM(x) is not loaded.`）。

## 请求形状

向客户端看齐，降低被当成异常客户端的概率：

```http
POST {baseUrl}/chat?name=orcaterm&mode=0
X-Product: orcaterm
Authorization:  Bearer <token>      ← 客户端原样带前导空格
x-seqid: <input uuid>
Accept: text/event-stream
Content-Type: application/json

{
  "conversationId": "cid-<uuid>",
  "user": { "id": "<userId>", "setting": {
      "model": "TokenHub/deepseek-v4-flash",
      "enableThinking": false,
      "language": "zh",
      "multimodal": true,
      "mcpServers": [], "uiServers": [],
      "enableAutoSubtaskExecution": false } },
  "input": { "input": "<文本>", "id": "<uuid v4>", "files": [], "emphasisPrompt": "" },
  "stream": true
}
```

响应：SSE `data: {"content":"增量",…}` + `[DONE]`，正文包在动作信封里
（`action:"completion"` → `taskCompletion`；`action:"ask"` → `question`+`options`；`thinking` → `reasoning_content`）。

## 测试

```bash
node test/run.mjs pacer                    # 限流器单测（不发网络）
node test/run.mjs auto                     # 登录：自动读取本机登录态
node test/run.mjs stream "问题" [模型id]    # 流式端到端
node test/run.mjs nostream "问题"           # 非流式端到端
```

`auto/stream/nostream` 会真实打到上游，注意 **10 RPM** 配额。

## 已知限制

- 上游所有 persona 都是**云服务器运维 Agent**：与运维无关的问题可能被拒答或拉回运维话题，这是服务端 system prompt 决定的。
- 上游没有可用的多轮记忆（同一 `conversationId` 第二轮不记得上一轮），插件把历史压平进 `input.input`。
- 不支持工具调用（`tool_call: false`）：上游是自带工具循环的 Agent，不是 function calling。
- 无 `usage` 钩子：上游没有独立用量端点，只有 `X-RateLimit-*` 的分钟级窗口。
