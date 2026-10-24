/**
 * 微信扫码登录（对齐客户端 asset_0196 的 OAuth 流程）。
 *
 *   1. GET  {OAUTH_BASE}/oauth/wechat/config      -> {appid, redirect_uri, state, scope}
 *   2. 打开 微信扫码页 qrconnect（appid/redirect_uri/state 都来自上一步）
 *   3. 扫码后微信回跳 redirect_uri（/oauth/wechat/bridge?code&state）
 *      bridge 是个 postMessage 页，桌面端用 iframe 接；插件这边让用户把地址栏 URL 贴回来
 *   4. POST {OAUTH_BASE}/oauth/wechat/exchange    -> {userId, providerUsername, avatar, accessToken, expiresIn}
 *
 * 错误码（客户端同款）：STATE_EXPIRED / STATE_MISMATCH / INVALID_REQUEST /
 * PROVIDER_DISABLED / INTERNAL_ERROR
 */
export const OAUTH_BASE = "https://orcaterm.com";

const WECHAT_QR = "https://open.weixin.qq.com/connect/qrconnect";

export class WechatOAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "WechatOAuthError";
    this.code = code;
  }
}

async function jsonFetch(url, init, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { res, body, text };
  } finally {
    clearTimeout(t);
  }
}

/** 1+2：拿 config，拼出扫码 URL */
export async function startWechatLogin({ base = OAUTH_BASE } = {}) {
  const { res, body } = await jsonFetch(`${base}/oauth/wechat/config`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const code = body?.code;
  if (!res.ok || Number(code) !== 0 || !body?.data) {
    throw new WechatOAuthError(
      String(code ?? "INTERNAL_ERROR"),
      body?.message || `[wechat-config] http ${res.status}`,
    );
  }
  const { appid, redirect_uri: redirectUri, state, scope } = body.data;
  if (!appid || !redirectUri || !state || !scope) {
    throw new WechatOAuthError("INTERNAL_ERROR", "[wechat-config] 响应缺字段");
  }

  const qr = new URL(WECHAT_QR);
  qr.searchParams.set("appid", appid);
  qr.searchParams.set("redirect_uri", redirectUri);
  qr.searchParams.set("response_type", "code");
  qr.searchParams.set("scope", scope);
  qr.searchParams.set("state", state);
  return {
    state,
    appid,
    redirectUri,
    url: `${qr.toString()}#wechat_redirect`,
    instructions:
      "用微信扫码。扫码后浏览器会跳到一个空白页（微信登录回调），" +
      "把地址栏里的完整 URL 贴回来即可（里面带 code 和 state）。",
  };
}

/**
 * 从用户粘贴的内容里抽出 code / state。
 * 支持：完整回调 URL、只有 query 串、或直接粘贴 code。
 */
export function parseCallbackInput(raw, expectState) {
  const s = String(raw ?? "").trim();
  if (!s) throw new WechatOAuthError("INVALID_REQUEST", "没有收到回调内容");

  const tryParams = (qs) => {
    const p = new URLSearchParams(qs);
    const code = p.get("code");
    if (!code) return null;
    return { code, state: p.get("state") || expectState, error: p.get("error") };
  };

  let hit = null;
  if (s.includes("code=") || s.includes("?")) {
    const qs = s.includes("?") ? s.slice(s.indexOf("?") + 1).split("#")[0] : s;
    hit = tryParams(qs);
    if (!hit) {
      try {
        hit = tryParams(new URL(s).search.slice(1));
      } catch {
        /* 忽略 */
      }
    }
  }
  if (!hit && /^[A-Za-z0-9_-]{8,}$/.test(s)) {
    hit = { code: s, state: expectState, error: null };
  }
  if (!hit) throw new WechatOAuthError("INVALID_REQUEST", "粘贴的内容里找不到 code");

  if (hit.error) throw new WechatOAuthError(hit.error, `微信返回错误: ${hit.error}`);
  if (expectState && hit.state && hit.state !== expectState) {
    throw new WechatOAuthError("STATE_MISMATCH", "state 不匹配，请重新发起扫码");
  }
  return { code: hit.code, state: hit.state || expectState };
}

/** 4：用 code 换 token */
export async function exchangeCode({ code, state, base = OAUTH_BASE }) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/exchange`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code, state }),
  });
  const c = body?.code;
  if (!res.ok || Number(c) !== 0 || !body?.data) {
    const known = [
      "STATE_EXPIRED",
      "STATE_MISMATCH",
      "INVALID_REQUEST",
      "PROVIDER_DISABLED",
      "INTERNAL_ERROR",
    ];
    const codeStr = known.includes(String(c)) ? String(c) : "INTERNAL_ERROR";
    throw new WechatOAuthError(codeStr, body?.message || text?.slice(0, 200) || "微信登录失败");
  }
  const d = body.data;
  if (!d.userId || !d.accessToken) {
    throw new WechatOAuthError("INTERNAL_ERROR", "[wechat-exchange] 响应缺字段");
  }
  const expiresIn = Number(d.expiresIn) || 0;
  return {
    userId: String(d.userId),
    providerUsername: d.providerUsername ?? "",
    avatar: d.avatar ?? "",
    accessToken: d.accessToken,
    expiresIn,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  };
}
