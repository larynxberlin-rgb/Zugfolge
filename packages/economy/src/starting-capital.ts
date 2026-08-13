import { MAX_I64 } from "./money.js";

/** Groesster in PostgreSQL `bigint` und im Simulationskern als `i64` darstellbarer Centbetrag. */
export const MAX_STARTING_CAPITAL_CENTS = MAX_I64;

/** Fachliche Startkapital-Policy. Unbegrenztheit ist niemals ein Zahlenwert. */
export type StartingCapitalPolicy =
  | { readonly mode: "finite"; readonly amountCents: bigint }
  | { readonly mode: "unlimited" };

/** JSON-/Event-/Deployment-Darstellung mit kanonischem Dezimalstring. */
export type SerializedStartingCapitalPolicy =
  | { readonly mode: "finite"; readonly amountCents: string }
  | { readonly mode: "unlimited" };

export class StartingCapitalPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartingCapitalPolicyValidationError";
  }
}

const DECIMAL_CENTS = /^(0|[1-9][0-9]*)$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function finiteAmount(amountCents: bigint): bigint {
  if (amountCents < 0n) {
    throw new StartingCapitalPolicyValidationError("Startkapital darf nicht negativ sein.");
  }
  if (amountCents > MAX_STARTING_CAPITAL_CENTS) {
    throw new StartingCapitalPolicyValidationError("Startkapital ueberschreitet den i64-Centbereich.");
  }
  return amountCents;
}

/** Parst ausschliesslich die kanonische externe Darstellung. */
export function parseStartingCapitalPolicy(value: unknown): StartingCapitalPolicy {
  if (!record(value) || typeof value.mode !== "string") {
    throw new StartingCapitalPolicyValidationError("Startkapital-Policy ist kein gueltiges Objekt.");
  }
  if (value.mode === "unlimited") {
    if (!exactKeys(value, ["mode"])) {
      throw new StartingCapitalPolicyValidationError("Unbegrenztes Startkapital darf keinen Betrag enthalten.");
    }
    return Object.freeze({ mode: "unlimited" });
  }
  if (value.mode !== "finite" || !exactKeys(value, ["amountCents", "mode"]) || typeof value.amountCents !== "string") {
    throw new StartingCapitalPolicyValidationError("Endliches Startkapital braucht genau einen Dezimalstring amountCents.");
  }
  if (!DECIMAL_CENTS.test(value.amountCents)) {
    throw new StartingCapitalPolicyValidationError("Startkapital muss ein nichtnegativer kanonischer Dezimalstring sein.");
  }
  return Object.freeze({ mode: "finite", amountCents: finiteAmount(BigInt(value.amountCents)) });
}

/** Serialisiert die Fachpolicy ohne `Number`, Gleitkommazahl oder Infinity. */
export function serializeStartingCapitalPolicy(policy: StartingCapitalPolicy): SerializedStartingCapitalPolicy {
  if (policy.mode === "unlimited") {
    return Object.freeze({ mode: "unlimited" });
  }
  if (policy.mode !== "finite" || typeof policy.amountCents !== "bigint") {
    throw new StartingCapitalPolicyValidationError("Unbekannte Startkapital-Policy.");
  }
  return Object.freeze({ mode: "finite", amountCents: finiteAmount(policy.amountCents).toString() });
}

/** Exakte deutsche Anzeige; `unlimited` wird ausschliesslich als Unendlichkeitszeichen dargestellt. */
export function formatStartingCapitalPolicyGerman(policy: StartingCapitalPolicy): string {
  if (policy.mode === "unlimited") return "∞";
  const amountCents = finiteAmount(policy.amountCents);
  const euros = (amountCents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = (amountCents % 100n).toString().padStart(2, "0");
  return `${euros},${cents} €`;
}
