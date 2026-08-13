import type { TutorialAction, TutorialBidLimitsView } from "./api.js";

function decimalParts(value: string, name: string): readonly [string, string] {
  const match = /^(0|[1-9][0-9]*),([0-9]{2})$/.exec(value.trim());
  if (match === null) throw new Error(`${name} braucht genau zwei Nachkommastellen.`);
  return [match[1]!, match[2]!];
}

/** Wandelt ausschließlich sichtbare Tutorialeinheiten in den API-Fachvertrag um. */
export function parseTutorialBidInput(input: {
  readonly orderingFeeEuro: string;
  readonly punctualityPercent: string;
  readonly extraSeats: string;
}, limits: TutorialBidLimitsView): Extract<TutorialAction, { readonly type: "submit-bid" }> {
  const [feeEuros, feeDecimals] = decimalParts(input.orderingFeeEuro, "Bestellerentgelt");
  const orderingFeeCents = BigInt(feeEuros) * 100n + BigInt(feeDecimals);
  const minimumFeeCents = BigInt(limits.minimumOrderingFeeCentsPerTrainKm);
  const maximumFeeCents = BigInt(limits.maximumOrderingFeeCentsPerTrainKm);
  if (orderingFeeCents < minimumFeeCents || orderingFeeCents > maximumFeeCents) {
    throw new Error(`Bestellerentgelt muss zwischen ${formatCents(minimumFeeCents)} und ${formatCents(maximumFeeCents)} je Zug-km liegen.`);
  }

  const [percentUnits, percentDecimals] = decimalParts(input.punctualityPercent, "Pünktlichkeitsversprechen");
  const punctualityBasisPoints = Number(percentUnits) * 100 + Number(percentDecimals);
  if (!Number.isSafeInteger(punctualityBasisPoints)
    || punctualityBasisPoints < limits.minimumPunctualityBasisPoints
    || punctualityBasisPoints > limits.maximumPunctualityBasisPoints) {
    throw new Error(`Pünktlichkeitsversprechen muss zwischen ${formatBasisPoints(limits.minimumPunctualityBasisPoints)} und ${formatBasisPoints(limits.maximumPunctualityBasisPoints)} liegen.`);
  }

  if (!/^(0|[1-9][0-9]*)$/.test(input.extraSeats)) throw new Error("Zusätzliche Sitzplätze müssen eine ganze Zahl sein.");
  const extraSeats = Number(input.extraSeats);
  if (!Number.isSafeInteger(extraSeats) || extraSeats < limits.minimumExtraSeats || extraSeats > limits.maximumExtraSeats) {
    throw new Error(`Zusätzliche Sitzplätze müssen zwischen ${limits.minimumExtraSeats} und ${limits.maximumExtraSeats} liegen.`);
  }
  return { type: "submit-bid", orderingFeeCentsPerTrainKm: orderingFeeCents.toString(), punctualityBasisPoints, extraSeats };
}

function formatCents(cents: bigint): string {
  return `${cents / 100n},${(cents % 100n).toString().padStart(2, "0")} €`;
}

function formatBasisPoints(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)},${String(basisPoints % 100).padStart(2, "0")} %`;
}
