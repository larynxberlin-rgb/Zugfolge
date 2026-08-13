import { PGlite } from "@electric-sql/pglite";
import { alphaWorldProfiles, domainEvents, MIGRATIONS_FOLDER, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { decodeEconomyValue, encodeEconomyValue } from "@zugfolge/economy";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALPHA_WORLD_BLUEPRINT_SCHEMA,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  AlphaWorldService,
  effectiveStartingCapitalPolicy,
  type AlphaWorldBlueprint,
  type AlphaWorldBlueprintV1,
  type AlphaWorldBlueprintV2,
  type WorldStartPort,
  validateWorldBlueprint,
} from "./world.js";
import { AlphaConflictError, AlphaValidationError } from "./errors.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000014";

function blueprint(): AlphaWorldBlueprintV2 {
  return {
    schemaVersion: ALPHA_WORLD_BLUEPRINT_SCHEMA,
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 42n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 6,
    startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    entryFacilityPolicy: {
      schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
      mode: "award-contingent-wet-lease",
      providerOperatorId: "public",
      costBasis: "formation-operating-cost",
    },
    releases: {
      infra: "a".repeat(64),
      timetable: "b".repeat(64),
      fleet: "c".repeat(64),
      economy: "d".repeat(64),
    },
    lots: [{
      lotId: "lot-1",
      contractEndsAtPeriod: 2,
      trainRunIds: ["train-1"],
      pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"],
      personnelDutyIds: ["duty-1"],
      circulationIds: ["circulation-1"],
      operatingProgramIds: ["program-1"],
    }],
    conflictCheckHash: "e".repeat(64),
    tenderCalendarHash: "f".repeat(64),
  };
}

function readyPort(): WorldStartPort {
  return {
    initializeEconomy: async () => {},
    initializeFleet: async () => {},
    initializeRegionalSimulation: async () => {},
    verify: async () => ({
      economyReady: true,
      fleetReady: true,
      regionalSimulationReady: true,
      livemapReady: true,
      operationsCenterReady: true,
      odooProjectionQueued: true,
      lotIds: ["lot-1"],
      runningTrainRunIds: ["train-1"],
    }),
  };
}

