import { describe, expect, it } from "vitest";

import { LivemapApiClient } from "./api.js";

describe("LivemapApiClient", () => {
  it("ruft browsernatives fetch mit dem globalen Empfaenger auf", async () => {
    const fetchImplementation = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(String(input)).toBe("/api/worlds/welt-1/livemap/config");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer zugriff-token");
      return Promise.resolve(new Response(JSON.stringify({ schemaVersion: "preview" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    } as typeof fetch;

    await expect(new LivemapApiClient("/api", "zugriff-token", fetchImplementation).config("welt-1"))
      .resolves.toEqual({ schemaVersion: "preview" });
  });
});
