import { operators, regionalSimulationStates, worlds } from "@zugfolge/db";
import { loadFleetProducerCheckpoint } from "@zugfolge/economy";
import { getAccount, type IdentityDatabase } from "@zugfolge/identity";
import type { BuildInteriorLayoutInputV1, ConductorInteriorRuntime, DemandRuntime, FleetRuntime,
  InteriorLayoutV1, OperationalProjection, OperationalSimulationRuntime, OperationalSimulationState,
  ProjectConductorPassengersInputV2 } from "@zugfolge/runtime-native";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ConductorInteriorDeployment, ConductorInteriorPeriod } from "./conductor-interior-configuration.js";
import { DemandStore, demandList, demandRecord, demandText } from "./demand-store.js";

export class ConductorAccessError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export interface ConductorAccess {
  readonly worldId: string; readonly operatorId: string; readonly trainRunId: string; readonly keycloakSubject: string;
}
export interface ConductorContextDependencies {
  readonly fleetRuntime: Pick<FleetRuntime, "verifyFleetWorldState">;
  readonly demandRuntime: DemandRuntime;
  readonly operationalRuntime: Pick<OperationalSimulationRuntime, "restore">;
  readonly interiorRuntime: Pick<ConductorInteriorRuntime, "build" | "bind" | "path" | "movement">;
  readonly interiorDeployment: ConductorInteriorDeployment;
  readonly regionBindings: (worldId: string) => readonly { regionId: string; initializationHash: string }[];
}
export interface ConductorCommittedContext {
  readonly accountId: string; readonly nowMs: number; readonly regionId: string;
  readonly operationalStateHash: string; readonly operationalInitializationHash: string;
  readonly operationalInfraReleaseHash: string;
  readonly operationalWorld: Readonly<Record<string, unknown>>; readonly operationalProjection: OperationalProjection;
  readonly interiorInput: BuildInteriorLayoutInputV1; readonly layout: InteriorLayoutV1;
  readonly projectionInput: ProjectConductorPassengersInputV2; readonly period: ConductorInteriorPeriod;
}
function requireFact(value: unknown, code = "conductor_source_unavailable", status = 503): asserts value {
  if (!value) throw new ConductorAccessError(status, code, "Die bestätigten Daten für diese Fahrt sind momentan nicht verfügbar.");
}

export async function loadConductorFleet(tx: IdentityDatabase, worldId: string, nowMs: number,
  runtime: ConductorContextDependencies["fleetRuntime"]) {
  const fleet = await loadFleetProducerCheckpoint(tx, worldId);
  requireFact(fleet !== undefined);
  const verification = runtime.verifyFleetWorldState(fleet.state, fleet.stateHash);
  requireFact(verification.worldId === worldId && verification.stateHash === fleet.stateHash
    && verification.snapshotHash === fleet.snapshotHash && verification.revision === fleet.state.revision
    && verification.authorityReleaseHash === fleet.state.authorityReleaseHash
    && fleet.snapshot.worldId === worldId && fleet.snapshot.revision === fleet.state.revision
    && fleet.state.producedAt <= Math.floor(nowMs / 1000));
  return fleet;
}

export function conductorHoldsVehicles(fleet: Awaited<ReturnType<typeof loadConductorFleet>>, operatorId: string,
  vehicleIds: readonly string[], nowMs: number): boolean {
  return vehicleIds.every((vehicleId) => {
    const asset = fleet.state.authorityRelease.assets.find((row) => row.id === vehicleId);
    if (asset === undefined) return false;
    const holding = fleet.state.assetHoldings?.[vehicleId];
    return (holding?.holderOperatorId ?? asset.operatorId) === operatorId
      && (holding?.validUntilS === undefined || holding.validUntilS === null || holding.validUntilS > Math.floor(nowMs / 1000));
  });
}

/** Ausschließlich unter der bereits exklusiv gesperrten Weltzeile aufrufen. */
export async function requireConductorAccount(tx: IdentityDatabase, access: ConductorAccess): Promise<string> {
  const [world] = await tx.select({ status: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, access.worldId));
  requireFact(world?.status === "active", "conductor_world_inactive", 409);
  const account = await getAccount(tx, { worldId: access.worldId, keycloakSubject: access.keycloakSubject });
  requireFact(account !== undefined, "conductor_access_denied", 403);
  const [operator] = await tx.select({ id: operators.id }).from(operators).where(and(eq(operators.worldId, access.worldId),
    eq(operators.id, access.operatorId), eq(operators.foundingAccountId, account.id), eq(operators.lifecycle, "active")));
  requireFact(operator !== undefined, "conductor_access_denied", 403);
  return account.id;
}

