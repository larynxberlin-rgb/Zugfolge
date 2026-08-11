/** Matches Rust `String::cmp`: lexicographic ordering of UTF-8 bytes. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
