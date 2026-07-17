import { vi } from "vitest";
import { accessJwks, accessJwksURL, requestURL } from "./access";

const originalFetch = globalThis.fetch;

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = requestURL(input);
  if (url === accessJwksURL) return Response.json(accessJwks);
  return originalFetch(input, init);
});
