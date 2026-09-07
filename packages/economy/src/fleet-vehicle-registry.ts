import { createHash } from "node:crypto";
import {
  fleetWorldCheckpoints, operators, vehicleAssetHistoryEvents, vehicleAssets,
  vehicleRegistryEntries, vehicleRegistryEvents, worlds,
} from "@zugfolge/db";
import type { NativeFleetWorldState } from "@zugfolge/runtime-native";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import { canonicalFleetJson } from "./fleet-snapshot.js";
import type { EconomyDatabase } from "./ledger.js";

function fingerprint(kind: string, value: unknown): string {
  return createHash("sha256").update(`${kind}\n${canonicalFleetJson(value)}`).digest("hex");
}

/** Reine Kopie bestätigter Rust-Fakten; fehlende Wert-/Kilometerangaben bleiben unbekannt. */
export async function persistFleetVehicleRegistry(
  db: EconomyDatabase,
  state: NativeFleetWorldState,
  sourceStateHash: string,
  projectMarketAssets = true,
): Promise<void> {
  const worldId = state.worldId;
  if (!/^[a-f0-9]{64}$/.test(sourceStateHash) || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error("Fahrzeugregister braucht eine bestaetigte Fleet-Revision mit Zustandshash.");
  }
  const knownOperators = new Set((await db.select({ id: operators.id }).from(operators)
    .where(eq(operators.worldId, worldId))).map((row) => row.id));
  for (const source of state.authorityRelease.assets) {
    const holding = state.assetHoldings?.[source.id] ?? {
      ownerOperatorId: source.operatorId, holderOperatorId: source.operatorId,
      lessorOperatorId: null, contractId: null, validUntilS: null,
      historyHash: fingerprint("vehicle-original-holding/v1", {
        worldId, vehicleId: source.id, authorityReleaseId: state.authorityRelease.releaseId,
        ownerOperatorId: source.operatorId,
      }),
    };
    const formations = Object.values(state.formations)
      .filter((formation) => formation.vehicleIds.includes(source.id)).map((formation) => formation.id).sort();
    const workshop = Object.values(state.maintenanceAssignments ?? {})
      .filter((assignment) => formations.includes(assignment.formationId) && assignment.endsAtS > state.producedAt)
      .map((assignment) => assignment.facilityId).sort();
    const bindings = { formations, workshop, contracts: holding.contractId === null ? [] : [holding.contractId], security: [] };
    const facts = { source, holding, bindings };
    const factsHash = fingerprint("vehicle-registry-facts/v1", facts);
    const [previous] = await db.select().from(vehicleRegistryEntries).where(and(
      eq(vehicleRegistryEntries.worldId, worldId), eq(vehicleRegistryEntries.vehicleId, source.id),
    )).limit(1);
    if (previous !== undefined && previous.fleetRevision > state.revision) continue;
    if (previous?.fleetRevision === state.revision) {
      if (previous.factsHash !== factsHash) throw new Error("Fahrzeugregister-Revision besitzt abweichende Originalfakten.");
      continue;
    }
    const changed = previous === undefined || previous.factsHash !== factsHash;
    const historyHash = changed ? fingerprint("vehicle-registry-history/v1", {
      worldId, vehicleId: source.id, fleetRevision: state.revision,
      priorHistoryHash: previous?.historyHash ?? null, factsHash, sourceStateHash,
    }) : previous.historyHash;
    const projected = {
      worldId, vehicleId: source.id, authorityReleaseId: state.authorityRelease.releaseId,
      classDesignation: source.classDesignation, ownerOperatorId: holding.ownerOperatorId,
      holderOperatorId: holding.holderOperatorId, introducedAtS: source.deliveredAt,
      retiredAtS: source.retiredAt, dataAtS: state.producedAt, fleetRevision: state.revision,
      sourceStateHash, facts, factsHash, historyHash,
    };
    await db.insert(vehicleRegistryEntries).values(projected).onConflictDoUpdate({
      target: [vehicleRegistryEntries.worldId, vehicleRegistryEntries.vehicleId], set: projected,
    });
    if (changed) await db.insert(vehicleRegistryEvents).values({
      worldId, vehicleId: source.id, fleetRevision: state.revision, atS: state.producedAt,
      eventType: previous === undefined ? "registered" : "condition-updated",
      priorHistoryHash: previous?.historyHash ?? null, resultingHistoryHash: historyHash, sourceStateHash, details: facts,
    });

    // Öffentliche Bestände gehören ins Register. EVU-Markteinträge brauchen
    // zusätzlich echte Welt-EVU, da Verträge und Ledger dieselben FKs verwenden.
    if (!projectMarketAssets || !knownOperators.has(holding.ownerOperatorId) || !knownOperators.has(holding.holderOperatorId)
      || (holding.lessorOperatorId !== null && !knownOperators.has(holding.lessorOperatorId))) continue;
    const [asset] = await db.select().from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.vehicleId, source.id),
    )).limit(1);
    const conditionProfile = "condition" in source ? source.condition : null;
    const projectedFacts = {
      ownerOperatorId: holding.ownerOperatorId,
      holderOperatorId: holding.holderOperatorId,
      lessorOperatorId: holding.lessorOperatorId,
      actualConfiguration: { ...source.passenger, technical: source.technical, installedProtection: source.installedProtection,
        buildYear: source.buildYear, acquisitionYear: source.acquisitionYear, procurementChannel: source.procurementChannel,
        deliveredAtS: source.deliveredAt, retiredAtS: source.retiredAt, sourceHistory: "history" in source ? source.history : [] },
      conditionProfile,
      maintenanceDeadlines: source.maintenanceDeadlines,
      approvals: source.approvedLineIds,
      operatingLimits: "restrictions" in source ? Object.keys(source.restrictions).sort() : [],
      bindings,
    };
    if (asset === undefined) {
      const marketHistoryHash = fingerprint("vehicle-market-initial-projection/v1", { worldId, sourceStateHash, vehicleId: source.id, projectedFacts });
      await db.insert(vehicleAssets).values({
        worldId, vehicleId: source.id, authorityReleaseId: state.authorityRelease.releaseId,
        classDesignation: source.classDesignation,
        ...projectedFacts, odometerMetres: null, conditionBasisPoints: null, damages: [],
        valuationSpecId: null, valueCents: null, acquiredAtS: source.deliveredAt, revision: 1, historyHash: marketHistoryHash,
      });
      await db.insert(vehicleAssetHistoryEvents).values({
        worldId, vehicleId: source.id, eventType: "registered", atS: state.producedAt,
        priorHistoryHash: null, resultingHistoryHash: marketHistoryHash,
        details: { sourceStateHash, source, holding }, idempotencyKey: `fleet-register:${source.id}`,
      });
    } else {
      const currentFacts = Object.fromEntries(Object.keys(projectedFacts).map((key) => [key, asset[key as keyof typeof asset]]));
      if (canonicalFleetJson(currentFacts) === canonicalFleetJson(projectedFacts)) continue;
      const marketHistoryHash = fingerprint("vehicle-market-projection/v1", {
        worldId, vehicleId: source.id, sourceStateHash, previousHistoryHash: asset.historyHash, projectedFacts,
      });
      await db.update(vehicleAssets).set({ ...projectedFacts, revision: asset.revision + 1, historyHash: marketHistoryHash })
        .where(and(eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.vehicleId, source.id)));
      await db.insert(vehicleAssetHistoryEvents).values({
        worldId, vehicleId: source.id, eventType: "condition-updated", atS: state.producedAt,
        priorHistoryHash: asset.historyHash, resultingHistoryHash: marketHistoryHash,
        details: { sourceStateHash, ...projectedFacts }, idempotencyKey: `fleet-condition:${source.id}:${state.revision}`,
      });
    }
  }
}

