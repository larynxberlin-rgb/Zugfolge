import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import {
  domainEvents,
  fleetMobilizationSnapshots,
  fleetWorldCheckpoints,
  MIGRATIONS_FOLDER,
  operators,
  simulationCommands,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { createFleetMobilizationEnvelope, type FleetMobilizationSnapshot } from "@zugfolge/economy";
import { requestWorldAccess, type AccountRecord } from "@zugfolge/identity";
import {
  PLANNING_COORDINATE_AUTHORITY_SCHEMA,
  PLANNING_PLAYER_PATH_REQUEST_SCHEMA,
} from "@zugfolge/planning-worker";
import type {
  FleetAuthorityRelease,
  FleetAuthorityVehicleRestriction,
  FleetRuntime,
  NativeFleetWorldState,
} from "@zugfolge/runtime-native";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const worldA = "11111111-1111-4111-8111-111111111111";
const worldB = "22222222-2222-4222-8222-222222222222";
const unknownWorld = "99999999-9999-4999-8999-999999999999";
const internalToken = "planning-route-internal-token";
const operatorA = "aaaaaaaa-0000-4000-8000-000000000001";
const operatorB = "bbbbbbbb-0000-4000-8000-000000000002";
let persistedFleetStateHash = "";
let persistedFleetSnapshotHash = "";

function canonicalTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalTestValue(item)]),
  );
}

function testFleetStateHash(state: NativeFleetWorldState): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalTestValue(state)), "utf8")
    .digest("hex");
}

const planningFleetRuntime: FleetRuntime = {
  initializeFleet() {
    throw new Error("Planning-Test nutzt keine Fleet-Initialisierung.");
  },
  applyFleetCommand() {
    throw new Error("Planning-Test nutzt keine Fleet-Kommandos.");
  },
  verifyFleetWorldState(state, expectedStateHash) {
    const actualStateHash = testFleetStateHash(state);
    if (actualStateHash !== expectedStateHash) {
      throw new Error("state_hash_mismatch: manipulierter Planning-Checkpoint");
    }
    return {
      schemaVersion: "zugfolge-fleet-world-state-verification/v1",
      worldId: state.worldId,
      revision: state.revision,
      producedAt: state.producedAt,
      authorityReleaseHash: state.authorityReleaseHash,
      stateHash: actualStateHash,
      snapshotHash: persistedFleetSnapshotHash,
    };
  },
};

function pathRequest(requestId: string, _trainId: string, _trainNumber: number, formationId = "formation-a") {
  return {
    schemaVersion: PLANNING_PLAYER_PATH_REQUEST_SCHEMA,
    requestId,
    formationId,
    trainCategory: "regional" as const,
    originStationId: "leipzig",
    destinationStationId: "halle",
    desiredDepartureS: 25_800,
    operatingDays: "daily" as const,
    stops: [],
    earlierS: 300,
    laterS: 300,
    stepS: 60,
    extraRunningTimeS: 0,
    maxOperationalStops: 1,
  };
}

