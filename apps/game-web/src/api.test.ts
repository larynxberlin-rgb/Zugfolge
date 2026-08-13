import { describe, expect, it, vi } from "vitest";

import {
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

import { GameApiClient } from "./api.js";

function projection(revision: number): PlanningProjectionV1 {
  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision: revision,
    worldId: "world-1",
    corridor: { id: "lhe", name: "Leipzig–Halle–Erfurt" },
    stations: [],
    trains: [],
    occupations: [],
    conflicts: [],
  };
}

function envelope(revision: number, sequence = revision): Response {
  return new Response(JSON.stringify({ sequence, data: projection(revision) }), { status: 200 });
}

describe("GameApiClient", () => {
  it("ruft den nativen Browser-Fetch mit seinem globalen Kontext auf", async () => {
    const boundFetch = vi.fn(function (this: typeof globalThis): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(envelope(1));
    });
    vi.stubGlobal("fetch", boundFetch);
    try {
      const client = new GameApiClient("https://api.test", "token");
      await expect(client.loadProjection("world-1")).resolves.toEqual(projection(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("laedt und validiert die veroeffentlichte Weltprojektion mit Bearer-Token", async () => {
    const fetchImplementation = vi.fn(async () => envelope(7, 99));
    const client = new GameApiClient(
      "https://api.test/",
      "token",
      fetchImplementation as typeof fetch,
    );
    await expect(client.loadProjection("world-1")).resolves.toEqual(projection(7));
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.test/worlds/world-1/planning/diagram",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );
  });

  it("verwirft unversionierte, fremde und strukturell unvollstaendige Payloads", async () => {
    const invalidClient = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ sequence: 1, data: { corridor: "x" } })),
    );
    await expect(invalidClient.loadProjection("world-1")).rejects.toThrow(/ungueltiges Format/);

    const foreign = { ...projection(1), worldId: "world-2" };
    const foreignClient = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ sequence: 1, data: foreign })),
    );
    await expect(foreignClient.loadProjection("world-1")).rejects.toThrow(/anderen Welt/);
  });

  it("verwendet bei Queue-Retry denselben serverautoritaeren Befehl und pollt bis zur neueren Fachrevision", async () => {
    const responses: (Response | Error)[] = [
      new Error("Verbindung nach Annahme abgerissen"),
      new Response(null, { status: 202 }),
      envelope(7, 900),
      envelope(8, 2),
    ];
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("unerwarteter Abruf");
      return response;
      },
    );
    const wait = vi.fn(async () => undefined);
    const client = new GameApiClient("", "token", fetchImplementation as typeof fetch, wait);

    await expect(
      client.applyAlternative("world-1", 7, "offer-stable", {
        queueRetryDelayMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(projection(8));

    const posts = fetchImplementation.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === "POST";
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]![1]).toMatchObject({ body: posts[1]![1]?.body });
    const body = JSON.parse(String(posts[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "planning-alternative-command/v1",
      projectionRevision: 7,
      alternativeId: "offer-stable",
      idempotencyKey: "alternative:7:offer-stable",
    });
    expect(body).not.toHaveProperty("trainId");
    expect(body).not.toHaveProperty("departureShiftS");
  });

  it("bricht bei einer rueckwaerts laufenden Revision ab", async () => {
    const client = new GameApiClient("", "token", async () => envelope(6));
    await expect(
      client.waitForNewerProjection("world-1", 7, { pollAttempts: 1, pollIntervalMs: 0 }),
    ).rejects.toThrow(/zurueckgefallen/);
  });

  it("startet, setzt fort und steuert die private Tutorialwelt nur ueber den Sessionvertrag", async () => {
    const view = { reference: "tut_abc", tutorialWorldId: "tutorial-id", publicWorldId: "public-id" };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tutorial-sessions/active")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(view), { status: init?.method === "POST" ? 201 : 200 });
    });
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    await expect(client.loadActiveTutorial("public-id")).resolves.toBeUndefined();
    await expect(client.startTutorial("public-id")).resolves.toMatchObject(view);
    await expect(client.tutorialAction("tutorial-id", { type: "confirm-path", alternativeId: "path-robust" })).resolves.toMatchObject(view);
    expect(fetchImplementation).toHaveBeenNthCalledWith(2, "https://api.test/worlds/public-id/tutorial-sessions", expect.objectContaining({ method: "POST" }));
    const action = fetchImplementation.mock.calls[2];
    expect(String(action?.[0])).toBe("https://api.test/worlds/tutorial-id/tutorial-session/actions");
    expect(JSON.parse(String((action?.[1] as RequestInit).body))).toEqual({ type: "confirm-path", alternativeId: "path-robust" });
  });

  it("meldet einen sicheren Fehler, wenn nur die Eventsequenz und nie die Fachrevision steigt", async () => {
    let sequence = 100;
    const client = new GameApiClient(
      "",
      "token",
      async () => envelope(7, sequence++),
      async () => undefined,
    );
    await expect(
      client.waitForNewerProjection("world-1", 7, { pollAttempts: 2, pollIntervalMs: 0 }),
    ).rejects.toThrow(/noch keine neuere Projektion/);
  });
});
