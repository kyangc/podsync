import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeD1 } from "./fake-d1";

describe("worker smoke", () => {
  it("returns health", async () => {
    const response = await worker.fetch(new Request("https://podcast.example.com/health"), {
      DB: fakeD1(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
