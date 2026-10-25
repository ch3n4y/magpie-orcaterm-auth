/**
 * Magpie / OpenCode v1 provider plugin —— OrcaTerm AI assistant
 *
 * 网关把任意 agent 的请求翻译成 OpenAI chat/completions 后交给 loader.fetch；
 * 这里翻译成 OrcaTerm 的 POST {baseUrl}/chat?name&mode（SSE），再把上游结果翻回
 * OpenAI 格式。
 *
 * 风控相关：上游每账号 10 RPM（X-RateLimit-*），打满返回 HTTP 200 + JSON code 429；
 * 这里做主动控速 + 429 退避重试。
 */
import {
  ASSISTANTS,
  DEFAULT_BASE_URL,
  MODELS,
  MODES,
  buildChatRequest,
  createSseTranslator,
  csrfCodeFromCookie,
  flattenEnvelope,
  interpretJsonResponse,
  toOpenAiError,
} from "./lib/protocol.mjs";
import {
  readLocalAuth,
  storePath,
  tokenExpiryMs,
  userIdFromToken,
} from "./lib/local-auth.mjs";
import { pacerFor, sleep } from "./lib/rate-limit.mjs";
import { exchangeCode, startWechatLogin } from "./lib/wechat-oauth.mjs";
import { refreshAccessToken } from "./lib/token-refresh.mjs";
import { createLocalCapture } from "./lib/wechat-local.mjs";

const PROVIDER = "orcaterm";
const MAX_RETRIES = 2;

const MODEL_ENTRIES = Object.fromEntries(
  MODELS.map((m) => [
    m.id,
    {
      name: m.name,
      limit: { context: m.context, output: 8192 },
      tool_call: false,
      reasoning: m.reasoning,
    },
  ]),
);

