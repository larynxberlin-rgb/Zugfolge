import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export interface SigningKey {
  readonly id: string;
  readonly secret: string;
  readonly activeFrom: Date;
  readonly activeUntil?: Date;
}

export interface SignedPayload<T> {
  readonly keyId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly payload: T;
}

export class WebhookSignatureError extends Error {
  constructor(readonly code: "unknown_key" | "inactive_key" | "expired" | "invalid") {
    super(`Odoo-Webhook-Signatur abgelehnt: ${code}.`);
    this.name = "WebhookSignatureError";
  }
}

function signingInput(timestamp: string, payload: unknown): string {
  return `${timestamp}.${canonicalJson(payload)}`;
}

function digest(secret: string, timestamp: string, payload: unknown): Buffer {
  return createHmac("sha256", secret).update(signingInput(timestamp, payload), "utf8").digest();
}

export function signPayload<T>(payload: T, key: SigningKey, now = new Date()): SignedPayload<T> {
  if (now < key.activeFrom || (key.activeUntil !== undefined && now > key.activeUntil)) {
    throw new WebhookSignatureError("inactive_key");
  }
  const timestamp = now.toISOString();
  return { keyId: key.id, timestamp, signature: digest(key.secret, timestamp, payload).toString("hex"), payload };
}

export function verifyPayload<T>(
  signed: SignedPayload<T>,
  keys: readonly SigningKey[],
  now = new Date(),
  maximumAgeMs = 5 * 60_000,
): T {
  const key = keys.find((candidate) => candidate.id === signed.keyId);
  if (key === undefined) throw new WebhookSignatureError("unknown_key");
  if (now < key.activeFrom || (key.activeUntil !== undefined && now > key.activeUntil)) {
    throw new WebhookSignatureError("inactive_key");
  }
  const timestamp = new Date(signed.timestamp);
  if (Number.isNaN(timestamp.getTime()) || Math.abs(now.getTime() - timestamp.getTime()) > maximumAgeMs) {
    throw new WebhookSignatureError("expired");
  }
  const supplied = Buffer.from(signed.signature, "hex");
  const expected = digest(key.secret, signed.timestamp, signed.payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new WebhookSignatureError("invalid");
  }
  return signed.payload;
}
