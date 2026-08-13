import { readFile } from "node:fs/promises";
import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  AlphaWorldService,
  alphaHash,
  validateWorldBlueprint,
  type AlphaDatabase,
  type AlphaWorldBlueprint,
  type WorldStartPort,
  type WorldStartVerification,
} from "@zugfolge/alpha";
import { enqueueWorldProjection } from "@zugfolge/commerce";
import {
  alphaWorldDeployments,
  alphaWorldProfiles,
  domainEvents,
  odooProjectionOutbox,
  worlds,
} from "@zugfolge/db";
import type { OperationsDecision, OperationsRegistry } from "@zugfolge/dispatch";
import {
  buildEconomyRelease,
  decodeEconomyValue,
  encodeEconomyValue,
  initializeFleetProducer,
  loadEconomyWorldState,
  loadFleetProducerCheckpoint,
  persistEconomyTransition,
  startEconomyWorld,
  type AuthorityBudget,
  type EconomyRelease,
  type Lot,
} from "@zugfolge/economy";
import type { LivemapRegistry } from "@zugfolge/livemap-stream";
import {
  parsePlanningInfrastructureRelease,
  type PlanningInfrastructureRelease,
} from "@zugfolge/planning-worker";
import type {
  FleetRuntime,
  FleetWorldInitialization,
  RegionalSimulationInitialization,
} from "@zugfolge/runtime-native";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { RegionalServiceCatalog, type RegionalBoundaryTransition } from "./boundary-transition-scheduler.js";
import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";

export const ALPHA_WORLD_DEPLOYMENT_SCHEMA = "zugfolge-alpha-world-deployment/v1" as const;

export interface AlphaDeploymentWorldDefinition {
  readonly name: string;
  readonly kind: "public" | "tutorial" | "private" | "test";
  readonly rankingStatus: "ranked" | "unranked";
  readonly schedulePeriodWeeks: number;
  readonly epoch: string;
}

interface SerializedEconomyRelease extends Omit<EconomyRelease, "rates" | "rules" | "checksum"> {
  readonly rates: EconomyRelease["rates"];
  readonly rules: EconomyRelease["rules"];
}

export interface AlphaPlanningAuthority {
  readonly accountId: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
}

export interface AlphaWorldDeployment {
  readonly schema: typeof ALPHA_WORLD_DEPLOYMENT_SCHEMA;
  readonly worldId: string;
  /** Vom Deployment-Hash und der Ed25519-Signatur gebundene Weltparameter. */
  readonly worldDefinition: AlphaDeploymentWorldDefinition;
  readonly infraReleaseHash: string;
  readonly blueprint: AlphaWorldBlueprint;
  readonly economy: {
    readonly durationMonths: 6 | 12 | 18 | "unlimited";
    readonly release: SerializedEconomyRelease;
    readonly lots: readonly Lot[];
    readonly authorityBudgets: readonly AuthorityBudget[];
    readonly accounts: readonly string[];
    readonly publicVehiclePoolByLot: Readonly<Record<string, readonly string[]>>;
  };
  readonly fleet: FleetWorldInitialization;
  readonly regionalSimulation: RegionalSimulationInitialization;
  readonly repeatEveryS: number;
  readonly boundaryTransitions: readonly RegionalBoundaryTransition[];
  /**
   * Kein Prozess- oder Env-Geheimnis: Konto und Release sind Bestandteil des
   * signierten, gehashten Weltvertrags und werden nur fuer aktive Welten
   * materialisiert.
   */
  readonly planning: {
    readonly authority: AlphaPlanningAuthority;
    readonly infrastructureRelease: PlanningInfrastructureRelease;
  };
  readonly provenance: {
    readonly infraReleaseId: string;
    readonly operationalNetworkHash: string;
    readonly gtfsSnapshotHash: string;
    readonly fleetSourceSha256: string;
    readonly generationScriptSha256: string;
  };
}

