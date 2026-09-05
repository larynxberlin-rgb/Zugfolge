import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";

import { odooProjectionOutbox, odooReconciliationTasks, odooProjectionQuarantine } from "@zugfolge/db";

import { canonicalJson } from "./canonical-json.js";
import { signPayload, type SigningKey } from "./signing.js";
import type { CommerceDatabase } from "./store.js";

export const ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA = "zugfolge-projection-envelope-sha256/v1";

export interface OdooReconciliationObservation {
  readonly messageId: string;
  readonly worldId: string;
  readonly correlationId: string;
  readonly payloadHash: string;
  readonly envelopeHashSchema: string | null;
  readonly envelopeHash: string | null;
}

export interface OdooReconciliationClient {
  snapshot(worldId: string): Promise<readonly OdooReconciliationObservation[]>;
}

export function createHttpOdooReconciliationClient(
  url: string,
  key: SigningKey,
  fetchImplementation: (input: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }> = globalThis.fetch,
): OdooReconciliationClient {
  return {
    async snapshot(worldId) {
      if (worldId.length === 0) throw new Error("Odoo-Reconciliation benoetigt eine Serverwelt.");
      const payload = { schemaVersion: "zugfolge-odoo/v1", worldId, requestedAt: new Date().toISOString() };
      const signed = signPayload(payload, key);
      const response = await fetchImplementation(url, { method: "POST", headers: { "content-type": "application/json", "x-zugfolge-odoo-key-id": signed.keyId, "x-zugfolge-odoo-timestamp": signed.timestamp, "x-zugfolge-odoo-signature": signed.signature }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Odoo-Reconciliation antwortete mit HTTP ${response.status}.`);
      const parsed = await response.json();
      const value = typeof parsed === "object" && parsed !== null && "result" in parsed ? (parsed as { result: unknown }).result : parsed;
      if (!Array.isArray(value) || value.some((item) => {
        if (typeof item !== "object" || item === null) return true;
        const observation = item as Record<string, unknown>;
        return typeof observation["messageId"] !== "string"
          || typeof observation["worldId"] !== "string"
          || typeof observation["correlationId"] !== "string"
          || typeof observation["payloadHash"] !== "string"
          || (observation["envelopeHashSchema"] !== null && typeof observation["envelopeHashSchema"] !== "string")
          || (observation["envelopeHash"] !== null && typeof observation["envelopeHash"] !== "string");
      })) {
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
  readonly issueKind: "missing" | "duplicate" | "divergent" | "unknown";
  readonly expectedHash: string;
  readonly observedHash?: string;
}

export interface OdooReconciliationExpectedProjection {
  readonly deliveredAt?: Date | null;
  readonly id: string;
  readonly schemaVersion: string;
  readonly messageType: string;
  readonly worldId: string;
  readonly correlationId: string;
  readonly occurredAt: Date | string;
  readonly payload: unknown;
}

export function projectionEnvelopeHash(message: OdooReconciliationExpectedProjection): string {
  const occurredAt = message.occurredAt instanceof Date
    ? message.occurredAt.toISOString()
    : message.occurredAt;
  return createHash("sha256").update(canonicalJson({
    schemaVersion: message.schemaVersion,
    messageId: message.id,
    messageType: message.messageType,
    worldId: message.worldId,
    correlationId: message.correlationId,
    occurredAt,
    payload: message.payload,
  }), "utf8").digest("hex");
}

/**
 * Reconciliation ermittelt nur Befunde. Der Rückgabewert ist absichtlich kein
 * Patch: weder Game noch Odoo werden bei einer Differenz still überschrieben.
 */
export function deriveReconciliationTasks(
  expected: readonly OdooReconciliationExpectedProjection[],
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
    const expectedHash = projectionEnvelopeHash(message);
    const matches = observedByMessage.get(message.id) ?? [];
    if (matches.length === 0) {
      if (message.deliveredAt !== null) tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "missing", expectedHash });
      continue;
    }
    if (matches.length > 1) {
      tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "duplicate", expectedHash, observedHash: matches[0]?.envelopeHash ?? undefined });
    }
    const first = matches[0]!;
    if (first.worldId !== message.worldId
        || first.correlationId !== message.correlationId
        || first.envelopeHashSchema !== ODOO_PROJECTION_ENVELOPE_HASH_SCHEMA
        || first.envelopeHash !== expectedHash) {
      tasks.push({ messageId: message.id, worldId: message.worldId, correlationId: message.correlationId, issueKind: "divergent", expectedHash, observedHash: first.envelopeHash ?? undefined });
    }
  }
  const expectedIds = new Set(expected.map((message) => message.id));
  const unknownIds = new Set<string>();
  for (const observation of observed) {
    const key = JSON.stringify([observation.worldId, observation.messageId]);
    if (expectedIds.has(observation.messageId) || unknownIds.has(key)) continue;
    unknownIds.add(key);
    tasks.push({ messageId: observation.messageId, worldId: observation.worldId, correlationId: observation.correlationId,
      issueKind: "unknown", expectedHash: "", observedHash: observation.envelopeHash ?? observation.payloadHash });
  }
  return tasks;
}

export async function reconcileOdooProjectionSnapshot(
  db: CommerceDatabase,
  observed: readonly OdooReconciliationObservation[],
  now = new Date(),
  worldId?: string,
): Promise<readonly ReconciliationTaskInput[]> {
  // guards:allow world-id — Der globale Abgleich enumeriert auch bekannte Belege ohne Empfangsbestaetigung; jeder Befund behaelt seinen Scope.
  const expected = await db
    .select({
      id: odooProjectionOutbox.id,
      schemaVersion: odooProjectionOutbox.schemaVersion,
      messageType: odooProjectionOutbox.messageType,
      worldId: odooProjectionOutbox.worldId,
      correlationId: odooProjectionOutbox.correlationId,
      occurredAt: odooProjectionOutbox.occurredAt,
      payload: odooProjectionOutbox.payload,
      deliveredAt: odooProjectionOutbox.deliveredAt,
    })
    .from(odooProjectionOutbox)
    .where(worldId === undefined ? undefined : or(
      eq(odooProjectionOutbox.worldId, worldId),
      eq(odooProjectionOutbox.worldId, "00000000-0000-0000-0000-000000000000"),
    ));
  // Das zentrale Odoo darf weitere Server bedienen. Globale Capabilities
  // gehoeren nur bei bekannter lokaler Message-ID zu diesem Server.
  const localGlobalIds = new Set(expected.filter((message) => message.worldId === "00000000-0000-0000-0000-000000000000").map((message) => message.id));
  const scopedObserved = worldId === undefined ? observed : observed.filter((message) =>
    message.worldId === worldId || (message.worldId === "00000000-0000-0000-0000-000000000000" && localGlobalIds.has(message.messageId)));
  // Nur vor Beginn des externen Snapshots bestaetigte Nachrichten koennen
  // dort bereits fehlen. Spaetere Acks bleiben bekannte ausstehende Belege.
  const tasks = deriveReconciliationTasks(expected.map((message) => ({ ...message,
    deliveredAt: message.deliveredAt !== null && message.deliveredAt.getTime() <= now.getTime() ? message.deliveredAt : null,
  })), scopedObserved);
  for (const task of tasks) {
    if (task.issueKind === "unknown") {
      await db.insert(odooProjectionQuarantine).values({ worldId: task.worldId, messageId: task.messageId, correlationId: task.correlationId,
        observedHash: task.observedHash, issueKind: task.issueKind, status: "open", createdAt: now }).onConflictDoNothing();
    } else {
      await db.insert(odooReconciliationTasks).values({ ...task, issueKind: task.issueKind, status: "open", createdAt: now }).onConflictDoNothing();
    }
  }
  return tasks;
}
