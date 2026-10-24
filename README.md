# magpie-orcaterm-auth

把 **OrcaTerm（腾讯云遨驰终端）内置 AI** 接成 Magpie / OpenCode 供应商的插件，支持它面板里的全部模型（DeepSeek-V4 / GLM-5.3 / Hunyuan / Kimi-K3）。

协议是对官方桌面客户端逆向 + 实网验证得出的。

> 仅用于**你自己账号**的客户端互通研究。请遵守 OrcaTerm 的服务条款；不要用它规避配额或做商业分发。

## 特性

- **9 个模型**：`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4.1-flash` / `glm-5.3` / `glm-5.3-flash` / `glm-5.2` / `kimi`(K3) / `hunyuan`(Hy3) / `hunyuan4`(Hy4-preview)
- **两种登录**：微信扫码（OAuth，自动接收回调）/ 自动读取本机 OrcaTerm 登录态
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

### 1. 微信扫码登录（自动接收回调）

插件在本地起一个一次性页面（默认 `http://127.0.0.1:14300/login`）：

- 页面用官方 `wxLogin.js` 渲染二维码，并设 **`self_redirect: true`** ——
  扫码后微信的回跳发生在**内层 iframe** 里（默认行为是顶层跳转，会把宿主页面整个换掉，
  于是 postMessage 收不到，这就是之前「登录后直接跳到 bridge URL」的原因）；
- 回跳落在 `orcaterm.com/oauth/wechat/bridge?code=…&state=…`，该页把结果
  `postMessage` 给父窗口 —— 正是我们的页面，于是插件立刻拿到 code 并兑换。

**不需要复制任何 URL**，也就不存在「state / code 被抢先消费」的问题。

#### 装在远端 / 通过 Web 访问时

插件在 magpie 所在机器上监听 `127.0.0.1:14300`，而你的浏览器在本地，够不到远端回环地址。
两种办法任选：

```bash
# A. SSH 隧道（推荐，不用暴露端口）
ssh -L 14300:127.0.0.1:14300 <server>
# 然后浏览器打开 http://127.0.0.1:14300/login
```

```bash
# B. 直接对外监听（注意网络暴露面，配合防火墙/反代使用）
ORCATERM_CAPTURE_HOST=0.0.0.0 ORCATERM_CAPTURE_BASE=https://magpie.example.com magpie ...
# 或者只改页面基址：
ORCATERM_CAPTURE_BASE=https://magpie.example.com:14300 magpie ...
```

可用环境变量：`ORCATERM_CAPTURE_PORT`（默认 14300，占用时自动换随机端口）、
`ORCATERM_CAPTURE_HOST`（默认 `127.0.0.1`）、`ORCATERM_CAPTURE_BASE`（页面地址前缀）。

> 之所以能内嵌：`open.weixin.qq.com` 的登录页没有 `X-Frame-Options` /
> CSP `frame-ancestors`；OrcaTerm 网页版用的就是这个机制。

### 2. 自动读取本机登录态

直接读 OrcaTerm 桌面端的持久化 store：

```
~/Library/Application Support/com.orcaterm-desktop.app/data.bin
```

取 `oauth_access_token` / `oauth_expires_at` / `userId`。用 `ORCATERM_STORE` 可指向别的路径。
token 已过期时登录会直接失败，提示先去 OrcaTerm 里刷新。

> CLI 提示：`magpie plugin login orcaterm` 选到这一项后仍会要求输入一行 key（这是 magpie 对
> `api` 类型方式的固定行为），随便输入一个字符回车即可。

**续期**：上游没有可用的 refresh 端点（桌面端在 Rust 侧续 token 并回写 `data.bin`）。
只有「自动读取本机登录态」方式支持续期（重读 store）；扫码登录的账号过期后需重新扫码。

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
