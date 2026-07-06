import type { Env } from "./env";
import { sha256Hex } from "./tokens";

const encoder = new TextEncoder();

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

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  return timingSafeTokenEqual(header.slice(prefix.length), expected);
}

export function hasCloudflareAccessIdentity(request: Request): boolean {
  return (request.headers.get("cf-access-jwt-assertion") ?? "").trim() !== "";
}
