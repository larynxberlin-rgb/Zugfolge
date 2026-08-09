import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EconomyDatabase } from "./ledger.js";
import {
  canonicalFleetJson,
  createFleetMobilizationEnvelope,
  fleetSnapshotHash,
  loadFleetMobilizationSnapshot,
  persistFleetMobilizationSnapshot,
  resolveVehicleConcept,
  validateFleetMobilizationSnapshot,
  verifyMobilizationReference,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";

const WORLD = "33333333-3333-4333-8333-333333333333";
const OTHER_WORLD = "44444444-4444-4444-8444-444444444444";
const AT = 10_000;

function snapshot(overrides: Partial<FleetMobilizationSnapshot> = {}): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: WORLD,
    revision: 8,
    producedAt: 9_000,
    formations: [{
      id: "formation-1",
      operatorId: "operator-1",
      vehicleIds: ["vehicle-1", "vehicle-2"],
      serviceLineIds: ["S1"],
      availability: "available",
      procurement: "delivered",
      availableFrom: 9_500,
      availableUntil: 20_000,
      characteristics: {
        seats: 220,
        firstClassBasisPoints: 500,
        accessible: true,
        bicyclePlaces: 12,
        wheelchairPlaces: 2,
        equipment: ["passenger-information"],
        vehicleAgeYears: 2,
        maximumSpeedKph: 160,
        operatingCostCentsPerTrainKm: 780,
        homologatedLineIds: ["S1"],
        maintenanceValidUntil: 20_000,
        traction: "electric",
        replacementPlan: true,
      },
    }],
    personnelDuties: [{
      id: "duty-1",
      operatorId: "operator-1",
      formationIds: ["formation-1"],
      status: "ready",
      validFrom: 9_500,
      validUntil: 20_000,
    }],
    pathReservations: [{
      id: "path-1",
      operatorId: "operator-1",
      serviceLineIds: ["S1"],
      status: "confirmed",
      validFrom: 9_500,
      validUntil: 20_000,
    }],
    ...overrides,
  };
}

describe("persistente M5→M6-Snapshot-Grenze", () => {
  let client: PGlite;
  let db: EconomyDatabase;

  beforeEach(async () => {
    client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    await database.insert(worlds).values([
      { id: WORLD, name: "Welt", schedulePeriodWeeks: 3, epoch: new Date(0) },
      { id: OTHER_WORLD, name: "Fremd", schedulePeriodWeeks: 3, epoch: new Date(0) },
    ]);
    db = database;
  });

  afterEach(async () => client.close());

  it("persistiert eine Revision unveränderlich und lädt sie über Revision plus Hash", async () => {
    const envelope = createFleetMobilizationEnvelope(snapshot());
    expect(await persistFleetMobilizationSnapshot(db, WORLD, envelope, new Date(10_000))).toMatchObject({ created: true });
    expect(await persistFleetMobilizationSnapshot(db, WORLD, envelope, new Date(10_001))).toMatchObject({ created: false });
    expect(await loadFleetMobilizationSnapshot(db, WORLD, { fleetRevision: 8, snapshotHash: envelope.snapshotHash })).toEqual(envelope.snapshot);
    await expect(persistFleetMobilizationSnapshot(db, OTHER_WORLD, envelope, new Date(10_002))).rejects.toThrow(/Weltisolation/);
  });

  it("leitet Angebotswerte ausschließlich aus der passenden, verfügbaren Formation ab", () => {
    const current = snapshot();
    const snapshotHash = fleetSnapshotHash(current);
    expect(resolveVehicleConcept(current, { fleetRevision: 8, snapshotHash, formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: AT })).toMatchObject({
      minimumSeats: 220,
      maximumSpeedKph: 160,
      operatingCostCentsPerTrainKm: 780,
      accessible: true,
      evidence: { fleetRevision: 8, snapshotHash, formationId: "formation-1" },
    });
    expect(() => resolveVehicleConcept(current, { fleetRevision: 8, snapshotHash, formationId: "formation-1" }, { operatorId: "foreign", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/anderen EVU/);
    const unavailable = snapshot({ formations: [{ ...current.formations[0]!, availability: "maintenance" }] });
    expect(() => resolveVehicleConcept(unavailable, { fleetRevision: 8, snapshotHash: fleetSnapshotHash(unavailable), formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/nicht frei verfügbar/);
    const unapproved = snapshot({ formations: [{ ...current.formations[0]!, characteristics: { ...current.formations[0]!.characteristics, homologatedLineIds: ["S2"] } }] });
    expect(() => resolveVehicleConcept(unapproved, { fleetRevision: 8, snapshotHash: fleetSnapshotHash(unapproved), formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/keine Zulassung/);
    const overdue = snapshot({ formations: [{ ...current.formations[0]!, characteristics: { ...current.formations[0]!.characteristics, maintenanceValidUntil: AT - 1 } }] });
    expect(() => resolveVehicleConcept(overdue, { fleetRevision: 8, snapshotHash: fleetSnapshotHash(overdue), formationId: "formation-1" }, { operatorId: "operator-1", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/Instandhaltungsfreigabe/);
    expect(() => validateFleetMobilizationSnapshot(snapshot({ formations: [{ ...current.formations[0]!, vehicleIds: ["vehicle-2", "vehicle-1"] }] }))).toThrow(/kanonisch sortiert/);
  });

  it("akzeptiert nur durch M5 belegte Formation, Personal und Trasse derselben Revision", () => {
    const current = snapshot();
    const reference = {
      fleetRevision: 8,
      snapshotHash: fleetSnapshotHash(current),
      formationIds: ["formation-1"],
      personnelDutyIds: ["duty-1"],
      pathReservationIds: ["path-1"],
    };
    expect(verifyMobilizationReference(current, reference, { operatorId: "operator-1", winningFormationId: "formation-1", serviceLineIds: ["S1"], operatingFrom: AT })).toMatchObject({
      verifiedBy: "zugfolge-fleet-mobilization/v1",
      snapshotHash: reference.snapshotHash,
    });
    expect(() => verifyMobilizationReference(current, { ...reference, personnelDutyIds: ["unknown"] }, { operatorId: "operator-1", winningFormationId: "formation-1", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/unbekannten Personaldienst/);
    expect(() => verifyMobilizationReference(current, { ...reference, snapshotHash: "0".repeat(64) }, { operatorId: "operator-1", winningFormationId: "formation-1", serviceLineIds: ["S1"], operatingFrom: AT })).toThrow(/Hash/);
  });

  it("liest den vom Rust-Single-Writer erzeugten Golden-Snapshot bytegleich", async () => {
    const fixtureUrl = new URL("../../../crates/zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.json", import.meta.url);
    const hashUrl = new URL("../../../crates/zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.sha256", import.meta.url);
    const canonical = (await readFile(fixtureUrl, "utf8")).trimEnd();
    const expectedHash = (await readFile(hashUrl, "utf8")).trimEnd();
    const fromRust = JSON.parse(canonical) as FleetMobilizationSnapshot;
    expect(validateFleetMobilizationSnapshot(fromRust)).toBe(fromRust);
    expect(fleetSnapshotHash(fromRust)).toBe(expectedHash);
    expect(canonicalFleetJson(fromRust)).toBe(canonical);
  });
});
