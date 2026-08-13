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
  return new Response(JSON.stringify({ sequence, timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 }, data: projection(revision) }), { status: 200 });
}

function contractResponse(): Record<string, unknown> {
  return {
    schemaVersion: "zugfolge-operator-contract/v1",
    id: "contract", worldId: "world", offerorOperatorId: "seller", offereeOperatorId: "buyer",
    contractType: "vehicle-rental", subject: {}, terms: {}, termsHash: "hash", priceCents: "125050",
    validFromS: 20, validUntilS: 100, responseDeadlineS: 15, terminationNoticeS: 10,
    status: "offered", offeredAtS: 1, revision: 1,
  };
}

function listingResponse(): Record<string, unknown> {
  return {
    schemaVersion: "zugfolge-vehicle-market-listing/v1",
    id: "listing", worldId: "world", vehicleId: "asset-1", offeringOperatorId: "seller",
    listingType: "sale", priceCents: "90000000", disclosure: {}, disclosureHash: "hash",
    listedAtS: 1, expiresAtS: 100, status: "open", revision: 1,
  };
}

function vehicleResponse(): Record<string, unknown> {
  return {
    worldId: "world", vehicleId: "asset-1", classDesignation: "442",
    ownerOperatorId: "buyer", holderOperatorId: "buyer", odometerMetres: "1000",
    conditionBasisPoints: 9000, damages: [], maintenanceDeadlines: [], bindings: {},
    valueCents: "90000000", revision: 2, historyHash: "a".repeat(64),
  };
}

function transferResponse(schemaVersion: unknown): Record<string, unknown> {
  return {
    schemaVersion, transferId: "transfer-1", listing: listingResponse(), vehicle: vehicleResponse(),
  };
}

function tutorialResponse(): Record<string, unknown> {
  return {
    schemaVersion: "zugfolge-tutorial-session/v1",
    reference: "tut_abc", tutorialWorldId: "tutorial-id", publicWorldId: "public-id", lifecycle: "running",
    templateVersion: "tutorial/v1", templateHash: "hash", currentChapter: 1, progressLabel: "Kapitel 1 von 5",
    chapters: [{ chapter: 1, code: "bid", title: "Angebot", goal: "Angebot abgeben" }],
    evidence: { "1": { completed: false, references: [] } },
    dialogue: { id: "dialogue", templateVersion: "tutorial/v1", chapter: 1, trigger: "session.started", speaker: "lutz", text: "Los.", canDismiss: true },
    presentation: {
      schemaVersion: "zugfolge-tutorial-presentation/v1",
      tender: {
        id: "tutorial-tender", priceWeightBasisPoints: 5000, qualityWeightBasisPoints: 5000, penaltyFocus: "punctuality",
        viabilityThresholdCentsPerTrainKm: "1739",
        limits: {
          minimumOrderingFeeCentsPerTrainKm: "100", maximumOrderingFeeCentsPerTrainKm: "1520", defaultOrderingFeeCentsPerTrainKm: "1450",
          minimumPunctualityBasisPoints: 8800, maximumPunctualityBasisPoints: 9800, defaultPunctualityBasisPoints: 9200,
          minimumExtraSeats: 0, maximumExtraSeats: 40, defaultExtraSeats: 12,
        },
      },
      leases: [], paths: [], programmes: [], programmeRuleEffects: [
        { rule: "hold-connections", label: "Anschlüsse abwarten", effect: { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 } },
        { rule: "prioritize-punctuality", label: "Pünktlichkeit priorisieren", effect: { costCents: "25000", qualityBasisPoints: 250, penaltyRiskBasisPoints: -300 } },
        { rule: "activate-reserve", label: "Reserve aktivieren", effect: { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 } },
      ], disruptionOptions: [],
    }, idleExpiresAt: "2026-01-01T00:10:00Z", maximumExpiresAt: "2026-01-01T00:15:00Z",
    publicWorldUrl: "?world=public-id",
  };
}

