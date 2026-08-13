import {
  alphaWorldProfiles,
  domainEvents,
  worlds,
  type AlphaWorldProfile,
} from "@zugfolge/db";
import { encodeEconomyValue } from "@zugfolge/economy";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { AlphaConflictError, AlphaValidationError } from "./errors.js";
import { alphaHash } from "./hash.js";

export type AlphaDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;
export type AlphaWorldKind = "public" | "tutorial" | "private" | "test";

export interface WorldLotBlueprint {
  readonly lotId: string;
  readonly contractEndsAtPeriod: number;
  readonly trainRunIds: readonly string[];
  readonly pathReceiptIds: readonly string[];
  readonly vehicleIds: readonly string[];
  readonly personnelDutyIds: readonly string[];
  readonly circulationIds: readonly string[];
  readonly operatingProgramIds: readonly string[];
}

export interface AlphaWorldBlueprint {
  readonly schemaVersion: "zugfolge-alpha-world-blueprint/v1";
  readonly regionId: string;
  readonly regionVariant: "B";
  readonly seed: bigint;
  readonly profileKind: AlphaWorldKind;
  readonly accelerationFactor: number;
  readonly periodCount: number | null;
  readonly startingCapitalPolicy: {
    readonly kind: "finite";
    readonly amountCents: string;
  } | {
    readonly kind: "unlimited";
  };
  readonly releases: {
    readonly infra: string;
    readonly timetable: string;
    readonly fleet: string;
    readonly economy: string;
  };
  readonly lots: readonly WorldLotBlueprint[];
  readonly conflictCheckHash: string;
  readonly tenderCalendarHash: string;
}

export interface WorldStartVerification {
  readonly economyReady: boolean;
  readonly fleetReady: boolean;
  readonly regionalSimulationReady: boolean;
  readonly livemapReady: boolean;
  readonly operationsCenterReady: boolean;
  readonly odooProjectionQueued: boolean;
  readonly lotIds: readonly string[];
  readonly runningTrainRunIds: readonly string[];
}

