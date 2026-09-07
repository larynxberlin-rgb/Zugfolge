import { conductorControlStates, regionalSimulationStates, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import type { OperationalSimulationCommandPayload, OperationalSimulationRuntime, OperationalSimulationState } from "@zugfolge/runtime-native";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ConductorAccessError } from "./conductor-context.js";
import type { ConductorPoliceAdapter, ControlOperationalHold, ControlOperationalHoldReceipt, FareControlRuntime, FareControlState } from "./conductor-control-runtime.js";
import { demandRecord } from "./demand-store.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";

/** Existing regional persistence inside the caller's world transaction.
 * The private registry receives provisional fanout; public views reload only committed rows.
 */
export function createConductorPoliceAdapter(deps: {
  readonly runtime: OperationalSimulationRuntime;
  readonly regionBindings: (worldId: string) => readonly { regionId: string; initializationHash: string }[];
  readonly controlRuntime?: Pick<FareControlRuntime, "restore">;
}): ConductorPoliceAdapter {
  const reject = (code: string): never => { throw new ConductorAccessError(409, code, "Die betriebliche Polizeianforderung passt nicht zum bestätigten Fahrtstand."); };
  async function load(tx: IdentityDatabase, input: { worldId: string; operatorId: string; trainRunId: string }, retiredHold = false) {
    const bindings = deps.regionBindings(input.worldId);
    if (bindings.length === 0) reject("conductor_police_region_missing");
    const rows = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, input.worldId),
      inArray(regionalSimulationStates.regionId, bindings.map((row) => row.regionId)),
      retiredHold
        ? sql`(${regionalSimulationStates.state}->'world'->'trains' ? ${input.trainRunId} or ${regionalSimulationStates.state}->'world'->'fareControlState'->'holds' ? ${input.trainRunId})`
        : sql`${regionalSimulationStates.state}->'world'->'trains' ? ${input.trainRunId}`));
    if (rows.length !== 1) reject("conductor_police_train_missing");
    const row = rows[0]!, binding = bindings.find((item) => item.regionId === row.regionId)!;
    if (row.initializationHash !== binding.initializationHash) reject("conductor_police_region_mismatch");
    const worker = new RegionalSimulationWorker(tx, deps.runtime, new LivemapRegistry());
    const restored = await worker.restore(input.worldId, row.regionId, binding.initializationHash);
    const train = demandRecord(restored.state.world["trains"])[input.trainRunId];
    if (train !== undefined) {
      if (demandRecord(train)["operatorId"] !== input.operatorId) reject("conductor_police_operator_mismatch");
    } else {
      // A physical continuation may already have consumed the old train. Only
      // its released native hold plus the verified private case pin authorizes history.
      const hold = receipt(restored.state, input.trainRunId)?.hold;
      if (!retiredHold || hold === undefined || hold.releasedAtMs === null || deps.controlRuntime === undefined)
        reject("conductor_police_train_missing");
      const [stored] = await tx.select().from(conductorControlStates).where(and(eq(conductorControlStates.worldId, input.worldId),
        eq(conductorControlStates.operatorId, input.operatorId)));
      if (stored === undefined) reject("conductor_police_case_missing");
      const control = deps.controlRuntime!.restore(stored!.state as FareControlState, stored!.stateHash);
      if (control.worldId !== input.worldId || control.operatorId !== input.operatorId || control.revision !== stored!.revision
        || control.nowMs !== stored!.atMs || !Object.values(control.cases).some((row) => row.pin.worldId === input.worldId
          && row.pin.operatorId === input.operatorId && row.pin.trainRunId === input.trainRunId
          && row.policeHoldId === hold!.holdId && hold!.caseIds.includes(row.caseId))) reject("conductor_police_operator_mismatch");
    }
    return { worker, row, restored };
  }
  function receipt(state: OperationalSimulationState, trainRunId: string): ControlOperationalHoldReceipt | undefined {
    const value = state.world["fareControlState"];
    if (value === undefined || value === null) return undefined;
    const hold = demandRecord(demandRecord(value)["holds"])[trainRunId] as ControlOperationalHold | undefined;
    if (hold === undefined) return undefined;
    if (hold.worldId !== state.world.worldId || hold.trainRunId !== trainRunId) reject("conductor_police_hold_mismatch");
    return { hold, operationalStateHash: state.stateHash, nowMs: state.world.nowMs };
  }
  async function apply(tx: IdentityDatabase, input: { worldId: string; operatorId: string; trainRunId: string; causalityId: string }, command: OperationalSimulationCommandPayload) {
    const { worker, row, restored } = await load(tx, input);
    const [world] = await tx.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, input.worldId));
    if (world === undefined) reject("conductor_police_world_missing");
    // Metadata time derives from committed world time. The native payload has no wall clock.
    const result = await worker.apply({ worldId: input.worldId, regionId: row.regionId,
      commandId: `fare-control:${input.causalityId}`, command }, new Date(world!.epoch.getTime() + restored.state.world.nowMs));
    return receipt(result.state, input.trainRunId) ?? reject("conductor_police_hold_missing");
  }
  return {
    async request(tx, context, input) {
      const binding = context.projectionInput.binding;
      return apply(tx, { worldId: binding.worldId, operatorId: binding.operatorId, trainRunId: binding.trainRunId, causalityId: input.causalityId },
        { type: "request-fare-control-hold", request: { trainId: binding.trainRunId, ...input } });
    },
    async read(tx, input) { const { restored } = await load(tx, input, true); return receipt(restored.state, input.trainRunId); },
    async resolve(tx, input) {
      return apply(tx, input, { type: "resolve-fare-control-hold", resolution: { trainId: input.trainRunId,
        holdId: input.holdId, expectedRevision: input.expectedRevision, modelHash: input.modelHash, outcome: input.outcome, causalityId: input.causalityId } });
    },
  };
}
