import { describe, expect, it } from "vitest";

import { LivemapApiClient } from "./api.js";

describe("LivemapApiClient", () => {
  it("ruft browsernatives fetch mit dem globalen Empfaenger auf", async () => {
    const fetchImplementation = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      expect(String(input)).toBe("/api/worlds/welt-1/livemap/config");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer zugriff-token");
      return Promise.resolve(new Response(JSON.stringify({
        schemaVersion: "zugfolge-livemap-config/v2", worldId: "welt-1", worldName: "Mitteldeutschland",
        infrastructureReleaseId: "infra", basemap: {}, infrastructure: {}, initialView: {},
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    } as typeof fetch;

    await expect(new LivemapApiClient("/api", "zugriff-token", fetchImplementation).config("welt-1"))
      .resolves.toMatchObject({ schemaVersion: "zugfolge-livemap-config/v2", worldName: "Mitteldeutschland" });
  });

  it("verlangt einen versionierten Weltanzeigenamen und die exakte Weltbindung", async () => {
    for (const payload of [
      { schemaVersion: "zugfolge-livemap-config/v1", worldId: "welt-1", worldName: "Alt" },
      { schemaVersion: "zugfolge-livemap-config/v2", worldId: "welt-2", worldName: "Fremd" },
      { schemaVersion: "zugfolge-livemap-config/v2", worldId: "welt-1", worldName: "" },
    ]) {
      const client = new LivemapApiClient("", "token", (() => Promise.resolve(new Response(JSON.stringify(payload)))) as typeof fetch);
      await expect(client.config("welt-1")).rejects.toBeInstanceOf(Error);
    }
  });

  it("lädt ausschließlich die authentifizierte und weltgebundene Postfachprojektion", async () => {
    const fetchImplementation = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(_input)).toBe("/api/worlds/welt-1/mailbox");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer zugriff-token");
      return Promise.resolve(new Response(JSON.stringify([{
        id: "meldung-1",
        worldId: "welt-1",
        recipientAccountId: "wird-nicht-für-das-routing-verwendet",
        messageType: "system.info",
        payload: { title: "Betrieb läuft" },
        sentAt: "2026-08-13T08:00:00.000Z",
        deadlineAt: null,
        acknowledgedAt: null,
        priority: "information",
        overdue: false,
      }]), { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;

    await expect(new LivemapApiClient("/api", "zugriff-token", fetchImplementation).mailbox("welt-1"))
      .resolves.toMatchObject([{ id: "meldung-1", worldId: "welt-1", priority: "information" }]);
  });

  it("bricht bei einer fremden Welt fail-closed ab", async () => {
    const fetchImplementation = (() => Promise.resolve(new Response(JSON.stringify([{
      id: "meldung-1",
      worldId: "welt-2",
      messageType: "system.info",
      payload: {},
      sentAt: "2026-08-13T08:00:00.000Z",
      deadlineAt: null,
      acknowledgedAt: null,
      priority: "information",
      overdue: false,
    }]), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch;

    await expect(new LivemapApiClient("/api", "zugriff-token", fetchImplementation).mailbox("welt-1"))
      .rejects.toThrow(/gewählten Welt/);
  });
});
