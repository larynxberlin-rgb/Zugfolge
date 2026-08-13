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
  domainEvents,
  odooProjectionOutbox,
  worlds,
} from "@zugfolge/db";
import type { OperationsDecision, OperationsRegistry } from "@zugfolge/dispatch";
import {
  buildEconomyRelease,
  decodeEconomyValue,
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
import type {
  FleetRuntime,
  FleetWorldInitialization,
  RegionalSimulationInitialization,
} from "@zugfolge/runtime-native";
import { and, desc, eq, sql } from "drizzle-orm";

import { RegionalServiceCatalog, type RegionalBoundaryTransition } from "./boundary-transition-scheduler.js";
import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";

export const ALPHA_WORLD_DEPLOYMENT_SCHEMA = "zugfolge-alpha-world-deployment/v1" as const;

interface SerializedEconomyRelease extends Omit<EconomyRelease, "rates" | "rules" | "checksum"> {
  readonly rates: EconomyRelease["rates"];
  readonly rules: EconomyRelease["rules"];
}

export interface AlphaWorldDeployment {
  readonly schema: typeof ALPHA_WORLD_DEPLOYMENT_SCHEMA;
  readonly worldId: string;
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

export async function loadSignedAlphaWorldDeployment(
  path: string,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<SignedAlphaWorldDeployment> {
  const parsed = record(JSON.parse(await readFile(path, "utf8")), "Alpha-Deployment");
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
    manualOverride: false,
    major: false,
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
    if (queued === undefined) await enqueueWorldProjection(this.db, {
      worldId,
      correlationId,
      occurredAt: new Date(0),
      payload: {
        lifecycle: "running",
        operator: "public",
        regionId: blueprint.regionId,
        releases: blueprint.releases,
        lotCount: blueprint.lots.length,
        trainRunCount: blueprint.lots.flatMap((lot) => lot.trainRunIds).length,
        deploymentHash: this.signed.deploymentHash,
        authoritative: true,
        freshness: "live-start",
      },
    });
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
  return new AlphaWorldService(db, port).start(signed.deployment.worldId, signed.deployment.blueprint, 0);
}
