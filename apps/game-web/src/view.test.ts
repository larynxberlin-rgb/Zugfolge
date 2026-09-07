import { describe, expect, it } from "vitest";

import {
  BLOCKING_PHASES,
  CONFLICT_KINDS,
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
  type PlanningResultProjection,
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
  const timeline: NonNullable<PlanningResultProjection["timeline"]> = {
    requested: [{ stationId: "a", arrivalS: 25_800, departureS: 25_800, kind: "origin" }, { stationId: "b", arrivalS: 26_400, departureS: 26_400, kind: "destination" }],
    planned: [{ stationId: "a", arrivalS: 25_920, departureS: 25_920, kind: "origin" }, { stationId: "b", arrivalS: 26_700, departureS: 26_700, kind: "destination" }],
  };
  const allocated: PlanningResultProjection = {
    status: "allocated", requestedDepartureS: 25_800, plannedDepartureS: 25_920,
    adjustments: [
      { kind: "departure-shift", stationId: "a", requestedS: 25_800, plannedS: 25_920, explanation: "Abfahrt zur Konfliktlösung verschoben." },
      { kind: "operational-stop", stationId: "b", requestedS: 0, plannedS: 120, explanation: "Betriebshalt für eine Zugkreuzung." },
      { kind: "dwell-extension", stationId: "b", requestedS: 60, plannedS: 180, explanation: "Aufenthalt für <Zugfolge> verlängert." },
      { kind: "running-time-extension", stationId: "b", requestedS: 600, plannedS: 840, explanation: "Gesamtfahrtdauer mit längeren Aufenthalten." },
    ],
  };

  it("öffnet den vollständigen Vergleich groß und erhält den Bildfahrplan als auswählbare Ansicht", () => {
    const base = projection();
    const data = { ...base, conflicts: [], trains: base.trains.map((train, index) => index === 0 ? { ...train, planning: { ...allocated, timeline } } : train) };
    const comparison = renderProjection(data, options);
    expect(comparison).toContain('class="planning-comparison-workspace"');
    expect(comparison).toContain("Ursprüngliche Planung");
    expect(comparison).toContain("Zugewiesene Trasse");
    expect(comparison).not.toContain('id="diagram-card"');
    expect(comparison).not.toContain('id="steps"');
    expect(comparison).toContain('id="planning-train"');
    const diagram = renderProjection(data, { ...options, planningView: "diagram" });
    expect(diagram).toContain('id="diagram-card"');
    expect(diagram).toContain('id="steps"');
    expect(diagram).not.toContain('id="planning-comparison"');
  });

  it("vergleicht nur den Vorschlag der gewählten Fahrt und lässt die echte Übernahme erreichbar", () => {
    const base = projection();
    const proposed: PlanningResultProjection = { ...allocated, status: "proposed", timeline };
    const data = { ...base, conflicts: [{ ...base.conflicts[0]!, alternative: { ...base.conflicts[0]!.alternative!, planning: proposed } }] };
    const html = renderProjection(data, options);
    expect(html).toContain("Trassenvorschlag");
    expect(html.indexOf('data-apply-alternative="offer-stable"')).toBeLessThan(html.indexOf('class="planning-comparison-details"'));
    const otherTrain = renderProjection(data, { ...options, selectedTrainId: "t2", planningView: "comparison" });
    expect(otherTrain).toContain("keine vollständigen Vergleichsangaben");
    expect(otherTrain).not.toContain('aria-label="Trassenvorschlag · A"');
    expect(otherTrain).not.toContain('class="planning-comparison-times"');
  });

  it("hält die Konfliktauswahl vor den eingeklappten Detailangaben erreichbar", () => {
    const base = projection();
    const data = { ...base, trains: base.trains.map((train, index) => index === 0 ? { ...train, planning: { ...allocated, timeline } } : train) };
    const html = renderProjection(data, options);
    const details = html.indexOf('class="planning-comparison-details"');
    for (const conflict of data.conflicts) {
      expect(html.indexOf(`data-conflict="${conflict.id}"`)).toBeLessThan(details);
      expect(html.slice(details)).not.toContain(`data-conflict="${conflict.id}"`);
    }
  });

  it("zeigt zugeteilte Anpassungen mit Wunsch/Plan, Sekundenwerten, Ursachen und nichtfarblichen Markierungen", () => {
    const base = projection();
    const data = { ...base, conflicts: [], trains: base.trains.map((train, index) => index === 0 ? { ...train, planning: allocated,
      calls: [{ ...train.calls[0]!, timeS: allocated.plannedDepartureS! }, ...train.calls.slice(1)] } : train) };
    const html = renderProjection(data, options);
    expect(html).toContain("Trasse zugeteilt");
    expect(html).toContain("So wurde deine Planung angepasst");
    expect(html).toContain("Gewünschte Abfahrt");
    expect(html).toContain("Zugewiesene Abfahrt");
    expect(html).toContain("07:10:00");
    expect(html).toContain("07:12:00");
    expect(html).toContain('aria-label="Änderung +2:00 min"');
    expect(html).toContain("Zusätzlicher Betriebshalt · B");
    expect(html).toContain("Gewünscht: Durchfahrt");
    expect(html).toContain("Beantragt: mindestens 1:00 min");
    expect(html).toContain("Fahrzeitverlängerung insgesamt");
    expect(html).toContain("14:00 min Gesamtfahrtdauer");
    expect(html).toContain("Aufenthalt für &lt;Zugfolge&gt; verlängert.");
    expect(html).toContain("train--adjusted");
    expect(html).toContain("angepasst △");
    expect(html).not.toContain("noch nicht übernommen");
  });

  it("trennt einen Vorschlag mit Betriebshalt bei unveränderter Abfahrt von der zugeteilten Trasse", () => {
    const base = projection();
    const proposed: PlanningResultProjection = { ...allocated, status: "proposed", plannedDepartureS: allocated.requestedDepartureS,
      adjustments: allocated.adjustments.filter((change) => change.kind !== "departure-shift") };
    const data = { ...base, trains: base.trains.map((train, index) => index === 0 ? { ...train,
      planning: { status: "requested" as const, requestedDepartureS: 25_800, plannedDepartureS: null, adjustments: [] } } : train),
    conflicts: [{ ...base.conflicts[0]!, alternative: { ...base.conflicts[0]!.alternative!, departureShiftS: 0, planning: proposed } }] };
    const html = renderProjection(data, options);
    expect(html).toContain("Vorschlag · noch nicht übernommen");
    expect(html).toContain("Vorgeschlagene Abfahrt");
    expect(html).toContain("Die Änderungen gelten erst, wenn du diese Alternative übernimmst.");
    expect(html).toContain("Angepasste Trasse übernehmen");
    expect(html).not.toContain("So wurde deine Planung angepasst");
    expect(html).not.toContain("train--adjusted");
  });

  it("markiert Ablehnung rot und als Klartext, auch ohne Konfliktdatensatz", () => {
    const base = projection();
    const data = { ...base, conflicts: [], trains: base.trains.map((train, index) => index === 0 ? { ...train,
      planning: { status: "rejected" as const, requestedDepartureS: 25_800, plannedDepartureS: null, adjustments: [] } } : train) };
    const html = renderProjection(data, options);
    expect(html).toContain("planning-adjustments--rejected");
    expect(html).toContain("Keine passende Trasse");
    expect(html).toContain("Nicht zugeteilt");
    expect(html).toContain("nicht zugeteilt !");
    expect(html).not.toContain("Konfliktfrei");
    expect(html).not.toContain("Die Strecke ist frei");
  });

  it("erfindet für historische Projektionen weder Wunschzeit noch zugeteilte Anpassungen", () => {
    const html = renderProjection(projection(), options);
    expect(html).not.toContain("Gewünschte Abfahrt");
    expect(html).not.toContain("planning-adjustments--");
    expect(html).toContain("Neue Zeit übernehmen");
  });

  it("kennzeichnet einen zugeteilten zeitgleichen Umweg ohne erfundene Zeitverschiebung", () => {
    const base = projection();
    const data = { ...base, conflicts: [], trains: base.trains.map((train, index) => index === 0 ? { ...train,
      planning: { status: "allocated" as const, requestedDepartureS: 25_800, plannedDepartureS: 25_800, adjustments: [],
        routeChange: { additionalDistanceMm: 1_200_000, explanation: "Anderer Fahrweg bei gleicher Abfahrt und Fahrtdauer." } } } : train) };
    const html = renderProjection(data, options);
    expect(html).toContain("Fahrweg angepasst");
    expect(html).toContain("Zusätzlicher Weg gegenüber der Ausgangstrasse: 1,200 km");
    expect(html).toContain("Anderer Fahrweg bei gleicher Abfahrt und Fahrtdauer.");
    expect(html).toContain("train--adjusted");
    expect(html).not.toContain("Abfahrt verschoben");
    expect(html).not.toContain("+0:00 min");
  });

  it("rendert Lade- und Fehlerzustand eigenstaendig und escaped Fehlermeldungen", () => {
    expect(renderLoadState("loading", "Planner laedt …")).toContain('role="status"');
    const error = renderLoadState("error", "<kaputt>", "?demo=1&world=w");
    expect(error).toContain('role="alert"');
    expect(error).toContain("&lt;kaputt&gt;");
    expect(error).toContain("?demo=1&amp;world=w");
    expect(error).toContain('id="planner-retry"');
    expect(error).toContain("Zur Welt");
  });

  it("kennzeichnet Beispieldaten dauerhaft und erhaelt den Demo-Parameter in der Navigation", () => {
    const html = renderProjection(projection(), { ...options, demoMode: true });
    expect(html).toContain("Demo · Beispieldaten");
    expect(html).toContain("nicht serverbestätigt");
    expect(html).toContain('class="demo-banner"');
    expect(html).not.toContain('class="notice notice--demo"');
    expect(html).toContain("&amp;demo=1");
    expect(html).not.toContain("Vom Server bestätigt");
  });

  it("rendert eine gueltige leere Projektion ohne Beispieldaten oder Zugriff auf Zug 0", () => {
    const empty = { ...projection(), stations: [], trains: [], occupations: [], conflicts: [] };
    const html = renderProjection(empty, { ...options, selectedTrainId: "", selectedConflictId: "" });
    expect(html).toContain("Dein Fahrplan wartet auf dich.");
    expect(html).toContain("noch keine geplanten Fahrten");
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
