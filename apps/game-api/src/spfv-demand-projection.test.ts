import { PGlite } from "@electric-sql/pglite";
import { domainEvents, MIGRATIONS_FOLDER, operators, simulationCommands, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demandHash } from "./demand-store.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERENCE = [{ worldId: WORLD, trainRunId: "reference", operatorId: OPERATOR, mode: "spnv", cancelled: false,
  reliabilityBasisPoints: 9_100, comfortBasisPoints: 8_200,
  stops: [{ stationId: "a", departureMs: 500_000 }, { stationId: "b", departureMs: 800_000 }, { stationId: "c", departureMs: 9_999_000 }] }];

describe("Bestätigte SPFV-Fahrten speisen die Nachfrage", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let accountId: string;
  let sequence: number;
  beforeEach(async () => {
    client = new PGlite(); db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD, name: "Explizite Projektionstestwelt", schedulePeriodWeeks: 3, epoch: new Date(0) });
    const access = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "projection-test", displayName: "Fixture" });
    accountId = access.id;
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: accountId, name: "Fixture-Verkehr" });
    sequence = 0;
  }, 30_000);
  afterEach(async () => { await client.close(); });

  async function event(eventType: string, payload: unknown) {
    sequence += 1;
    await db.insert(domainEvents).values({ worldId: WORLD, sequence, eventType, payload, occurredAt: new Date(0) });
  }

  // Explicit transport fixtures: native Rust tests separately prove acceptance,
  // actual profile stop times, baseline competition and future-only replacement.
  async function submitted(id: string, departure = 3_600, fareCents = "1200", corruptPreview = false) {
    const draft = { lineId: "line", name: "Linie", stopIds: ["a", "c"], headwayS: 3_600, fareCents,
      formationId: "formation", validFromS: departure, validUntilS: departure + 3_600, referenceTrainId: "reference" };
    const body = { schemaVersion: "zugfolge-spfv-preview/v1", worldId: WORLD, operatorId: OPERATOR, lineId: "line", draft,
      fleetStateHash: "f".repeat(64), capacityFacts: { standardSeats: 100, premiumSeats: 20, bicycleSpaces: 8, wheelchairSpaces: 2 } };
    const previewId = demandHash(body);
    await event("spfv.preview", { ...body, previewId, accountId, ...(corruptPreview ? { capacityFacts: { standardSeats: 9999 } } : {}) });
    const payload = { schemaVersion: "planning.path-request/v4", worldId: WORLD, operatorId: OPERATOR, requestingAccountId: accountId,
      trainId: id, formationId: "formation", fleetStateHash: "f".repeat(64), trainCategory: "long-distance", desiredDepartureS: departure,
      serviceWindow: { validFromS: departure, validUntilS: departure + 1 } };
    const [request] = await db.insert(simulationCommands).values({ worldId: WORLD, requestingAccountId: accountId,
      idempotencyKey: `request-${id}`, commandType: "planning.path-request", payload, submittedAt: new Date(0), status: "processed", resultEventSequence: sequence + 3 }).returning();
    const [coordinate] = await db.insert(simulationCommands).values({ worldId: WORLD, requestingAccountId: accountId,
      idempotencyKey: `coordinate-${id}`, commandType: "planning.coordinate", payload: { worldId: WORLD, requestCommandIds: [request!.id] },
      submittedAt: new Date(0), status: "processed", resultEventSequence: sequence + 3 }).returning();
    await event("spfv.submitted", { worldId: WORLD, operatorId: OPERATOR, accountId, lineId: "line", previewId, draft,
      submission: { worldId: WORLD, operatorId: OPERATOR, lineId: "line", previewId, status: "submitted", planningRequestIds: [request!.id], planningCoordinationId: coordinate!.id } });
    return { request: request!, coordinate: coordinate!, payload,
      reservation: { train: { id }, serviceWindow: payload.serviceWindow,
        passengerStops: [{ stationId: "a", arrivalS: departure, departureS: departure }, { stationId: "c", arrivalS: departure + 300, departureS: departure + 300 }] } };
  }

  async function committed(reservations: Record<string, unknown>, revision = 1) {
    const projection = { worldId: WORLD, projectionRevision: revision };
    const state = { schemaVersion: "zugfolge-planning-runtime-state/v1", worldId: WORLD, projectionRevision: revision, projection, reservations };
    await event("planning.runtime-state", { schemaVersion: "planning-runtime-state-event/v1", worldId: WORLD, projectionRevision: revision, stateHash: demandHash(state), state });
    await event("planning.diagram", projection);
  }

  it("übernimmt nur native Zeiten, gepinnte Plätze und Abschnittspreise; Qualität bleibt Referenzprognose", async () => {
    const fixture = await submitted("accepted"); await committed({ accepted: fixture.reservation });
    const loaded = await loadCommittedSpfvServices(db, WORLD, REFERENCE);
    expect(loaded.services).toHaveLength(1);
    expect(loaded.services[0]).toMatchObject({ worldId: WORLD, trainRunId: "accepted", mode: "spfv", operatorId: OPERATOR,
      stops: [{ stationId: "a", departureMs: 3_600_000 }, { stationId: "c", arrivalMs: 3_900_000 }],
      capacity: { standardSeats: 100, premiumSeats: 20, standardStanding: 0, bicycleSpaces: 8, wheelchairSpaces: 2 },
      fares: [{ centsPerSegment: 1_200 }, { centsPerSegment: 1_200 }], serviceIntervalMs: 3_600_000,
      reliabilityBasisPoints: 9_100, comfortBasisPoints: 8_200 });
    expect(loaded.provenance).toMatchObject({ kind: "forecast", planningRevision: 1, referenceTrainIds: ["reference"] });
    const query = vi.spyOn(db, "select");
    expect(await loadCommittedSpfvServices(db, WORLD, REFERENCE)).toEqual(loaded);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
  });

  it.each(["pending", "failed"] as const)("nimmt %s Anträge trotz Vorschau und Beleg nicht als Angebot auf", async (status) => {
    const fixture = await submitted("unprocessed");
    await db.update(simulationCommands).set({ status }).where(eq(simulationCommands.id, fixture.request.id));
    await committed({ unprocessed: fixture.reservation });
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE)).services).toEqual([]);
  });

  it("nimmt abgelehnte oder durch Linienänderung entfernte Fahrten nicht aus alten Bestätigungen wieder auf", async () => {
    const old = await submitted("old"); await committed({ old: old.reservation });
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE)).services).toHaveLength(1);
    const replacement = await submitted("replacement", 7_200, "900");
    await committed({ replacement: replacement.reservation }, 2);
    const loaded = await loadCommittedSpfvServices(db, WORLD, REFERENCE);
    expect(loaded.services.map((service) => service["trainRunId"])).toEqual(["replacement"]);
    expect(loaded.services[0]).toMatchObject({ fares: [{ centsPerSegment: 900 }, { centsPerSegment: 900 }] });
    await committed({}, 3);
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE)).services).toEqual([]);
  });

  it("weist fremde Betreiber zurück", async () => {
    const fixture = await submitted("accepted"); await committed({ accepted: fixture.reservation });
    await db.update(simulationCommands).set({ payload: { ...fixture.payload, operatorId: "foreign" } }).where(eq(simulationCommands.id, fixture.request.id));
    await expect(loadCommittedSpfvServices(db, WORLD, REFERENCE)).rejects.toThrow("Kontoautorität");
  });

  it("begrenzt den aktuellen Zeitraum vor der 2000-Fahrten-Schranke und bindet ihn an den Cache", async () => {
    const fixture = await submitted("accepted");
    const history = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`past-${index}`, {
      passengerStops: [{ stationId: "a", arrivalS: 10, departureS: 10 }],
    }]));
    await committed({ ...history, accepted: fixture.reservation });
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE, { windowStartMs: 3_600_000, windowEndMs: 7_200_000 })).services).toHaveLength(1);
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE, { windowStartMs: 7_200_000, windowEndMs: 10_800_000 })).services).toEqual([]);
    await expect(loadCommittedSpfvServices(db, WORLD, REFERENCE, { windowStartMs: 0, windowEndMs: 3_600_000 })).rejects.toThrow("überschreitet");
  });

  it("weist manipulierte Vorschaupins zurück", async () => {
    const fixture = await submitted("corrupt-preview", 3_600, "1200", true); await committed({ "corrupt-preview": fixture.reservation });
    await expect(loadCommittedSpfvServices(db, WORLD, REFERENCE)).rejects.toThrow("verändert oder fremd");
  });

  it("erfindet keine Halte, keinen Referenzkomfort und keinen fehlenden Commit", async () => {
    expect((await loadCommittedSpfvServices(db, WORLD, REFERENCE)).services).toEqual([]);
    const fixture = await submitted("accepted"); await committed({ accepted: fixture.reservation });
    await expect(loadCommittedSpfvServices(db, WORLD, [])).rejects.toThrow("Referenzqualität");
    await expect(loadCommittedSpfvServices(db, WORLD, [{ ...REFERENCE[0]!, stops: [{ stationId: "c" }, { stationId: "a" }] }])).rejects.toThrow("Referenzqualität");
    await committed({ accepted: { ...fixture.reservation, passengerStops: [{ stationId: "a", arrivalS: 3600, departureS: 3600 }] } }, 2);
    await expect(loadCommittedSpfvServices(db, WORLD, REFERENCE)).rejects.toThrow("Verkehrshalten");
  });
});