function authorityRelease(): FleetAuthorityRelease {
  const asset = (
    id: string,
    operatorId: string,
    input: {
      readonly classDesignation: string;
      readonly traction: "unpowered" | "electric" | "diesel" | "battery";
      readonly electricSystems: readonly ("ac15kv" | "ac25kv")[];
      readonly installedProtection: readonly ("pzb" | "lzb" | "etcs-level1")[];
      readonly lengthMm?: number;
      readonly massKg?: number;
      readonly maximumSpeedKph?: number;
      readonly maximumSpeedMmps?: number;
      readonly continuousPowerKw?: number;
      readonly role?: "locomotive" | "powered-unit" | "coach" | "control-car";
      readonly controlStands?: Readonly<{ front: boolean; rear: boolean }>;
      readonly orientation?: "along" | "against";
      readonly restrictions?: Readonly<Record<string, FleetAuthorityVehicleRestriction>>;
    },
  ) => ({
    id,
    numericId: Number(id.replace(/\D/g, "").slice(-4) || "1") + 1,
    operatorId,
    vehicleTypeId: Number(id.replace(/\D/g, "").slice(-4) || "1") + 100,
    classDesignation: input.classDesignation,
    tradeName: id,
    buildYear: 2024,
    acquisitionYear: 2025,
    procurementChannel: "leasing" as const,
    approvedLineIds: ["S1"],
    maintenanceDeadlines: [{ kind: "inspection", dueAt: 100_000 }],
    installedProtection: input.installedProtection,
    technical: {
      lengthMm: input.lengthMm ?? 70_000,
      massKg: input.massKg ?? 120_000,
      maximumSpeedKph: input.maximumSpeedKph ?? 160,
      maximumSpeedMmps: input.maximumSpeedMmps
        ?? Math.floor((input.maximumSpeedKph ?? 160) * 1_000_000 / 3_600),
      accelerationMmPerS2: input.traction === "unpowered" ? 0 : 800,
      decelerationMmPerS2: input.traction === "unpowered" ? 0 : 900,
      continuousPowerKw: input.continuousPowerKw
        ?? (input.traction === "unpowered" ? 0 : 2_000),
      startingTractiveEffortKn: input.traction === "unpowered" ? 0 : 250,
      brakeWeightKg: 100_000,
      maximumAccelerationCapMmps2: input.traction === "unpowered" ? 0 : 800,
      serviceBrakeCapMmps2: 900,
      emergencyBrakeMultiplierBasisPoints: 15_000,
      traction: input.traction,
      electricSystems: input.electricSystems,
      role: input.role ?? (input.traction === "unpowered" ? "coach" : "powered-unit"),
      controlStands: input.controlStands
        ?? (input.traction === "unpowered"
          ? { front: false, rear: false }
          : { front: true, rear: true }),
    },
    passenger: {
      seats: 120,
      firstClassSeats: 12,
      accessible: true,
      bicyclePlaces: 8,
      wheelchairPlaces: 2,
      equipment: ["pis"],
      operatingCostCentsPerTrainKm: 700,
      replacementPlan: true,
    },
    orientation: input.orientation ?? "along",
    condition: {
      mechanicsBasisPoints: 10_000,
      driveBasisPoints: 10_000,
      brakesBasisPoints: 10_000,
      kilometresSinceMaintenance: 0,
      operatingHoursSinceMaintenance: 0,
      openObservations: 0,
    },
    restrictions: input.restrictions ?? {},
    history: [],
    deliveredAt: 0,
    retiredAt: 100_000,
  });
  const receipt = (
    id: string,
    owner: string,
    approvedClasses: readonly string[],
    electrifications: FleetAuthorityRelease["pathReceipts"][number]["electrifications"],
  ) => ({
    id,
    numericRouteId: Number(id.replace(/\D/g, "").slice(-4) || "1") + id.length,
    operatorId: owner,
    serviceLineIds: ["S1"],
    decision: "confirmed" as const,
    validFrom: 0,
    validUntil: 100_000,
    platformLengthsMm: [150_000],
    electrifications,
    requiredProtection: ["pzb" as const],
    approvedClasses,
    plannerStateHash: "b".repeat(64),
    conflictCheckHash: "c".repeat(64),
  });
  return {
    schemaVersion: "zugfolge-fleet-authority-release/v2",
    releaseId: "fleet-lhe-2026",
    referenceYear: 2026,
    economyReleaseId: "economy-lhe-2026",
    economyReleaseSha256: "f".repeat(64),
    assets: [
      asset("asset-a-1", operatorA, { classDesignation: "ET1", traction: "electric", electricSystems: ["ac15kv"], installedProtection: ["pzb"], massKg: 123_000, lengthMm: 71_000, maximumSpeedKph: 100 }),
      asset("asset-b-2", operatorB, { classDesignation: "VT1", traction: "diesel", electricSystems: [], installedProtection: ["pzb"] }),
      asset("asset-clearance-3", operatorA, { classDesignation: "TOO-WIDE", traction: "electric", electricSystems: ["ac15kv"], installedProtection: ["pzb"] }),
      asset("asset-electric-4", operatorA, { classDesignation: "ET1", traction: "electric", electricSystems: ["ac25kv"], installedProtection: ["pzb"] }),
      asset("asset-unprotected-5", operatorA, { classDesignation: "ET1", traction: "electric", electricSystems: ["ac15kv"], installedProtection: [] }),
      asset("asset-control-6", operatorA, {
        classDesignation: "CTRL",
        traction: "unpowered",
        electricSystems: [],
        installedProtection: ["pzb"],
        role: "control-car",
        controlStands: { front: false, rear: true },
        orientation: "against",
      }),
      asset("asset-loco-7", operatorA, {
        classDesignation: "LOCO",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["etcs-level1"],
        role: "locomotive",
      }),
      asset("asset-protection-8", operatorA, {
        classDesignation: "ET1",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
        restrictions: { unavailable: { "protection-unavailable": "pzb" } },
      }),
      asset("asset-speed-9", operatorA, {
        classDesignation: "ET1",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
        maximumSpeedKph: 100,
        restrictions: {
          brake: { "service-brake": 650 },
          speed: { "maximum-speed": 20_001 },
        },
      }),
      asset("asset-bemu-10", operatorA, {
        classDesignation: "BEMU",
        traction: "battery",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
      }),
      asset("asset-bemu-bad-11", operatorA, {
        classDesignation: "BEMU",
        traction: "battery",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
      }),
      asset("asset-immobilized-12", operatorA, {
        classDesignation: "ET1",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
        restrictions: { unavailable: "immobilized" },
      }),
      asset("asset-zero-power-13", operatorA, {
        classDesignation: "ET1",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
        continuousPowerKw: 1,
        restrictions: { derated: { "power-basis-points": 1 } },
      }),
      asset("asset-utf8-power-14", operatorA, {
        classDesignation: "ET1",
        traction: "electric",
        electricSystems: ["ac15kv"],
        installedProtection: ["pzb"],
        continuousPowerKw: 3,
        restrictions: {
          "\uE000": { "power-basis-points": 5_070 },
          "\u{10000}": { "power-basis-points": 6_748 },
        },
      }),
    ],
    personnelPools: [],
    pathReceipts: [
      receipt("path-a", operatorA, ["ET1"], ["overhead-ac15kv"]),
      receipt("path-b", operatorB, ["VT1"], ["unelectrified", "overhead-ac15kv"]),
      receipt("path-control-6", operatorA, ["CTRL", "LOCO"], ["overhead-ac15kv"]),
      receipt("path-protection-8", operatorA, ["ET1"], ["overhead-ac15kv"]),
      receipt("path-speed-9", operatorA, ["ET1"], ["overhead-ac15kv"]),
      receipt("path-bemu-good-10", operatorA, ["BEMU"], ["unelectrified", "overhead-ac15kv"]),
      receipt("path-bemu-bad-11", operatorA, ["BEMU"], ["overhead-ac25kv"]),
      receipt("path-immobilized-12", operatorA, ["ET1"], ["overhead-ac15kv"]),
      receipt("path-zero-power-13", operatorA, ["ET1"], ["overhead-ac15kv"]),
      receipt("path-utf8-power-14", operatorA, ["ET1"], ["overhead-ac15kv"]),
    ],
  };
}

