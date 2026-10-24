/**
 * 从 OrcaTerm 桌面端的持久化 store 里读登录态。
 *
 * 文件：~/Library/Application Support/com.orcaterm-desktop.app/data.bin（JSON）
 * 键：oauth_access_token / oauth_expires_at / oauth_refresh_token(可选) / userId
 *
 * 桌面端自己会刷新 token 并回写这个文件，所以「重读」就等于「续期」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function storePath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library/Application Support/com.orcaterm-desktop.app/data.bin"),
    path.join(home, ".config/com.orcaterm-desktop.app/data.bin"),
    path.join(home, ".local/share/com.orcaterm-desktop.app/data.bin"),
  ];
  if (process.env.ORCATERM_STORE) candidates.unshift(process.env.ORCATERM_STORE);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** @returns {{token:string, expiresAt:number|null, userId:string, refreshToken:string, source:string}|null} */
export function readLocalAuth(overridePath) {
  const file = overridePath || storePath();
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const token = data.oauth_access_token;
  if (!token) return null;
  const exp = Number(data.oauth_expires_at) || null;
  return {
    token,
    expiresAt: exp,
    userId: String(data.userId ?? ""),
    refreshToken: data.oauth_refresh_token ?? "",
    source: file,
  };
}

/** JWT payload 里的 userId（对应客户端 data.bin 的 userId） */
export function userIdFromToken(token) {
  try {
    const payload = String(token).split(".")[1];
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return String(JSON.parse(json).userId ?? "");
  } catch {
    return "";
  }
}

/** JWT exp（秒）-> ms；解析失败返回 null */
export function tokenExpiryMs(token) {
  try {
    const payload = String(token).split(".")[1];
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const exp = Number(JSON.parse(json).exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
