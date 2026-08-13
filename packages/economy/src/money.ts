/** Exakter Wertebereich von PostgreSQL `bigint` und Rust `i64`. */
export const MIN_I64 = -9_223_372_036_854_775_808n;
export const MAX_I64 = 9_223_372_036_854_775_807n;

export function assertI64(value: bigint, name: string): bigint {
  if (value < MIN_I64 || value > MAX_I64) {
    throw new RangeError(`${name} ueberschreitet den i64-Wertebereich.`);
  }
  return value;
}

export function assertNonnegativeI64(value: bigint, name: string): bigint {
  if (value < 0n) throw new RangeError(`${name} darf nicht negativ sein.`);
  return assertI64(value, name);
}

export function addI64(left: bigint, right: bigint, name: string): bigint {
  return assertI64(left + right, name);
}

export function subtractI64(left: bigint, right: bigint, name: string): bigint {
  return assertI64(left - right, name);
}

export function multiplyNonnegativeI64(left: bigint, right: bigint, name: string): bigint {
  assertNonnegativeI64(left, name);
  assertNonnegativeI64(right, name);
  return assertNonnegativeI64(left * right, name);
}
