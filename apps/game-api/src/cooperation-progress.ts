import type { CooperationService } from "@zugfolge/cooperation";
import { worlds } from "@zugfolge/db";
import { backfillFleetVehicleRegistry, type EconomyDatabase } from "@zugfolge/economy";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { applyConfiguredVehicleValuations, type VehicleValuationCatalog } from "./vehicle-valuation-configuration.js";

/** Derselbe serverseitige Fortschritt vor Aktionen und während Spieler offline sind. */
export async function advanceCooperationWorld(
  db: EconomyDatabase, cooperation: CooperationService, worldId: string, atS: number,
  valuationCatalog?: VehicleValuationCatalog,
): Promise<void> {
  const [world] = await db.select({ lifecycle: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (world?.lifecycle !== "active") return;
  await backfillFleetVehicleRegistry(db, worldId);
  const valuationConfiguration = valuationCatalog?.[worldId];
  if (valuationConfiguration !== undefined) await applyConfiguredVehicleValuations(db, valuationConfiguration, atS);
  await cooperation.advanceVehicleValuations(worldId, atS);
  await cooperation.advanceMarket(worldId, atS);
  await cooperation.advanceContracts(worldId, atS);
  await cooperation.advanceInsolvencies(worldId, atS);
}

export function registerCooperationProgress(app: FastifyInstance, deps: {
  readonly worldIds: readonly string[];
  readonly advance: (worldId: string) => Promise<void>;
  readonly intervalMs?: number;
}): void {
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const progress = () => {
    if (running !== undefined) return;
    running = (async () => {
      for (const worldId of deps.worldIds) {
        try { await deps.advance(worldId); }
        catch (error) { app.log.error({ err: error, worldId }, "Kooperationsfortschritt wartet auf betriebliche Freigabe oder Datenkorrektur."); }
      }
    })().finally(() => { running = undefined; });
  };
  app.addHook("onReady", async () => {
    progress();
    await running;
    timer = setInterval(progress, deps.intervalMs ?? 15_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer !== undefined) clearInterval(timer);
    await running;
  });
}
