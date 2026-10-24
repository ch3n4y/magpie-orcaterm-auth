/**
 * OrcaTerm protocol adapter —— 全部字段经实网验证。
 *
 * 上游: POST https://lightai.cloud.tencent.com/assistant/chat?name&mode[&csrfCode]
 * 鉴权: Authorization: Bearer <oauth_access_token>   (uin/skey 只在无 Bearer 时才必需)
 * 请求: { conversationId, user:{id,setting:{model}}, input:{input,id,files,emphasisPrompt}, stream:true }
 *      注意文本字段是 input.input（不是 input.content）
 * 出流: data: {"id","content"(增量),"reasoningContent","reasoning","type":"ai","code":0}
 * 终止: data: [DONE]    错误: data: [ERROR]: [LLM_ERROR]: <msg>
 *
 * 上游是"云端运维 Agent"，正文包在动作信封里：
 *   {"action":"completion","thinking":"…","taskCompletion":"最终答案"}
 *   {"action":"ask","thinking":"…","question":"…","options":["…"]}
 *   {"action":"review", …}   -> 需要用户审批工具调用
 */

export const DEFAULT_BASE_URL = "https://lightai.cloud.tencent.com/assistant";

/**
 * 真实模型目录（客户端 asset_0027 内置表；model 字段才是发给服务端的 id）。
 * 每个模型能否使用取决于账号权限，无权限时上游回 401 token无访问此模型权限。
 */
export const MODELS = [
  { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", model: "TokenHub/deepseek-v4-pro", context: 1000000, reasoning: true },
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", model: "TokenHub/deepseek-v4-flash", context: 1000000, reasoning: true },
  { id: "hunyuan", name: "Hy3", model: "Hunyuan3/hy3", context: 256000, reasoning: true },
  { id: "hunyuan4", name: "Hy4-preview", model: "Hunyuan3/hy4-preview", context: 256000, reasoning: true },
  { id: "kimi", name: "Kimi-K3", model: "TokenHub/kimi-k3", context: 1000000, reasoning: false },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", model: "TokenHub/deepseek-v4.1-flash", context: 1000000, reasoning: true },
  { id: "glm-5.2", name: "GLM-5.2", model: "TokenHub/glm-5.2", context: 200000, reasoning: true },
  { id: "glm-5.3", name: "GLM-5.3", model: "TokenHub/glm-5.3", context: 200000, reasoning: true },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", model: "TokenHub/glm-5.3-flash", context: 200000, reasoning: true },
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));
export const MODEL_BY_API_ID = Object.fromEntries(MODELS.map((m) => [m.model, m]));

/** 客户端 m44516.js 的 assistant 枚举；决定服务端注入的人格 */
export const ASSISTANTS = [
  "orcaterm",
  "lighthouse",
  "lighthouse-buy",
  "beian",
  "cns",
  "dnspod",
  "domain",
  "ssl",
  "httpdns",
  "lightgame",
  "cvm",
];

/** mode 枚举（m42644.js）: RE_ACT=0, PLAN_ACT=1, AUTO_ACT=2 */
export const MODES = { RE_ACT: "0", PLAN_ACT: "1", AUTO_ACT: "2" };

/** djb2 over the `skey` cookie value, & 0x7fffffff —— 客户端 m56632.js */
export function csrfCodeFromCookie(cookieHeader = "") {
  let skey = "";
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === "skey") {
      skey = part.slice(idx + 1);
      break;
    }
  }
  if (!skey) return "";
  let h = 5381;
  for (let i = 0; i < skey.length; i += 1) h += (h << 5) + skey.charCodeAt(i);
  return String(h & 0x7fffffff);
}

/** 去首尾斜杠后 join —— 客户端 m92054.js */
export function joinUrl(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => String(p).trim().replace(/^\/|\/$/g, ""))
    .join("/");
}

export function newId(prefix = "") {
  const rnd =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return prefix ? `${prefix}${rnd}` : rnd;
}

export function newConversationId() {
  return newId("cid-");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string" ? p : p?.type === "text" ? (p.text ?? "") : "",
      )
      .join("");
  }
  return "";
}

/**
 * OpenAI messages -> OrcaTerm 的 input.input 文本。
 * 上游是"运维 Agent"，conversationId 不提供可用的多轮记忆（实测同一 cid
 * 第二轮不记得上一轮），所以历史必须自己压平成前缀文本。
 */
export function messagesToInput(messages = []) {
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter(Boolean);
  const rest = messages.filter((m) => m.role !== "system");
  const last = rest[rest.length - 1] ?? { role: "user", content: "" };
  const prior = rest.slice(0, -1);

  let text = textOf(last.content);
  const context = [];
  if (sys.length) context.push(sys.join("\n\n"));
  if (prior.length) {
    context.push(
      prior
        .map(
          (m) =>
            `${m.role === "assistant" ? "Assistant" : "User"}: ${textOf(m.content)}`,
        )
        .join("\n"),
    );
  }
  if (context.length) text = `${context.join("\n\n")}\n\nUser: ${text}`;

  return {
    input: { input: text, id: ensureUuid(newId()), files: [], emphasisPrompt: "" },
  };
}

