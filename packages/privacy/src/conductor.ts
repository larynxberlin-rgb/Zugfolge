import { conductorCommandReceipts, conductorLeases, conductorOwners, conductorSnapshots } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { and, asc, eq } from "drizzle-orm";

/** Ausschließlich eigene bereits sichtbare Sitzungsdaten; keine verdeckten Fallfakten. */
export async function exportConductorPersonalData(db: IdentityDatabase, worldId: string, accountId: string) {
  const [owner] = await db.select().from(conductorOwners).where(and(eq(conductorOwners.worldId, worldId), eq(conductorOwners.accountId, accountId)));
  if (owner === undefined) return { ownerRef: null, leases: [], receipts: [], snapshots: [] };
  const leases = await db.select().from(conductorLeases).where(and(eq(conductorLeases.worldId, worldId), eq(conductorLeases.accountId, accountId)));
  const receipts = await db.select().from(conductorCommandReceipts).where(and(eq(conductorCommandReceipts.worldId, worldId), eq(conductorCommandReceipts.ownerRef, owner.ownerRef)))
    .orderBy(asc(conductorCommandReceipts.trainRunId), asc(conductorCommandReceipts.commandId));
  const snapshots = await db.select().from(conductorSnapshots).where(and(eq(conductorSnapshots.worldId, worldId), eq(conductorSnapshots.ownerRef, owner.ownerRef)))
    .orderBy(asc(conductorSnapshots.trainRunId), asc(conductorSnapshots.sequence));
  return { ownerRef: owner.ownerRef, leases, receipts, snapshots };
}

/** Unter Weltmutex: Private Zuordnung entfernen, unabhängige synthetische Fälle erhalten. */
export async function eraseConductorPersonalData(tx: IdentityDatabase, worldId: string, accountId: string): Promise<void> {
  const [owner] = await tx.select().from(conductorOwners).where(and(eq(conductorOwners.worldId, worldId), eq(conductorOwners.accountId, accountId)));
  await tx.delete(conductorLeases).where(and(eq(conductorLeases.worldId, worldId), eq(conductorLeases.accountId, accountId)));
  if (owner === undefined) return;
  await tx.delete(conductorCommandReceipts).where(and(eq(conductorCommandReceipts.worldId, worldId), eq(conductorCommandReceipts.ownerRef, owner.ownerRef)));
  await tx.delete(conductorSnapshots).where(and(eq(conductorSnapshots.worldId, worldId), eq(conductorSnapshots.ownerRef, owner.ownerRef)));
  await tx.delete(conductorOwners).where(and(eq(conductorOwners.worldId, worldId), eq(conductorOwners.accountId, accountId)));
}