export interface SignedAlphaWorldDeployment {
  readonly deployment: AlphaWorldDeployment;
  readonly deploymentHash: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly valueBase64: string;
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} ist kein Objekt.`);
  return value as Record<string, unknown>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validatePlanningBinding(deployment: AlphaWorldDeployment): void {
  const planning = record(deployment.planning, "Alpha-Deployment-Planning");
  const authority = record(planning["authority"], "Alpha-Deployment-Planning-Authority");
  if (
    Object.keys(planning).length !== 2
    || !Object.hasOwn(planning, "authority")
    || !Object.hasOwn(planning, "infrastructureRelease")
    || Object.keys(authority).length !== 3
    || !["accountId", "keycloakSubject", "displayName"].every((key) => Object.hasOwn(authority, key))
    || typeof authority["accountId"] !== "string"
    || !UUID_PATTERN.test(authority["accountId"])
    || typeof authority["keycloakSubject"] !== "string"
    || authority["keycloakSubject"].trim() === ""
    || typeof authority["displayName"] !== "string"
    || authority["displayName"].trim() === ""
  ) throw new Error("Alpha-Deployment besitzt keine gueltige signierte Planning-Authority.");
  const release = parsePlanningInfrastructureRelease(
    planning["infrastructureRelease"],
    deployment.worldId,
    deployment.provenance.infraReleaseId,
  );
  if (release.sourceId !== deployment.infraReleaseHash) {
    throw new Error("Planning-Infrastrukturrelease ist nicht an den signierten InfraRelease-Hash gebunden.");
  }
}

function validateDeploymentWorldDefinition(
  value: unknown,
  profileKind: AlphaWorldBlueprint["profileKind"],
): asserts value is AlphaDeploymentWorldDefinition {
  const definition = record(value, "Alpha-Deployment-Weltdefinition");
  if (
    Object.keys(definition).length !== 5
    || !["name", "kind", "rankingStatus", "schedulePeriodWeeks", "epoch"].every((key) => Object.hasOwn(definition, key))
    || typeof definition["name"] !== "string"
    || definition["name"].trim() === ""
    || definition["kind"] !== profileKind
    || !["public", "tutorial", "private", "test"].includes(definition["kind"] as string)
    || !["ranked", "unranked"].includes(definition["rankingStatus"] as string)
    || (definition["kind"] === "public") !== (definition["rankingStatus"] === "ranked")
    || !Number.isSafeInteger(definition["schedulePeriodWeeks"])
    || (definition["schedulePeriodWeeks"] as number) < 3
    || (definition["schedulePeriodWeeks"] as number) > 8
    || typeof definition["epoch"] !== "string"
    || Number.isNaN(new Date(definition["epoch"]).getTime())
  ) {
    throw new Error("Alpha-Deployment besitzt keine gueltige signierte Weltdefinition.");
  }
}

export function parseSignedAlphaWorldDeployment(
  value: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): SignedAlphaWorldDeployment {
  const parsed = record(value, "Alpha-Deployment");
  const signature = record(parsed["signature"], "Alpha-Deployment-Signatur");
  if (signature["algorithm"] !== "Ed25519" || typeof signature["keyId"] !== "string" || typeof signature["valueBase64"] !== "string") {
    throw new Error("Alpha-Deployment-Signatur ist unvollstaendig.");
  }
  const key = trustedKeys[signature["keyId"]];
  if (key === undefined) throw new Error(`Alpha-Deployment-Schluessel '${signature["keyId"]}' ist nicht vertrauenswuerdig.`);
  const deployment = decodeEconomyValue(parsed["deployment"]) as AlphaWorldDeployment;
  if (deployment.schema !== ALPHA_WORLD_DEPLOYMENT_SCHEMA || deployment.worldId.trim() === "") {
    throw new Error("Alpha-Deployment verletzt Schema- oder Weltbindung.");
  }
  validateWorldBlueprint(deployment.blueprint);
  validateDeploymentWorldDefinition(deployment.worldDefinition, deployment.blueprint.profileKind);
  validatePlanningBinding(deployment);
  if (
    deployment.infraReleaseHash !== deployment.blueprint.releases.infra
    || deployment.provenance.operationalNetworkHash !== deployment.blueprint.conflictCheckHash
    || deployment.provenance.gtfsSnapshotHash !== deployment.blueprint.releases.timetable
    || buildEconomyRelease({
      version: deployment.economy.release.version,
      rates: deployment.economy.release.rates,
      rules: deployment.economy.release.rules,
      tenderProfiles: deployment.economy.release.tenderProfiles,
    }).checksum !== deployment.blueprint.releases.economy
  ) {
    throw new Error("Alpha-Deployment besitzt widerspruechliche interne Release-Hashbindungen.");
  }
  const deploymentHash = alphaHash(ALPHA_WORLD_DEPLOYMENT_SCHEMA, deployment);
  if (parsed["deploymentHash"] !== deploymentHash) throw new Error("Alpha-Deployment-Hash stimmt nicht mit dem Inhalt ueberein.");
  const signatureBytes = Buffer.from(signature["valueBase64"], "base64");
  if (signatureBytes.length !== 64 || !verifySignature(
    null,
    Buffer.from(deploymentHash, "hex"),
    createPublicKey(key),
    signatureBytes,
  )) throw new Error("Alpha-Deployment besitzt keine gueltige Ed25519-Signatur.");
  return {
    deployment,
    deploymentHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signature["keyId"],
      valueBase64: signature["valueBase64"],
    },
  };
}

/** Kanonisch JSON-faehige Huelle fuer die dauerhafte, erneute Signaturpruefung. */
export function serializeSignedAlphaWorldDeployment(
  signed: SignedAlphaWorldDeployment,
): Readonly<Record<string, unknown>> {
  return {
    deployment: encodeEconomyValue(signed.deployment) as Readonly<Record<string, unknown>>,
    deploymentHash: signed.deploymentHash,
    signature: signed.signature,
  };
}

export async function persistSignedAlphaWorldDeployment(
  db: AlphaDatabase,
  signed: SignedAlphaWorldDeployment,
): Promise<void> {
  const authorityAccountId = signed.deployment.planning.authority.accountId;
  const serialized = serializeSignedAlphaWorldDeployment(signed);
  let [stored] = await db.insert(alphaWorldDeployments).values({
    worldId: signed.deployment.worldId,
    deploymentHash: signed.deploymentHash,
    signedDeployment: serialized,
    planningAuthorityAccountId: authorityAccountId,
  }).onConflictDoNothing({ target: alphaWorldDeployments.worldId }).returning();
  if (stored === undefined) {
    [stored] = await db.select().from(alphaWorldDeployments)
      .where(eq(alphaWorldDeployments.worldId, signed.deployment.worldId)).limit(1);
  }
  if (
    stored === undefined
    || stored.deploymentHash !== signed.deploymentHash
    || stored.planningAuthorityAccountId !== authorityAccountId
  ) throw new Error("Persistiertes Alpha-Deployment steht im Konflikt zum signierten Weltvertrag.");
}

export async function loadPersistedActiveAlphaWorldDeployments(
  db: AlphaDatabase,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<readonly { readonly signed: SignedAlphaWorldDeployment; readonly epoch: Date }[]> {
  const rows = await db.select({
    worldId: alphaWorldDeployments.worldId,
    deploymentHash: alphaWorldDeployments.deploymentHash,
    planningAuthorityAccountId: alphaWorldDeployments.planningAuthorityAccountId,
    signedDeployment: alphaWorldDeployments.signedDeployment,
    name: worlds.name,
    schedulePeriodWeeks: worlds.schedulePeriodWeeks,
    epoch: worlds.epoch,
    worldKind: worlds.worldKind,
    rankingStatus: worlds.rankingStatus,
  }).from(alphaWorldDeployments).innerJoin(worlds, and(
    eq(worlds.id, alphaWorldDeployments.worldId),
    eq(worlds.lifecycleStatus, "active"),
  )).orderBy(alphaWorldDeployments.worldId);
  return rows.map((row) => {
    const signed = parseSignedAlphaWorldDeployment(row.signedDeployment, trustedKeys);
    if (
      signed.deployment.worldId !== row.worldId
      || signed.deploymentHash !== row.deploymentHash
      || signed.deployment.planning.authority.accountId !== row.planningAuthorityAccountId
      || signed.deployment.worldDefinition.name !== row.name
      || signed.deployment.worldDefinition.schedulePeriodWeeks !== row.schedulePeriodWeeks
      || new Date(signed.deployment.worldDefinition.epoch).getTime() !== row.epoch.getTime()
      || (signed.deployment.worldDefinition.kind === "public" ? "public" : "private") !== row.worldKind
      || signed.deployment.worldDefinition.rankingStatus !== row.rankingStatus
    ) throw new Error(`Persistiertes Alpha-Deployment fuer '${row.worldId}' verletzt seine DB-Bindung.`);
    return { signed, epoch: row.epoch };
  });
}

/**
 * Odoo-Monitoring sieht ausschliesslich voll gestartete, aktive Welten.
 * Ein retrybares `provisioning`-Profil darf weder projiziert werden noch den
 * gemeinsamen Projektionszyklus anderer Welten abbrechen.
 */
export async function loadActiveAlphaWorldProjectionProfiles(db: AlphaDatabase) {
  return db.select({
    worldId: alphaWorldProfiles.worldId,
    profileKind: alphaWorldProfiles.profileKind,
    blueprintHash: alphaWorldProfiles.blueprintHash,
    deploymentHash: alphaWorldProfiles.deploymentHash,
    blueprint: alphaWorldProfiles.blueprint,
  }).from(alphaWorldProfiles).innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId)).where(and(
    eq(alphaWorldProfiles.state, "running"),
    eq(worlds.lifecycleStatus, "active"),
  )).orderBy(asc(alphaWorldProfiles.worldId));
}

/**
 * Verifiziert die laufende Profilprojektion gegen die dauerhaft gespeicherte
 * Ed25519-Huelle. Ein manipuliertes Blueprint+Hash-Paar wird dadurch nicht
 * allein aufgrund interner Selbstkonsistenz akzeptiert.
 */
export async function loadSignedRunningWorldDeployment(
  db: AlphaDatabase,
  worldId: string,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<SignedAlphaWorldDeployment> {
  const [row] = await db.select({
    deploymentHash: alphaWorldDeployments.deploymentHash,
    signedDeployment: alphaWorldDeployments.signedDeployment,
    profileDeploymentHash: alphaWorldProfiles.deploymentHash,
    blueprintHash: alphaWorldProfiles.blueprintHash,
    blueprint: alphaWorldProfiles.blueprint,
    state: alphaWorldProfiles.state,
    lifecycleStatus: worlds.lifecycleStatus,
  }).from(alphaWorldDeployments)
    .innerJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, alphaWorldDeployments.worldId))
    .innerJoin(worlds, eq(worlds.id, alphaWorldDeployments.worldId))
    .where(eq(alphaWorldDeployments.worldId, worldId))
    .limit(1);
  if (row === undefined || row.state !== "running" || row.lifecycleStatus !== "active") {
    throw new Error(`Welt '${worldId}' besitzt kein aktives signiertes Deployment.`);
  }
  const signed = parseSignedAlphaWorldDeployment(row.signedDeployment, trustedKeys);
  const projectedBlueprint = decodeEconomyValue(row.blueprint) as AlphaWorldBlueprint;
  if (
    signed.deployment.worldId !== worldId
    || signed.deploymentHash !== row.deploymentHash
    || row.profileDeploymentHash !== row.deploymentHash
    || validateWorldBlueprint(projectedBlueprint) !== row.blueprintHash
    || row.blueprintHash !== validateWorldBlueprint(signed.deployment.blueprint)
  ) throw new Error(`Welt '${worldId}' weicht von ihrem signierten Deployment ab.`);
  return signed;
}

export async function loadSignedAlphaWorldDeployment(
  path: string,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<SignedAlphaWorldDeployment> {
  return parseSignedAlphaWorldDeployment(JSON.parse(await readFile(path, "utf8")), trustedKeys);
}

function publicStartDecision(sequence: number, worldId: string, occurredAt: Date, trainRunCount: number): OperationsDecision {
  return {
    sequence,
    occurredAt: occurredAt.toISOString(),
    trainRunId: "",
    decisionId: `public-operation-start:${worldId}`,
    action: "monitor_public_operation",
    cause: "world-start",
    causeCode: null,
    causeLabel: "Weltstart mit Eigenbetrieb",
    fineCauseId: "",
    fineCauseLabel: "",
    affectedResource: "regional-network",
    outcomeReason: "Vollstaendiges SPNV-Angebot ab Simulationssekunde null.",
    impact: { trainRunCount },
    raw: { worldId, operatorIds: ["public"], trainRunCount },
  };
}

export class ProductionWorldStartPort implements WorldStartPort {
  readonly boundaryTransitions: RegionalServiceCatalog;

  constructor(
    private readonly db: AlphaDatabase,
    private readonly signed: SignedAlphaWorldDeployment,
    private readonly fleetRuntime: FleetRuntime,
    private readonly regionalSimulation: RegionalSimulationWorker,
    private readonly livemap: LivemapRegistry,
    private readonly operations: OperationsRegistry,
  ) {
    this.boundaryTransitions = new RegionalServiceCatalog(
      signed.deployment.worldId,
      signed.deployment.regionalSimulation.regionId,
      signed.deployment.repeatEveryS,
      signed.deployment.regionalSimulation.trains,
      signed.deployment.boundaryTransitions,
    );
  }

  #deployment(worldId: string, blueprint: AlphaWorldBlueprint): AlphaWorldDeployment {
    const deployment = this.signed.deployment;
    if (deployment.worldId !== worldId || validateWorldBlueprint(blueprint) !== validateWorldBlueprint(deployment.blueprint)) {
      throw new Error("Weltstart verwendet nicht das signierte Alpha-Deployment.");
    }
    return deployment;
  }

  async verifyDurable(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    this.#deployment(worldId, blueprint);
    const correlationId = `alpha-world-start:${worldId}:${this.signed.deploymentHash}`;
    const [economy, fleet, operationsEvent, projection] = await Promise.all([
      loadEconomyWorldState(this.db, worldId),
      loadFleetProducerCheckpoint(this.db, worldId),
      this.db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "alpha.public-operation-visible"),
      )).limit(1),
      this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
        eq(odooProjectionOutbox.worldId, worldId),
        eq(odooProjectionOutbox.correlationId, correlationId),
      )).limit(1),
    ]);
    if (
      economy?.releasePin.releaseChecksum !== blueprint.releases.economy
      || fleet?.state.authorityReleaseHash !== blueprint.releases.fleet
      || operationsEvent.length !== 1
      || projection.length !== 1
    ) throw new Error("Laufende Alpha-Welt besitzt keine vollstaendige dauerhafte Startprojektion.");
  }

  async initializeEconomy(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    const existing = await loadEconomyWorldState(this.db, worldId);
    if (existing !== undefined) {
      if (existing.releasePin.releaseChecksum !== blueprint.releases.economy) throw new Error("Bestehende Wirtschaftswelt besitzt einen fremden Release.");
      return;
    }
    const release = buildEconomyRelease({
      version: deployment.economy.release.version,
      rates: deployment.economy.release.rates,
      rules: deployment.economy.release.rules,
      tenderProfiles: deployment.economy.release.tenderProfiles,
    });
    if (release.checksum !== blueprint.releases.economy) throw new Error("EconomyRelease stimmt nicht mit dem Weltentwurf ueberein.");
    const started = startEconomyWorld({
      worldId,
      seed: blueprint.seed,
      durationMonths: deployment.economy.durationMonths,
      release,
      lots: deployment.economy.lots,
      authorityBudgets: deployment.economy.authorityBudgets,
      accounts: deployment.economy.accounts,
      publicVehiclePoolByLot: deployment.economy.publicVehiclePoolByLot,
    });
    const calendarHash = alphaHash("zugfolge-alpha-tender-calendar/v1", started.state.calendar);
    if (calendarHash !== blueprint.tenderCalendarHash) throw new Error("Vergabekalender stimmt nicht mit dem Weltentwurf ueberein.");
    await persistEconomyTransition(this.db, { expectedRevision: null, ...started, committedAt: new Date(0) });
  }

  async initializeFleet(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    if (deployment.fleet.worldId !== worldId) throw new Error("Fleet-Release verletzt Weltisolation.");
    const probe = this.fleetRuntime.initializeFleet(deployment.fleet);
    if (probe.state.authorityReleaseHash !== blueprint.releases.fleet) throw new Error("Fleet-Release stimmt nicht mit dem Weltentwurf ueberein.");
    await initializeFleetProducer({
      db: this.db,
      runtime: this.fleetRuntime,
      initialization: deployment.fleet,
      ingestedAt: new Date(0),
    });
  }

  async #ensureOperationsEvent(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const eventType = "alpha.public-operation-visible";
    const [world] = await this.db.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (world === undefined) throw new Error("Welt fuer Betriebszentralenprojektion fehlt.");
    let [event] = await this.db.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      eq(domainEvents.eventType, eventType),
    )).limit(1);
    if (event === undefined) {
      [event] = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
        const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
          .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
        return tx.insert(domainEvents).values({
          worldId,
          sequence: (head?.sequence ?? 0) + 1,
          eventType,
          payload: {
            schemaVersion: "zugfolge-public-operation-visible/v1",
            operatorIds: ["public"],
            lotIds: blueprint.lots.map((lot) => lot.lotId),
            trainRunIds: blueprint.lots.flatMap((lot) => lot.trainRunIds),
            deploymentHash: this.signed.deploymentHash,
          },
          occurredAt: world.epoch,
        }).returning();
      });
    }
    if (event === undefined) throw new Error("Betriebszentralenprojektion konnte nicht erzeugt werden.");
    this.operations.forOperator(worldId, "public").publish({
      worldId,
      operatorId: "public",
      sequence: event.sequence,
      decision: publicStartDecision(event.sequence, worldId, event.occurredAt, blueprint.lots.flatMap((lot) => lot.trainRunIds).length),
    });
  }

  async initializeRegionalSimulation(worldId: string, blueprint: AlphaWorldBlueprint): Promise<void> {
    const deployment = this.#deployment(worldId, blueprint);
    if (!this.regionalSimulation.isReady(worldId, deployment.regionalSimulation.regionId)) {
      try {
        await this.regionalSimulation.initialize(deployment.regionalSimulation, new Date(0));
      } catch (error) {
        await this.regionalSimulation.restore(worldId, deployment.regionalSimulation.regionId).catch(() => { throw error; });
      }
    }
    for (const transition of this.boundaryTransitions.at(worldId, deployment.regionalSimulation.regionId, deployment.regionalSimulation.nowS)) {
      await this.regionalSimulation.apply({
        worldId,
        regionId: deployment.regionalSimulation.regionId,
        commandId: transition.transitionId,
        command: transition.command,
      }, new Date(0));
    }
    await this.#ensureOperationsEvent(worldId, blueprint);
    const correlationId = `alpha-world-start:${worldId}:${this.signed.deploymentHash}`;
    const [queued] = await this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
      eq(odooProjectionOutbox.worldId, worldId),
      eq(odooProjectionOutbox.correlationId, correlationId),
    )).limit(1);
    if (queued === undefined) {
      const [world] = await this.db.select({
        name: worlds.name,
        schedulePeriodWeeks: worlds.schedulePeriodWeeks,
      }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
      if (world === undefined) throw new Error("Welt fuer Odoo-Startprojektion fehlt.");
      await enqueueWorldProjection(this.db, {
      worldId,
      correlationId,
      occurredAt: new Date(0),
      payload: {
        worldName: world.name,
        projectionRevision: this.signed.deploymentHash,
        lifecycle: "starting",
        worldStatus: "starting",
        operator: "public",
        regionId: blueprint.regionId,
        releases: blueprint.releases,
        infraReleaseHash: blueprint.releases.infra,
        economyReleaseHash: blueprint.releases.economy,
        profileKind: blueprint.profileKind,
        blueprintHash: validateWorldBlueprint(blueprint),
        lotCount: blueprint.lots.length,
        trainRunCount: blueprint.lots.flatMap((lot) => lot.trainRunIds).length,
        deploymentHash: this.signed.deploymentHash,
        startingCapitalPolicy: blueprint.startingCapitalPolicy,
        schedulePeriod: `${world.schedulePeriodWeeks} Wochen`,
        authoritative: true,
        freshness: "live",
      },
    });
    }
  }

  async verify(worldId: string, blueprint: AlphaWorldBlueprint): Promise<WorldStartVerification> {
    const deployment = this.#deployment(worldId, blueprint);
    const [economy, fleet, operationsEvent, projection] = await Promise.all([
      loadEconomyWorldState(this.db, worldId),
      loadFleetProducerCheckpoint(this.db, worldId),
      this.db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "alpha.public-operation-visible"),
      )).limit(1),
      this.db.select({ id: odooProjectionOutbox.id }).from(odooProjectionOutbox).where(and(
        eq(odooProjectionOutbox.worldId, worldId),
        eq(odooProjectionOutbox.correlationId, `alpha-world-start:${worldId}:${this.signed.deploymentHash}`),
      )).limit(1),
    ]);
    const snapshot = this.livemap.initializedWorld(worldId)?.snapshot();
    return {
      economyReady: economy !== undefined && economy.publicOperations.size === blueprint.lots.length,
      fleetReady: fleet !== undefined
        && Object.keys(fleet.state.formations).length > 0
        && Object.keys(fleet.state.personnelDuties).length > 0
        && Object.keys(fleet.state.pathReservations).length > 0,
      regionalSimulationReady: this.regionalSimulation.isReady(worldId, deployment.regionalSimulation.regionId),
      livemapReady: snapshot !== undefined,
      operationsCenterReady: operationsEvent.length === 1,
      odooProjectionQueued: projection.length === 1,
      lotIds: economy === undefined ? [] : [...economy.publicOperations.keys()],
      runningTrainRunIds: snapshot === undefined ? [] : [
        ...snapshot.trains.map((train) => train.id),
        ...(snapshot.externalTrains ?? []).map((train) => train.id),
      ],
    };
  }
}

export async function startSignedAlphaWorld(
  db: AlphaDatabase,
  signed: SignedAlphaWorldDeployment,
  port: ProductionWorldStartPort,
) {
  return new AlphaWorldService(db, port).start(
    signed.deployment.worldId,
    signed.deployment.blueprint,
    0,
    signed.deploymentHash,
  );
}
