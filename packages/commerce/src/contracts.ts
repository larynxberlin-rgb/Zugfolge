/** Versionierter, minimaler Vertrag an der Odoo-Grenze (E23). */
export const ODOO_CONTRACT_VERSION = "zugfolge-odoo/v1";
export const AUTHORITATIVE_WORLD_START_PROJECTION = "zugfolge-authoritative-world-start-projection/v1" as const;

export const PRODUCT_KINDS = [
  "zugfolge_plus",
  "cosmetic",
  "public_world_slot",
  "private_unranked_world",
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const COMMAND_TYPES = [
  "entitlement.change",
  "world.participation.change",
  "demand.data.update",
  "admin.world_access_revoke",
  "admin.infra_release_adoption",
  "admin.manual_disruption_create",
  "admin.disruption_policy_schedule",
  "admin.abuse_sanction_activate",
  "admin.world_close",
  "admin.world_deploy",
  "admin.alpha_invitation_create",
  "admin.alpha_invitation_resend",
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
  "disruption_policy_schedule",
  "abuse_sanction_activate",
  "world_close",
  "world_deploy",
  "alpha_invitation_create",
  "alpha_invitation_resend",
] as const;
export type AdminActionType = (typeof ADMIN_ACTION_TYPES)[number];

export type GameAdminCapabilityAvailability = "prepared" | "available" | "unavailable";

/** Signierte Game-Projektion; nur ein echter Game-Handler darf `available` melden. */
export interface GameAdminCapabilityProjection {
  readonly actionType: AdminActionType;
  readonly availability: GameAdminCapabilityAvailability;
  readonly detail?: string;
  /** Pre-world world_deploy transportiert global, bindet aber genau einen Zielserver. */
  readonly targetWorldId?: string;
}

export type RiskClass = "standard" | "high";

/**
 * JSON-Vertrag der Startkapital-Policy. Geldbetraege verlassen die
 * Integer-Cent-Domaene ausschliesslich als kanonischer Dezimalstring.
 */
export type SerializedStartingCapitalPolicy =
  | {
      readonly mode: "finite";
      readonly amountCents: string;
    }
  | {
      readonly mode: "unlimited";
    };

export interface WorldDefinition {
  readonly name: string;
  readonly kind: "public" | "private" | "test";
  readonly rankingStatus: "ranked" | "unranked";
  readonly schedulePeriodWeeks: number;
  readonly epoch: string;
}

/** Vollstaendiges, ausserhalb Odoos signiertes Deployment-Artefakt. */
export interface SignedWorldDeployment {
  readonly deployment: Readonly<Record<string, unknown>>;
  readonly deploymentHash: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly valueBase64: string;
  };
}

export const WORLD_PARTICIPATION_CONTRACT_VERSION = "zugfolge-world-participation/v1" as const;

export interface WorldParticipationChangePayload {
  readonly kind: "world.participation.change";
  readonly schemaVersion: typeof WORLD_PARTICIPATION_CONTRACT_VERSION;
  readonly action: "provision" | "cancel" | "refund";
  readonly worldId: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
  readonly odooPartnerReference: string;
  readonly odooOrderReference: string;
  readonly paymentReference: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

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
  /** Monotoner Zustand derselben Belegquelle; Transport-/Retryzeit hat keine Prioritaet. */
  readonly sourceRevision?: number;
}

export function validateEntitlementChange(payload: EntitlementChangePayload): void {
  if (!isProductKind(payload.productKind) || !["grant", "renew", "revoke", "restore", "expire"].includes(payload.change)
    || typeof payload.subject !== "string" || payload.subject.length === 0
    || typeof payload.sourceReference !== "string" || payload.sourceReference.length === 0
    || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1
    || typeof payload.validFrom !== "string" || !Number.isFinite(new Date(payload.validFrom).getTime())
    || (payload.validUntil !== undefined && (typeof payload.validUntil !== "string" || !Number.isFinite(new Date(payload.validUntil).getTime()) || new Date(payload.validUntil) <= new Date(payload.validFrom)))
    || (payload.sourceRevision !== undefined && (!Number.isSafeInteger(payload.sourceRevision) || payload.sourceRevision < 1))) {
    throw new Error("Ungueltiger Entitlement-Lifecycle-Befehl.");
  }
}

