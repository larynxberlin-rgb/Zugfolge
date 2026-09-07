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

/** Folgt ausschließlich nativ bestätigten Übergaben zwischen unabhängig gepinnten Köpfen. */
export async function resolveConductorRegion(tx: IdentityDatabase, worldId: string, trainRunId: string,
  deps: Pick<ConductorContextDependencies, "regionBindings" | "operationalRuntime">,
  origin?: { readonly regionId: string; readonly atMs: number }) {
  const bindings = deps.regionBindings(worldId);
  requireFact(bindings.length > 0 && bindings.length <= 256 && new Set(bindings.map((row) => row.regionId)).size === bindings.length);
  const candidates = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId),
    inArray(regionalSimulationStates.regionId, bindings.map((row) => row.regionId)),
    sql`${regionalSimulationStates.state}->'world'->'trains' ? ${trainRunId}`));
  requireFact(candidates.length <= 1, "conductor_handover_pending", 409);
  if (origin === undefined) requireFact(candidates.length === 1, "conductor_train_unavailable", 409);
  let regionId = origin?.regionId ?? candidates[0]!.regionId;
  let atMs = origin?.atMs ?? 0;
  const visited = new Set<string>();
  let expectedReceipt: { id: string; hash: string } | undefined;
  while (!visited.has(regionId) && visited.size < bindings.length) {
    visited.add(regionId);
    const initializationHash = bindings.find((row) => row.regionId === regionId)?.initializationHash;
    const [head] = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId), eq(regionalSimulationStates.regionId, regionId)));
    requireFact(initializationHash !== undefined && head !== undefined && head.initializationHash === initializationHash);
    let restored: ReturnType<ConductorContextDependencies["operationalRuntime"]["restore"]>;
    try { restored = deps.operationalRuntime.restore(head.state as OperationalSimulationState, initializationHash); }
    catch { throw new ConductorAccessError(503, "conductor_source_unavailable", "Der regionale Betriebsstand ist nicht bestätigt."); }
    requireFact(restored.stateHash === head.stateHash && restored.state.revision === head.revision
      && restored.state.publisherSequence === head.publisherSequence && restored.initializationHash === initializationHash
      && restored.state.world.worldId === worldId && restored.state.world.regionId === regionId && restored.state.world.nowMs >= atMs);
    const world = restored.state.world;
    if (expectedReceipt !== undefined)
      requireFact(demandRecord(world["acceptedHandovers"] ?? {})[expectedReceipt.id] === expectedReceipt.hash, "conductor_handover_unconfirmed");
    requireFact(!Object.values(demandRecord(world["preparedHandovers"] ?? {})).some((value) =>
      demandRecord(demandRecord(value)["train"])["id"] === trainRunId), "conductor_handover_pending", 409);
    if (demandRecord(world["trains"])[trainRunId] !== undefined) {
      requireFact(candidates.length === 1 && candidates[0]!.regionId === regionId, "conductor_handover_unconfirmed");
      return { head, restored, initializationHash };
    }
    const receipts = Object.entries(demandRecord(world["finishedHandoverReceipts"] ?? {}))
      .map(([id, value]) => ({ id, value: demandRecord(value) }))
      .filter(({ value }) => value["trainRunId"] === trainRunId && Number(value["atMs"]) >= atMs)
      .sort((a, b) => Number(b.value["atMs"]) - Number(a.value["atMs"]));
    const receipt = receipts[0];
    if (receipt === undefined) {
      // Eine wirklich entfernte Fahrt kann enden; eine andere Zugkopie oder
      // ein alter, nicht zuordenbarer Übergabehash darf diesen Schluss nicht erzeugen.
      const typedReceipts = demandRecord(world["finishedHandoverReceipts"] ?? {});
      requireFact(candidates.length === 0 && Object.keys(demandRecord(world["finishedHandovers"] ?? {})).every((id) => typedReceipts[id] !== undefined),
        "conductor_handover_unconfirmed");
      return { head, restored, initializationHash };
    }
    const proof = receipt.value;
    requireFact(proof["handoverId"] === receipt.id && proof["worldId"] === worldId && proof["sourceRegionId"] === regionId
      && typeof proof["targetRegionId"] === "string" && typeof proof["payloadHash"] === "string"
      && demandRecord(world["finishedHandovers"] ?? {})[receipt.id] === proof["payloadHash"]
      && Number.isSafeInteger(proof["atMs"]) && Number(proof["atMs"]) <= world.nowMs
      && (receipts[1] === undefined || receipts[1].value["atMs"] !== proof["atMs"]), "conductor_handover_unconfirmed");
    expectedReceipt = { id: receipt.id, hash: proof["payloadHash"] };
    requireFact(bindings.some((binding) => binding.regionId === proof["targetRegionId"]));
    atMs = Number(proof["atMs"]); regionId = proof["targetRegionId"];
  }
  throw new ConductorAccessError(503, "conductor_handover_unconfirmed", "Der Regionsübergang dieser Fahrt ist noch nicht bestätigt.");
}

/** M4, M5 und M10 werden aus demselben serialisierten DB-Stand zusammengesetzt. */
export async function loadConductorContext(tx: IdentityDatabase, access: ConductorAccess,
  deps: ConductorContextDependencies): Promise<ConductorCommittedContext> {
  const accountId = await requireConductorAccount(tx, access);
  const { head, restored, initializationHash } = await resolveConductorRegion(tx, access.worldId, access.trainRunId, deps);
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
