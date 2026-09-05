import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, operators, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import {
  conductorProjectionRuntimeFromAddon,
  demandRuntimeFromAddon,
  loadConductorProjectionRuntime,
  loadDemandRuntime,
  type InteriorPassengerPlacesV1,
} from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ConductorProjectionService } from "./conductor-projection.js";
import { DemandStore, demandList, demandRecord, demandText, type DemandCheckpoint } from "./demand-store.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRAIN = "regional-1";
const hasNative = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined
  || process.env["ZUGFOLGE_DEMAND_TEST_BINARY"] !== undefined && process.env["ZUGFOLGE_CONDUCTOR_TEST_BINARY"] !== undefined;

function callRust(binary: string, input: string): string {
  const result = spawnSync(binary, [], { input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function runtimes() {
  const demandBinary = process.env["ZUGFOLGE_DEMAND_TEST_BINARY"];
  const conductorBinary = process.env["ZUGFOLGE_CONDUCTOR_TEST_BINARY"];
  return {
    demandRuntime: demandBinary === undefined ? loadDemandRuntime() : demandRuntimeFromAddon({
      evaluatePassengerDemand(input) { return callRust(demandBinary, input); },
    }),
    projectionRuntime: conductorBinary === undefined ? loadConductorProjectionRuntime() : conductorProjectionRuntimeFromAddon({
      projectConductorPassengers(input) { return callRust(conductorBinary, input); },
    }),
  };
}

function demandFixture(): Record<string, unknown> {
  const input = demandRecord(JSON.parse(readFileSync(new URL("../../../crates/zugfolge-demand/examples/evaluation.json", import.meta.url), "utf8")));
  input["worldId"] = WORLD;
  input["services"] = demandList(input["services"]).map((service) => ({ ...service, worldId: WORLD, operatorId: OPERATOR }));
  input["alternatives"] = demandList(input["alternatives"]).map((alternative) => ({ ...alternative, worldId: WORLD }));
  return input;
}

/** Explizite synthetische Prüfgeometrie, kein produktiver Innenraumgenerator. */
function interiorFixture(): InteriorPassengerPlacesV1 {
  const interior: InteriorPassengerPlacesV1 = {
    schemaVersion: "interior-passenger-places/v1", worldId: WORLD, trainRunId: TRAIN,
    layoutId: "balanced-six-place-regression", layoutHash: "",
    places: ["1", "2", "3", "4", "5", "6"].map((ordinal, index): InteriorPassengerPlacesV1["places"][number] => ({
      placeId: `place-${ordinal}`, vehicleId: "balanced-test-car", xMm: index * 1000, yMm: 1000,
      comfortClass: "standard", kind: index < 4 ? "seat" : "standing",
      spaceNeeds: ["ordinary", "wheelchair", "bicycle", "stroller"],
    })),
  };
  // Die explizite Objektform folgt der veröffentlichten Rust-Feldreihenfolge.
  return { ...interior, layoutHash: createHash("sha256").update(JSON.stringify(interior)).digest("hex") };
}

function confirmedInput(previous: DemandCheckpoint, nowMs: number, stops: readonly Record<string, unknown>[]) {
  return { ...previous.input, nowMs, revision: Number(previous.result["revision"]) + 1,
    previousEvaluation: { result: previous.result, services: previous.input["services"] },
    operationalProgress: { schemaVersion: "demand-operational-progress/v1", worldId: WORLD,
      asOfMs: nowMs, receiptId: `balanced-halt-receipt-${nowMs}`, trains: [{ trainRunId: TRAIN, stops }] },
  };
}

describe("M15.2: Autorisierung und datensparsame Fehler ohne Native-Abhängigkeit", () => {
  it("weist fehlenden Zugang, Fremdzugriff und Archiv vor Journal- oder Kernzugriff ab", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    const latest = vi.spyOn(DemandStore.prototype, "latest");
    const evaluate = vi.fn(() => { throw new Error("Nachfrage darf für unberechtigte Anfragen nicht laufen"); });
    const project = vi.fn(() => { throw new Error("Projektion darf für unberechtigte Anfragen nicht laufen"); });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values([
        { id: WORLD, name: "Access regression", schedulePeriodWeeks: 3, epoch: new Date(0) },
        { id: OTHER, name: "Other world", schedulePeriodWeeks: 3, epoch: new Date(0) },
      ]);
      const owner = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "owner", displayName: "Owner" });
      await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "visitor", displayName: "Visitor" });
      await requestWorldAccess(db, { worldId: OTHER, keycloakSubject: "owner", displayName: "Other owner" });
      await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: owner.id, name: "Access regression operator", color: "#123456" });
      const service = new ConductorProjectionService({ db, demandRuntime: { evaluate }, projectionRuntime: { project } });
      const access = { worldId: WORLD, keycloakSubject: "owner", operatorId: OPERATOR, trainRunId: TRAIN, expectedDemandStateHash: "a".repeat(64) };
      const interior = interiorFixture();
      await expect(service.project({ ...access, keycloakSubject: "no-access" }, interior)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.project({ ...access, keycloakSubject: "visitor" }, interior)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.project({ ...access, worldId: OTHER }, interior)).rejects.toMatchObject({ statusCode: 403 });
      await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, WORLD));
      await expect(service.project(access, interior)).rejects.toMatchObject({ statusCode: 409 });
      expect(latest).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
    } finally { latest.mockRestore(); await client.close(); }
  }, 30_000);

  it("entfernt private SQL-Parameter und Fehlerursachen an der Servicegrenze", async () => {
    const privateData = "fareFact valid_unpresentable passenger-secret private-world-seed";
    const queryError = Object.assign(new Error(`SELECT private_manifest params ${privateData}`), {
      name: "DrizzleQueryError", query: "SELECT private_manifest", params: [privateData], cause: new Error(privateData),
    });
    const db = { select() { throw queryError; } } as unknown as IdentityDatabase;
    const service = new ConductorProjectionService({ db,
      demandRuntime: { evaluate() { throw new Error(privateData); } },
      projectionRuntime: { project() { throw new Error(privateData); } },
    });
    const error = await service.project({ worldId: WORLD, keycloakSubject: "owner", operatorId: OPERATOR,
      trainRunId: TRAIN, expectedDemandStateHash: "a".repeat(64) }, interiorFixture()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ statusCode: 503, message: "Die belegte Fahrgastprojektion ist momentan nicht verfügbar." });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("params");
    for (const secret of ["private_manifest", "fareFact", "passenger-secret", "private-world-seed"]) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

// Die Linux-CI nutzt das echte NAPI-Addon; Windows kann dieselben Rust-JSON-Beispiele aufrufen.
// Keiner der Adapter besitzt einen JavaScript-Ersatz für Nachfrage oder Platzzuweisung.
describe.skipIf(!hasNative)("M15.2: native Nachfrage → Weltjournal → private Projektion", () => {
  it("projiziert belegte volle Abschnitte 1:1, restauriert das Datenbankabbild und prüft den Zugriff erneut", async () => {
    const native = runtimes();
    let client = new PGlite();
    let db = drizzle(client, { schema });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values([
        { id: WORLD, name: "Balanced M15 regression", schedulePeriodWeeks: 3, epoch: new Date(0) },
        { id: OTHER, name: "Other world", schedulePeriodWeeks: 3, epoch: new Date(0) },
      ]);
      const owner = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "owner", displayName: "Owner" });
      await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "visitor", displayName: "Visitor" });
      await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: owner.id, name: "Balanced test operator", color: "#123456" });
      let store = new DemandStore(db, native.demandRuntime);
      let service = new ConductorProjectionService({ db, ...native });
      const interior = interiorFixture();
      const request = (checkpoint: DemandCheckpoint) => ({ worldId: WORLD, keycloakSubject: "owner", operatorId: OPERATOR,
        trainRunId: TRAIN, expectedDemandStateHash: demandText(checkpoint.result["stateHash"]) });
      const forecast = await store.commit(demandFixture(), "balanced-deployment-pin", new Date(0));
      expect(forecast.result["projectionMode"]).toBe("forecast");
      await expect(service.project(request(forecast), interior)).rejects.toMatchObject({ statusCode: 409 });

      // Auch progress_bound allein beweist keinen tatsächlichen Einstieg im Zielzug.
      const unboarded = await store.commit(confirmedInput(forecast, 1000, []), "balanced-deployment-pin", new Date(1000));
      expect(unboarded.result["projectionMode"]).toBe("progress_bound");
      await expect(service.project(request(unboarded), interior)).rejects.toMatchObject({ statusCode: 503 });

      const firstDeparture = { stopId: "regional-leipzig", actualArrivalMs: null, actualDepartureMs: 600_000 };
      const running = await store.commit(confirmedInput(unboarded, 601_000, [firstDeparture]), "balanced-deployment-pin", new Date(601_000));
      expect(running.result["projectionMode"]).toBe("progress_bound");
      const projected = await service.project(request(running), interior);
      const manifest = demandList(running.result["manifests"]).find((row) => row["trainRunId"] === TRAIN && row["segmentId"] === projected.segmentId)!;
      const expectedKeys = demandList(manifest["passengers"]).map((person) => demandText(person["passengerKey"])).sort();
      expect(expectedKeys).toHaveLength(6);
      expect(projected.passengers.map((person) => person.passengerKey).sort()).toEqual(expectedKeys);
      expect(new Set(projected.passengers.map((person) => person.placeId)).size).toBe(6);
      expect(projected.passengers.filter((person) => person.posture === "seated")).toHaveLength(4);
      expect(projected.phase).toBe("in_transit");
      for (const secret of ["fareFact", "farePolicyProvenance", "journeyChainId", "demandSegment", "valid_unpresentable"]) {
        expect(JSON.stringify(projected)).not.toContain(secret);
      }
      await expect(service.project(request(forecast), interior)).rejects.toMatchObject({ statusCode: 409 });
      await expect(service.project({ ...request(running), keycloakSubject: "visitor" }, interior)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.project({ ...request(running), worldId: OTHER }, interior)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.project({ ...request(running), trainRunId: "express-1" }, interior)).rejects.toMatchObject({ statusCode: 404 });

      const databaseImage = await client.dumpDataDir();
      await client.close();
      client = new PGlite({ loadDataDir: databaseImage });
      db = drizzle(client, { schema });
      store = new DemandStore(db, native.demandRuntime);
      service = new ConductorProjectionService({ db, ...native });
      const restored = await store.latest(WORLD, "balanced-deployment-pin");
      expect(restored).toEqual(running);
      expect(await service.project(request(restored!), interior)).toEqual(projected);

      const arrived = await store.commit(confirmedInput(restored!, 1_800_001, [firstDeparture,
        { stopId: "regional-halle", actualArrivalMs: 1_800_000, actualDepartureMs: null },
      ]), "balanced-deployment-pin", new Date(1_800_001));
      const atStation = await service.project(request(arrived), interior, projected);
      expect(atStation.phase).toBe("at_stop");
      expect(atStation.currentStopId).toBe("regional-halle");
      expect(atStation.passengers.map((person) => person.passengerKey).sort()).toEqual(expectedKeys);
      expect(atStation.passengers.filter((person) => person.activity === "alighting").map((person) => person.passengerKey).sort())
        .toEqual(demandList(manifest["passengers"]).filter((person) => person["alightingStopId"] === "regional-halle")
          .map((person) => demandText(person["passengerKey"])).sort());

      const afterStop = await store.commit(confirmedInput(arrived, 1_921_000, [firstDeparture,
        { stopId: "regional-halle", actualArrivalMs: 1_800_000, actualDepartureMs: 1_920_000 },
      ]), "balanced-deployment-pin", new Date(1_921_000));
      const next = await service.project(request(afterStop), interior, JSON.parse(JSON.stringify(atStation)));
      const nextManifest = demandList(afterStop.result["manifests"]).find((row) => row["trainRunId"] === TRAIN && row["segmentId"] === next.segmentId)!;
      expect(next.passengers.map((person) => person.passengerKey).sort())
        .toEqual(demandList(nextManifest["passengers"]).map((person) => demandText(person["passengerKey"])).sort());
      expect(new Set(next.passengers.map((person) => person.passengerKey)).size).toBe(next.passengers.length);
      for (const person of next.passengers) {
        const before = projected.passengers.find((prior) => prior.passengerKey === person.passengerKey);
        if (before !== undefined) expect(person.placeId).toBe(before.placeId);
      }
      expect(await new ConductorProjectionService({ db, ...native }).project(request(afterStop), interior,
        JSON.parse(JSON.stringify(atStation)))).toEqual(next);

      await db.update(worldAccesses).set({ status: "revoked" })
        .where(and(eq(worldAccesses.worldId, WORLD), eq(worldAccesses.keycloakSubject, "owner")));
      await expect(service.project(request(afterStop), interior, next)).rejects.toMatchObject({ statusCode: 403 });
      await db.update(worldAccesses).set({ status: "active" })
        .where(and(eq(worldAccesses.worldId, WORLD), eq(worldAccesses.keycloakSubject, "owner")));
      await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, WORLD));
      await expect(service.project(request(afterStop), interior, next)).rejects.toMatchObject({ statusCode: 409 });
    } finally { await client.close(); }
  }, 30_000);
});
