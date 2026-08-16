export const PLAYER_OPERATOR_CONTEXT_SCHEMA = "zugfolge-operator-context/v1" as const;

export type OperatorFinanceSummaryV1 =
  | {
      readonly mode: "finite";
      readonly ledgerBalanceCents: string;
      readonly pendingDebitCents: string;
      readonly availableCents: string;
    }
  | { readonly mode: "unlimited" };

export interface PlayerOperatorSummaryV1 {
  readonly id: string;
  readonly name: string;
  readonly finance: OperatorFinanceSummaryV1;
}

export interface PlayerOperatorContextV1 {
  readonly schemaVersion: typeof PLAYER_OPERATOR_CONTEXT_SCHEMA;
  readonly worldId: string;
  readonly operators: readonly PlayerOperatorSummaryV1[];
}

export class PlayerContextContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerContextContractError";
  }
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlayerContextContractError(`${name} ist kein Objekt.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlayerContextContractError(`${name} ist kein nichtleerer Textwert.`);
  }
  return value;
}

function signedCents(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new PlayerContextContractError(`${name} ist kein kanonischer Integer-Centstring.`);
  }
  const cents = BigInt(value);
  if (cents < -9_223_372_036_854_775_808n || cents > 9_223_372_036_854_775_807n) {
    throw new PlayerContextContractError(`${name} liegt ausserhalb des i64-Bereichs.`);
  }
  return value;
}

function finance(value: unknown, name: string): OperatorFinanceSummaryV1 {
  const item = record(value, name);
  if (item["mode"] === "unlimited") {
    if (Object.keys(item).length !== 1) {
      throw new PlayerContextContractError(`${name} darf bei unbegrenzter Liquiditaet keine Centwerte enthalten.`);
    }
    return Object.freeze({ mode: "unlimited" });
  }
  if (item["mode"] !== "finite") {
    throw new PlayerContextContractError(`${name}.mode ist unbekannt.`);
  }
  const ledgerBalanceCents = signedCents(item["ledgerBalanceCents"], `${name}.ledgerBalanceCents`);
  const pendingDebitCents = signedCents(item["pendingDebitCents"], `${name}.pendingDebitCents`);
  const availableCents = signedCents(item["availableCents"], `${name}.availableCents`);
  if (BigInt(pendingDebitCents) < 0n) {
    throw new PlayerContextContractError(`${name}.pendingDebitCents darf nicht negativ sein.`);
  }
  if (BigInt(ledgerBalanceCents) - BigInt(pendingDebitCents) !== BigInt(availableCents)) {
    throw new PlayerContextContractError(`${name} ist rechnerisch nicht konsistent.`);
  }
  return Object.freeze({ mode: "finite", ledgerBalanceCents, pendingDebitCents, availableCents });
}

export function parsePlayerOperatorContext(value: unknown, expectedWorldId?: string): PlayerOperatorContextV1 {
  const context = record(value, "Spielerkontext");
  if (context["schemaVersion"] !== PLAYER_OPERATOR_CONTEXT_SCHEMA) {
    throw new PlayerContextContractError("Spielerkontext besitzt kein unterstuetztes Schema.");
  }
  const worldId = nonEmptyText(context["worldId"], "Spielerkontext.worldId");
  if (expectedWorldId !== undefined && worldId !== expectedWorldId) {
    throw new PlayerContextContractError("Spielerkontext gehoert zu einer anderen Welt.");
  }
  if (!Array.isArray(context["operators"])) {
    throw new PlayerContextContractError("Spielerkontext.operators ist keine Liste.");
  }
  const operatorIds = new Set<string>();
  const operators = context["operators"].map((value, index) => {
    const name = `Spielerkontext.operators[${index}]`;
    const item = record(value, name);
    const id = nonEmptyText(item["id"], `${name}.id`);
    if (operatorIds.has(id)) throw new PlayerContextContractError(`${name}.id ist doppelt.`);
    operatorIds.add(id);
    return Object.freeze({
      id,
      name: nonEmptyText(item["name"], `${name}.name`),
      finance: finance(item["finance"], `${name}.finance`),
    });
  });
  return Object.freeze({ schemaVersion: PLAYER_OPERATOR_CONTEXT_SCHEMA, worldId, operators: Object.freeze(operators) });
}

/** Exakte, BigInt-sichere Eurodarstellung fuer Konten- und Ledgerwerte. */
export function formatEuroCents(value: string): string {
  const cents = BigInt(signedCents(value, "Geldbetrag"));
  const sign = cents < 0n ? "−" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${(absolute / 100n).toLocaleString("de-DE")},${(absolute % 100n).toString().padStart(2, "0")} €`;
}

export function formatAvailableFinance(financeSummary: OperatorFinanceSummaryV1): string {
  return financeSummary.mode === "unlimited" ? "Unbegrenzt" : formatEuroCents(financeSummary.availableCents);
}