// ---------------------------------------------------------------- 参数校验

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** input.id 必须是 UUID v4，否则上游回 [LLM_ERROR]: Invalid inputId */
export function ensureUuid(id) {
  return UUID_V4.test(String(id)) ? String(id) : newId();
}

/** conversationId 不能缺省：缺省会变成 "unknown"，上游回 Invalid conversationId: unknown. */
export function ensureConversationId(id) {
  const s = String(id ?? "").trim();
  if (!s || s === "unknown" || s === "null" || s === "undefined") {
    return newConversationId();
  }
  return s;
}

/**
 * mode 只能是 0/1/2。
 * 实测非法值不会得到友好报错，而是服务端 handler 分派崩溃：
 *   {"code":500,"message":"... [mode] is not a function"}
 */
export function ensureMode(mode) {
  const s = String(mode ?? MODES.RE_ACT);
  return Object.values(MODES).includes(s) ? s : MODES.RE_ACT;
}

/**
 * 组装 /chat 请求。请求形状向客户端看齐（`asset_0027` 里 initSetting 的
 * user.setting 结构），避免因为字段缺失被风控或降级。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {object} o.auth  { token, cookie?, userId? }
 * @param {object} o.body  网关给的 OpenAI chat/completions body
 * @param {object} o.opts  { assistant, mode, model, conversationId, enableThinking, language }
 */
export function buildChatRequest({ baseUrl, auth, body, opts = {} }) {
  const { input } = messagesToInput(body.messages ?? []);
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const u = new URL(`${base}/chat`);

  const assistant = String(opts.assistant ?? "orcaterm");
  if (!ASSISTANTS.includes(assistant)) {
    throw new OrcaError(
      `未知 assistant: ${assistant}（上游会回「服务繁忙」）`,
      "invalid_request_error",
    );
  }
  u.searchParams.set("name", assistant);
  u.searchParams.set("mode", ensureMode(opts.mode));
  // csrfCode 只在带 skey cookie 时才有值；Bearer 模式下可省略
  const csrf = csrfCodeFromCookie(auth.cookie ?? "");
  if (csrf) u.searchParams.set("csrfCode", csrf);

  const requested = opts.model ?? body.model;
  const mapped = MODEL_BY_ID[requested]?.model ?? MODEL_BY_API_ID[requested]?.model ?? requested;
  if (!mapped) {
    throw new OrcaError("缺少模型 id", "invalid_request_error");
  }

  // 与客户端 initSetting 的 setting 同形
  const setting = {
    model: mapped,
    enableThinking: Boolean(opts.enableThinking),
    language: opts.language ?? "zh",
    multimodal: true,
    mcpServers: [],
    uiServers: [],
    enableAutoSubtaskExecution: false,
  };

  const payload = {
    conversationId: ensureConversationId(opts.conversationId),
    user: { id: String(auth.userId ?? ""), setting },
    input,
    stream: true,
  };

  const headers = {
    "X-Product": "orcaterm",
    "x-seqid": input.id,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    // 客户端写的是 " Bearer " + token（带前导空格），这里保持原样
    Authorization: auth.token ? ` Bearer ${auth.token}` : "",
  };
  if (auth.cookie) headers.Cookie = auth.cookie;

  return { url: u.toString(), seqId: input.id, payload, headers };
}

export function flattenEnvelope(text) {
  const obj = extractEnvelope(String(text));
  if (!obj) return null;

  const reasoning = obj.thinking ? String(obj.thinking).trim() : "";
  const action = String(obj.action);

  // completion: 最终答案在 taskCompletion
  if (action === "completion") {
    const answer =
      obj.taskCompletion ?? obj.answer ?? obj.content ?? obj.message ?? "";
    return { reasoning, text: String(answer).trim(), action };
  }

  // ask: 反问 + 选项
  if (action === "ask") {
    const parts = [];
    if (obj.question) parts.push(String(obj.question).trim());
    if (Array.isArray(obj.options) && obj.options.length) {
      parts.push(obj.options.map((o, i) => `${i + 1}. ${o}`).join("\n"));
    }
    return { reasoning, text: parts.join("\n\n"), action };
  }

  // review / 其他: 尽量给出可读文本
  const fallback =
    obj.taskCompletion ??
    obj.question ??
    obj.message ??
    obj.summary ??
    (obj.review ? JSON.stringify(obj.review) : "");
  return { reasoning, text: String(fallback ?? "").trim(), action };
}