/** M4, M5 und M10 werden aus demselben serialisierten DB-Stand zusammengesetzt. */
export async function loadConductorContext(tx: IdentityDatabase, access: ConductorAccess,
  deps: ConductorContextDependencies): Promise<ConductorCommittedContext> {
  const accountId = await requireConductorAccount(tx, access);
  const bindings = deps.regionBindings(access.worldId);
  requireFact(bindings.length > 0 && bindings.length <= 256 && new Set(bindings.map((row) => row.regionId)).size === bindings.length);
  // JSON-Pfad und Wert sind gebundene Parameter. Eine ähnlich benannte Fahrt
  // oder ein LiveMap-Cache ist kein Ersatz für den committed Betriebszustand.
  const rows = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, access.worldId),
    inArray(regionalSimulationStates.regionId, bindings.map((row) => row.regionId)),
    sql`${regionalSimulationStates.state}->'world'->'trains' ? ${access.trainRunId}`));
  requireFact(rows.length === 1, "conductor_train_unavailable", 409);
  const head = rows[0]!;
  const initializationHash = bindings.find((row) => row.regionId === head.regionId)?.initializationHash;
  requireFact(initializationHash !== undefined && head.initializationHash === initializationHash);
  const restored = deps.operationalRuntime.restore(head.state as OperationalSimulationState, initializationHash);
  requireFact(restored.stateHash === head.stateHash && restored.state.revision === head.revision
    && restored.state.publisherSequence === head.publisherSequence && restored.initializationHash === initializationHash
    && restored.state.world.worldId === access.worldId && restored.state.world.regionId === head.regionId);
  const operationalWorld = restored.state.world;
  const nowMs = operationalWorld.nowMs;
  requireFact(Number.isSafeInteger(nowMs) && nowMs >= 0);
  const train = demandRecord(demandRecord(operationalWorld["trains"])[access.trainRunId]);
  requireFact(train["operatorId"] === access.operatorId && train["movementKind"] === "train" && train["publicPassengerStop"] === true,
    "conductor_train_ineligible", 409);
  const operationalFormation = demandRecord(demandRecord(operationalWorld["formations"])[demandText(train["formationVersionId"])]);
  const vehicleIds = operationalFormation["vehicleIds"];
  requireFact(Array.isArray(vehicleIds) && vehicleIds.length > 0 && vehicleIds.every((value) => typeof value === "string"));

  const fleet = await loadConductorFleet(tx, access.worldId, nowMs, deps.fleetRuntime);
  const matches = fleet.snapshot.formations.filter((formation) => formation.operatorId === access.operatorId
    && formation.vehicleIds.length === vehicleIds.length && formation.vehicleIds.every((value, index) => value === vehicleIds[index]));
  requireFact(matches.length === 1, "conductor_formation_unbound", 409);
  const formation = matches[0]!;
  requireFact(formation.procurement === "delivered" && formation.availability !== "retired"
    && formation.availableFrom <= Math.floor(nowMs / 1000) && formation.availableUntil > Math.floor(nowMs / 1000),
    "conductor_formation_unavailable", 409);
  requireFact(conductorHoldsVehicles(fleet, access.operatorId, formation.vehicleIds, nowMs), "conductor_access_denied", 403);
  const checkpoint = await new DemandStore(tx, deps.demandRuntime).latest(access.worldId);
  requireFact(checkpoint !== undefined);
  const evaluation = checkpoint.result;
  const service = demandList(checkpoint.input["services"]).find((row) => row["worldId"] === access.worldId
    && row["trainRunId"] === access.trainRunId && row["operatorId"] === access.operatorId && row["mode"] === "spnv");
  requireFact(service !== undefined, "conductor_train_ineligible", 409);
  requireFact(evaluation["projectionMode"] === "progress_bound" && evaluation["operationalProgress"] !== undefined,
    "conductor_passengers_unconfirmed", 409);
  const periodId = demandText(evaluation["periodId"]);
  const period = deps.interiorDeployment.period(access.worldId, periodId, nowMs);
  requireFact(period !== undefined, "conductor_release_unavailable", 409);
  const interiorInput: BuildInteriorLayoutInputV1 = { schemaVersion: "conductor-interior-layout-input/v1",
    binding: { worldId: access.worldId, periodId, operatorId: access.operatorId, formationId: formation.id,
      formationRevision: fleet.state.revision, fleetStateHash: fleet.stateHash,
      fleetAuthorityReleaseId: fleet.state.authorityRelease.releaseId, fleetAuthorityReleaseHash: fleet.state.authorityReleaseHash,
      mobilizationSnapshotHash: fleet.snapshotHash, geometryPolicyHash: period.geometryPolicyHash,
      artReleaseId: period.artPin.releaseId, artManifestHash: period.artPin.manifestSha256 },
    authorityRelease: fleet.state.authorityRelease, mobilization: fleet.snapshot, geometryPolicy: period.geometryPolicy };
  const layout = deps.interiorRuntime.build(interiorInput);
  const interior = deps.interiorRuntime.bind({ schemaVersion: "conductor-interior-bind-input/v1", layout, trainRunId: access.trainRunId, service });
  const projectionInput: ProjectConductorPassengersInputV2 = { schemaVersion: "conductor-passenger-projection-input/v2",
    binding: { worldId: access.worldId, periodId, demandReleaseId: demandText(evaluation["demandReleaseId"]),
      releaseHash: demandText(evaluation["releaseHash"]), seedHash: demandText(evaluation["seedHash"]), trainRunId: access.trainRunId,
      operatorId: access.operatorId, manifestRevision: Number(evaluation["revision"]), demandStateHash: demandText(evaluation["stateHash"]),
      operationalReceiptId: demandText(demandRecord(evaluation["operationalProgress"])["receiptId"]) }, evaluation, service, interior };
  return { accountId, nowMs, regionId: head.regionId, operationalStateHash: head.stateHash, operationalInfraReleaseHash: restored.state.infraRelease.stateHash,
    operationalInitializationHash: initializationHash, operationalWorld, operationalProjection: restored.liveMap,
    interiorInput, layout, projectionInput, period };
}
