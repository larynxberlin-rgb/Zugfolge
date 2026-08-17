import { describe, expect, it } from "vitest";

import {
  formatAvailableFinance,
  formatEuroCents,
  parsePlayerOperatorContext,
  PlayerContextContractError,
} from "./index.js";

const finite = {
  schemaVersion: "zugfolge-operator-context/v1",
  worldId: "world-1",
  operators: [{
    id: "operator-1",
    name: "Saale-Sprinter",
    finance: {
      mode: "finite",
      ledgerBalanceCents: "284050000",
      pendingDebitCents: "5000",
      availableCents: "284045000",
    },
  }],
};

describe("Spieler-Kontextvertrag", () => {
  it("bindet EVU und verfuegbare Liquiditaet an die erwartete Welt", () => {
    const parsed = parsePlayerOperatorContext(finite, "world-1");
    expect(parsed.operators[0]).toMatchObject({
      id: "operator-1",
      finance: { mode: "finite", availableCents: "284045000" },
    });
  });

  it("verwirft fremde Welten, Doppelungen und rechnerisch inkonsistente Werte", () => {
    expect(() => parsePlayerOperatorContext(finite, "world-2")).toThrow(/anderen Welt/);
    expect(() => parsePlayerOperatorContext({ ...finite, operators: [finite.operators[0], finite.operators[0]] }))
      .toThrow(/doppelt/);
    expect(() => parsePlayerOperatorContext({
      ...finite,
      operators: [{ ...finite.operators[0]!, finance: { ...finite.operators[0]!.finance, availableCents: "284050000" } }],
    })).toThrow(/nicht konsistent/);
  });

  it("haelt unbegrenzt strikt von numerischen Nullwerten getrennt", () => {
    const parsed = parsePlayerOperatorContext({
      ...finite,
      operators: [{ id: "operator-1", name: "Saale-Sprinter", finance: { mode: "unlimited" } }],
    });
    expect(formatAvailableFinance(parsed.operators[0]!.finance)).toBe("Unbegrenzt");
    expect(() => parsePlayerOperatorContext({
      ...finite,
      operators: [{ id: "operator-1", name: "Saale-Sprinter", finance: { mode: "unlimited", availableCents: "0" } }],
    })).toThrow(PlayerContextContractError);
  });

  it("formatiert grosse und negative Centwerte ohne Number-Praezisionsverlust", () => {
    expect(formatEuroCents("284050000")).toBe("2.840.500,00 €");
    expect(formatEuroCents("-1234")).toBe("−12,34 €");
  });
});
