import {
  alphaWorldProfiles,
  domainEvents,
  worlds,
  type AlphaWorldProfile,
} from "@zugfolge/db";
import {
  encodeEconomyValue,
  parseStartingCapitalPolicy,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  type PublicEntryFacilityPolicy,
  type SerializedStartingCapitalPolicy,
  type StartingCapitalPolicy,
} from "@zugfolge/economy";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { AlphaConflictError, AlphaValidationError } from "./errors.js";
import { validateActivityPolicy, type ActivityPolicyV1, type WorldActivityPolicy } from "./activity-policy.js";
import { alphaHash } from "./hash.js";

export type AlphaDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;
export type AlphaWorldKind = "public" | "tutorial" | "private" | "test";
export const ALPHA_WORLD_BLUEPRINT_SCHEMA = "zugfolge-alpha-world-blueprint/v2" as const;
export { PUBLIC_ENTRY_FACILITY_SCHEMA, type PublicEntryFacilityPolicy } from "@zugfolge/economy";

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

interface AlphaWorldBlueprintBase {
  readonly regionId: string;
  readonly regionVariant: "B";
  readonly seed: bigint;
  readonly profileKind: AlphaWorldKind;
  readonly accelerationFactor: number;
  readonly periodCount: number | null;
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

/**
 * Bereits persistierte v1-Welten bleiben unter ihrem urspruenglichen
 * Schema-Namespace lesbar. Ihr Hash wird niemals als v2 neu interpretiert.
 */
export interface AlphaWorldBlueprintV1 extends AlphaWorldBlueprintBase {
  readonly schemaVersion: "zugfolge-alpha-world-blueprint/v1";
  readonly startingCapitalPolicy: {
    readonly kind: "finite";
    readonly amountCents: string;
  } | {
    readonly kind: "unlimited";
  };
  readonly entryFacilityPolicy?: never;
  readonly activityPolicy?: never;
  readonly admission?: never;
  readonly publicMetadata?: never;
}

/** Neue, extern signierte Weltvertraege verwenden ausschliesslich v2. */
export interface AlphaWorldBlueprintV2 extends AlphaWorldBlueprintBase {
  readonly schemaVersion: typeof ALPHA_WORLD_BLUEPRINT_SCHEMA;
  /** Signierte JSON-Darstellung; der endliche Betrag bleibt ein Dezimalstring. */
  readonly startingCapitalPolicy: SerializedStartingCapitalPolicy;
  /** Signierte Anschubregel; sie vergibt beim Beitritt keinerlei Ressource. */
  readonly entryFacilityPolicy: PublicEntryFacilityPolicy;
  /** `null` bedeutet: fachliche Grenzwerte noch nicht freigegeben; keine Kennzahl behaupten. */
  readonly activityPolicy?: WorldActivityPolicy;
  readonly admission?: {
    readonly capacity: number;
    readonly status: "planned" | "open" | "waitlist" | "closed";
  };
  readonly publicMetadata?: {
    readonly description: string;
    readonly phase: "planned" | "registration_open" | "active" | "ended" | "archived";
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly regionLabel: string;
    readonly ruleRelease: string;
    readonly banner: {
      readonly altText: string;
      readonly source: string;
      readonly author: string;
      readonly license: string;
      readonly attribution: string | null;
      readonly focalPointXPermille: number;
      readonly focalPointYPermille: number;
      readonly rightsApproved: boolean;
    };
  };
}

export type AlphaWorldBlueprint = AlphaWorldBlueprintV1 | AlphaWorldBlueprintV2;

export function effectiveStartingCapitalPolicy(blueprint: AlphaWorldBlueprint): StartingCapitalPolicy {
  if (blueprint.schemaVersion === "zugfolge-alpha-world-blueprint/v1") {
    if (blueprint.entryFacilityPolicy !== undefined || blueprint.activityPolicy !== undefined
      || blueprint.admission !== undefined || blueprint.publicMetadata !== undefined) {
      throw new AlphaValidationError("v1-Weltentwurf darf keine v2-Vertragsfelder enthalten.");
    }
    return blueprint.startingCapitalPolicy.kind === "unlimited"
      ? { mode: "unlimited" }
      : { mode: "finite", amountCents: BigInt(blueprint.startingCapitalPolicy.amountCents) };
  }
  return parseStartingCapitalPolicy(blueprint.startingCapitalPolicy);
}

export function effectiveActivityPolicy(blueprint: AlphaWorldBlueprint): ActivityPolicyV1 | null {
  if (blueprint.activityPolicy === undefined || blueprint.activityPolicy === null) return null;
  return validateActivityPolicy(blueprint.activityPolicy);
}

export interface WorldStartVerification {
  readonly economyReady: boolean;
  readonly fleetReady: boolean;
  readonly regionalSimulationReady: boolean;
  /** Das signierte Betriebsprogramm ist im autoritativen Scheduler registriert. */
  readonly operationalProgramReady: boolean;
  readonly livemapReady: boolean;
  readonly operationsCenterReady: boolean;
  readonly odooProjectionQueued: boolean;
  readonly lotIds: readonly string[];
  /** Signierte Basisfahrten des registrierten Schedulerprogramms. */
  readonly scheduledTrainRunIds: readonly string[];
  /** Im Livemap-Snapshot tatsaechlich sichtbare Basisfahrten; darf beim Start leer sein. */
  readonly runningTrainRunIds: readonly string[];
}

export interface WorldStartPort {
  /**
   * Restart-Preflight fuer bereits laufende, deployment-gebundene Welten.
   * Dauerhafte Teilprojektionen muessen vorhanden sein, bevor die Port-
   * Initialisierung ausschliesslich prozesslokale Projektionen rekonstruiert.
   */
  verifyDurable?(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void>;
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
  if (blueprint.schemaVersion !== "zugfolge-alpha-world-blueprint/v1"
    && blueprint.schemaVersion !== ALPHA_WORLD_BLUEPRINT_SCHEMA) {
    throw new AlphaValidationError("Unbekanntes Weltentwurf-Schema.");
  }
  if (blueprint.regionId !== "mitteldeutschland-b" || blueprint.regionVariant !== "B") {
    throw new AlphaValidationError("Alpha-Welt liegt nicht in der freigegebenen Variante B.");
  }
  if (blueprint.profileKind === "public" && blueprint.accelerationFactor !== 1) {
    throw new AlphaValidationError("Beschleunigte Zeit ist in oeffentlichen Welten verboten.");
  }
  if (blueprint.profileKind === "tutorial" && blueprint.accelerationFactor <= 1) {
    throw new AlphaValidationError("Tutorial-Welten muessen gegenueber Echtzeit beschleunigt sein.");
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
  if (blueprint.schemaVersion === "zugfolge-alpha-world-blueprint/v1") {
    if (blueprint.startingCapitalPolicy.kind === "finite") {
      if (!/^[0-9]+$/.test(blueprint.startingCapitalPolicy.amountCents)
        || BigInt(blueprint.startingCapitalPolicy.amountCents) > 9_223_372_036_854_775_807n) {
        throw new AlphaValidationError("StartingCapitalPolicy besitzt keinen endlichen Integer-Centbetrag.");
      }
    } else if (blueprint.startingCapitalPolicy.kind !== "unlimited") {
      throw new AlphaValidationError("StartingCapitalPolicy ist unbekannt.");
    }
  } else {
    try {
      parseStartingCapitalPolicy(blueprint.startingCapitalPolicy);
    } catch {
      throw new AlphaValidationError("Startkapital-Policy ist ungueltig.");
    }
    if (blueprint.entryFacilityPolicy === undefined
      || blueprint.entryFacilityPolicy.schemaVersion !== PUBLIC_ENTRY_FACILITY_SCHEMA) {
      throw new AlphaValidationError("Unbekannte Anschubregel.");
    }
    if (blueprint.profileKind === "public") {
      if (
        blueprint.entryFacilityPolicy.mode !== "award-contingent-wet-lease"
        || blueprint.entryFacilityPolicy.providerOperatorId !== "public"
        || blueprint.entryFacilityPolicy.costBasis !== "formation-operating-cost"
      ) {
        throw new AlphaValidationError("Oeffentliche Welt braucht den transparenten zuschlagsgebundenen Nullstartpfad.");
      }
    } else if (blueprint.entryFacilityPolicy.mode !== "disabled") {
      throw new AlphaValidationError("Die oeffentliche Anschubregel ist ausserhalb oeffentlicher Welten deaktiviert.");
    }
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
  const hasPublicCatalogContract = blueprint.schemaVersion === ALPHA_WORLD_BLUEPRINT_SCHEMA
    && (blueprint.admission !== undefined || blueprint.publicMetadata !== undefined || blueprint.activityPolicy !== undefined);
  if (hasPublicCatalogContract) {
    if (blueprint.activityPolicy !== null) {
      if (blueprint.activityPolicy === undefined) throw new AlphaValidationError("Oeffentlicher Weltvertrag braucht eine explizite ActivityPolicy oder null.");
      try { validateActivityPolicy(blueprint.activityPolicy); } catch (error) {
        throw new AlphaValidationError(error instanceof Error ? error.message : "ActivityPolicy ist ungueltig.");
      }
    }
    if (blueprint.admission === undefined || !Number.isSafeInteger(blueprint.admission.capacity) || blueprint.admission.capacity < 1
      || !["planned", "open", "waitlist", "closed"].includes(blueprint.admission.status)) {
      throw new AlphaValidationError("Oeffentlicher Weltvertrag braucht Kapazitaet und Aufnahmestatus.");
    }
    const metadata = blueprint.publicMetadata;
    if (metadata === undefined || metadata.description.trim() === "" || metadata.regionLabel.trim() === "" || metadata.ruleRelease.trim() === ""
      || Number.isNaN(new Date(metadata.startsAt).getTime()) || (metadata.endsAt !== null && Number.isNaN(new Date(metadata.endsAt).getTime()))) {
      throw new AlphaValidationError("Oeffentlicher Weltvertrag braucht gueltige oeffentliche Metadaten.");
    }
    const banner = metadata.banner;
    if (banner.altText.trim() === "" || banner.source.trim() === "" || banner.author.trim() === "" || banner.license.trim() === ""
      || !Number.isSafeInteger(banner.focalPointXPermille) || !Number.isSafeInteger(banner.focalPointYPermille)
      || banner.focalPointXPermille < 0 || banner.focalPointXPermille > 1_000
      || banner.focalPointYPermille < 0 || banner.focalPointYPermille > 1_000
      || banner.rightsApproved !== true) {
      throw new AlphaValidationError("Banner-Metadaten sind unvollstaendig oder der Brennpunkt ist ungueltig.");
    }
  }
  return alphaHash(blueprint.schemaVersion, blueprint);
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

  async start(worldId: string, blueprint: AlphaWorldBlueprint, atS: number, deploymentHash?: string): Promise<AlphaWorldProfile> {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new AlphaValidationError("Weltstartzeit ist ungueltig.");
    if (deploymentHash !== undefined) sha(deploymentHash, "Deployment");
    const blueprintHash = validateWorldBlueprint(blueprint);
    const [world] = await this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new AlphaValidationError("Welt existiert nicht.");
    if (blueprint.profileKind === "public" && (world.worldKind !== "public" || world.rankingStatus !== "ranked")) {
      throw new AlphaValidationError("Oeffentlicher Alpha-Weltentwurf passt nicht zum Weltprofil.");
    }
    if (blueprint.profileKind === "tutorial" && (world.worldKind !== "private" || world.rankingStatus !== "unranked")) {
      throw new AlphaValidationError("Tutorial-Weltentwurf braucht eine private, ungewertete Welt.");
    }
    if (blueprint.profileKind !== "public" && world.worldKind === "public") {
      throw new AlphaValidationError("Tutorial-, Privat- und Testprofil darf keine oeffentliche Welt markieren.");
    }

    let verifyRunningDeploymentBinding = false;
    let rehydrateRunningDeployment = false;
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
      deploymentHash,
      periodCount: blueprint.periodCount,
      state: "draft",
    }).onConflictDoNothing().returning();
    if (profile === undefined) {
      [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
      if (profile === undefined) throw new Error("Weltprofil konnte nicht gelesen werden.");
      if (profile.blueprintHash !== blueprintHash) throw new AlphaConflictError("Welt wurde bereits mit einem anderen Entwurf gebunden.", "world_blueprint_conflict");
      if (deploymentHash !== undefined && profile.deploymentHash !== null && profile.deploymentHash !== deploymentHash) {
        throw new AlphaConflictError("Welt wurde bereits mit einem anderen signierten Deployment gebunden.", "world_deployment_conflict");
      }
      if (profile.state === "running") {
        if (deploymentHash === undefined) return profile;
        if (profile.deploymentHash === deploymentHash) rehydrateRunningDeployment = true;
        // Laufende Altprofile ohne Deployment-Hash duerfen erst nach einer
        // vollstaendigen, erfolgreichen Re-Verifikation an das signierte
        // Deployment gebunden werden. So wird kein ungepruefter Hash durch
        // einen blossen Retry dauerhaft autoritativ.
        else verifyRunningDeploymentBinding = true;
      } else if (deploymentHash !== undefined && profile.deploymentHash === null) {
        const [bound] = await this.db.update(alphaWorldProfiles).set({ deploymentHash }).where(and(
          eq(alphaWorldProfiles.worldId, worldId),
          isNull(alphaWorldProfiles.deploymentHash),
        )).returning();
        if (bound !== undefined) profile = bound;
        else {
          [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
          if (profile?.deploymentHash !== deploymentHash) {
            throw new AlphaConflictError("Welt verlor die Deployment-Bindung an einen parallelen Start.", "world_deployment_conflict");
          }
        }
      }
      if (!verifyRunningDeploymentBinding && !rehydrateRunningDeployment && profile.state !== "draft") throw new AlphaConflictError("Welt kann in diesem Zustand nicht gestartet werden.");
    }

    if (rehydrateRunningDeployment) await this.port.verifyDurable?.(worldId, blueprint);
    await this.port.initializeEconomy(worldId, blueprint);
    await this.port.initializeFleet(worldId, blueprint);
    await this.port.initializeRegionalSimulation(worldId, blueprint);
    const verified = await this.port.verify(worldId, blueprint);
    if (!verified.economyReady || !verified.fleetReady || !verified.regionalSimulationReady || !verified.operationalProgramReady || !verified.livemapReady || !verified.operationsCenterReady || !verified.odooProjectionQueued) {
      throw new AlphaConflictError("Weltstart ist nicht in allen produktiven Projektionen sichtbar.", "world_start_projection_incomplete");
    }
    const expectedTrainRunIds = exactTrainRuns(blueprint);
    if (
      !sameSet(verified.lotIds, exactLots(blueprint))
      || !sameSet(verified.scheduledTrainRunIds, expectedTrainRunIds)
      || verified.runningTrainRunIds.some((trainRunId) => !expectedTrainRunIds.includes(trainRunId))
    ) {
      throw new AlphaConflictError("Eigenbetrieb deckt Lose oder Zugfahrten nicht vollstaendig ab.", "public_operation_incomplete");
    }
    if (rehydrateRunningDeployment) return profile;
    const occurredAt = new Date(world.epoch.getTime() + atS * 1_000);
    if (verifyRunningDeploymentBinding) {
      return this.db.transaction(async (tx) => {
        const [bound] = await tx.update(alphaWorldProfiles).set({ deploymentHash: deploymentHash! }).where(and(
          eq(alphaWorldProfiles.worldId, worldId),
          eq(alphaWorldProfiles.state, "running"),
          isNull(alphaWorldProfiles.deploymentHash),
        )).returning();
        if (bound === undefined) {
          const [concurrent] = await tx.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
          if (concurrent === undefined || concurrent.deploymentHash !== deploymentHash) {
            throw new AlphaConflictError("Welt verlor die Deployment-Bindung an einen parallelen Start.", "world_deployment_conflict");
          }
          return concurrent;
        }
        await appendWorldEvent(tx, worldId, "alpha.world-deployment-bound", {
          blueprintHash,
          deploymentHash,
          startingCapitalPolicy: blueprint.startingCapitalPolicy,
          releasePins: blueprint.releases,
        }, occurredAt);
        return bound;
      });
    }
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(alphaWorldProfiles).set({ state: "running", startedAtS: atS })
        .where(and(eq(alphaWorldProfiles.worldId, worldId), eq(alphaWorldProfiles.state, "draft"))).returning();
      if (updated === undefined) throw new AlphaConflictError("Weltstart verlor ein Parallelrennen.", "world_start_race");
      await appendWorldEvent(tx, worldId, "alpha.world-started-with-public-operation", {
        blueprintHash,
        deploymentHash,
        regionId: blueprint.regionId,
        lotCount: blueprint.lots.length,
        trainRunCount: exactTrainRuns(blueprint).length,
        startingCapitalPolicy: blueprint.startingCapitalPolicy,
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
