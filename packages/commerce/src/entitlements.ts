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
  readonly cosmetics: boolean;
}

/** Keine Spielwerte, Informationsvorspruenge oder Automatisierung im Ergebnis. */
export function entitlementFeatures(records: readonly EntitlementRecord[], at = new Date()): EntitlementFeatures {
  const active = records.filter((record) => record.status === "active" && record.validFrom <= at && (record.validUntil === undefined || record.validUntil > at));
  return {
    cosmetics: active.some((record) => record.productKind === "cosmetic"),
  };
}

export function entitlementChangeToStatus(change: EntitlementChangePayload["change"]): EntitlementRecord["status"] {
  if (change === "revoke") return "revoked";
  if (change === "expire") return "expired";
  return "active";
}
