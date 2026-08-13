import type { OdooWebhookEnvelope } from "./contracts.js";
import { isAdminActionType, isOdooCommandType, isProductKind, ODOO_CONTRACT_VERSION, validateWorldParticipationChange } from "./contracts.js";
import { validateAdminCommand } from "./admin-workflow.js";
import type { SignedPayload, SigningKey } from "./signing.js";
import { verifyPayload } from "./signing.js";

export class WebhookValidationError extends Error {
  constructor(readonly code: "schema" | "tenant" | "authorization" | "command") {
    super(`Odoo-Webhook wurde abgelehnt: ${code}.`);
    this.name = "WebhookValidationError";
  }
}

export interface OdooWebhookReceiptStore {
  /** Liefert false bei schon persistierter Event-ID, atomar mit dem Queue-Eintrag. */
  receive(envelope: OdooWebhookEnvelope, signatureKeyId: string, receivedAt: Date): Promise<boolean>;
}

export interface OdooWebhookReceiverOptions {
  readonly tenantId: string;
  readonly keys: readonly SigningKey[];
  readonly authorizedActors: Readonly<Record<string, readonly string[]>>;
  readonly maximumAgeMs?: number;
}

function validateShape(envelope: OdooWebhookEnvelope): void {
  if (envelope.schemaVersion !== ODOO_CONTRACT_VERSION || envelope.eventType !== "commerce.command") {
    throw new WebhookValidationError("schema");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(envelope.eventId) || envelope.correlationId.length < 8) {
    throw new WebhookValidationError("schema");
  }
  if (!isOdooCommandType(envelope.command.kind)) throw new WebhookValidationError("command");
  if (envelope.command.kind === "entitlement.change") {
    if (!isProductKind(envelope.command.productKind) || envelope.command.quantity < 1 || !Number.isSafeInteger(envelope.command.quantity)) {
      throw new WebhookValidationError("command");
    }
    if (Number.isNaN(new Date(envelope.command.validFrom).getTime())) throw new WebhookValidationError("command");
    return;
  }
  if (envelope.command.kind === "world.participation.change") {
    try { validateWorldParticipationChange(envelope.command); } catch {
      throw new WebhookValidationError("command");
    }
    return;
  }
  if (envelope.command.worldId.length === 0 || !isAdminActionType(envelope.command.actionType)) throw new WebhookValidationError("command");
  validateAdminCommand(envelope.command);
}

export async function receiveOdooWebhook(
  store: OdooWebhookReceiptStore,
  signed: SignedPayload<OdooWebhookEnvelope>,
  options: OdooWebhookReceiverOptions,
  now = new Date(),
): Promise<{ readonly accepted: boolean; readonly duplicate: boolean }> {
  const envelope = verifyPayload(signed, options.keys, now, options.maximumAgeMs);
  validateShape(envelope);
  if (envelope.tenantId !== options.tenantId) throw new WebhookValidationError("tenant");
  const permitted = options.authorizedActors[envelope.actorReference];
  if (permitted === undefined || !permitted.includes(envelope.command.kind)) {
    throw new WebhookValidationError("authorization");
  }
  const inserted = await store.receive(envelope, signed.keyId, now);
  return { accepted: true, duplicate: !inserted };
}