/** Holt bei bestehenden Welten alle seit Einführung fehlenden, bereits bestätigten Revisionen nach. */
export async function backfillFleetVehicleRegistry(db: EconomyDatabase, worldId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
    const [world] = await tx.select({ lifecycle: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
    // Historische Archive bleiben versiegelt; vorhandene Registerdaten sind weiterhin lesbar.
    if (world === undefined || world.lifecycle === "archived") return;
    const [head] = await tx.select({ revision: max(vehicleRegistryEntries.fleetRevision) }).from(vehicleRegistryEntries)
      .where(eq(vehicleRegistryEntries.worldId, worldId));
    const rows = await tx.select().from(fleetWorldCheckpoints).where(and(
      eq(fleetWorldCheckpoints.worldId, worldId), gt(fleetWorldCheckpoints.revision, head?.revision ?? -1),
    )).orderBy(asc(fleetWorldCheckpoints.revision));
    for (const row of rows) {
      const state = row.state as NativeFleetWorldState;
      if (state.worldId !== worldId || state.revision !== row.revision || state.schemaVersion !== row.stateSchema) {
        throw new Error("Fahrzeugregister-Checkpoint verletzt Welt-, Revisions- oder Schemabindung.");
      }
      await persistFleetVehicleRegistry(tx as unknown as EconomyDatabase, state, row.stateHash);
    }
  });
}
