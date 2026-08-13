import { describe, expect, it } from "vitest";

import {
  formatStartingCapitalPolicyGerman,
  MAX_STARTING_CAPITAL_CENTS,
  parseStartingCapitalPolicy,
  serializeStartingCapitalPolicy,
  StartingCapitalPolicyValidationError,
} from "./starting-capital.js";

describe("StartingCapitalPolicy", () => {
  it("parst und serialisiert endliche Centbetraege verlustfrei", () => {
    const parsed = parseStartingCapitalPolicy({ mode: "finite", amountCents: "1000000" });

    expect(parsed).toEqual({ mode: "finite", amountCents: 1_000_000n });
    expect(serializeStartingCapitalPolicy(parsed)).toEqual({ mode: "finite", amountCents: "1000000" });
  });

  it("erlaubt den ausdruecklichen Nullstart", () => {
    expect(parseStartingCapitalPolicy({ mode: "finite", amountCents: "0" })).toEqual({
      mode: "finite",
      amountCents: 0n,
    });
  });

  it("stellt unbegrenztes Kapital ohne Zahlenersatz dar", () => {
    const parsed = parseStartingCapitalPolicy({ mode: "unlimited" });

    expect(parsed).toEqual({ mode: "unlimited" });
    expect(serializeStartingCapitalPolicy(parsed)).toEqual({ mode: "unlimited" });
    expect(formatStartingCapitalPolicyGerman(parsed)).toBe("∞");
  });

  it.each([
    { mode: "finite", amountCents: -1 },
    { mode: "finite", amountCents: "-1" },
    { mode: "finite", amountCents: "+1" },
    { mode: "finite", amountCents: "01" },
    { mode: "finite", amountCents: "1.5" },
    { mode: "finite", amountCents: "1e3" },
    { mode: "finite", amountCents: "Infinity" },
    { mode: "unlimited", amountCents: "0" },
    { mode: "finite", amountCents: "0", extra: true },
  ])("weist nichtkanonische oder mehrdeutige Policy zurueck: $amountCents", (value) => {
    expect(() => parseStartingCapitalPolicy(value)).toThrow(StartingCapitalPolicyValidationError);
  });

  it("begrenzt Betraege auf den i64-Centbereich", () => {
    expect(parseStartingCapitalPolicy({ mode: "finite", amountCents: MAX_STARTING_CAPITAL_CENTS.toString() })).toEqual({
      mode: "finite",
      amountCents: MAX_STARTING_CAPITAL_CENTS,
    });
    expect(() => parseStartingCapitalPolicy({
      mode: "finite",
      amountCents: (MAX_STARTING_CAPITAL_CENTS + 1n).toString(),
    })).toThrow(StartingCapitalPolicyValidationError);
  });

  it("formatiert Centbetraege deutsch und ohne Gleitkommazahl", () => {
    expect(formatStartingCapitalPolicyGerman({ mode: "finite", amountCents: 0n })).toBe("0,00 €");
    expect(formatStartingCapitalPolicyGerman({ mode: "finite", amountCents: 1n })).toBe("0,01 €");
    expect(formatStartingCapitalPolicyGerman({ mode: "finite", amountCents: 1_000_000n })).toBe("10.000,00 €");
    expect(formatStartingCapitalPolicyGerman({ mode: "finite", amountCents: MAX_STARTING_CAPITAL_CENTS })).toBe(
      "92.233.720.368.547.758,07 €",
    );
  });
});
