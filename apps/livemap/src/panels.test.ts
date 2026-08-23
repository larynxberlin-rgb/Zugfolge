import { describe, expect, it } from "vitest";
import type { LivemapObjectDetailV1, PublicTrain, StationBoardV1 } from "@zugfolge/livemap-stream";

import { playerObjectSummary, stationBoardSummary, trainMapPositionSummary } from "./panels.js";

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

  it("kennzeichnet fehlende Exact-Lage als sicheren Freeze ohne Schätzung", () => {
    const summary = trainMapPositionSummary(baseTrain);
    expect(summary.definitions).toEqual([{ term: "Kartenlage", value: "sicher eingefroren" }]);
    expect(summary.note).toMatch(/keine Kartenlage geschätzt/);
  });
});

describe("spielerzentrierte Infrastrukturdetails", () => {
  const corridor = {
    schemaVersion: "zugfolge-livemap-object-detail/v1",
    worldId: "world-1",
    infrastructureReleaseId: "infra-de-2026",
    kind: "track",
    id: "rail-corridor:6340:1",
    name: "Streckenkorridor 6340 Leipzig–Halle",
    qualityClass: "B",
    facts: [
      { label: "Streckennummer", value: "6340" },
      { label: "Streckenbezeichnung", value: "Leipzig–Halle" },
      { label: "Zulaessige Geschwindigkeit", value: "160", unit: "km/h" },
      { label: "Elektrifizierung", value: "Oberleitung" },
      { label: "Gleiszahl", value: "2" },
      { label: "Kilometer von", value: "0,0", unit: "km" },
      { label: "Betriebsmodell", value: "amtlicher Korridor" },
    ],
  } satisfies LivemapObjectDetailV1;

  it("zeigt bei einem Streckenklick nur Bezeichnung, Nummer, Vzul und wenige Betriebsfakten", () => {
    expect(playerObjectSummary(corridor)).toEqual({
      eyebrow: "STRECKE",
      title: "Leipzig–Halle",
      definitions: [
        { term: "VzG-Streckennummer", value: "6340" },
        { term: "Vzul", value: "160 km/h" },
        { term: "Elektrifizierung", value: "Oberleitung" },
        { term: "Gleise", value: "2" },
      ],
    });
    expect(JSON.stringify(playerObjectSummary(corridor))).not.toMatch(/rail-corridor|infra-de|Betriebsmodell|Kilometer von/);
  });

  it("benennt eine KBS erst, wenn sie als eigenes autoritatives Faktum vorliegt", () => {
    const summary = playerObjectSummary({
      ...corridor,
      facts: [{ label: "KBS-Bezeichnung", value: "KBS 501 Leipzig–Halle" }, ...corridor.facts],
    });
    expect(summary.title).toBe("KBS 501 Leipzig–Halle");
    expect(summary.definitions).toEqual(expect.arrayContaining([
      { term: "KBS", value: "KBS 501 Leipzig–Halle" },
      { term: "VzG-Streckennummer", value: "6340" },
    ]));
  });

  it("stellt die RIL-100-Bezeichnung einer Betriebsstelle vor technische IDs", () => {
    expect(playerObjectSummary({
      ...corridor,
      kind: "station",
      id: "station:eva:8010205",
      name: "Leipzig Hbf",
      facts: [{ label: "RIL-100-Kürzel", value: "LL" }, { label: "EVA-/UIC-Nummer", value: "8010205" }],
    })).toMatchObject({
      eyebrow: "BAHNHOF",
      title: "Leipzig Hbf",
      definitions: [{ term: "RIL 100", value: "LL" }, { term: "EVA / UIC", value: "8010205" }],
    });
  });
});

describe("Bahnhofsstatistik", () => {
  it("verdichtet das aktuelle Tafelzeitfenster ohne Ankunft und Abfahrt doppelt zu zählen", () => {
    const board = {
      schemaVersion: "zugfolge-station-board/v1",
      worldId: "world-1",
      stationId: "station-1",
      stationName: "Leipzig Hbf",
      streamId: "live",
      sequence: 17,
      atS: 43_200,
      departures: [
        { trainId: "train-1", trainNumber: "20001", category: "RE", scheduledTimeS: 43_500, expectedTimeS: 43_680, platform: "7", destination: "Halle", status: "scheduled" },
        { trainId: "train-2", trainNumber: "20002", category: "S", scheduledTimeS: 43_800, expectedTimeS: 43_800, platform: "2", destination: "Wurzen", status: "cancelled" },
      ],
      arrivals: [
        { trainId: "train-1", trainNumber: "20001", category: "RE", scheduledTimeS: 43_300, expectedTimeS: 43_480, platform: "7", origin: "Halle", status: "scheduled" },
        { trainId: "train-3", trainNumber: "20003", category: "IC", scheduledTimeS: 44_000, expectedTimeS: 44_601, platform: "10", origin: "Dresden", status: "scheduled" },
      ],
    } satisfies StationBoardV1;

    expect(stationBoardSummary(board).definitions).toEqual([
      { term: "Fahrten im aktuellen Fenster", value: "3" },
      { term: "Pünktlich bis 5 min", value: "50 %" },
      { term: "Ausfälle", value: "1" },
      { term: "Gleise mit Verkehr", value: "3" },
      { term: "Zuggattungen", value: "IC, RE, S" },
    ]);
  });
});
