import { createHash } from "node:crypto";

import { odooProjectionOutbox, odooReconciliationTasks } from "@zugfolge/db";
import { isNotNull } from "drizzle-orm";

import { canonicalJson } from "./canonical-json.js";
import { signPayload, type SigningKey } from "./signing.js";
import type { CommerceDatabase } from "./store.js";

export interface OdooReconciliationObservation {
  readonly messageId: string;
  readonly worldId: string;
  readonly correlationId: string;
  readonly payloadHash: string;
}

export interface OdooReconciliationClient {
  snapshot(): Promise<readonly OdooReconciliationObservation[]>;
}

export function createHttpOdooReconciliationClient(
  url: string,
  key: SigningKey,
  fetchImplementation: (input: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }> = globalThis.fetch,
): OdooReconciliationClient {
  return {
    async snapshot() {
      const payload = { schemaVersion: "zugfolge-odoo/v1", requestedAt: new Date().toISOString() };
      const signed = signPayload(payload, key);
      const response = await fetchImplementation(url, { method: "POST", headers: { "content-type": "application/json", "x-zugfolge-odoo-key-id": signed.keyId, "x-zugfolge-odoo-timestamp": signed.timestamp, "x-zugfolge-odoo-signature": signed.signature }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Odoo-Reconciliation antwortete mit HTTP ${response.status}.`);
      const parsed = await response.json();
      const value = typeof parsed === "object" && parsed !== null && "result" in parsed ? (parsed as { result: unknown }).result : parsed;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || typeof (item as Record<string, unknown>)["messageId"] !== "string" || typeof (item as Record<string, unknown>)["worldId"] !== "string" || typeof (item as Record<string, unknown>)["correlationId"] !== "string" || typeof (item as Record<string, unknown>)["payloadHash"] !== "string")) {
        throw new Error("Odoo-Reconciliation-Snapshot hat ein ungueltiges Schema.");
      }
      return value as OdooReconciliationObservation[];
    },
  };
}

export interface ReconciliationTaskInput {
  readonly messageId: string;
  readonly worldId: string;
  readonly correlationId: string;
  readonly issueKind: "missing" | "duplicate" | "divergent";
  readonly expectedHash: string;
  readonly observedHash?: string;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * Reconciliation ermittelt nur Befunde. Der Rückgabewert ist absichtlich kein
 * Patch: weder Game noch Odoo werden bei einer Differenz still überschrieben.
 */
export function deriveReconciliationTasks(
  expected: readonly { readonly id: string; readonly worldId: string; readonly correlationId: string; readonly payload: unknown }[],
  observed: readonly OdooReconciliationObservation[],
): readonly ReconciliationTaskInput[] {
  const observedByMessage = new Map<string, OdooReconciliationObservation[]>();
  for (const observation of observed) {
    const list = observedByMessage.get(observation.messageId) ?? [];
    list.push(observation);
    observedByMessage.set(observation.messageId, list);
  }
  const tasks: ReconciliationTaskInput[] = [];
  for (const message of expected) {
    const expectedHash = hashPayload(message.payload);
    const matches = observedByMessage.get(message.id) ?? [];
    if (matches.length === 0) {
      tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "missing", expectedHash });
      continue;
    }
    if (matches.length > 1) {
      tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "duplicate", expectedHash, observedHash: matches[0]?.payloadHash });
    }
    const first = matches[0]!;
    if (first.worldId !== message.worldId || first.correlationId !== message.correlationId || first.payloadHash !== expectedHash) {
      tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "divergent", expectedHash, observedHash: first.payloadHash });
    }
  }
  return tasks;
}

export async function reconcileOdooProjectionSnapshot(
  db: CommerceDatabase,
  observed: readonly OdooReconciliationObservation[],
  now = new Date(),
): Promise<readonly ReconciliationTaskInput[]> {
  // guards:allow world-id — Der globale Abgleich enumeriert gelieferte Belege; erzeugte Aufgaben tragen deren Welt-ID.
  const expected = await db
    .select({ id: odooProjectionOutbox.id, worldId: odooProjectionOutbox.worldId, correlationId: odooProjectionOutbox.correlationId, payload: odooProjectionOutbox.payload })
    .from(odooProjectionOutbox)
    .where(isNotNull(odooProjectionOutbox.deliveredAt));
  const tasks = deriveReconciliationTasks(expected, observed);
  for (const task of tasks) {
    await db.insert(odooReconciliationTasks).values({ ...task, status: "open", createdAt: now }).onConflictDoNothing();
  }
  return tasks;
}
