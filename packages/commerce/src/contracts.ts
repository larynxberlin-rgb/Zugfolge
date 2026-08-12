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
  "admin.manual_disruption_create",
  "admin.abuse_sanction_activate",
  "admin.world_close",
  "admin.tutorial_account_reset",
] as const;
export type OdooCommandType = (typeof COMMAND_TYPES)[number];

/**
 * Dieser Katalog ist absichtlich klein und versioniert. Eine Odoo-Ansicht darf
 * nie eine neue Game-Macht nur durch Konfiguration erfinden: Jede weitere
 * Aktion braucht zuerst eine Game-Implementierung, einen Vertrag und Tests.
 */
export const ADMIN_ACTION_TYPES = [
  "world_access_revoke",
  "infra_release_adoption",
  "manual_disruption_create",
  "abuse_sanction_activate",
  "world_close",
  "tutorial_account_reset",
] as const;
export type AdminActionType = (typeof ADMIN_ACTION_TYPES)[number];

export type GameAdminCapabilityAvailability = "prepared" | "available" | "unavailable";

/** Signierte Game-Projektion; nur ein echter Game-Handler darf `available` melden. */
export interface GameAdminCapabilityProjection {
  readonly actionType: AdminActionType;
  readonly availability: GameAdminCapabilityAvailability;
  readonly detail?: string;
}

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

export interface ManualDisruption {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cause: string;
  readonly affectedResourceIds: readonly string[];
  readonly declaredEffect: Readonly<Record<string, unknown>>;
}

export interface AdminCommandPayload {
  readonly kind: Exclude<OdooCommandType, "entitlement.change">;
  readonly worldId: string;
  readonly actionType: AdminActionType;
  readonly riskClass: RiskClass;
  readonly requesterReference: string;
  readonly approverReference?: string;
  readonly reason: string;
  readonly effectPreview: Readonly<Record<string, unknown>>;
  readonly releaseHash?: string;
  readonly requestedPeriodStart?: string;
  readonly targetReference?: string;
  readonly requestedAtS?: number;
  /**
   * Vertrag fuer M8.3: Odoo erfasst die Pflichtdaten, die Game-Implementierung
   * prueft Ressourcen, Zeitpunkt und Wirkung erst bei ihrer spaeteren
   * fachlichen Ausfuehrung.
   */
  readonly manualDisruption?: ManualDisruption;
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
  readonly messageType: "world.projection" | "admin.command.result" | "admin.capability.projection" | "reconciliation.task";
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

export function isAdminActionType(value: unknown): value is AdminActionType {
  return typeof value === "string" && (ADMIN_ACTION_TYPES as readonly string[]).includes(value);
}
