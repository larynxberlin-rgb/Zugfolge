import { describe, expect, it } from "vitest";

import {
  allocatePublicRegionalTrainNumbers,
  publicRegionalTrainNumber,
} from "./train-numbers.js";

describe("oeffentliche Regionalzugnummern", () => {
  it("vergibt unabhaengig von der Eingabereihenfolge eindeutige fuenfstellige Nummern", () => {
    const first = allocatePublicRegionalTrainNumbers(["fahrt-z", "fahrt-a"]);
    const second = allocatePublicRegionalTrainNumbers(["fahrt-a", "fahrt-z"]);

    expect([...first]).toEqual([...second]);
    expect(publicRegionalTrainNumber("S4", "fahrt-a", first)).toBe("S4-39000");
    expect(publicRegionalTrainNumber("S4", "fahrt-z", first)).toBe("S4-39001");
  });

  it("verweigert doppelte Fahrten statt doppelte Nummern zu erzeugen", () => {
    expect(() => allocatePublicRegionalTrainNumbers(["fahrt-a", "fahrt-a"]))
      .toThrow(/eindeutig/);
  });

  it("verweigert eine Ueberbelegung des reservierten Bereichs", () => {
    const identifiers = Array.from({ length: 1_001 }, (_, index) => `fahrt-${index}`);
    expect(() => allocatePublicRegionalTrainNumbers(identifiers)).toThrow(/ausgeschoepft/);
  });
});
