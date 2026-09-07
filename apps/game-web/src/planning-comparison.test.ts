import { describe, expect, it } from "vitest";
import type { PlanningProjectionV1, PlanningResultProjection, PlanningTimelineCallProjection } from "@zugfolge/planning-projection";
import { alignPlanningTimelines, planningRowDeltas, planningRowSeverity, renderPlanningComparison } from "./planning-comparison.js";

const call = (stationId: string, arrivalS = 600, departureS = arrivalS, kind: PlanningTimelineCallProjection["kind"] = "pass"): PlanningTimelineCallProjection => ({ stationId, arrivalS, departureS, kind });
const projection: PlanningProjectionV1 = { schemaVersion: "planning-projection/v1", projectionRevision: 1, worldId: "world-test", corridor: { id: "corridor-test", name: "Nord–Süd" },
  stations: ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ id, name: `Bahnhof ${id.toUpperCase()}`, distanceMm: index * 1_000_000 })), trains: [], conflicts: [], occupations: [] };
const result = (requested: readonly PlanningTimelineCallProjection[], planned: readonly PlanningTimelineCallProjection[] | null, status: PlanningResultProjection["status"] = "allocated"): PlanningResultProjection => ({ status,
  requestedDepartureS: requested[0]!.departureS, plannedDepartureS: planned?.[0]?.departureS ?? null, adjustments: [], timeline: { requested, planned } });

describe("Fahrwegvergleich richtet echte Folgen aus", () => {
  it("erhält beide Reihenfolgen bei Umwegen mit deterministischen Lücken", () => {
    const requested = ["a", "b", "d", "e", "f"].map((id) => call(id));
    const planned = ["a", "c", "e", "d", "f"].map((id) => call(id));
    const rows = alignPlanningTimelines(requested, planned);
    expect(rows.flatMap((row) => row.requested ? [row.requested] : [])).toEqual(requested);
    expect(rows.flatMap((row) => row.planned ? [row.planned] : [])).toEqual(planned);
    expect(rows.filter((row) => row.requested && row.planned)).toHaveLength(3);
    expect(rows.map((row) => [row.requested?.stationId, row.planned?.stationId])).toEqual([
      ["a", "a"], ["b", undefined], ["d", undefined], [undefined, "c"], ["e", "e"], [undefined, "d"], ["f", "f"],
    ]);
    expect(alignPlanningTimelines(requested, planned)).toEqual(rows);
  });

  it("erfindet für einen eingefügten Betriebshalt keine ursprüngliche Ankunft", () => {
    const requested = [call("a", 0, 0, "origin"), call("d", 900, 900, "destination")];
    const planned = [requested[0]!, call("b", 300, 420, "operational-stop"), requested[1]!];
    const row = alignPlanningTimelines(requested, planned)[1]!;
    expect(row.requested).toBeUndefined();
    expect(planningRowDeltas(row)).toBeUndefined();
    expect(planningRowSeverity(row, planned, "allocated")).toBe("changed");
    const html = renderPlanningComparison(result(requested, planned), projection, "FV 1");
    expect(html).toContain("Im ursprünglichen Fahrweg nicht enthalten");
    expect(html).toContain("Aufenthalt <strong>2:00 min</strong>");
    expect(html).not.toContain("Ankunft +5:00 min");
  });

  it("markiert Strukturänderungen bei gleichen Zeiten gelb", () => {
    const requested = call("b"); const planned = call("b", 600, 600, "operational-stop");
    expect(planningRowSeverity({ requested, planned }, [planned], "allocated")).toBe("changed");
    expect(planningRowSeverity({ requested }, [], "allocated")).toBe("changed");
  });
});

