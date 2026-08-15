export const PUBLIC_REGIONAL_TRAIN_NUMBER_MINIMUM = 39_000;
export const PUBLIC_REGIONAL_TRAIN_NUMBER_MAXIMUM = 39_999;

function compareUtf8(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministische, weltweite Reservierung fuer die importierten oeffentlichen
 * Regionalfahrten. Der Bereich bleibt getrennt von den Spielerfahrten
 * (20.000 bis 38.999), damit auch spaetere Planungen keine Nummer duplizieren.
 */
export function allocatePublicRegionalTrainNumbers(
  trainRunIds: Iterable<string>,
): ReadonlyMap<string, number> {
  const identifiers = [...trainRunIds];
  if (identifiers.some((identifier) => identifier.trim() === "")) {
    throw new RangeError("Oeffentliche Zuglaufkennungen duerfen nicht leer sein.");
  }
  const unique = [...new Set(identifiers)].sort(compareUtf8);
  if (unique.length !== identifiers.length) {
    throw new RangeError("Oeffentliche Zuglaufkennungen muessen eindeutig sein.");
  }
  const capacity = PUBLIC_REGIONAL_TRAIN_NUMBER_MAXIMUM
    - PUBLIC_REGIONAL_TRAIN_NUMBER_MINIMUM
    + 1;
  if (unique.length > capacity) {
    throw new RangeError("Der reservierte Zugnummernbereich fuer oeffentliche Regionalfahrten ist ausgeschoepft.");
  }
  return new Map(unique.map((identifier, index) => [
    identifier,
    PUBLIC_REGIONAL_TRAIN_NUMBER_MINIMUM + index,
  ]));
}

export function publicRegionalTrainNumber(
  line: string,
  trainRunId: string,
  allocated: ReadonlyMap<string, number>,
): string {
  const number = allocated.get(trainRunId);
  if (number === undefined) {
    throw new RangeError(`Fuer oeffentliche Fahrt '${trainRunId}' ist keine Zugnummer reserviert.`);
  }
  const prefix = line.trim() || "SPNV";
  return `${prefix}-${number}`;
}
