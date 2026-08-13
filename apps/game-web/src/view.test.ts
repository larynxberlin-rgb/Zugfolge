import { describe, expect, it } from "vitest";

import {
  BLOCKING_PHASES,
  CONFLICT_KINDS,
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

import { renderLoadState, renderProjection, type ProjectionViewOptions } from "./view.js";

const options: ProjectionViewOptions = {
  density: "control",
  showBlockingTimes: true,
  selectedTrainId: "t1",
  selectedConflictId: "c0",
};

function projection(): PlanningProjectionV1 {
  const resource = { id: "block", kind: "block" as const, label: "Block A–B" };
  return {
    schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
    projectionRevision: 4,
    worldId: "world-1",
    corridor: { id: "ab", name: "A–B" },
    stations: [
      { id: "a", name: "A", distanceMm: 0 },
      { id: "b", name: "B", distanceMm: 10_000_000 },
    ],
    trains: [
      {
        id: "t1",
        number: "R 1",
        direction: "with-chainage",
        boundaryWindows: [
          {
            windowId: "window-exit-eisenach",
            portalId: "portal-eisenach",
            direction: "exit",
            earliestS: 26_100,
            targetS: 26_400,
            latestS: 26_700,
          },
        ],
        calls: [
          { stationId: "a", timeS: 25_800 },
          { stationId: "b", timeS: 26_400 },
        ],
      },
      {
        id: "t2",
        number: "R 2",
        direction: "against-chainage",
        calls: [
          { stationId: "b", timeS: 25_900 },
          { stationId: "a", timeS: 26_500 },
        ],
      },
    ],
    occupations: BLOCKING_PHASES.map((phase, index) => ({
      trainId: "t1",
      resource,
      governingStationId: index < 3 ? "a" : "b",
      phase,
      startS: 25_900 + index * 20,
      endS: 25_920 + index * 20,
      startDistanceMm: index < 3 ? 0 : 10_000_000,
      endDistanceMm: index < 3 ? 0 : 10_000_000,
    })),
    conflicts: CONFLICT_KINDS.map((kind, index) => ({
      id: `c${index}`,
      kind,
      resource,
      window: { startS: 26_000 + index, endS: 26_060 + index },
      trainIds: ["t1", "t2"],
      explanation: index === 0 ? "<script>keine zweite Abfrage</script>" : `Erklaerung ${kind}`,
      alternative:
        index === 0
          ? {
              alternativeId: "offer-stable",
              trainId: "t1",
              departureShiftS: 120,
              explanation: "Serverseitig konfliktfrei geprueft.",
            }
          : null,
    })),
  };
}

describe("Bildfahrplan-Renderer", () => {
  it("rendert Lade- und Fehlerzustand eigenstaendig und escaped Fehlermeldungen", () => {
    expect(renderLoadState("loading", "Planner laedt …")).toContain('role="status"');
    const error = renderLoadState("error", "<kaputt>", "?demo=1&world=w");
    expect(error).toContain('role="alert"');
    expect(error).toContain("&lt;kaputt&gt;");
    expect(error).toContain("?demo=1&amp;world=w");
  });

  it("rendert eine gueltige leere Projektion ohne Beispieldaten oder Zugriff auf Zug 0", () => {
    const empty = { ...projection(), stations: [], trains: [], occupations: [], conflicts: [] };
    const html = renderProjection(empty, { ...options, selectedTrainId: "", selectedConflictId: "" });
    expect(html).toContain("Keine Planner-Daten");
    expect(html).toContain("keine Beispieldaten");
    expect(html).not.toContain("R 1");
  });

  it("zeigt sechs echte Sperrzeitanteile, vier Konfliktarten und den nichtfarblichen Warnkanal", () => {
    const html = renderProjection(projection(), options);
    expect(html).toContain('id="diagram-card" class="diagram-card zf-surface" role="region" aria-labelledby="diagram-title" tabindex="-1"');
    for (const label of [
      "Fahrstraßenbildezeit",
      "Signalsichtzeit",
      "Annäherungsfahrzeit",
      "Fahrzeit",
      "Räumfahrzeit",
      "Fahrstraßenauflösezeit",
    ]) {
      expect(html).toContain(label);
    }
    for (const label of ["Zugfolge", "Gegenfahrt", "Fahrstraßenausschluss", "Anlagenbelegung"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Konflikt !");
  });

  it("zeigt Ressource, Fenster, beide Zugfahrten, Servererklaerung und nur die Alternative-ID als Aktion", () => {
    const html = renderProjection(projection(), options);
    expect(html).toContain("Block A–B");
    expect(html).toContain("07:13:20–07:14:20");
    expect(html).toContain("R 1");
    expect(html).toContain("R 2");
    expect(html).toContain("&lt;script&gt;keine zweite Abfrage&lt;/script&gt;");
    expect(html).toContain('data-apply-alternative="offer-stable"');
    expect(html).not.toContain("data-departure-shift");
  });

  it("stellt einen konfliktfreien Normalzustand farblos dar", () => {
    const withoutConflicts = { ...projection(), conflicts: [] };
    const html = renderProjection(withoutConflicts, options);
    expect(html).toContain("Konfliktfrei");
    expect(html).toContain("zf-badge--neutral");
    expect(html).not.toContain("zf-badge--success");
  });

  it("erklaert dem Spieler das serverseitige Grenzfenster als feste, sichtbare Randbedingung", () => {
    const html = renderProjection(projection(), options);
    expect(html).toContain("Durchgehende Fahrt");
    expect(html).toContain("Ausfahrt an der Netzgrenze");
    expect(html).toContain("<summary>Technische Details</summary><code>portal-eisenach</code>");
    expect(html).toContain("07:15:00–07:25:00");
    expect(html).toContain("Außenlauf bleibt Teil derselben Zugfahrt");
    expect(html).not.toContain("data-boundary-window");
  });

  it("verwendet in sichtbaren Grundtexten korrektes Deutsch statt Entwicklungsbegriffe", () => {
    const html = renderProjection(projection(), options);
    for (const forbidden of ["Fuer", "Ueberlappung", "Aussenlauf", "ausgewaehlt", "serverautoritaer", "Planner-Projektion", "M12 ·"]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("Planungsstand");
    expect(html).toContain("Überlappung");
  });

  it("nennt Betriebstag, Datum und feste Weltzeitzone in Ticks und ARIA-Texten", () => {
    const withWorldTime = {
      ...projection(),
      timeBasis: { epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin" as const, operatingDayBoundaryS: 0 as const },
    };
    const html = renderProjection(withWorldTime, options);
    expect(html).toContain("D+0 · 01.01.2026");
    expect(html).toContain("Weltzeit Europe/Berlin");
  });
});