describe("Änderungsstärke", () => {
  it.each([[-300, "major"], [-299, "changed"], [0, "unchanged"], [299, "changed"], [300, "major"]] as const)("klassifiziert Abfahrtsänderung %i Sekunden", (shift, expected) => {
    const requested = call("a", 600, 600, "origin"); const planned = call("a", 600 + shift, 600 + shift, "origin");
    expect(planningRowSeverity({ requested, planned }, [planned], "allocated")).toBe(expected);
  });

  it("erkennt große Zwischenänderung auch bei unveränderter Startabfahrt", () => {
    const origin = call("a", 0, 0, "origin");
    const requested = call("b", 600, 960, "passenger-stop"); const planned = call("b", 900, 960, "passenger-stop");
    expect(planningRowSeverity({ requested: origin, planned: origin }, [origin, planned], "allocated")).toBe("unchanged");
    expect(planningRowDeltas({ requested, planned })).toEqual({ arrivalS: 300, departureS: 0, dwellS: -300 });
    expect(planningRowSeverity({ requested, planned }, [origin, planned], "allocated")).toBe("major");
  });

  it("nutzt die Aufenthaltsänderung, auch wenn jede einzelne Zeit unter fünf Minuten abweicht", () => {
    const requested = call("b", 600, 660, "passenger-stop"); const planned = call("b", 450, 810, "passenger-stop");
    expect(planningRowDeltas({ requested, planned })).toEqual({ arrivalS: -150, departureS: 150, dwellS: 300 });
    expect(planningRowSeverity({ requested, planned }, [planned], "proposed")).toBe("major");
  });

  it.each([299, 300])("prüft einen neuen Betriebshalt mit %i Sekunden ohne erfundene Wunschzeit", (dwell) => {
    const planned = call("b", 600, 600 + dwell, "operational-stop");
    expect(planningRowSeverity({ planned }, [planned], "allocated")).toBe(dwell === 300 ? "major" : "changed");
    expect(planningRowDeltas({ planned })).toBeUndefined();
  });

  it.each(["pass", "operational-stop"] as const)("markiert Verlust eines Fahrgasthalts zugunsten %s rot", (kind) => {
    const requested = call("b", 600, 600, "passenger-stop"); const planned = call("b", 600, 600, kind);
    expect(planningRowSeverity({ requested, planned }, [planned], "allocated")).toBe("major");
    expect(planningRowSeverity({ requested }, [], "allocated")).toBe("major");
  });

  it("behandelt einen durch Reihenfolgeänderung ungematchten Fahrgasthalt nicht als entfallen", () => {
    const passenger = call("b", 600, 660, "passenger-stop");
    expect(planningRowSeverity({ requested: passenger }, [call("c"), passenger], "allocated")).toBe("changed");
  });
});

describe("Planungszustand und fehlende Daten", () => {
  const requested = [call("a", 0, 0, "origin"), call("d", 900, 900, "destination")];
  it.each(["requested", "rejected"] as const)("zeigt rechts bei %s keine Zeitwerte", (status) => {
    const html = renderPlanningComparison(result(requested, null, status), projection, "FV 1");
    const cards = html.match(/<div class="planning-comparison-call[^>]*data-comparison-side="planned">[^]*?<\/div>/g)!;
    expect(cards).toHaveLength(2);
    for (const card of cards) { expect(card).not.toContain("planning-comparison-times"); expect(card).not.toMatch(/\d{2}:\d{2}:\d{2}/); }
    expect(planningRowSeverity({ requested: requested[0] }, null, status)).toBe(status === "rejected" ? "major" : "unchanged");
  });

  it("unterscheidet fehlende Legacyangaben vom bekannten Zuteilungsstatus", () => {
    const absent = renderPlanningComparison(undefined, projection, "FV 1");
    expect(absent).toContain("keine vollständigen Vergleichsangaben");
    expect(absent).not.toContain("noch nicht zugeteilt");
    const legacy = renderPlanningComparison({ status: "allocated", requestedDepartureS: 0, plannedDepartureS: 0, adjustments: [] }, projection, "FV 1");
    expect(legacy).toContain("Diese Trasse wurde zugeteilt");
    expect(legacy).toContain("fehlt der vollständige Verlauf");
    expect(legacy).not.toContain("planning-comparison-times");
  });

  it("erhält beim Übernehmen exakt dieselben Zeiten und ändert nur den Vorschlagsstatus", () => {
    const planned = [requested[0]!, call("b", 300, 420, "operational-stop"), requested[1]!];
    const proposed = renderPlanningComparison(result(requested, planned, "proposed"), projection, "FV 1");
    const allocated = renderPlanningComparison(result(requested, planned, "allocated"), projection, "FV 1");
    expect(proposed.match(/\d{2}:\d{2}:\d{2}/g)).toEqual(allocated.match(/\d{2}:\d{2}:\d{2}/g));
    expect(proposed).toContain('aria-label="Trassenvorschlag · Bahnhof B"');
    expect(allocated).toContain('aria-label="Zugewiesene Trasse · Bahnhof B"');
    expect(allocated).not.toContain("Vorschlag</span>");
  });
});
