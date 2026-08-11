import { Buffer } from "node:buffer";

/** Rust-kompatible lexikografische Ordnung der tatsaechlichen UTF-8-Bytes. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