function worldContractResponse(): Record<string, unknown> {
  return {
    schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "world", name: "Mitteldeutschland",
    region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
    duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
    entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
    releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
  };
}

function cooperationResourcesResponse(worldId = "world/1", operatorId = "operator/1"): Record<string, unknown> {
  const option = { id: "internal-1", label: "RE 12 nach Halle Hbf", detail: "Regionalzug · geplant · Saale-Bahn" };
  return {
    schemaVersion: "zugfolge-cooperation-resource-catalog/v1",
    worldId,
    operatorId,
    fleetRevision: 7,
    trainRuns: [option], connectionTrainRuns: [option], formations: [option], personnelDuties: [option],
    pathReceipts: [option], disruptions: [option], rentableVehicles: [option], assistanceVehicles: [option],
  };
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
      await expect(client.loadProjection("world-1")).resolves.toEqual({ ...projection(1), timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("spricht den vollständigen M12-Vertrags- und Marktpfad mit weltgebundenen URLs an", async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify(String(input).endsWith("/simulation-time") ? { atS: 123 }
        : String(input).endsWith("/cooperation-resources") ? cooperationResourcesResponse()
          : String(input).includes("/contracts?") || String(input).includes("/listings?") ? { schemaVersion: "zugfolge-cooperation-page/v1", items: [], nextCursor: null } : []),
      { status: 200 },
    ));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);

    await client.loadOwnOperators();
    await expect(client.loadSimulationTime("world/1")).resolves.toBe(123);
    await client.loadWorldOperators("world/1");
    await client.loadMailbox("world/1");
    await client.loadContracts("world/1", "operator/1");
    await expect(client.loadCooperationResources("world/1", "operator/1")).resolves.toMatchObject({ fleetRevision: 7, trainRuns: [{ label: "RE 12 nach Halle Hbf" }] });
    await client.loadVehicleMarket("world/1");
    await client.loadOwnedVehicles("world/1", "operator/1");
    await client.loadVehicleHistory("world/1", "asset/1");

    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/me/operators",
      "https://api.test/worlds/world%2F1/simulation-time",
      "https://api.test/worlds/world%2F1/operators",
      "https://api.test/worlds/world%2F1/mailbox",
      "https://api.test/worlds/world%2F1/operators/operator%2F1/contracts?view=actionable&limit=50",
      "https://api.test/worlds/world%2F1/operators/operator%2F1/cooperation-resources",
      "https://api.test/worlds/world%2F1/vehicle-market/listings?view=actionable&limit=50",
      "https://api.test/worlds/world%2F1/operators/operator%2F1/vehicles",
      "https://api.test/worlds/world%2F1/vehicles/asset%2F1/history",
    ]);
  });

  it("reicht denselben absoluten Fristfilter durch Vertrags- und Marktseiten", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      schemaVersion: "zugfolge-cooperation-page/v1", items: [], nextCursor: null,
    })));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    await client.loadContracts("world", "operator", "actionable", "v1.10.00000000-0000-4000-8000-000000000001", 25, 86_400);
    await client.loadVehicleMarket("world", "actionable", "v1.9.00000000-0000-4000-8000-000000000002", 25, 86_400);
    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/worlds/world/operators/operator/contracts?view=actionable&limit=25&cursor=v1.10.00000000-0000-4000-8000-000000000001&deadlineBeforeS=86400",
      "https://api.test/worlds/world/vehicle-market/listings?view=actionable&limit=25&cursor=v1.9.00000000-0000-4000-8000-000000000002&deadlineBeforeS=86400",
    ]);
    expect(() => client.loadContracts("world", "operator", "actionable", undefined, 50, -1)).toThrow(/Fristfilter/);
  });

  it("akzeptiert nur versionierte v1-Vertraege, Marktangebote und Cursor-Seiten", async () => {
    const page = (item: unknown) => ({ schemaVersion: "zugfolge-cooperation-page/v1", items: [item], nextCursor: null });
    const clientFor = (payload: unknown) => new GameApiClient("", "token", async () => new Response(JSON.stringify(payload)));
    await expect(clientFor(page(contractResponse())).loadContracts("world", "operator")).resolves.toMatchObject({
      schemaVersion: "zugfolge-cooperation-page/v1", items: [{ schemaVersion: "zugfolge-operator-contract/v1" }],
    });
    await expect(clientFor(page(listingResponse())).loadVehicleMarket("world")).resolves.toMatchObject({
      schemaVersion: "zugfolge-cooperation-page/v1", items: [{ schemaVersion: "zugfolge-vehicle-market-listing/v1" }],
    });
    for (const schemaVersion of [undefined, "zugfolge-cooperation-page/v2"]) {
      await expect(clientFor({ schemaVersion, items: [], nextCursor: null }).loadContracts("world", "operator"))
        .rejects.toThrow(/Seitenschema/);
    }
    for (const schemaVersion of [undefined, "zugfolge-operator-contract/v2"]) {
      await expect(clientFor(page({ ...contractResponse(), schemaVersion })).loadContracts("world", "operator"))
        .rejects.toThrow(/Vertragsschema/);
    }
    for (const schemaVersion of [undefined, "zugfolge-vehicle-market-listing/v2"]) {
      await expect(clientFor(page({ ...listingResponse(), schemaVersion })).loadVehicleMarket("world"))
        .rejects.toThrow(/Marktangebotsschema/);
    }
    await expect(clientFor(transferResponse("zugfolge-vehicle-transfer-result/v1")).transferVehicleListing("world", "listing", "buyer", 2, "transfer"))
      .resolves.toMatchObject({ schemaVersion: "zugfolge-vehicle-transfer-result/v1", transferId: "transfer-1" });
    for (const schemaVersion of [undefined, "zugfolge-vehicle-transfer-result/v2"]) {
      await expect(clientFor(transferResponse(schemaVersion)).reverseVehicleTransfer("world", "listing", "buyer", "Mangel", "reverse"))
        .rejects.toThrow(/Transferschema/);
    }
  });

  it.each([401, 403])("bewahrt HTTP %i als Authentifizierungsstatus", async (status) => {
    const client = new GameApiClient("", "token", async () => new Response(JSON.stringify({ error: "Sitzung ungueltig" }), { status }));
    await expect(client.loadOwnOperators()).rejects.toMatchObject({ status, retryable: false, message: "Sitzung ungueltig" });
  });

  it("verwirft fremd gebundene oder strukturell unvollständige Ressourcenkataloge", async () => {
    const foreign = new GameApiClient("", "token", async () => new Response(JSON.stringify(cooperationResourcesResponse("other-world", "operator"))));
    await expect(foreign.loadCooperationResources("world", "operator")).rejects.toThrow(/anderen Welt/);
    const incomplete = new GameApiClient("", "token", async () => new Response(JSON.stringify({ ...cooperationResourcesResponse("world", "operator"), rentableVehicles: [{ id: "raw" }] })));
    await expect(incomplete.loadCooperationResources("world", "operator")).rejects.toThrow(/Kooperationsressourcen\.rentableVehicles\[0\]/);
  });

  it("beendet eine nicht antwortende Spielerreise und meldet einen wiederholbaren Fehler", async () => {
    vi.useFakeTimers();
    try {
      const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
      const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
      const result = expect(client.loadOwnOperators()).rejects.toThrow(/antwortet nicht/);
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("validiert Weltverträge und sendet beim Eintritt genau den bestätigten Vertrags-Hash", async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith("/public-world-contracts") ? [worldContractResponse()] : {})));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    await expect(client.loadPublicWorldContracts()).resolves.toMatchObject([{ noWipe: true, entry: { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { amountCents: "0" } }]);
    await client.enterPublicWorld("world", "Anna", "a".repeat(64));
    expect(JSON.parse(String(fetchImplementation.mock.calls[1]![1]!.body))).toEqual({ displayName: "Anna", acceptedWorldContractHash: "a".repeat(64) });
  });

  it("verwirft fehlerhafte Tutorial- und Vertragsantworten kontrolliert", async () => {
    const invalidContract = new GameApiClient("", "token", async () => new Response(JSON.stringify({ schemaVersion: "zugfolge-cooperation-page/v1", items: [{ schemaVersion: "zugfolge-operator-contract/v1", id: "nur-eine-id" }], nextCursor: null })));
    await expect(invalidContract.loadContracts("world", "operator")).rejects.toThrow(/Vertragsseite\.items\[0\]/);
    const invalidTutorial = new GameApiClient("", "token", async () => new Response(JSON.stringify({ ...tutorialResponse(), lifecycle: "fremd" })));
    await expect(invalidTutorial.loadTutorial("tutorial-id")).rejects.toThrow(/unbekannten Wert/);
    const unversioned = new GameApiClient("", "token", async () => new Response(JSON.stringify({ ...tutorialResponse(), schemaVersion: undefined })));
    await expect(unversioned.loadTutorial("tutorial-id")).rejects.toThrow(/unbekanntes Schema/);
    const malformedPresentation = tutorialResponse();
    malformedPresentation["presentation"] = { ...(malformedPresentation["presentation"] as Record<string, unknown>), leases: [{ id: "zu-wenig" }] };
    const malformed = new GameApiClient("", "token", async () => new Response(JSON.stringify(malformedPresentation)));
    await expect(malformed.loadTutorial("tutorial-id")).rejects.toThrow(/presentation\.leases\[0\]/);
    const incompleteSummary = tutorialResponse();
    incompleteSummary["lifecycle"] = "summary";
    incompleteSummary["summary"] = {
      startLiquidityCents: "100", leasingCostCents: "0", pathAndOperatingCostCents: "0", orderingRevenueCents: "100",
      disruptionCostCents: "0", resultCents: "100", punctualityBasisPoints: 9000, qualityTargetsMet: [], comparison: { selectedAction: "request_reroute" },
    };
    const incompleteComparison = new GameApiClient("", "token", async () => new Response(JSON.stringify(incompleteSummary)));
    await expect(incompleteComparison.loadTutorial("tutorial-id")).rejects.toThrow(/programmePenaltyRiskBasisPoints/);
  });

  it("verlangt die serverautoritative Postfachprioritaet im Laufzeitvertrag", async () => {
    const message = { id: "mail", worldId: "world", messageType: "contract", payload: {}, sentAt: "2026-01-01T00:00:00Z", deadlineAt: null, acknowledgedAt: null, priority: "action-required", overdue: false };
    const client = new GameApiClient("", "token", async () => new Response(JSON.stringify([message])));
    await expect(client.loadMailbox("world")).resolves.toMatchObject([{ priority: "action-required", overdue: false }]);
    const incomplete = new GameApiClient("", "token", async () => new Response(JSON.stringify([{ ...message, priority: undefined }])));
    await expect(incomplete.loadMailbox("world")).rejects.toThrow(/priority/);
  });

  it("sendet M12-Schreibaktionen mit kanonischen Centstrings und Fachrevisionen", async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const payload = url.includes("/contracts") ? contractResponse()
        : url.endsWith("/transfer") || url.endsWith("/reverse") ? transferResponse("zugfolge-vehicle-transfer-result/v1")
          : listingResponse();
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    await client.offerContract("world", "seller", {
      offereeOperatorId: "buyer", contractType: "vehicle-rental", subject: { vehicleIds: ["asset-1"] },
      terms: { summary: "Miete" }, priceCents: "125050", validFromS: 20, validUntilS: 100,
      responseDeadlineS: 15, terminationNoticeS: 10, idempotencyKey: "offer-1",
    });
    await client.respondToContract("world", "buyer", "contract", "accept", "respond-1");
    await client.endContract("world", "buyer", "contract", "Ordentliche Kündigung", false, "end-1");
    await client.createVehicleListing("world", "seller", "asset-1", { listingType: "sale", priceCents: "90000000", expiresAtS: 100, idempotencyKey: "listing-1" });
    await client.reserveVehicleListing("world", "listing", "buyer", 1, "reserve-1");
    await client.transferVehicleListing("world", "listing", "buyer", 2, "transfer-1");
    await client.reverseVehicleTransfer("world", "listing", "buyer", "undisclosed-damage", "reverse-1");
    await client.cancelVehicleListing("world", "seller", "listing", 1, "cancel-1");

    expect(fetchImplementation).toHaveBeenCalledTimes(8);
    for (const [, init] of fetchImplementation.mock.calls) expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]![1]!.body))).toMatchObject({ priceCents: "125050", contractType: "vehicle-rental" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[1]![1]!.body))).toMatchObject({ response: "accept", idempotencyKey: "respond-1" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[2]![1]!.body))).toMatchObject({ idempotencyKey: "end-1" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[2]![1]!.body))).not.toHaveProperty("nonPerformance");
    expect(JSON.parse(String(fetchImplementation.mock.calls[4]![1]!.body))).toMatchObject({ expectedRevision: 1, idempotencyKey: "reserve-1" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[5]![1]!.body))).toMatchObject({ expectedRevision: 2, idempotencyKey: "transfer-1" });
    expect(JSON.parse(String(fetchImplementation.mock.calls[7]![1]!.body))).toMatchObject({ expectedRevision: 1, idempotencyKey: "cancel-1" });
    for (const [, init] of fetchImplementation.mock.calls) {
      expect(JSON.parse(String(init!.body))).not.toHaveProperty("atS");
    }
  });

  it("sendet Nichterfüllung ausschließlich an die Belegroute", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(contractResponse())));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);
    expect(() => client.endContract("world", "buyer", "contract", "Belegte Nichterfüllung", true, "end-missing"))
      .toThrow(/Betriebsbeleg/);
    await client.endContract(
      "world", "buyer", "contract", "Belegte Nichterfüllung", true, "end-proof",
      "daily-operation-report/v1:2026-12-13",
    );
    expect(String(fetchImplementation.mock.calls[0]![0])).toContain("/non-performance");
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]![1]!.body))).toEqual({
      reason: "Belegte Nichterfüllung",
      evidenceReference: "daily-operation-report/v1:2026-12-13",
      idempotencyKey: "end-proof",
    });
  });

  it("ruft ausschliesslich die oeffentliche Startkapital-Policy ab", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ mode: "finite", amountCents: "0" })));
    const client = new GameApiClient("https://api.test", "token", fetchImplementation as typeof fetch);

    await expect(client.loadStartingCapitalPolicy("public/world")).resolves.toEqual({ mode: "finite", amountCents: "0" });

    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.test/worlds/public%2Fworld/starting-capital-policy",
    ]);
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
    await expect(client.loadProjection("world-1")).resolves.toEqual({ ...projection(7), timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 } });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.test/worlds/world-1/planning/diagram",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );
  });

  it("verwirft unversionierte, fremde und strukturell unvollstaendige Payloads", async () => {
    const invalidClient = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ sequence: 1, timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 }, data: { corridor: "x" } })),
    );
    await expect(invalidClient.loadProjection("world-1")).rejects.toThrow(/ungültiges Format/);

    const foreign = { ...projection(1), worldId: "world-2" };
    const foreignClient = new GameApiClient(
      "",
      "token",
      async () => new Response(JSON.stringify({ sequence: 1, timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 }, data: foreign })),
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
    ).resolves.toEqual({ ...projection(8), timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin", operatingDayBoundaryS: 0 } });

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
    ).rejects.toThrow(/zurückgefallen/);
  });

  it("startet, setzt fort und steuert die private Tutorialwelt nur ueber den Sessionvertrag", async () => {
    const view = tutorialResponse();
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
    ).rejects.toThrow(/noch keinen neueren bestätigten Stand/);
  });
});
