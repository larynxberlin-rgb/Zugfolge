import { describe, expect, it } from "vitest";
import {
  conflictsForTrain,
  extent,
  formatMinute,
  pathPoints,
  sampleData,
  shiftedData,
  stationY,
} from "./diagram.js";
describe("Bildfahrplan-Domänenadapter", () => {
  it("skaliert Betriebsstellen und Zeiten aus den Daten", () => {
    expect(stationY(sampleData, "halle")).toBeLessThan(
      stationY(sampleData, "leipzig"),
    );
    expect(
      pathPoints(sampleData, sampleData.trains[0]!).split(" "),
    ).toHaveLength(4);
    expect(extent(sampleData)).toEqual([425, 490]);
  });
  it("formatiert Zeit und weist unbekannte Betriebsstellen zurück", () => {
    expect(formatMinute(449)).toBe("07:29");
    expect(() => stationY(sampleData, "nirgendwo")).toThrow(
      "Unbekannte Betriebsstelle",
    );
  });
  it("bildet alle sechs fachlichen Sperrzeitanteile ab", () =>
    expect(new Set(sampleData.occupations.map((o) => o.phase))).toEqual(
      new Set([
        "formation",
        "approach",
        "running",
        "clearing",
        "release",
        "buffer",
      ]),
    ));
  it("ordnet Konflikte ausschließlich beteiligten Zügen zu", () => {
    expect(conflictsForTrain(sampleData, "t1").map((c) => c.id)).toEqual([
      "c1",
    ]);
    expect(conflictsForTrain(sampleData, "t3").map((c) => c.kind)).toEqual([
      "exclusion",
    ]);
  });
  it("wendet eine ausreichende Alternative unveränderlich auf Lauf und Belegung an", () => {
    const shifted = shiftedData(sampleData, "t1", 3);
    expect(shifted.trains[0]!.calls[0]!.minute).toBe(433);
    expect(shifted.occupations[0]!.startMinute).toBe(449);
    expect(conflictsForTrain(shifted, "t1")).toHaveLength(0);
    expect(shifted.conflicts.map((c) => c.id)).toEqual(["c2"]);
    expect(sampleData.trains[0]!.calls[0]!.minute).toBe(430);
  });
  it("behält den Konflikt bei einer zu kleinen Verschiebung bei", () =>
    expect(
      conflictsForTrain(shiftedData(sampleData, "t1", 2), "t1").map(
        (c) => c.id,
      ),
    ).toEqual(["c1"]));
});
