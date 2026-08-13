import { describe, expect, it } from "vitest";

import { parseTutorialBidInput } from "./tutorial-input.js";

const limits = {
  minimumOrderingFeeCentsPerTrainKm: "100",
  maximumOrderingFeeCentsPerTrainKm: "1520",
  defaultOrderingFeeCentsPerTrainKm: "1450",
  minimumPunctualityBasisPoints: 8800,
  maximumPunctualityBasisPoints: 9800,
  defaultPunctualityBasisPoints: 9200,
  minimumExtraSeats: 0,
  maximumExtraSeats: 40,
  defaultExtraSeats: 12,
} as const;

describe("sichtbare Tutorialeinheiten", () => {
  it("wandelt 14,50 Euro und 92,00 Prozent exakt in Cent und Basispunkte", () => {
    expect(parseTutorialBidInput({ orderingFeeEuro: "14,50", punctualityPercent: "92,00", extraSeats: "12" }, limits)).toEqual({
      type: "submit-bid", orderingFeeCentsPerTrainKm: "1450", punctualityBasisPoints: 9200, extraSeats: 12,
    });
  });

  it("verweigert mehr als die sichtbaren Fachgrenzen und mehrdeutige Einheiten", () => {
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "15,21", punctualityPercent: "92,00", extraSeats: "12" }, limits)).toThrow(/15,20/);
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "14,50", punctualityPercent: "100,01", extraSeats: "12" }, limits)).toThrow(/98,00/);
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "14.5", punctualityPercent: "92,00", extraSeats: "12" }, limits)).toThrow(/Nachkommastellen/);
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "14,50", punctualityPercent: "92,00", extraSeats: "41" }, limits)).toThrow(/zwischen 0 und 40/);
  });

  it("verwendet ausschließlich die Grenzen des empfangenen Tutorialvertrags", () => {
    const contracted = {
      ...limits,
      minimumOrderingFeeCentsPerTrainKm: "1300",
      maximumOrderingFeeCentsPerTrainKm: "1400",
      minimumPunctualityBasisPoints: 9100,
      maximumPunctualityBasisPoints: 9300,
      minimumExtraSeats: 10,
      maximumExtraSeats: 20,
    };
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "14,50", punctualityPercent: "92,00", extraSeats: "12" }, contracted)).toThrow(/13,00 € und 14,00 €/);
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "13,50", punctualityPercent: "90,00", extraSeats: "12" }, contracted)).toThrow(/91,00 % und 93,00 %/);
    expect(() => parseTutorialBidInput({ orderingFeeEuro: "13,50", punctualityPercent: "92,00", extraSeats: "9" }, contracted)).toThrow(/zwischen 10 und 20/);
  });
});
