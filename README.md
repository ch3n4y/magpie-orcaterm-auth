# opencode-orcaterm-auth

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

## 快速开始

```bash
git clone <this repo>
magpie plugin add ./plugin
magpie plugin login orcaterm     # 选「微信扫码登录」或「自动读取本机登录态」
magpie provider test orcaterm
```

然后 agent 里就能用 `orcaterm/deepseek-v4-flash` 这类模型了。

详细说明见 [`plugin/README.md`](plugin/README.md)。

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

## 仓库结构

```
plugin/                 Magpie / OpenCode v1 供应商插件
  index.mjs             钩子：config / auth（3 种登录）/ loader.fetch / provider.models
  lib/protocol.mjs      参数校验、请求构造、信封解析、错误判别
  lib/wechat-oauth.mjs  微信扫码登录
  lib/local-auth.mjs    读取本机 OrcaTerm 登录态
  lib/rate-limit.mjs    滑动窗口 + 429 冷却
  test/run.mjs          自测（pacer / wechat / auto / stream / nostream）
```

## 自测

```bash
cd plugin
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
