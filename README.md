# magpie-orcaterm-auth

把 **OrcaTerm（腾讯云遨驰终端）内置 AI** 接成 Magpie / OpenCode 供应商的插件，支持它面板里的全部模型（DeepSeek-V4 / GLM-5.3 / Hunyuan / Kimi-K3）。

协议是对官方桌面客户端逆向 + 实网验证得出的。

> 仅用于**你自己账号**的客户端互通研究。请遵守 OrcaTerm 的服务条款；不要用它规避配额或做商业分发。

## 特性

- **9 个模型**：`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4.1-flash` / `glm-5.3` / `glm-5.3-flash` / `glm-5.2` / `kimi`(K3) / `hunyuan`(Hy3) / `hunyuan4`(Hy4-preview)
- **三种登录**：微信扫码（OAuth）/ 自动读取本机 OrcaTerm 登录态 / 手动粘贴 token
- **风控对齐**：按上游 `X-RateLimit-*` 主动控速（10 RPM）+ 429 退避重试 + 串行发送
- **参数校验**：发出前守住 UUID v4、conversationId、mode 枚举三条硬校验
- **请求仿冒**：请求头与 body 形状与官方客户端同形
- **信封解析**：把上游的 `action:completion/ask` 动作信封拍平成正常回答，`thinking` 映射为 `reasoning_content`

## 安装

仓库根就是插件包，直接把仓库地址加进 magpie：

```bash
magpie plugin add ch3n4y/magpie-orcaterm-auth
magpie plugin login orcaterm
magpie provider test orcaterm
```

或者本地克隆后就地加载：

```bash
git clone https://github.com/ch3n4y/magpie-orcaterm-auth
magpie plugin add ./magpie-orcaterm-auth
```

装好后 agent 里就能用 `orcaterm/deepseek-v4-flash` 这类模型。

## 登录

### 1. 微信扫码登录

插件走 OrcaTerm 自己的 OAuth：

1. `GET https://orcaterm.com/oauth/wechat/config` → `{appid, redirect_uri, state, scope}`
2. 拼出微信扫码页 `https://open.weixin.qq.com/connect/qrconnect?...`，magpie 打开它
3. 用微信扫码；微信回跳 `https://orcaterm.com/oauth/wechat/bridge?code=…&state=…`
   （那是个 `postMessage` 桥页，桌面端用 iframe 接；插件这边请把地址栏完整 URL 贴回来）
4. 插件 `POST /oauth/wechat/exchange {code, state}` 换到 accessToken

错误码与客户端一致：`STATE_EXPIRED` / `STATE_MISMATCH` / `INVALID_REQUEST` / `PROVIDER_DISABLED` / `INTERNAL_ERROR`。

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

能否使用取决于账号权限：无权限时上游返回 `[LLM_ERROR]: 401 token无访问此模型权限`。

## 上游协议速览

```http
POST https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0
X-Product: orcaterm
Authorization: Bearer <oauth_access_token>
Accept: text/event-stream
Content-Type: application/json

{
  "conversationId": "cid-<uuid>",
  "user": { "id": "<userId>", "setting": { "model": "TokenHub/deepseek-v4-flash", … } },
  "input": { "input": "<文本>", "id": "<uuid v4>", "files": [], "emphasisPrompt": "" },
  "stream": true
}
```

几个容易踩的点：

- 文本字段是 **`input.input`**，不是 `input.content`
- `input.id` 必须是 **UUID v4**
- `conversationId` 不能缺省（缺省等于 `"unknown"`，会被拒）
- 上游**没有多轮记忆**，历史要自己压平重放
- 限流 **10 RPM/账号**，打满返回的是 `HTTP 200` + `application/json`（不是 SSE）

## 风控与校验

上游打满限流时的返回（注意状态码仍是 200）：

```json
{"code":429,"data":null,"message":"Rate limit exceeded: chat-rpm"}
```

插件的处理：滑动窗口主动控速（默认 10/60s，选项 `rateLimitPerMinute` 可调低）、
收到 429 记录冷却并指数退避重试（最多 2 次）、每次响应用 `X-RateLimit-*` 校正窗口、
`package.json` 里 `maxConcurrency: 1` 串行发送。

服务端真正硬校验的只有三条，插件在发出前就守住（避免无谓消耗配额）：

| 字段 | 规则 | 不守的后果 |
|---|---|---|
| `input.id` | UUID v4 | `[LLM_ERROR]: Invalid inputId` |
| `conversationId` | 非空、非 `"unknown"` | `[LLM_ERROR]: Invalid conversationId: unknown.` |
| `mode` | `0` / `1` / `2` | 服务端 handler 分派崩溃 `code:500` |

## 仓库结构

```
index.mjs              钩子：config / auth（3 种登录）/ loader.fetch / provider.models
lib/protocol.mjs       参数校验、请求构造、信封解析、错误判别
lib/wechat-oauth.mjs   微信扫码登录
lib/local-auth.mjs     读取本机 OrcaTerm 登录态
lib/rate-limit.mjs     滑动窗口 + 429 冷却
test/run.mjs           自测（pacer / wechat / auto / stream / nostream）
```

## 自测

```bash
node test/run.mjs pacer          # 限流器单测，不发网络
node test/run.mjs wechat         # 打印微信二维码 URL
node test/run.mjs auto           # 用本机登录态跑一次真实请求
node test/run.mjs stream "问题" glm-5.3
```

## 已知限制

- 上游所有 persona 都是**云服务器运维 Agent**，与运维无关的问题可能被拒答或拉回运维话题（服务端 system prompt 决定，插件改不了）
- 不支持 function calling（上游是自带工具循环的 Agent）
- 无 `usage` 钩子：上游只有分钟级限流窗口，没有独立用量端点

## License

MIT
