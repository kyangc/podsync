import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const accessIssuer = "https://podsync-test.cloudflareaccess.com";
export const accessAudience = "podsync-test-audience";
export const accessEnv = {
  ACCESS_ISSUER: accessIssuer,
  ACCESS_AUD: accessAudience,
};

const keyID = "podsync-test-key";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = {
  ...await exportJWK(publicKey),
  alg: "RS256",
  kid: keyID,
  use: "sig",
};

export async function signAccessAssertion(audience = accessAudience): Promise<string> {
  return new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: keyID })
    .setIssuer(accessIssuer)
    .setAudience(audience)
    .setSubject("podsync-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

export const accessAssertion = await signAccessAssertion();

export const accessJwksURL = `${accessIssuer}/cdn-cgi/access/certs`;
export const accessJwks = { keys: [publicJwk] };

export function requestURL(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if ("url" in input && typeof input.url === "string") return input.url;
  return input.toString();
}
