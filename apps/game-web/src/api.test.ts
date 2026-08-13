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
  it("spricht den vollständigen M12-Vertrags- und Marktpfad mit weltgebundenen URLs an", async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify(String(input).endsWith("/simulation-time") ? { atS: 123 } : []),
      { status: 200 },
    ));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);

    await client.loadOwnOperators();
    await expect(client.loadSimulationTime("world/1")).resolves.toBe(123);
    await client.loadWorldOperators("world/1");
    await client.loadContracts("world/1", "operator/1");
    await client.loadVehicleMarket("world/1");
    await client.loadOwnedVehicles("world/1", "operator/1");
    await client.loadVehicleHistory("world/1", "asset/1");

    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/me/operators",
      "https://api.test/worlds/world%2F1/simulation-time",
      "https://api.test/worlds/world%2F1/operators",
      "https://api.test/worlds/world%2F1/operators/operator%2F1/contracts",
      "https://api.test/worlds/world%2F1/vehicle-market/listings",
      "https://api.test/worlds/world%2F1/operators/operator%2F1/vehicles",
      "https://api.test/worlds/world%2F1/vehicles/asset%2F1/history",
    ]);
  });

  it("sendet M12-Schreibaktionen mit kanonischen Centstrings und Fachrevisionen", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    await client.offerContract("world", "seller", {
      offereeOperatorId: "buyer", contractType: "vehicle-rental", subject: { vehicleIds: ["asset-1"] },
      terms: { summary: "Miete" }, priceCents: "125050", validFromS: 20, validUntilS: 100,
      responseDeadlineS: 15, terminationNoticeS: 10, offeredAtS: 10, idempotencyKey: "offer-1",
    });
    await client.respondToContract("world", "buyer", "contract", "accept", 12);
    await client.endContract("world", "buyer", "contract", 50, "Ordentliche Kündigung", false);
    await client.createVehicleListing("world", "seller", "asset-1", { listingType: "sale", priceCents: "90000000", listedAtS: 10, expiresAtS: 100, idempotencyKey: "listing-1" });
    await client.reserveVehicleListing("world", "listing", "buyer", 20, 30, 1);
    await client.transferVehicleListing("world", "listing", "buyer", 25, 2, "transfer-1");
    await client.reverseVehicleTransfer("world", "listing", "buyer", 26, "undisclosed-damage", "reverse-1");
    await client.cancelVehicleListing("world", "seller", "listing", 20, 1);

    expect(fetchImplementation).toHaveBeenCalledTimes(8);
    for (const [, init] of fetchImplementation.mock.calls) expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]![1]!.body))).toMatchObject({ priceCents: "125050", contractType: "vehicle-rental" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[5]![1]!.body))).toMatchObject({ expectedRevision: 2, idempotencyKey: "transfer-1" });
  });

  it("ruft Tutorialpaket und -assistent getrennt von der öffentlichen Startkapital-Policy ab", async () => {
    const grant = {
      idempotentReplay: false,
      grant: {
        id: "grant-1",
        operatorId: "operator-1",
        emergencyLotId: "lot-1",
        vehicleId: "vehicle-1",
        pathReceiptId: "path-1",
        personnelPoolId: "personnel-1",
        operatingProgramId: "program-1",
        expiresAtS: "1000",
      },
    };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/starting-capital-policy")) {
        return new Response(JSON.stringify({ mode: "finite", amountCents: "0" }));
      }
      if (url.endsWith("/onboarding/assistant")) {
        return new Response(JSON.stringify({ ready: true, facts: {}, warnings: [] }));
      }
      if (url.endsWith("/onboarding/start-package") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify(grant));
      }
      return new Response(JSON.stringify(grant));
    });
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);

    await expect(client.loadStartPackage("tutorial/world")).resolves.toEqual(grant);
    await expect(client.claimStartPackage("tutorial/world")).resolves.toEqual(grant);
    await expect(client.loadOnboardingAssistant("tutorial/world")).resolves.toMatchObject({ ready: true });
    await expect(client.loadStartingCapitalPolicy("public/world")).resolves.toEqual({ mode: "finite", amountCents: "0" });

    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/worlds/tutorial%2Fworld/onboarding/start-package",
      "https://api.test/worlds/tutorial%2Fworld/onboarding/start-package",
      "https://api.test/worlds/tutorial%2Fworld/onboarding/assistant",
      "https://api.test/worlds/public%2Fworld/starting-capital-policy",
    ]);
    expect(fetchImplementation.mock.calls[1]![1]).toMatchObject({ method: "POST" });
  });

  it("verwirft numerisches oder überlaufendes Startkapital an der Web-Vertragsgrenze", async () => {
    const numeric = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ mode: "finite", amountCents: 0 })),
    );
    await expect(numeric.loadStartingCapitalPolicy("world-1")).rejects.toThrow(/ungültiges Format/);

    const overflowing = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ mode: "finite", amountCents: "9223372036854775808" })),
    );
    await expect(overflowing.loadStartingCapitalPolicy("world-1")).rejects.toThrow(/ungültiges Format/);
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