export interface WorldStartPort {
  initializeEconomy(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void>;
  initializeFleet(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void>;
  initializeRegionalSimulation(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void>;
  verify(worldId: string, blueprint: AlphaWorldBlueprint): Promise<WorldStartVerification>;
}

function sha(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new AlphaValidationError(`${name} ist kein SHA-256.`);
}

function identifiers(values: readonly string[], name: string): void {
  if (values.length === 0 || values.length > 100_000 || values.some((value) => value.trim() === "")) {
    throw new AlphaValidationError(`${name} ist leer oder ungueltig.`);
  }
  if (new Set(values).size !== values.length) throw new AlphaValidationError(`${name} enthaelt Duplikate.`);
}

export function validateWorldBlueprint(blueprint: AlphaWorldBlueprint): string {
  if (blueprint.schemaVersion !== "zugfolge-alpha-world-blueprint/v1") throw new AlphaValidationError("Unbekanntes Weltentwurf-Schema.");
  if (blueprint.regionId !== "mitteldeutschland-b" || blueprint.regionVariant !== "B") {
    throw new AlphaValidationError("Alpha-Welt liegt nicht in der freigegebenen Variante B.");
  }
  if (blueprint.profileKind === "public" && blueprint.accelerationFactor !== 1) {
    throw new AlphaValidationError("Beschleunigte Zeit ist in oeffentlichen Welten verboten.");
  }
  if (!["tutorial", "private", "test"].includes(blueprint.profileKind) && blueprint.accelerationFactor !== 1) {
    throw new AlphaValidationError("Beschleunigung ist nur in Tutorial-, privaten oder markierten Testwelten erlaubt.");
  }
  if (!Number.isSafeInteger(blueprint.accelerationFactor) || blueprint.accelerationFactor < 1 || blueprint.accelerationFactor > 3_600) {
    throw new AlphaValidationError("Beschleunigungsfaktor liegt ausserhalb 1..3600.");
  }
  if (blueprint.periodCount !== null && (!Number.isSafeInteger(blueprint.periodCount) || blueprint.periodCount < 1)) {
    throw new AlphaValidationError("Befristete Welt braucht mindestens eine Fahrplanperiode.");
  }
  if (blueprint.startingCapitalPolicy.kind === "finite") {
    if (!/^[0-9]+$/.test(blueprint.startingCapitalPolicy.amountCents)
      || BigInt(blueprint.startingCapitalPolicy.amountCents) > 9_223_372_036_854_775_807n) {
      throw new AlphaValidationError("StartingCapitalPolicy besitzt keinen endlichen Integer-Centbetrag.");
    }
  } else if (blueprint.startingCapitalPolicy.kind !== "unlimited") {
    throw new AlphaValidationError("StartingCapitalPolicy ist unbekannt.");
  }
  for (const [name, value] of Object.entries(blueprint.releases)) sha(value, `${name}-Release`);
  sha(blueprint.conflictCheckHash, "Konfliktpruefung");
  sha(blueprint.tenderCalendarHash, "Vergabekalender");
  if (blueprint.lots.length === 0) throw new AlphaValidationError("Weltentwurf besitzt kein SPNV-Los.");
  identifiers(blueprint.lots.map((lot) => lot.lotId), "Lose");
  for (const lot of blueprint.lots) {
    if (!Number.isSafeInteger(lot.contractEndsAtPeriod) || lot.contractEndsAtPeriod < 1) {
      throw new AlphaValidationError(`Los '${lot.lotId}' besitzt kein gestaffeltes Vertragsende.`);
    }
    identifiers(lot.trainRunIds, `${lot.lotId}: Zugfahrten`);
    identifiers(lot.pathReceiptIds, `${lot.lotId}: Trassen`);
    identifiers(lot.vehicleIds, `${lot.lotId}: Fahrzeuge`);
    identifiers(lot.personnelDutyIds, `${lot.lotId}: Personal`);
    identifiers(lot.circulationIds, `${lot.lotId}: Umlaeufe`);
    identifiers(lot.operatingProgramIds, `${lot.lotId}: Betriebsprogramme`);
  }
  const contractEnds = new Set(blueprint.lots.map((lot) => lot.contractEndsAtPeriod));
  if (blueprint.lots.length > 1 && contractEnds.size < 2) throw new AlphaValidationError("Vertragsenden sind nicht gestaffelt.");
  return alphaHash("zugfolge-alpha-world-blueprint/v1", blueprint);
}

function exactLots(blueprint: AlphaWorldBlueprint): readonly string[] {
  return [...blueprint.lots.map((lot) => lot.lotId)].sort();
}

function exactTrainRuns(blueprint: AlphaWorldBlueprint): readonly string[] {
  return [...blueprint.lots.flatMap((lot) => lot.trainRunIds)].sort();
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

async function appendWorldEvent(db: AlphaDatabase, worldId: string, eventType: string, payload: Record<string, unknown>, occurredAt: Date) {
  await db.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
  const [head] = await db.select({ sequence: domainEvents.sequence }).from(domainEvents)
    .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
  await db.insert(domainEvents).values({ worldId, sequence: (head?.sequence ?? 0) + 1, eventType, payload, occurredAt });
}

export class AlphaWorldService {
  constructor(private readonly db: AlphaDatabase, private readonly port: WorldStartPort) {}

  async start(worldId: string, blueprint: AlphaWorldBlueprint, atS: number): Promise<AlphaWorldProfile> {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Weltstartzeit ist ungueltig.");
    const blueprintHash = validateWorldBlueprint(blueprint);
    const [world] = await this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new AlphaValidationError("Welt existiert nicht.");
    if (blueprint.profileKind === "public" && (world.worldKind !== "public" || world.rankingStatus !== "ranked")) {
      throw new AlphaValidationError("Oeffentlicher Alpha-Weltentwurf passt nicht zum Weltprofil.");
    }
    if (blueprint.profileKind !== "public" && world.worldKind === "public") {
      throw new AlphaValidationError("Tutorial-, Privat- und Testprofil darf keine oeffentliche Welt markieren.");
    }

    let [profile] = await this.db.insert(alphaWorldProfiles).values({
      worldId,
      profileKind: blueprint.profileKind,
      regionId: blueprint.regionId,
      regionVariant: blueprint.regionVariant,
      worldSeed: blueprint.seed,
      accelerationFactor: blueprint.accelerationFactor,
      infraReleaseHash: blueprint.releases.infra,
      timetableReleaseHash: blueprint.releases.timetable,
      fleetReleaseHash: blueprint.releases.fleet,
      economyReleaseHash: blueprint.releases.economy,
      blueprint: encodeEconomyValue(blueprint),
      blueprintHash,
      periodCount: blueprint.periodCount,
      state: "draft",
    }).onConflictDoNothing().returning();
    if (profile === undefined) {
      [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
      if (profile === undefined) throw new Error("Weltprofil konnte nicht gelesen werden.");
      if (profile.blueprintHash !== blueprintHash) throw new AlphaConflictError("Welt wurde bereits mit einem anderen Entwurf gebunden.", "world_blueprint_conflict");
      if (profile.state === "running") return profile;
      if (profile.state !== "draft") throw new AlphaConflictError("Welt kann in diesem Zustand nicht gestartet werden.");
    }

    await this.port.initializeEconomy(worldId, blueprint);
    await this.port.initializeFleet(worldId, blueprint);
    await this.port.initializeRegionalSimulation(worldId, blueprint);
    const verified = await this.port.verify(worldId, blueprint);
    if (!verified.economyReady || !verified.fleetReady || !verified.regionalSimulationReady || !verified.livemapReady || !verified.operationsCenterReady || !verified.odooProjectionQueued) {
      throw new AlphaConflictError("Weltstart ist nicht in allen produktiven Projektionen sichtbar.", "world_start_projection_incomplete");
    }
    if (!sameSet(verified.lotIds, exactLots(blueprint)) || !sameSet(verified.runningTrainRunIds, exactTrainRuns(blueprint))) {
      throw new AlphaConflictError("Eigenbetrieb deckt Lose oder Zugfahrten nicht vollstaendig ab.", "public_operation_incomplete");
    }
    const occurredAt = new Date(world.epoch.getTime() + atS * 1_000);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(alphaWorldProfiles).set({ state: "running", startedAtS: atS })
        .where(and(eq(alphaWorldProfiles.worldId, worldId), eq(alphaWorldProfiles.state, "draft"))).returning();
      if (updated === undefined) throw new AlphaConflictError("Weltstart verlor ein Parallelrennen.", "world_start_race");
      await appendWorldEvent(tx, worldId, "alpha.world-started-with-public-operation", {
        blueprintHash,
        regionId: blueprint.regionId,
        lotCount: blueprint.lots.length,
        trainRunCount: exactTrainRuns(blueprint).length,
        releasePins: blueprint.releases,
      }, occurredAt);
      return updated;
    });
  }

  async assertTenderAllowed(worldId: string): Promise<void> {
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile === undefined) return;
    if (profile.state !== "running") throw new AlphaConflictError("Neue Ausschreibungen sind ausserhalb der laufenden Welt gesperrt.", "tenders_closed");
    if (profile.periodCount !== null && profile.currentPeriod >= profile.periodCount - 1) {
      throw new AlphaConflictError("In der letzten Fahrplanperiode beginnen keine neuen Ausschreibungen.", "final_period_no_tenders");
    }
  }
}