describe("AlphaWorldService", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({
      id: WORLD_ID,
      name: "Alpha",
      schedulePeriodWeeks: 4,
      epoch: new Date(0),
      worldKind: "public",
      rankingStatus: "ranked",
      lifecycleStatus: "active",
    });
  });

  afterEach(async () => client.close());

  it("persistiert den BigInt-Seed JSONB-sicher und startet idempotent", async () => {
    const firstPort = readyPort();
    const service = new AlphaWorldService(db, firstPort);
    const expected = blueprint();
    const deploymentHash = "9".repeat(64);

    const first = await service.start(WORLD_ID, expected, 0, deploymentHash);
    // Eine neue Serviceinstanz bildet den Prozessneustart auf demselben
    // persistierten Profil ab.
    const restartPort = readyPort();
    restartPort.verifyDurable = vi.fn(async () => undefined);
    restartPort.initializeEconomy = vi.fn(restartPort.initializeEconomy);
    restartPort.initializeFleet = vi.fn(restartPort.initializeFleet);
    restartPort.initializeRegionalSimulation = vi.fn(restartPort.initializeRegionalSimulation);
    restartPort.verify = vi.fn(restartPort.verify);
    const second = await new AlphaWorldService(db, restartPort).start(WORLD_ID, expected, 0, deploymentHash);
    const [stored] = await db.select().from(alphaWorldProfiles);

    expect(first.state).toBe("running");
    expect(second.blueprintHash).toBe(first.blueprintHash);
    expect(stored).toBeDefined();
    expect(stored?.deploymentHash).toBe(deploymentHash);
    expect(stored?.blueprint).toMatchObject({
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    });
    expect(decodeEconomyValue(stored?.blueprint)).toEqual(expected);
    expect(() => JSON.stringify(stored?.blueprint)).not.toThrow();
    const [event] = await db.select().from(domainEvents);
    expect(event?.payload).toMatchObject({
      blueprintHash: first.blueprintHash,
      deploymentHash,
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    });
    expect(restartPort.verifyDurable).toHaveBeenCalledOnce();
    expect(restartPort.initializeEconomy).toHaveBeenCalledOnce();
    expect(restartPort.initializeFleet).toHaveBeenCalledOnce();
    expect(restartPort.initializeRegionalSimulation).toHaveBeenCalledOnce();
    expect(restartPort.verify).toHaveBeenCalledOnce();
  });

  it("bricht den Restart vor jeder Rehydration ab, wenn eine dauerhafte Teilprojektion fehlt", async () => {
    const expected = blueprint();
    const deploymentHash = "8".repeat(64);
    await new AlphaWorldService(db, readyPort()).start(WORLD_ID, expected, 0, deploymentHash);
    const initializeEconomy = vi.fn(async () => undefined);
    const port: WorldStartPort = {
      verifyDurable: vi.fn(async () => { throw new Error("dauerhafte Fleet-Projektion fehlt"); }),
      initializeEconomy,
      initializeFleet: async () => undefined,
      initializeRegionalSimulation: async () => undefined,
      verify: readyPort().verify,
    };

    await expect(new AlphaWorldService(db, port).start(WORLD_ID, expected, 0, deploymentHash))
      .rejects.toThrow(/Fleet-Projektion fehlt/);
    expect(initializeEconomy).not.toHaveBeenCalled();
  });

  it("bindet endliches, Null- und unbegrenztes Startkapital jeweils an einen anderen Hash", () => {
    const zero = blueprint();
    const finite = { ...blueprint(), startingCapitalPolicy: { mode: "finite", amountCents: "1000000" } as const };
    const unlimited = { ...blueprint(), startingCapitalPolicy: { mode: "unlimited" } as const };

    expect(validateWorldBlueprint(zero)).not.toBe(validateWorldBlueprint(finite));
    expect(validateWorldBlueprint(finite)).not.toBe(validateWorldBlueprint(unlimited));
    expect(validateWorldBlueprint(unlimited)).not.toBe(validateWorldBlueprint(zero));
  });

  it("haelt persistierte v1-Vertraege und neue v2-Vertraege in getrennten Hash-Namensraeumen", () => {
    const current = blueprint();
    const legacy: AlphaWorldBlueprintV1 = {
      schemaVersion: "zugfolge-alpha-world-blueprint/v1",
      regionId: current.regionId,
      regionVariant: current.regionVariant,
      seed: current.seed,
      profileKind: current.profileKind,
      accelerationFactor: current.accelerationFactor,
      periodCount: current.periodCount,
      startingCapitalPolicy: { kind: "finite", amountCents: "0" },
      releases: current.releases,
      lots: current.lots,
      conflictCheckHash: current.conflictCheckHash,
      tenderCalendarHash: current.tenderCalendarHash,
    };

    expect(validateWorldBlueprint(legacy)).not.toBe(validateWorldBlueprint(current));
    expect(effectiveStartingCapitalPolicy(legacy)).toEqual({ mode: "finite", amountCents: 0n });
    expect(effectiveStartingCapitalPolicy(current)).toEqual({ mode: "finite", amountCents: 0n });
  });

  it("weist nichtkanonisches Startkapital im signierten Weltentwurf zurueck", () => {
    const invalid = {
      ...blueprint(),
      startingCapitalPolicy: { mode: "finite", amountCents: "-1" },
    } as AlphaWorldBlueprint;

    expect(() => validateWorldBlueprint(invalid)).toThrow(AlphaValidationError);
  });

  it("weist ein unbeschleunigtes oder nicht privat-unranked gebundenes Tutorial vor dem Start zurueck", async () => {
    const realtimeTutorial = {
      ...blueprint(),
      profileKind: "tutorial",
      accelerationFactor: 1,
      entryFacilityPolicy: {
        schemaVersion: PUBLIC_ENTRY_FACILITY_SCHEMA,
        mode: "disabled",
      },
    } as const satisfies AlphaWorldBlueprint;
    expect(() => validateWorldBlueprint(realtimeTutorial)).toThrow(/beschleunigt/);

    const acceleratedTutorial = { ...realtimeTutorial, accelerationFactor: 60 } as const satisfies AlphaWorldBlueprint;
    expect(() => validateWorldBlueprint(acceleratedTutorial)).not.toThrow();
    await expect(new AlphaWorldService(db, readyPort()).start(WORLD_ID, acceleratedTutorial, 0))
      .rejects.toThrow(/private, ungewertete Welt/);
  });

  it("laesst die gebundene Startkapital-Policy nach dem Start nicht austauschen", async () => {
    const service = new AlphaWorldService(db, readyPort());
    await service.start(WORLD_ID, blueprint(), 0);

    await expect(service.start(WORLD_ID, {
      ...blueprint(),
      startingCapitalPolicy: { mode: "unlimited" } as const,
    }, 0)).rejects.toBeInstanceOf(AlphaConflictError);
  });

  it("laesst den Ed25519-geprueften Deployment-Hash nach dem Start nicht austauschen", async () => {
    const service = new AlphaWorldService(db, readyPort());
    await service.start(WORLD_ID, blueprint(), 0, "1".repeat(64));

    await expect(service.start(WORLD_ID, blueprint(), 0, "2".repeat(64))).rejects.toMatchObject({
      code: "world_deployment_conflict",
    });
  });

  it("verifiziert ein laufendes Altprofil vollstaendig, bevor es den Deployment-Hash bindet", async () => {
    const expected = blueprint();
    const deploymentHash = "7".repeat(64);
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID,
      profileKind: expected.profileKind,
      regionId: expected.regionId,
      regionVariant: expected.regionVariant,
      worldSeed: expected.seed,
      accelerationFactor: expected.accelerationFactor,
      infraReleaseHash: expected.releases.infra,
      timetableReleaseHash: expected.releases.timetable,
      fleetReleaseHash: expected.releases.fleet,
      economyReleaseHash: expected.releases.economy,
      blueprint: encodeEconomyValue(expected),
      blueprintHash: validateWorldBlueprint(expected),
      deploymentHash: null,
      periodCount: expected.periodCount,
      state: "running",
      startedAtS: 0,
    });
    const initializeEconomy = vi.fn(async () => undefined);
    const initializeFleet = vi.fn(async () => undefined);
    const initializeRegionalSimulation = vi.fn(async () => undefined);
    const verify = vi.fn(async () => ({
      economyReady: false,
      fleetReady: true,
      regionalSimulationReady: true,
      livemapReady: true,
      operationsCenterReady: true,
      odooProjectionQueued: true,
      lotIds: ["lot-1"],
      runningTrainRunIds: ["train-1"],
    }));
    const service = new AlphaWorldService(db, { initializeEconomy, initializeFleet, initializeRegionalSimulation, verify });

    await expect(service.start(WORLD_ID, expected, 0, deploymentHash)).rejects.toMatchObject({
      code: "world_start_projection_incomplete",
    });
    expect((await db.select().from(alphaWorldProfiles))[0]?.deploymentHash).toBeNull();

    verify.mockResolvedValue({
      economyReady: true,
      fleetReady: true,
      regionalSimulationReady: true,
      livemapReady: true,
      operationsCenterReady: true,
      odooProjectionQueued: true,
      lotIds: ["lot-1"],
      runningTrainRunIds: ["train-1"],
    });
    const bound = await service.start(WORLD_ID, expected, 0, deploymentHash);

    expect(initializeEconomy).toHaveBeenCalledTimes(2);
    expect(initializeFleet).toHaveBeenCalledTimes(2);
    expect(initializeRegionalSimulation).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(bound.deploymentHash).toBe(deploymentHash);
    expect(await db.select().from(domainEvents)).toEqual([
      expect.objectContaining({
        eventType: "alpha.world-deployment-bound",
        payload: expect.objectContaining({ deploymentHash }),
      }),
    ]);
  });
});