export interface ManualDisruption {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cause: string;
  readonly affectedResourceIds: readonly string[];
  readonly declaredEffect: Readonly<Record<string, unknown>>;
}

export interface DisruptionPolicySchedule {
  readonly schemaVersion: "zugfolge-disruption-policy-schedule/v1";
  /** Verifizierte OIDC-Bindung des Odoo-Antragstellers, kein frei gewaehltes Konto. */
  readonly requesterSubject: string;
  readonly effectiveAt: string;
  readonly plannedWorksMode: "REALISTIC" | "SIMULATED" | "MANUAL";
  readonly operationalIncidentMode: "REALISTIC" | "SIMULATED" | "MANUAL";
  readonly providerSetId?: string;
  readonly simulationProfile: Readonly<Record<string, unknown>>;
  readonly rulesetVersion: string;
}

export interface AdminCommandPayload {
  readonly kind: Exclude<OdooCommandType, "entitlement.change" | "world.participation.change" | "demand.data.update">;
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
  readonly startingCapitalPolicy?: SerializedStartingCapitalPolicy;
  readonly worldDefinition?: WorldDefinition;
  readonly signedDeployment?: SignedWorldDeployment;
  readonly deploymentHash?: string;
  readonly deploymentRevision?: number;
  readonly invitation?: {
    readonly requestReference: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: "player" | "world_admin";
    readonly keycloakSubject?: string;
  };
  /**
   * Vertrag fuer M8.3: Odoo erfasst die Pflichtdaten, die Game-Implementierung
   * prueft Ressourcen, Zeitpunkt und Wirkung erst bei ihrer spaeteren
   * fachlichen Ausfuehrung.
   */
  readonly manualDisruption?: ManualDisruption;
  readonly disruptionPolicy?: DisruptionPolicySchedule;
}

/** Normales Speichern von Nachfragestammdaten; kein administrativer Freigabeantrag. */
export interface DemandDataUpdatePayload {
  readonly kind: "demand.data.update";
  readonly schemaVersion: "zugfolge-demand-data-update/v1";
  readonly worldId: string;
  readonly sourceRevision: number;
  readonly baseReleaseId: string;
  readonly populationModel: Readonly<Record<string, unknown>>;
  readonly zonePopulations: readonly { readonly zoneId: string; readonly population: number }[];
}

export type OdooCommandPayload = EntitlementChangePayload | WorldParticipationChangePayload | DemandDataUpdatePayload | AdminCommandPayload;

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
  readonly messageType: "world.projection" | "public.world.snapshot" | "world.participation.result" | "demand.data.result" | "alpha.feedback.projection" | "admin.command.result" | "admin.capability.projection" | "reconciliation.task";
  readonly worldId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuthoritativeWorldStartAuthorization {
  readonly schemaVersion: typeof AUTHORITATIVE_WORLD_START_PROJECTION;
  readonly deploymentHash: string;
  readonly deploymentRevision: number;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly valueBase64: string;
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

export class WorldParticipationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldParticipationValidationError";
  }
}

export function validateWorldParticipationChange(payload: WorldParticipationChangePayload): void {
  if (payload.kind !== "world.participation.change" || payload.schemaVersion !== WORLD_PARTICIPATION_CONTRACT_VERSION) {
    throw new WorldParticipationValidationError("Unbekannter Weltteilnahmevertrag.");
  }
  if (!("provision cancel refund".split(" ") as readonly string[]).includes(payload.action)) {
    throw new WorldParticipationValidationError("Unbekannte Weltteilnahmeaktion.");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(payload.worldId)) {
    throw new WorldParticipationValidationError("Weltteilnahme braucht eine gueltige world_id.");
  }
  for (const [name, value, minimum] of [
    ["keycloakSubject", payload.keycloakSubject, 1],
    ["displayName", payload.displayName, 1],
    ["odooPartnerReference", payload.odooPartnerReference, 1],
    ["odooOrderReference", payload.odooOrderReference, 1],
    ["paymentReference", payload.paymentReference, 1],
    ["idempotencyKey", payload.idempotencyKey, 8],
  ] as const) {
    if (value.trim().length < minimum || value.length > 255) throw new WorldParticipationValidationError(`${name} ist ungueltig.`);
  }
  if (Number.isNaN(new Date(payload.requestedAt).getTime())) {
    throw new WorldParticipationValidationError("Weltteilnahme braucht einen gueltigen Zeitstempel.");
  }
}
