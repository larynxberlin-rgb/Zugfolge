import { describe, expect, it } from "vitest";
import type { PublicTrain } from "@zugfolge/livemap-stream";

import { trainMapPositionSummary } from "./panels.js";

const baseTrain: PublicTrain = {
  id: "train-1",
  operator: "EVU Beispiel",
  trainNumber: "RV 20001",
  category: "RV",
  positionMm: 100,
  speedMmPerSecond: 10,
  delaySeconds: 0,
  nextOperatingPoint: "Leipzig Hbf",
  status: "running",
};

describe("Zugpanel-Kartenlage", () => {
  it("nennt bei bestaetigter Lage das reale Gleis und den exakten Offset", () => {
    const summary = trainMapPositionSummary({
      ...baseTrain,
      mapPosition: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "resource-1",
        trackId: "track-7",
        offsetMm: 25_000,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
      },
    });

    expect(summary.definitions).toEqual([
      { term: "Kartenlage", value: "bestätigt" },
      { term: "Infrastrukturstand", value: "infra-de-2026" },
      { term: "Gleis", value: "track-7" },
      { term: "Position", value: "25 m" },
    ]);
    expect(summary.note).toBeUndefined();
  });

  it("erklaert eine Korridorschaetzung grob und verschweigt den technischen Darstellungspfad", () => {
    const summary = trainMapPositionSummary({
      ...baseTrain,
      mapEstimate: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "resource-1",
        method: "route-corridor",
        displayPathId: "track-secret-display-path",
        displayOffsetMm: 25_123,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
        uncertaintyMm: 750_000,
      },
    });

    expect(summary.definitions).toEqual([
      { term: "Kartenlage", value: "geschätzt (≈)" },
      { term: "Infrastrukturstand", value: "infra-de-2026" },
      { term: "Ableitung", value: "Fahrtfortschritt im geplanten Streckenkorridor" },
      { term: "Unsicherheitsbereich", value: "ungefähr ± 800 m" },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/track-secret|25[_.]?123|Gleis/);
    expect(summary.note).toMatch(/keine Wirkung auf Fahrweg, Konflikte oder Fahrdienstleitung/);
  });

  it("erklaert anchor-hold als letzte Lage und nicht als Stillstand", () => {
    const summary = trainMapPositionSummary({
      ...baseTrain,
      mapEstimate: {
        infrastructureReleaseId: "infra-de-2026",
        resourceId: "resource-1",
        method: "anchor-hold",
        displayPathId: "anchor-1",
        displayOffsetMm: 25_000,
        latitudeE7: 510_000_000,
        longitudeE7: 123_000_000,
        uncertaintyMm: 2_300_000,
      },
    });

    expect(summary.definitions).toContainEqual({ term: "Kartenlage", value: "letzte Lage (?)" });
    expect(summary.definitions).toContainEqual({ term: "Unsicherheitsbereich", value: "ungefähr ± 3 km" });
    expect(summary.note).toMatch(/kein Stillstandssignal/);
  });
});
