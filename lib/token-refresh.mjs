/**
 * OrcaTerm access token 续期。
 *
 * 客户端里是 CAPI 调用（asset_0102 模块 41808）：
 *   pe(e) -> JE({ action: "OAuthRefreshToken", data: { accessToken: e } })
 * 实测请求：
 *   POST https://orcaterm.com/cgi/api?action=OAuthRefreshToken
 *   {"action":"OAuthRefreshToken","data":{"accessToken":"<当前 token>"}}
 * 响应：
 *   {"data":{"Response":{"Code":0,"Message":"Success","AccessToken":"<新 token>","ExpiresIn":7200}}}
 *
 * 新 token 与旧 token 同构（JWT，2 小时），换出来即可继续用；
 * 旧 token 不会被立刻吊销，无需额外的清理动作。
 */
export const CAPI_BASE = process.env.ORCATERM_CAPI_BASE || "https://orcaterm.com";

export class RefreshError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RefreshError";
    this.code = code;
  }
}

export async function refreshAccessToken(accessToken, { base = CAPI_BASE, timeoutMs = 20_000 } = {}) {
  if (!accessToken) throw new RefreshError("没有可用的 accessToken", "INVALID_REQUEST");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let body;
  let status = 0;
  try {
    const res = await fetch(`${base}/cgi/api?action=OAuthRefreshToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "OAuthRefreshToken", data: { accessToken } }),
      signal: ctrl.signal,
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }

  const r = body?.data?.Response;
  if (!r) {
    throw new RefreshError(`续期响应异常（HTTP ${status}）`, "BAD_RESPONSE");
  }
  if (Number(r.Code) !== 0 || !r.AccessToken) {
    throw new RefreshError(r.Message || `续期失败（Code ${r.Code}）`, String(r.Code ?? "UNKNOWN"));
  }
  return {
    accessToken: r.AccessToken,
    expiresIn: Number(r.ExpiresIn) || 7200,
  };
}
