import { regionalSimulationStates, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { OperationalSimulationRuntime, OperationalSimulationState } from "@zugfolge/runtime-native";
import { and, eq, inArray } from "drizzle-orm";
import type { ConductorControlService } from "./conductor-control.js";

/** Reads committed native clocks under the same world writer as monetary/physical effects. */
export async function advanceConductorControlWorld(input: {
  readonly db: IdentityDatabase; readonly worldId: string;
  readonly regions: readonly { regionId: string; initializationHash: string }[];
  readonly runtime: Pick<OperationalSimulationRuntime, "restore">;
  readonly control: Pick<ConductorControlService, "advanceWorld">;
}): Promise<boolean> {
  if (input.regions.length === 0) return false;
  return input.db.transaction(async (tx) => {
    const [world] = await tx.select({ status: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, input.worldId)).for("update");
    if (world?.status !== "active") return false;
    const heads = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, input.worldId),
      inArray(regionalSimulationStates.regionId, input.regions.map((row) => row.regionId))));
    if (heads.length !== input.regions.length) return false;
    const times: number[] = [];
    for (const binding of input.regions) {
      const head = heads.find((row) => row.regionId === binding.regionId);
      if (head === undefined || head.initializationHash !== binding.initializationHash)
        throw new Error("conductor_control_region_pin_mismatch");
      const restored = input.runtime.restore(head.state as OperationalSimulationState, binding.initializationHash);
      if (restored.stateHash !== head.stateHash || restored.state.revision !== head.revision
        || restored.state.publisherSequence !== head.publisherSequence || restored.state.world.worldId !== input.worldId
        || restored.state.world.regionId !== head.regionId)
        throw new Error("conductor_control_region_state_mismatch");
      times.push(restored.state.world.nowMs);
    }
    const nowMs = times[0]!;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || times.some((time) => time !== nowMs)) return false;
    await input.control.advanceWorld(tx, input.worldId, nowMs);
    return true;
  });
}
