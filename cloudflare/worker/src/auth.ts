import type { Env } from "./env";
import { sha256Hex } from "./tokens";

const encoder = new TextEncoder();
const adminCookieName = "podsync_admin_token";

async function timingSafeTokenEqual(actual: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([sha256Hex(actual), sha256Hex(expected)]);
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  let diff = actualBytes.length ^ expectedBytes.length;

  for (let index = 0; index < actualHash.length; index += 1) {
    diff |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }

  return diff === 0;
}

export async function isAuthorizedNasRequest(request: Request, env: Env): Promise<boolean> {
  const expected = env.NAS_TOKEN;
  if (!expected) return false;

  const token = bearerToken(request);
  if (!token) return false;

  return timingSafeTokenEqual(token, expected);
}

export function hasCloudflareAccessIdentity(request: Request): boolean {
  return (request.headers.get("cf-access-jwt-assertion") ?? "").trim() !== "";
}

export async function isAuthorizedAdminRequest(request: Request, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return hasCloudflareAccessIdentity(request);

  const token = bearerToken(request) ?? adminCookieToken(request);
  if (!token) return false;

  return timingSafeTokenEqual(token, expected);
}

export async function isAuthorizedAdminToken(token: string | null, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected || token === null) return false;

  return timingSafeTokenEqual(token, expected);
}

export function adminTokenCookie(token: string): string {
  return `${adminCookieName}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;

  return header.slice(prefix.length);
}

function adminCookieToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== adminCookieName) continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch {
      return null;
    }
  }

  return null;
}