export const OrcaTermAuthPlugin = async (_input, options) => {
  const perMinute = Number(options?.rateLimitPerMinute) || 10;

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OrcaTerm",
        npm: "@ai-sdk/openai-compatible",
        api: DEFAULT_BASE_URL,
        models: MODEL_ENTRIES,
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          // 微信扫码（自动）：本地起一个页面内嵌 qrconnect，回调通过 postMessage
          // 直接收回。用户只需扫码，不用复制任何 URL，也就不存在「state 被别人
          // 抢先消费」的窗口。
          type: "oauth",
          label: "微信扫码登录（自动接收回调）",
          async authorize() {
            const login = await startWechatLogin();
            const cap = createLocalCapture({
              appid: login.appid,
              redirectUri: login.redirectUri,
              state: login.state,
            });
            const pageUrl = await cap.ready;
            return {
              url: pageUrl,
              instructions:
                "在浏览器里用微信扫码即可，扫完会自动继续，无需复制任何链接。" +
                (process.env.ORCATERM_CAPTURE_BASE
                  ? `（当前页面地址来自 ORCATERM_CAPTURE_BASE）`
                  : "（magpie 装在远端时，先 ssh -L 14300:127.0.0.1:14300 再打开该地址）"),
              method: "auto",
              async callback() {
                try {
                  const { code, state } = await cap.wait;
                  return wechatSuccess(await exchangeCode({ code, state }));
                } finally {
                  cap.close();
                }
              },
            };
          },
        },
        {
          // 不提问 -> inputs 通常为 undefined，直接读本机 store。
          // 但 CLI 对 api 类型强制读一行 key（空则 EOF 报错），所以这里也接受
          // 直接粘贴的 token：看着像 JWT 就用它，否则一律回落到本机 store。
          type: "api",
          label: "自动读取本机 OrcaTerm 登录态",
          placeholder: "无需填写（CLI 里随便输一个字符即可），也可直接粘 token",
          async authorize(inputs) {
            const typed = String(
              inputs?.key ?? inputs?.token ?? (typeof inputs === "string" ? inputs : "") ?? "",
            ).trim();
            const looksJwt = /^eyJ[A-Za-z0-9_-]{8,}/.test(typed);
            const local = readLocalAuth();
            const token = looksJwt ? typed : local?.token;

            if (!token) {
              return {
                type: "failed",
                error: storePath()
                  ? `本机 data.bin 里没有 token（OrcaTerm 似乎已登出），请先在 OrcaTerm 里重新登录，或改用「粘贴 oauth_access_token」`
                  : "没找到 OrcaTerm 的 data.bin，请先在 OrcaTerm 里登录，或改用「粘贴 oauth_access_token」",
              };
            }
            const exp = looksJwt
              ? tokenExpiryMs(typed)
              : (local.expiresAt ?? tokenExpiryMs(token));
            if (exp && exp < Date.now()) {
              return {
                type: "failed",
                error: "token 已过期，请先打开 OrcaTerm 让它刷新一下，再重试",
              };
            }
            return {
              type: "success",
              key: token,
              metadata: {
                assistant: "orcaterm",
                mode: MODES.RE_ACT,
                baseUrl: DEFAULT_BASE_URL,
                userId: (looksJwt ? "" : local.userId) || userIdFromToken(token),
                expires: exp ?? undefined,
                source: looksJwt ? "pasted" : local.source,
                via: looksJwt ? "manual" : "local-store",
                cookie: "",
              },
            };
          },
        },
      ],
      /**
       * 续期：
       *  - via "local-store"：桌面端在 Rust 侧续 token 并回写 data.bin，重读即可；
       *  - 其他（微信扫码）：走 CAPI 的 OAuthRefreshToken，用当前 token 换新 token。
       */
      async refresh(auth) {
        const meta = auth?.metadata ?? {};

        if (meta.via === "local-store") {
          const local = readLocalAuth();
          if (!local || !local.token) return null;
          const same = local.token === (auth?.access ?? auth?.key);
          const exp = local.expiresAt ?? tokenExpiryMs(local.token);
          if (same && exp && exp < Date.now()) {
            throw Object.assign(
              new Error("OrcaTerm token 已过期且本机未刷新，请在 OrcaTerm 里重新登录"),
              { signIn: "expired" },
            );
          }
          if (same) return { key: local.token, access: local.token, expires: exp ?? undefined };
          return {
            key: local.token,
            access: local.token,
            refresh: local.refreshToken || undefined,
            expires: exp ?? undefined,
            metadata: { userId: local.userId || userIdFromToken(local.token) },
          };
        }

        const token = auth?.key ?? auth?.access;
        if (!token) return null;
        try {
          const r = await refreshAccessToken(token);
          const expires = Date.now() + r.expiresIn * 1000;
          return {
            key: r.accessToken,
            access: r.accessToken,
            expires,
            metadata: { ...meta, expires },
          };
        } catch (err) {
          // 明确的失效才要求重新登录；网络/网关抖动则保留现有凭据，交给下一轮
          if (/expired|invalid|失效|过期/i.test(String(err?.message ?? ""))) {
            throw Object.assign(new Error(`OrcaTerm 续期失败：${err.message}`), {
              signIn: "expired",
            });
          }
          return null;
        }
      },

      async loader(getAuth) {
        const auth = await getAuth();
        let token = auth?.key ?? auth?.access ?? "";
        const meta = auth?.metadata ?? {};
        const baseUrl = meta.baseUrl || DEFAULT_BASE_URL;
        const pacer = pacerFor(`orcaterm:${meta.userId || token.slice(-12)}`, {
          limit: perMinute,
          windowMs: 60_000,
        });

        return {
          baseURL: baseUrl,
          async fetch(input, init) {
            const url = typeof input === "string" ? input : input.url;
            let path;
            try {
              path = new URL(url).pathname;
            } catch {
              return fetch(input, init);
            }
            if (!/\/chat\/completions\/?$/.test(path)) return fetch(input, init);

            let body;
            try {
              body = JSON.parse(init?.body ?? "{}");
            } catch {
              return errRes(400, "无法解析请求体", "invalid_request_error");
            }

            const makeReq = () =>
              buildChatRequest({
                baseUrl,
                auth: { token, cookie: meta.cookie, userId: meta.userId },
                body,
                opts: {
                  assistant: meta.assistant,
                  mode: meta.mode,
                  model: body.model,
                  enableThinking: meta.enableThinking,
                  language: meta.language,
                },
              });

            let req;
            try {
              req = makeReq();
            } catch (err) {
              return errRes(400, err.message, err.type ?? "invalid_request_error");
            }

            // 一次请求内最多自愈一次，避免死循环
            let refreshedOnce = false;
            const tryRefresh = async () => {
              if (refreshedOnce) return false;
              refreshedOnce = true;
              const r = await refreshAccessToken(token).catch(() => null);
              if (!r) return false;
              token = r.accessToken;
              req = makeReq();
              return true;
            };

            const signal = init?.signal;
            let upstream = null;
            let lastErr = null;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
              await pacer.acquire(signal);
              try {
                upstream = await fetch(req.url, {
                  method: "POST",
                  headers: req.headers,
                  body: JSON.stringify(req.payload),
                  signal,
                });
              } catch (err) {
                lastErr = err;
                if (signal?.aborted) throw err;
                await sleep(500 * 2 ** attempt, signal);
                continue;
              }

              pacer.syncFromHeaders(upstream.headers);
              const ct = upstream.headers.get("content-type") || "";

              // 非 SSE：429 / 参数错误 / stream:false 的成功
              if (!ct.includes("text/event-stream")) {
                const text = await upstream.text().catch(() => "");
                let obj = null;
                try {
                  obj = JSON.parse(text);
                } catch {
                  /* 非 JSON */
                }
                const verdict = interpretJsonResponse(upstream.status, obj);
                if (verdict.kind === "rate_limit") {
                  pacer.note429(verdict.error.retryAfter);
                  lastErr = verdict.error;
                  continue;
                }
                if (verdict.kind === "auth") {
                  if (await tryRefresh()) continue;
                  throw Object.assign(
                    new Error(verdict.error.message || "登录已失效"),
                    { signIn: "expired" },
                  );
                }
                if (verdict.kind === "error") {
                  // 续期会把旧 token 轮换失效，所以碰到「失效」时自愈一次
                  if (/Invalid or expired AccessToken/i.test(verdict.error.message)) {
                    if (await tryRefresh()) continue;
                  }
                  return errRes(502, verdict.error.message, verdict.error.type);
                }
                if (verdict.kind === "ok") {
                  const env = verdict.envelope ? flattenEnvelope(JSON.stringify(verdict.envelope)) : null;
                  const answer = env?.text ?? text;
                  return completionResponse({
                    model: body.model,
                    content: answer,
                    reasoning: env?.reasoning,
                  });
                }
              }

              // SSE
              if (!upstream.ok) {
                const t = await upstream.text().catch(() => "");
                if (upstream.status === 401 || upstream.status === 403) {
                  throw Object.assign(new Error(t || "登录已失效"), {
                    signIn: "expired",
                  });
                }
                return errRes(upstream.status, t || upstream.statusText, "upstream_error");
              }
              break;
            }

            if (!upstream) {
              return errRes(
                429,
                `OrcaTerm 限流或网络失败：${lastErr?.message ?? "unknown"}`,
                "rate_limit_error",
              );
            }

            // 流式：边读边翻
            const reader = upstream.body.getReader();
            const tr = createSseTranslator(body.model ?? "orcaterm-default");

            if (body.stream === false) {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                tr.feed(tr.decode(value));
              }
              const raw = tr.text();
              const env = flattenEnvelope(raw);
              if (!env && /^\s*\[ERROR\]/.test(raw.trim())) {
                return errRes(502, raw.trim(), "upstream_error");
              }
              return completionResponse({
                model: body.model,
                content: env?.text ?? raw,
                reasoning: env?.reasoning,
              });
            }

            const stream = new ReadableStream({
              async pull(controller) {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.enqueue(tr.finish());
                    controller.close();
                    return;
                  }
                  const out = tr.feed(tr.decode(value));
                  if (out) {
                    controller.enqueue(out);
                    return;
                  }
                }
              },
              cancel(reason) {
                return reader.cancel(reason);
              },
            });

            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                connection: "keep-alive",
              },
            });
          },
        };
      },

      // 上游没有独立的用量端点；额度信息只能从 X-RateLimit-* 推，暂不暴露 usage。
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth?.key) return provider.models;
        return provider.models ?? MODEL_ENTRIES;
      },
    },

    // 让 agent 每轮拿到干净的上游会话（上游没有多轮记忆，历史由我们压平）
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return;
      output.headers["x-product"] = "orcaterm";
    },
  };
};

function wechatSuccess(r) {
  // 注意：magpie 只有在结果里带 `key` 时才会把登录态写进 plugin-auth.json
  // （带 access+refresh 才算 oauth 凭据；只给 access 会被丢弃，表现为
  //  CLI 说 signed in、但下次查询又变成 not signed in）。
  return {
    type: "success",
    key: r.accessToken,
    metadata: {
      via: "wechat-qr",
      assistant: "orcaterm",
      mode: MODES.RE_ACT,
      baseUrl: DEFAULT_BASE_URL,
      userId: r.userId,
      nickname: r.providerUsername,
      avatar: r.avatar,
      expires: r.expiresAt ?? undefined,
      cookie: "",
    },
  };
}

function completionResponse({ model, content, reasoning }) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-orcaterm",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model ?? "orcaterm-default",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: content ?? "",
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errRes(status, message, type) {
  return new Response(JSON.stringify(toOpenAiError({ message, type })), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default { id: PROVIDER, server: OrcaTermAuthPlugin };

// 测试用内部导出（入口不要导出额外函数：magpie 会把每个导出当插件）
export const _internal = { csrfCodeFromCookie, flattenEnvelope };
