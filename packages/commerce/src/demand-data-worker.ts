import { odooCommandQueue, odooProjectionOutbox, type OdooCommandQueueRow } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import { ODOO_CONTRACT_VERSION, type DemandDataUpdatePayload } from "./contracts.js";
import { validateDemandDataResult, validateDemandDataUpdate, type DemandDataCommandHandler } from "./demand-data.js";
import { OdooCommandClaimLostError, type CommerceDatabase, type ProcessedOdooCommand } from "./store.js";

/** Datenwirkung, Queue und knappe Rückmeldung teilen genau eine DB-Transaktion. */
export async function processDemandDataCommand(
  db: CommerceDatabase,
  command: OdooCommandQueueRow,
  claimToken: string,
  now: Date,
  handler: DemandDataCommandHandler | undefined,
): Promise<ProcessedOdooCommand> {
  if (command.worldId === null) throw new TypeError("Nachfragedaten benötigen eine Weltbindung.");
  const scope = and(eq(odooCommandQueue.id, command.id), eq(odooCommandQueue.worldId, command.worldId),
    eq(odooCommandQueue.status, "processing"), eq(odooCommandQueue.claimToken, claimToken));
  let payload: DemandDataUpdatePayload;
  try {
    validateDemandDataUpdate(command.payload);
    if (command.payload.worldId !== command.worldId) throw new TypeError("Nachfragedaten besitzen eine fremde Weltbindung.");
    payload = command.payload;
  } catch {
    const rejected = await db.update(odooCommandQueue).set({ status: "rejected", processedAt: now,
      claimToken: null, claimExpiresAt: null, failureCode: "demand_data_invalid_payload" }).where(scope).returning({ id: odooCommandQueue.id });
    if (rejected.length !== 1) throw new OdooCommandClaimLostError(command.id);
    // Ein historischer beschädigter Payload kann keine gültige Ergebnisreferenz bilden.
    return { id: command.id, outcome: "rejected", code: "demand_data_invalid_payload" };
  }
  try {
    return await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: odooCommandQueue.id }).from(odooCommandQueue).where(scope).limit(1).for("update");
      if (owned === undefined) throw new OdooCommandClaimLostError(command.id);
      if (handler === undefined) throw new Error("Nachfragedaten-Handler ist nicht verfügbar.");
      const result = await handler({ payload, commandId: command.id, eventId: command.eventId,
        correlationId: command.correlationId, receivedAt: command.receivedAt, now, db: tx });
      validateDemandDataResult(result);
      const finalized = await tx.update(odooCommandQueue).set({ status: result.outcome === "accepted" ? "completed" : "rejected",
        processedAt: now, claimToken: null, claimExpiresAt: null, failureCode: result.code ?? null }).where(scope).returning({ id: odooCommandQueue.id });
      if (finalized.length !== 1) throw new OdooCommandClaimLostError(command.id);
      await tx.insert(odooProjectionOutbox).values({ worldId: payload.worldId, messageType: "demand.data.result",
        schemaVersion: ODOO_CONTRACT_VERSION, correlationId: command.correlationId,
        payload: { baseReleaseId: payload.baseReleaseId, sourceRevision: payload.sourceRevision, outcome: result.outcome,
          ...(result.code === undefined ? {} : { code: result.code }), ...(result.detail === undefined ? {} : { detail: result.detail }) },
        occurredAt: now, enqueuedAt: now });
      return { id: command.id, outcome: result.outcome, ...(result.code === undefined ? {} : { code: result.code }) };
    });
  } catch (error) {
    if (error instanceof OdooCommandClaimLostError) throw error;
    // Der Handler und jede folgende Quittierung sind bereits zurückgerollt.
    const released = await db.update(odooCommandQueue).set({ status: "pending", processedAt: null,
      claimToken: null, claimExpiresAt: null, failureCode: null }).where(scope).returning({ id: odooCommandQueue.id });
    if (released.length !== 1) throw new OdooCommandClaimLostError(command.id);
    throw error;
  }
}
