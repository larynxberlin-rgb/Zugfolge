import type { EntitlementChangePayload, ProductKind } from "./contracts.js";

export interface EntitlementRecord {
  readonly subject: string;
  readonly productKind: ProductKind;
  readonly status: "active" | "revoked" | "expired";
  readonly validFrom: Date;
  readonly validUntil?: Date;
  readonly quantity: number;
}

export interface EntitlementFeatures {
  readonly activePublicWorldLimit: number;
  readonly cosmetics: boolean;
  readonly mayCreatePrivateUnrankedWorld: boolean;
}

/** Keine Spielwerte, Informationsvorspruenge oder Automatisierung im Ergebnis. */
export function entitlementFeatures(records: readonly EntitlementRecord[], at = new Date()): EntitlementFeatures {
  const active = records.filter((record) => record.status === "active" && record.validFrom <= at && (record.validUntil === undefined || record.validUntil > at));
  const extraSlots = active.filter((record) => record.productKind === "public_world_slot").reduce((sum, record) => sum + record.quantity, 0);
  const plus = active.some((record) => record.productKind === "zugfolge_plus");
  return {
    activePublicWorldLimit: 1 + (plus ? 2 : 0) + extraSlots,
    cosmetics: active.some((record) => record.productKind === "cosmetic"),
    mayCreatePrivateUnrankedWorld: active.some((record) => record.productKind === "private_unranked_world"),
  };
}

export function entitlementChangeToStatus(change: EntitlementChangePayload["change"]): EntitlementRecord["status"] {
  if (change === "revoke") return "revoked";
  if (change === "expire") return "expired";
  return "active";
}

export class PublicWorldSlotError extends Error {
  constructor() {
    super("Die Anzahl gleichzeitig aktiver oeffentlicher Welten uebersteigt das Entitlement-Limit.");
    this.name = "PublicWorldSlotError";
  }
}

export function assertPublicWorldSlot(records: readonly EntitlementRecord[], activePublicWorlds: number, at = new Date()): void {
  if (activePublicWorlds >= entitlementFeatures(records, at).activePublicWorldLimit) throw new PublicWorldSlotError();
}

export class PrivateWorldEntitlementError extends Error {
  constructor() {
    super("Eine private Welt braucht ein aktives Entitlement für private, ungewertete Welten.");
    this.name = "PrivateWorldEntitlementError";
  }
}

export function assertPrivateWorldEntitlement(records: readonly EntitlementRecord[], at = new Date()): void {
  if (!entitlementFeatures(records, at).mayCreatePrivateUnrankedWorld) throw new PrivateWorldEntitlementError();
}
