/** Versionierter, minimaler Vertrag an der Odoo-Grenze (E23). */
export const ODOO_CONTRACT_VERSION = "zugfolge-odoo/v1";

export const PRODUCT_KINDS = [
  "zugfolge_plus",
  "cosmetic",
  "public_world_slot",
  "private_unranked_world",
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const COMMAND_TYPES = [
  "entitlement.change",
  "admin.world_access_revoke",
  "admin.infra_release_adoption",
] as const;
export type OdooCommandType = (typeof COMMAND_TYPES)[number];

export type RiskClass = "standard" | "high";

export interface EntitlementChangePayload {
  readonly kind: "entitlement.change";
  readonly subject: string;
  readonly productKind: ProductKind;
  readonly change: "grant" | "renew" | "revoke" | "restore" | "expire";
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly quantity: number;
  /** Odoo-Belegreferenz, kein Zahlungsinstrument und keine Personaldaten. */
  readonly sourceReference: string;
}

export interface AdminCommandPayload {
  readonly kind: Exclude<OdooCommandType, "entitlement.change">;
  readonly worldId: string;
  readonly actionType: "world_access_revoke" | "infra_release_adoption";
  readonly riskClass: RiskClass;
  readonly requesterReference: string;
  readonly approverReference?: string;
  readonly reason: string;
  readonly effectPreview: Readonly<Record<string, unknown>>;
  readonly releaseHash?: string;
  readonly requestedPeriodStart?: string;
}

export type OdooCommandPayload = EntitlementChangePayload | AdminCommandPayload;

export interface OdooWebhookEnvelope {
  readonly schemaVersion: typeof ODOO_CONTRACT_VERSION;
  readonly eventId: string;
  readonly eventType: "commerce.command";
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly actorReference: string;
  readonly command: OdooCommandPayload;
}

export interface OdooProjectionEnvelope {
  readonly schemaVersion: typeof ODOO_CONTRACT_VERSION;
  readonly messageId: string;
  readonly messageType: "world.projection" | "admin.command.result" | "reconciliation.task";
  readonly worldId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function isProductKind(value: unknown): value is ProductKind {
  return typeof value === "string" && (PRODUCT_KINDS as readonly string[]).includes(value);
}

export function isOdooCommandType(value: unknown): value is OdooCommandType {
  return typeof value === "string" && (COMMAND_TYPES as readonly string[]).includes(value);
}
