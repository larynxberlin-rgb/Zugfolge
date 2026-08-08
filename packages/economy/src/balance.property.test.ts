import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isBalanced, sumEntries } from "./balance.js";

/**
 * Property-Test auf Ausgeglichenheit (M2.4): Egal, welche Buchungsbeträge
 * eine Transaktion versammelt — sobald die letzte Buchung genau den
 * Gegenwert der übrigen trägt, ist die Transaktion ausgeglichen. Und egal,
 * wie eine ausgeglichene Menge von Buchungen umsortiert wird, bleibt sie
 * ausgeglichen: Doppelte Buchführung kennt keine Reihenfolge.
 */

const centAmount = fc.bigInt({ min: -1_000_000_000_00n, max: 1_000_000_000_00n });

describe("Ausgeglichenheit einer Ledger-Transaktion", () => {
  it("ist immer ausgeglichen, sobald die letzte Buchung den Gegenwert der übrigen trägt", () => {
    fc.assert(
      fc.property(fc.array(centAmount, { minLength: 1, maxLength: 50 }), (amounts) => {
        const ausgleichsbuchung = -sumEntries(amounts);
        expect(isBalanced([...amounts, ausgleichsbuchung])).toBe(true);
      }),
    );
  });

  it("bleibt ausgeglichen, unabhängig von der Reihenfolge der Buchungen", () => {
    fc.assert(
      fc.property(fc.array(centAmount, { minLength: 1, maxLength: 50 }), (amounts) => {
        const ausgeglichen = [...amounts, -sumEntries(amounts)];
        const umgekehrt = [...ausgeglichen].reverse();
        const sortiert = [...ausgeglichen].sort((links, rechts) => (links < rechts ? -1 : links > rechts ? 1 : 0));
        expect(isBalanced(umgekehrt)).toBe(true);
        expect(isBalanced(sortiert)).toBe(true);
      }),
    );
  });

  it("meldet jede Menge von Buchungen mit einer Summe ungleich null als unausgeglichen", () => {
    fc.assert(
      fc.property(
        fc.array(centAmount, { minLength: 1, maxLength: 50 }).filter((amounts) => sumEntries(amounts) !== 0n),
        (amounts) => {
          expect(isBalanced(amounts)).toBe(false);
        },
      ),
    );
  });

  it("die leere Buchungsmenge gilt als ausgeglichen — null Cent ist null Cent", () => {
    expect(isBalanced([])).toBe(true);
    expect(sumEntries([])).toBe(0n);
  });
});
