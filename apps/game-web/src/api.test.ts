import { describe, expect, it, vi } from "vitest";

import { GameApiClient } from "./api.js";
import { sampleData } from "./diagram.js";

describe("GameApiClient", () => {
  it("lädt die veröffentlichte Planner-Projektion mit Bearer-Token", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ sequence: 7, data: sampleData }), { status: 200 }));
    const client = new GameApiClient("https://api.test/", "token", fetchImplementation as typeof fetch);
    await expect(client.loadDiagram("world-1")).resolves.toEqual(sampleData);
    expect(fetchImplementation).toHaveBeenCalledWith("https://api.test/worlds/world-1/planning/diagram", expect.objectContaining({ headers: { authorization: "Bearer token" } }));
  });

  it("verwirft unvollständige Event-Payloads", async () => {
    const client = new GameApiClient("", "token", async () => new Response(JSON.stringify({ data: { corridor: "x" } }), { status: 200 }));
    await expect(client.loadDiagram("world-1")).rejects.toThrow(/ungültiges Format/);
  });
});
