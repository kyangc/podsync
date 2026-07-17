import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { sha256Hex } from "./tokens";

const encoder = new TextEncoder();
const accessJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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

async function hasCloudflareAccessIdentity(request: Request, env: Env): Promise<boolean> {
  const assertion = (request.headers.get("cf-access-jwt-assertion") ?? "").trim();
  const issuer = env.ACCESS_ISSUER?.replace(/\/$/, "");
  const audience = env.ACCESS_AUD?.trim();
  if (!assertion || !issuer || !audience) return false;

  let jwks = accessJwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessJwksByIssuer.set(issuer, jwks);
  }

  try {
    await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function isAuthorizedAdminRequest(request: Request, env: Env): Promise<boolean> {
  return hasCloudflareAccessIdentity(request, env);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;

  return header.slice(prefix.length);
}
