const hex = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

export async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => hex[byte]).join("");
}
