import { describe, expect, it } from "vitest";
import { formatMinute, pathPoints, stationY, trains } from "./diagram.js";
describe("Bildfahrplan-Geometrie", () => {
  it("ordnet Betriebsstellen kilometrisch und Zeiten chronologisch an", () => {
    expect(stationY("halle")).toBeLessThan(stationY("leipzig"));
    const points = pathPoints(trains[0]!);
    expect(points.split(" ")).toHaveLength(4);
  });
  it("formatiert die Zeit mit Tabellenziffern", () => expect(formatMinute(449)).toBe("07:29"));
  it("weist unbekannte Betriebsstellen zurück", () => expect(() => stationY("nirgendwo")).toThrow("Unbekannte Betriebsstelle"));
});