async function persistFleetFixture(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<void> {
  const release = authorityRelease();
  const formations = {
    "formation-a": { id: "formation-a", vehicleIds: ["asset-a-1"], pathReceiptId: "path-a", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-b": { id: "formation-b", vehicleIds: ["asset-b-2"], pathReceiptId: "path-b", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-clearance": { id: "formation-clearance", vehicleIds: ["asset-clearance-3"], pathReceiptId: "path-a", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-electric": { id: "formation-electric", vehicleIds: ["asset-electric-4"], pathReceiptId: "path-a", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-unprotected": { id: "formation-unprotected", vehicleIds: ["asset-unprotected-5"], pathReceiptId: "path-a", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-control": { id: "formation-control", vehicleIds: ["asset-control-6", "asset-loco-7"], pathReceiptId: "path-control-6", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-protection": { id: "formation-protection", vehicleIds: ["asset-protection-8"], pathReceiptId: "path-protection-8", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-speed": { id: "formation-speed", vehicleIds: ["asset-speed-9"], pathReceiptId: "path-speed-9", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 650 } },
    "formation-bemu-good": { id: "formation-bemu-good", vehicleIds: ["asset-bemu-10"], pathReceiptId: "path-bemu-good-10", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-bemu-bad": { id: "formation-bemu-bad", vehicleIds: ["asset-bemu-bad-11"], pathReceiptId: "path-bemu-bad-11", dynamics: { accelerationMmPerS2: 800, decelerationMmPerS2: 900 } },
    "formation-immobilized": { id: "formation-immobilized", vehicleIds: ["asset-immobilized-12"], pathReceiptId: "path-immobilized-12" },
    "formation-zero-power": { id: "formation-zero-power", vehicleIds: ["asset-zero-power-13"], pathReceiptId: "path-zero-power-13" },
    "formation-utf8-power": { id: "formation-utf8-power", vehicleIds: ["asset-utf8-power-14"], pathReceiptId: "path-utf8-power-14" },
  } as const;
  const assetHoldings = Object.fromEntries(release.assets.map((asset) => [asset.id, {
    ownerOperatorId: asset.operatorId,
    holderOperatorId: asset.operatorId,
    lessorOperatorId: null,
    contractId: null,
    validUntilS: null,
    historyHash: "d".repeat(64),
  }]));
  const assetsById = new Map(release.assets.map((asset) => [asset.id, asset] as const));
  const receiptsById = new Map(release.pathReceipts.map((receipt) => [receipt.id, receipt] as const));
  const snapshotFormations: FleetMobilizationSnapshot["formations"] = Object.values(formations)
    .map((formation) => {
      const assets = formation.vehicleIds.map((vehicleId) => assetsById.get(vehicleId)!);
      const receipt = receiptsById.get(formation.pathReceiptId)!;
      const seats = assets.reduce((sum, asset) => sum + asset.passenger.seats, 0);
      const firstClassSeats = assets.reduce(
        (sum, asset) => sum + asset.passenger.firstClassSeats,
        0,
      );
      const powered = assets.find((asset) => asset.technical.traction !== "unpowered");
      const availableUntil = Math.min(
        receipt.validUntil,
        ...assets.flatMap((asset) => [
          asset.retiredAt,
          ...asset.maintenanceDeadlines.map((deadline) => deadline.dueAt),
        ]),
      );
      return {
        id: formation.id,
        operatorId: receipt.operatorId,
        vehicleIds: formation.vehicleIds,
        pathReceiptId: formation.pathReceiptId,
        serviceLineIds: receipt.serviceLineIds,
        availability: powered !== undefined && formation.dynamics === undefined
          ? "maintenance" as const
          : "available" as const,
        procurement: "delivered" as const,
        availableFrom: Math.max(...assets.map((asset) => asset.deliveredAt)),
        availableUntil,
        characteristics: {
          seats,
          firstClassBasisPoints: Math.floor(firstClassSeats * 10_000 / seats),
          accessible: assets.every((asset) => asset.passenger.accessible),
          bicyclePlaces: assets.reduce((sum, asset) => sum + asset.passenger.bicyclePlaces, 0),
          wheelchairPlaces: assets.reduce(
            (sum, asset) => sum + asset.passenger.wheelchairPlaces,
            0,
          ),
          equipment: ["pis"],
          vehicleAgeYears: Math.max(...assets.map((asset) => release.referenceYear - asset.buildYear)),
          maximumSpeedKph: Math.min(...assets.map((asset) => asset.technical.maximumSpeedKph)),
          operatingCostCentsPerTrainKm: assets.reduce(
            (sum, asset) => sum + asset.passenger.operatingCostCentsPerTrainKm,
            0,
          ),
          homologatedLineIds: receipt.serviceLineIds,
          maintenanceValidUntil: availableUntil,
          traction: powered?.technical.traction ?? "unpowered",
          replacementPlan: assets.every((asset) => asset.passenger.replacementPlan),
        },
      };
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const state = {
    schemaVersion: "zugfolge-fleet-world-state/v2",
    worldId: worldA,
    revision: 0,
    producedAt: 0,
    authorityReleaseHash: "a".repeat(64),
    authorityRelease: release,
    formations,
    personnelDuties: {},
    pathReservations: {},
    assetHoldings,
  } satisfies NativeFleetWorldState;
  const snapshot: FleetMobilizationSnapshot = {
    schema: "zugfolge-fleet-mobilization/v1",
    worldId: worldA,
    revision: 0,
    producedAt: 0,
    formations: snapshotFormations,
    personnelDuties: [],
    pathReservations: [],
  };
  const envelope = createFleetMobilizationEnvelope(snapshot);
  persistedFleetStateHash = testFleetStateHash(state);
  persistedFleetSnapshotHash = envelope.snapshotHash;
  await db.insert(fleetMobilizationSnapshots).values({
    worldId: worldA,
    revision: 0,
    snapshotHash: envelope.snapshotHash,
    payload: snapshot,
    producedAt: new Date(0),
    ingestedAt: new Date(0),
  });
  await db.insert(fleetWorldCheckpoints).values({
    worldId: worldA,
    revision: 0,
    stateSchema: state.schemaVersion,
    state,
    stateHash: persistedFleetStateHash,
    snapshotHash: envelope.snapshotHash,
    commandId: null,
    commandSchema: null,
    commandJson: null,
    commandHash: null,
    producedAt: new Date(0),
    ingestedAt: new Date(0),
  });
}

async function replaceFleetFixture(
  db: ReturnType<typeof drizzle<typeof schema>>,
  transform: (current: {
    readonly state: NativeFleetWorldState;
    readonly snapshot: FleetMobilizationSnapshot;
  }) => {
    readonly state: NativeFleetWorldState;
    readonly snapshot: FleetMobilizationSnapshot;
  },
  options: { readonly preserveStateHash?: boolean } = {},
): Promise<void> {
  const [checkpoint] = await db
    .select({ state: fleetWorldCheckpoints.state })
    .from(fleetWorldCheckpoints)
    .where(eq(fleetWorldCheckpoints.worldId, worldA))
    .limit(1);
  const [snapshotRow] = await db
    .select({ payload: fleetMobilizationSnapshots.payload })
    .from(fleetMobilizationSnapshots)
    .where(eq(fleetMobilizationSnapshots.worldId, worldA))
    .limit(1);
  if (checkpoint === undefined || snapshotRow === undefined) {
    throw new Error("Fleet-Testfixture ist unvollstaendig.");
  }
  const next = transform({
    state: structuredClone(checkpoint.state) as NativeFleetWorldState,
    snapshot: structuredClone(snapshotRow.payload) as FleetMobilizationSnapshot,
  });
  const envelope = createFleetMobilizationEnvelope(next.snapshot);
  persistedFleetSnapshotHash = envelope.snapshotHash;
  await db
    .update(fleetMobilizationSnapshots)
    .set({ payload: next.snapshot, snapshotHash: envelope.snapshotHash })
    .where(eq(fleetMobilizationSnapshots.worldId, worldA));
  await db
    .update(fleetWorldCheckpoints)
    .set({
      state: next.state,
      snapshotHash: envelope.snapshotHash,
      ...(options.preserveStateHash ? {} : { stateHash: testFleetStateHash(next.state) }),
    })
    .where(eq(fleetWorldCheckpoints.worldId, worldA));
}

describe("produktive M3-Planning-Routen", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let accountA: AccountRecord;
  let accountB: AccountRecord;
  let authority: AccountRecord;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      { id: worldA, name: "A", schedulePeriodWeeks: 4, epoch: new Date(0) },
      { id: worldB, name: "B", schedulePeriodWeeks: 4, epoch: new Date(0) },
    ]);
    accountA = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "account-a",
      displayName: "A",
    });
    accountB = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "account-b",
      displayName: "B",
    });
    await requestWorldAccess(db, {
      worldId: worldB,
      keycloakSubject: "foreign",
      displayName: "Fremd",
    });
    authority = await requestWorldAccess(db, {
      worldId: worldA,
      keycloakSubject: "authority",
      displayName: "Aufgabentraeger",
    });
    await db.insert(operators).values([
      { id: operatorA, worldId: worldA, foundingAccountId: accountA.id, name: "EVU A" },
      { id: operatorB, worldId: worldA, foundingAccountId: accountB.id, name: "EVU B" },
    ]);
    await persistFleetFixture(db);
    app = buildApp({
      db,
      verifyToken: async (token) => {
        if (!["account-a", "account-b", "foreign"].includes(token)) {
          throw new Error("ungueltig");
        }
        return { keycloakSubject: token, displayName: token };
      },
      simulationIngestToken: internalToken,
      planningAuthorityAccountIds: { [worldA]: authority.id },
      fleetRuntime: planningFleetRuntime,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await client.close();
  });

  async function submitPath(token: string, body: ReturnType<typeof pathRequest>) {
    return app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it("bindet Welt und zwei aktive Konten serverseitig und validiert exakt", async () => {
    const bodyA = pathRequest("request-a", "train-a", 26801);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      payload: bodyA,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${unknownWorld}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: bodyA,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer foreign" },
      payload: bodyA,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: { ...bodyA, worldId: worldB, requestingAccountId: accountB.id },
    })).statusCode).toBe(400);

    const first = await submitPath("account-a", bodyA);
    const second = await submitPath(
      "account-b",
      pathRequest("request-b", "train-b", 26802, "formation-b"),
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const commands = await db
      .select()
      .from(simulationCommands)
      .where(inArray(simulationCommands.id, [
        first.json<{ id: string }>().id,
        second.json<{ id: string }>().id,
      ]));
    expect(new Set(commands.map((command) => command.requestingAccountId))).toEqual(
      new Set([accountA.id, accountB.id]),
    );
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        worldId: worldA,
        commandType: "planning.path-request",
        payload: expect.objectContaining({
          worldId: worldA,
          formationId: "formation-a",
          operatorId: operatorA,
          fleetRevision: 0,
          fleetStateHash: persistedFleetStateHash,
          fleetAuthorityReleaseId: "fleet-lhe-2026",
          trainId: expect.stringMatching(/^player-/),
          trainNumber: expect.any(Number),
          train: {
            numericId: expect.any(Number),
            name: "formation-a",
            massKg: 123_000,
            lengthMm: 71_000,
            maximumSpeedMmps: 27_777,
            accelerationMmPerS2: 800,
            decelerationMmPerS2: 900,
          },
        }),
      }),
    ]));
    const assignedNumbers = commands.map((command) => (command.payload as { trainNumber: number }).trainNumber);
    expect(new Set(assignedNumbers).size).toBe(2);
    expect(assignedNumbers.every((number) => number >= 20_000 && number <= 39_999)).toBe(true);
  });

  it("verwirft manipulierte Clientphysik und fremde Formationen vor dem Queue-Write", async () => {
    const body = pathRequest("cheat-physics", "train-cheat", 26_810);
    const manipulated = await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: {
        ...body,
        train: {
          numericId: 1,
          name: "Ein-Kilogramm-ICE",
          massKg: 1,
          lengthMm: 1,
          maximumSpeedKph: 999,
          accelerationMmPerS2: 999_999,
          decelerationMmPerS2: 999_999,
        },
      },
    });
    expect(manipulated.statusCode).toBe(400);

    const foreign = await submitPath(
      "account-b",
      pathRequest("foreign-formation", "train-foreign", 26_812, "formation-a"),
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: "planning_formation_forbidden" });
    expect(await db.select().from(simulationCommands)).toEqual([]);
  });

  it("erzwingt Elektrifizierung, Zugsicherung und Baureihen-/Lichtraumfreigabe, erlaubt aber passenden Diesel", async () => {
    for (const [formationId, suffix] of [
      ["formation-electric", "electric"],
      ["formation-unprotected", "protection"],
      ["formation-clearance", "clearance"],
    ] as const) {
      const denied = await submitPath(
        "account-a",
        pathRequest(`incompatible-${suffix}`, `train-${suffix}`, 26_820 + suffix.length, formationId),
      );
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ code: "planning_formation_incompatible" });
    }

    const diesel = await submitPath(
      "account-b",
      pathRequest("diesel-compatible", "train-diesel", 26_830, "formation-b"),
    );
    expect(diesel.statusCode).toBe(202);
    expect(diesel.json()).toMatchObject({
      payload: {
        formationId: "formation-b",
        train: {
          name: "formation-b",
          massKg: 120_000,
          lengthMm: 70_000,
          maximumSpeedMmps: 44_444,
          accelerationMmPerS2: 800,
          decelerationMmPerS2: 900,
        },
      },
    });
  });

  it("verwirft manipulierte v2-Stromsysteme bei unveraendertem Fleet-Zustandshash fail-closed", async () => {
    await replaceFleetFixture(
      db,
      ({ state, snapshot }) => ({
        state: {
          ...state,
          authorityRelease: {
            ...state.authorityRelease,
            assets: state.authorityRelease.assets.map((asset) => asset.id === "asset-electric-4"
              ? {
                  ...asset,
                  technical: { ...asset.technical, electricSystems: ["ac15kv" as const] },
                }
              : asset),
          },
        } as NativeFleetWorldState,
        snapshot,
      }),
      { preserveStateHash: true },
    );

    const manipulated = await submitPath(
      "account-a",
      pathRequest("forged-electric-system", "ignored", 1, "formation-electric"),
    );
    expect(manipulated.statusCode).toBe(503);
    expect(manipulated.json()).toMatchObject({ code: "planning_fleet_state_invalid" });
    expect(await db.select().from(simulationCommands)).toEqual([]);
  });

  it("wertet v2-Orientierung und Zugsicherungsrestriktionen nur an der aktiven Spitze aus", async () => {
    const rotatedControlCar = await submitPath(
      "account-a",
      pathRequest("rotated-control-car", "ignored", 1, "formation-control"),
    );
    expect(rotatedControlCar.statusCode).toBe(202);
    expect(rotatedControlCar.json()).toMatchObject({
      payload: {
        formationId: "formation-control",
        train: {
          name: "formation-control",
          massKg: 240_000,
          lengthMm: 140_000,
        },
      },
    });

    const unavailableAtTip = await submitPath(
      "account-a",
      pathRequest("unavailable-protection", "ignored", 1, "formation-protection"),
    );
    expect(unavailableAtTip.statusCode).toBe(409);
    expect(unavailableAtTip.json()).toMatchObject({
      code: "planning_formation_incompatible",
    });
  });

  it("wendet v2-Vmax- und Servicebremsrestriktionen ohne Einheitenverlust an", async () => {
    const accepted = await submitPath(
      "account-a",
      pathRequest("restricted-performance", "ignored", 1, "formation-speed"),
    );
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      payload: {
        train: {
          maximumSpeedMmps: 20_001,
          accelerationMmPerS2: 800,
          decelerationMmPerS2: 650,
        },
      },
    });
  });

  it("laesst AC15-BEMU nur unelektrifiziert oder am passenden Oberleitungssystem fahren", async () => {
    const compatibleBattery = await submitPath(
      "account-a",
      pathRequest("bemu-compatible", "ignored", 1, "formation-bemu-good"),
    );
    expect(compatibleBattery.statusCode).toBe(202);

    const incompatibleBattery = await submitPath(
      "account-a",
      pathRequest("bemu-incompatible", "ignored", 1, "formation-bemu-bad"),
    );
    expect(incompatibleBattery.statusCode).toBe(409);
    expect(incompatibleBattery.json()).toMatchObject({
      code: "planning_formation_incompatible",
    });
  });

  it("behandelt Immobilized und auf null gerasterte v2-Leistung als nicht nutzbaren Antrieb", async () => {
    for (const formationId of [
      "formation-immobilized",
      "formation-zero-power",
      // U+E000 sortiert in UTF-8 vor U+10000, in JavaScript-UTF-16 aber
      // dahinter. Nur die Rust-paritaetische Reihenfolge rastert 3 kW hier
      // nach zwei Restriktionen auf null.
      "formation-utf8-power",
    ]) {
      const denied = await submitPath(
        "account-a",
        pathRequest(`unusable-${formationId}`, "ignored", 1, formationId),
      );
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ code: "planning_formation_incompatible" });
    }
  });

  it("laesst Zukunftsplanung nach aktiver Instandhaltung zu und sperrt jedes ueberlappende Fenster", async () => {
    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state: {
        ...state,
        maintenanceAssignments: {
          "formation-a": {
            formationId: "formation-a",
            facilityId: "workshop:leipzig",
            startsAtS: 0,
            endsAtS: 30_000,
          },
        },
      },
      snapshot: {
        ...snapshot,
        formations: snapshot.formations.map((formation) => formation.id === "formation-a"
          ? { ...formation, availability: "maintenance" as const }
          : formation),
      },
    }));

    const afterMaintenance = await submitPath(
      "account-a",
      {
        ...pathRequest("maintenance-finished", "ignored", 1),
        desiredDepartureS: 40_000,
      },
    );
    expect(afterMaintenance.statusCode).toBe(202);

    const denied = await submitPath(
      "account-a",
      pathRequest("maintenance-active", "ignored", 1),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: "planning_formation_incompatible" });
    expect(await db.select().from(simulationCommands)).toHaveLength(1);
  });

  it("verwirft widerspruechliche Instandhaltungsstatus als manipulierten Fleet-Zustand", async () => {
    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state: {
        ...state,
        maintenanceAssignments: {
          "formation-a": {
            formationId: "formation-a",
            facilityId: "workshop:leipzig",
            startsAtS: 0,
            endsAtS: 30_000,
          },
        },
      },
      snapshot,
    }));
    const activeButAvailable = await submitPath(
      "account-a",
      pathRequest("maintenance-status-forged-available", "ignored", 1),
    );
    expect(activeButAvailable.statusCode).toBe(503);
    expect(activeButAvailable.json()).toMatchObject({ code: "planning_fleet_state_invalid" });

    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state: { ...state, maintenanceAssignments: {} },
      snapshot: {
        ...snapshot,
        formations: snapshot.formations.map((formation) => formation.id === "formation-a"
          ? { ...formation, availability: "maintenance" as const }
          : formation),
      },
    }));
    const maintenanceWithoutCause = await submitPath(
      "account-a",
      pathRequest("maintenance-status-forged-maintenance", "ignored", 1),
    );
    expect(maintenanceWithoutCause.statusCode).toBe(503);
    expect(maintenanceWithoutCause.json()).toMatchObject({ code: "planning_fleet_state_invalid" });
    expect(await db.select().from(simulationCommands)).toEqual([]);
  });

  it("verweigert fehlende und manipulierte v2-Formationsdynamik fail-closed", async () => {
    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state: {
        ...state,
        formations: {
          ...state.formations,
          "formation-a": {
            ...state.formations["formation-a"]!,
            dynamics: undefined,
          },
        },
      },
      snapshot,
    }));
    const missing = await submitPath(
      "account-a",
      pathRequest("formation-dynamics-missing", "ignored", 1),
    );
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ code: "planning_fleet_state_invalid" });

    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state: {
        ...state,
        formations: {
          ...state.formations,
          "formation-a": {
            ...state.formations["formation-a"]!,
            dynamics: { accelerationMmPerS2: 801, decelerationMmPerS2: 900 },
          },
        },
      },
      snapshot,
    }));
    const manipulated = await submitPath(
      "account-a",
      pathRequest("formation-dynamics-manipulated", "ignored", 1),
    );
    expect(manipulated.statusCode).toBe(503);
    expect(manipulated.json()).toMatchObject({ code: "planning_fleet_state_invalid" });
    expect(await db.select().from(simulationCommands)).toEqual([]);
  });

  it("verwirft einen weltfremden oder fehlenden Mobilisierungssnapshot fail-closed", async () => {
    await replaceFleetFixture(db, ({ state, snapshot }) => ({
      state,
      snapshot: { ...snapshot, worldId: worldB },
    }));
    const manipulated = await submitPath(
      "account-a",
      pathRequest("snapshot-world-forged", "ignored", 1),
    );
    expect(manipulated.statusCode).toBe(503);
    expect(manipulated.json()).toMatchObject({ code: "planning_fleet_state_invalid" });

    await db
      .delete(fleetMobilizationSnapshots)
      .where(eq(fleetMobilizationSnapshots.worldId, worldA));
    const missing = await submitPath(
      "account-a",
      pathRequest("snapshot-missing", "ignored", 1),
    );
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ code: "planning_fleet_unavailable" });
    expect(await db.select().from(simulationCommands)).toEqual([]);
  });

  it("behandelt fachliche Antrags-ID-Kollisionen stabil als 409", async () => {
    const body = pathRequest("same-request", "train-a", 26801);
    const first = await submitPath("account-a", body);
    const retry = await submitPath("account-a", body);
    const collision = await submitPath("account-a", { ...body, trainCategory: "supplementary" as const });

    expect(first.statusCode).toBe(202);
    expect(retry.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "planning_train_identity_conflict" });
  });

  it("weist Spieler-Zugnummern ab und vergibt bei parallelen Anträgen atomar eindeutige Nummern", async () => {
    await db.insert(simulationCommands).values({
      worldId: worldA,
      requestingAccountId: accountA.id,
      idempotencyKey: "legacy-path",
      commandType: "planning.path-request",
      payload: { trainNumber: 20_005 },
      submittedAt: new Date(0),
    });
    const manipulated = await app.inject({
      method: "POST",
      url: `/worlds/${worldA}/planning/path-requests`,
      headers: { authorization: "Bearer account-a" },
      payload: { ...pathRequest("client-number", "ignored", 1), trainNumber: 1 },
    });
    expect(manipulated.statusCode).toBe(400);

    const [first, second] = await Promise.all([
      submitPath("account-a", pathRequest("parallel-a", "ignored-a", 1)),
      submitPath("account-b", pathRequest("parallel-b", "ignored-b", 1, "formation-b")),
    ]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstNumber = first.json<{ payload: { trainNumber: number } }>().payload.trainNumber;
    const secondNumber = second.json<{ payload: { trainNumber: number } }>().payload.trainNumber;
    expect(firstNumber).not.toBe(secondNumber);
    expect(firstNumber).toBeGreaterThan(20_005);
    expect(secondNumber).toBeGreaterThan(20_005);
    const retry = await submitPath("account-a", pathRequest("parallel-a", "changed-client-id", 99_999));
    expect(retry.json<{ payload: { trainNumber: number } }>().payload.trainNumber).toBe(firstNumber);
  });

  it("koordiniert nur intern ueber den konfigurierten Authority-Principal", async () => {
    const first = await submitPath(
      "account-a",
      pathRequest("request-a", "train-a", 26801),
    );
    const second = await submitPath(
      "account-b",
      pathRequest("request-b", "train-b", 26802, "formation-b"),
    );
    const body = {
      schemaVersion: PLANNING_COORDINATE_AUTHORITY_SCHEMA,
      runId: "run-1",
      expectedProjectionRevision: null,
      seedWorld: "1",
      seedPeriod: 0,
      infrastructureReleaseId: "lhe-2026",
      requestCommandIds: [
        first.json<{ id: string }>().id,
        second.json<{ id: string }>().id,
      ],
    } as const;
    const url = `/internal/worlds/${worldA}/planning/coordinate`;
    expect((await app.inject({ method: "POST", url, payload: body })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        ...body,
        authorityAccountId: accountA.id,
        stations: [],
        segments: [],
      },
    })).statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      worldId: worldA,
      requestingAccountId: authority.id,
      commandType: "planning.coordinate",
      payload: {
        ...body,
        worldId: worldA,
      },
    });
    expect(accepted.json<{ payload: Record<string, unknown> }>().payload).not.toHaveProperty(
      "authorityAccountId",
    );
    expect(accepted.json<{ payload: Record<string, unknown> }>().payload).not.toHaveProperty(
      "stations",
    );

    const collision = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { ...body, seedWorld: "2" },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "planning_worker_conflict" });
  });

  it("sperrt reservierte Planning-Ereignisse und Kommandos fuer generische Adapter", async () => {
    const first = await submitPath(
      "account-a",
      pathRequest("request-a", "train-a", 26801),
    );
    for (const eventType of [
      "planning.runtime-state",
      "planning.diagram",
      "livemap-operation-marked",
      "livemap-operation-cleared",
      "operating-duty-ended",
      "operating-transition-completed",
      "train-operation-assigned",
    ]) {
      const reservedEvents = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/simulation/events`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: {
          events: [
            {
              sequence: 1,
              eventType,
              payload: {},
              occurredAt: "2026-08-11T00:00:00.000Z",
            },
          ],
        },
      });
      expect(reservedEvents.statusCode).toBe(409);
    expect(reservedEvents.json()).toMatchObject({
        code: "reserved_single_writer_event_type",
      });
    }
    expect(await db.select().from(domainEvents)).toEqual([]);

    const additionalReserved = await db.insert(simulationCommands).values([
      {
        worldId: worldA,
        requestingAccountId: authority.id,
        idempotencyKey: "reserved-coordinate",
        commandType: "planning.coordinate",
        payload: {},
        submittedAt: new Date(0),
      },
      {
        worldId: worldA,
        requestingAccountId: accountA.id,
        idempotencyKey: "reserved-alternative",
        commandType: "planning.apply-alternative",
        payload: {},
        submittedAt: new Date(0),
      },
    ]).returning({ id: simulationCommands.id });
    const [generic] = await db.insert(simulationCommands).values({
      worldId: worldA,
      requestingAccountId: accountA.id,
      idempotencyKey: "generic",
      commandType: "dispatch.backtest",
      payload: {},
      submittedAt: new Date(0),
    }).returning();
    const pending = await app.inject({
      method: "GET",
      url: `/internal/worlds/${worldA}/simulation/commands`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pending.json()).toEqual([expect.objectContaining({ id: generic!.id })]);
    expect(pending.json<readonly { id: string }[]>().some(
      (command) => command.id === first.json<{ id: string }>().id,
    )).toBe(false);

    const reservedCommandIds = [
      first.json<{ id: string }>().id,
      ...additionalReserved.map((command) => command.id),
    ];
    for (const commandId of reservedCommandIds) {
      const reservedResult = await app.inject({
        method: "POST",
        url: `/internal/worlds/${worldA}/simulation/commands/${commandId}/result`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: {
          status: "failed",
          failureCode: "generic_failure",
          processedAt: "2026-08-11T00:00:01.000Z",
        },
      });
      expect(reservedResult.statusCode).toBe(409);
      expect(reservedResult.json()).toMatchObject({
        code: "reserved_planning_command_type",
      });
    }
    expect(
      await db
        .select({ id: simulationCommands.id, status: simulationCommands.status })
        .from(simulationCommands)
        .where(inArray(simulationCommands.id, reservedCommandIds)),
    ).toEqual(expect.arrayContaining(
      reservedCommandIds.map((id) => ({ id, status: "pending" })),
    ));

    const genericResult = await app.inject({
      method: "POST",
      url: `/internal/worlds/${worldA}/simulation/commands/${generic!.id}/result`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        status: "failed",
        failureCode: "done",
        processedAt: "2026-08-11T00:00:01.000Z",
      },
    });
    expect(genericResult.statusCode).toBe(200);
  });
});
