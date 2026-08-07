/**
 * Das reine Kernstück des Ledgers (M2.4): eine Transaktion ist ausgeglichen,
 * wenn die Summe ihrer Buchungen exakt null Cent ergibt — die technische
 * Übersetzung von „unveränderlich, ausgeglichen, doppelte Buchführung".
 *
 * Bewusst ohne Datenbank, ohne Uhr, ohne Zufall: Nur diese Rechenregel macht
 * sie property-testbar (`balance.property.test.ts`), unabhängig von jeder
 * Persistenz.
 */

/** Summe aller Beträge einer Transaktion, in Integer-Cent. */
export function sumEntries(amountsCents: readonly bigint[]): bigint {
  return amountsCents.reduce((sum, amount) => sum + amount, 0n);
}

/** Ob eine Menge von Buchungsbeträgen ausgeglichen ist — Summe exakt null. */
export function isBalanced(amountsCents: readonly bigint[]): boolean {
  return sumEntries(amountsCents) === 0n;
}