/** 从任意文本里找出带 action 的信封对象：先试围栏代码块，再试裸 JSON。 */
function extractEnvelope(s) {
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const f of fences.reverse()) {
    try {
      const o = JSON.parse(f[1].trim());
      if (o && typeof o === "object" && "action" in o) return o;
    } catch {
      /* 继续找 */
    }
  }
  const trimmed = s.trim();
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o === "object" && "action" in o) return o;
  } catch {
    /* 不是纯 JSON */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    if (slice.includes('"action"')) {
      try {
        const o = JSON.parse(slice);
        if (o && typeof o === "object" && "action" in o) return o;
      } catch {
        /* 放弃 */
      }
    }
  }
  return null;
}
/**
 * OrcaTerm SSE -> OpenAI chat.completion.chunk 流。
 * @param {string} model
 * @param {{unwrap?: boolean}} opts unwrap: 把动作信封拍平成人话（默认开）
 */
export function createSseTranslator(model, { unwrap = true } = {}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  let reasoningAcc = "";
  let upstreamId = "";
  let sentRole = false;

  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${upstreamId || "orcaterm"}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const roleChunk = () => {
    if (sentRole) return "";
    sentRole = true;
    return chunk({ role: "assistant", content: "" });
  };

  const feed = (text) => {
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      const raw = line.replace(/^\s*data:\s*/, "").trim();
      if (!raw) continue;
      if (raw === "[DONE]" || raw.startsWith("[ABORTED]")) continue;
      if (raw.startsWith("[ERROR]")) {
        const msg = raw.replace(/^\[ERROR\]:\s*(\[LLM_ERROR\]:\s*)?/, "");
        out += `data: ${JSON.stringify({
          error: { message: msg, type: "upstream_error" },
        })}\n\n`;
        continue;
      }
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        continue;
      }
      if (item?.id) upstreamId = item.id;
      if (item?.reasoningContent) {
        reasoningAcc += item.reasoningContent;
        if (!unwrap) {
          out += roleChunk() + chunk({ reasoning_content: item.reasoningContent });
        }
      }
      if (item?.content) {
        acc += item.content;
        if (!unwrap) out += roleChunk() + chunk({ content: item.content });
      }
    }
    return out ? enc.encode(out) : undefined;
  };

  const finish = () => {
    let out = roleChunk();
    if (unwrap) {
      const env = flattenEnvelope(acc);
      const reasoning = env?.reasoning || reasoningAcc;
      const text = env ? env.text : acc;
      if (reasoning) out += chunk({ reasoning_content: reasoning });
      if (text) out += chunk({ content: text });
    }
    out += chunk({}, "stop");
    out += "data: [DONE]\n\n";
    return enc.encode(out);
  };

  return {
    feed,
    finish,
    text: () => acc,
    decode: (bytes) => dec.decode(bytes, { stream: true }),
  };
}

// ---------------------------------------------------------------- 响应判别

export class OrcaError extends Error {
  constructor(message, type = "upstream_error", extra = {}) {
    super(message);
    this.name = "OrcaError";
    this.type = type;
    Object.assign(this, extra);
  }
}

/**
 * 上游不是每个错误都用 SSE。实测这些情况返回 application/json：
 *   429  {"code":429,"message":"Rate limit exceeded: chat-rpm"}      (HTTP 仍是 200)
 *   缺 name {"code":"10060101","message":"查询配额缺少agentId"}
 *   mode 非法 {"code":500,"message":"... [mode] is not a function"}
 *   stream:false 成功 {"code":0,"data":{action,thinking,...}}
 * 鉴权失败则可能是 401/403 + JSON。
 */
export function interpretJsonResponse(status, obj) {
  const code = obj?.code;
  const message = obj?.message ?? obj?.error?.message ?? "";
  if (status === 401 || status === 403) {
    return { kind: "auth", error: new OrcaError(message || "登录已失效", "authentication_error") };
  }
  if (Number(code) === 429 || /rate limit/i.test(message)) {
    const retryAfter = 60;
    return {
      kind: "rate_limit",
      error: new OrcaError(message || "Rate limit exceeded: chat-rpm", "rate_limit_error", {
        retryAfter,
      }),
    };
  }
  if (code === 0 && obj?.data) {
    return { kind: "ok", envelope: obj.data };
  }
  if (String(code) === "10060101") {
    return { kind: "error", error: new OrcaError(message || "缺少 agentId", "invalid_request_error") };
  }
  if (Number(code) === 0) {
    return { kind: "ok", envelope: null };
  }
  return { kind: "error", error: new OrcaError(message || `上游返回 code=${code}`, "upstream_error") };
}

/** 把错误对象统一成 OpenAI 错误体，便于 agent 显示厂商原话 */
export function toOpenAiError(err) {
  return {
    error: {
      message: String(err?.message ?? err),
      type: err?.type ?? "upstream_error",
      code: err?.code,
    },
  };
}
