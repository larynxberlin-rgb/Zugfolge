import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Alpha-Zustand enthaelt keine sichere Ganzzahl.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError("Alpha-Zustand enthaelt einen nicht kanonisierbaren Wert.");
}

export function alphaHash(schema: string, value: unknown): string {
  return createHash("sha256").update(canonical({ schema, value }), "utf8").digest("hex");
}

export function pseudonym(secret: string, subject: string): string {
  return createHash("sha256").update(`${secret}\u0000${subject}`, "utf8").digest("hex");
}
