import { describe, expect, it } from "vitest";
import { nativeServiceDayEvidence } from "./service-days.js";
import { nativeServiceEvidence } from "./service-outcomes.js";

type Facts = Record<string, unknown>;
const DAY = 86_400_000, serviceDay = "2026-09-05";
const common = { worldId: "world:1", regionId: "region:1", operatorId: "operator:1", lotId: "lot:1", serviceDay };
const ids = ["train:1", "train:2"].map((id) => `${id}:service-day:${serviceDay}`);

function fixture() {
  const group = { ...common, serviceDayId: JSON.stringify([serviceDay, common.operatorId, common.lotId]), dayIndex: 0, dayEndMs: DAY, serviceRunIds: ids };
  const originalPlans = new Map<string, Facts>(), outcomes = new Map<string, Facts>();
  const cost: Facts[] = [];
  for (const [index, serviceRunId] of ids.entries()) {
    const binding = { ...common, serviceRunId, serviceId: `train:${index + 1}`, trainRunId: `train:${index + 1}`, scheduledArrivalMs: 60_000 };
    originalPlans.set(serviceRunId, { ...binding, schemaVersion: "zugfolge-operational-train-service-planned/v1", requiredSeats: 100, connectionAssessment: "none-contracted" });
    outcomes.set(serviceRunId, { ...binding, schemaVersion: "zugfolge-operational-train-outcome/v1", status: "completed", actualArrivalMs: 60_000,
      distanceMm: "750000", trainKm: "0", minimumSeatsProvided: 100, missingSeats: 0, missedConnections: 0, evidenceComplete: true });
    cost.push({ ...binding, schemaVersion: "zugfolge-operational-service-vehicle-cost/v1", evidenceComplete: true,
      basis: "formation-operating-cost", millimetreCents: "2250000" });
  }
  const planned: Facts = { ...group, schemaVersion: "zugfolge-operational-service-day-planned/v1" };
  const closed: Facts = { ...group, schemaVersion: "zugfolge-operational-service-day-closed/v1", closedAtMs: DAY,
    dayPlanComplete: true, vehicleCostEvidenceComplete: true, formationOperatingCostCents: "4" };
  return { planned, closed, cost, originalPlans, outcomes };
}
function read(f = fixture()) { return nativeServiceDayEvidence([f.planned, ...f.cost, f.closed], f.originalPlans, f.outcomes); }

describe("vollständige native Tagesgruppen", () => {
  it("summiert Kostenbruchteile vor dem Abrunden und bindet die vollständige Originalmenge", () => {
    expect(read()).toEqual({ dayPlanComplete: true, expectedServiceRunIds: ids,
      vehicleCostEvidenceComplete: true, formationOperatingCostCents: "4" });
  });

  it("verlangt auch die nie gestartete zweite Sollfahrt", () => {
    const f = fixture(); f.originalPlans.delete(ids[1]!); f.outcomes.delete(ids[1]!); f.cost.pop();
    expect(read(f)).toMatchObject({ dayPlanComplete: false, expectedServiceRunIds: ids, vehicleCostEvidenceComplete: false, formationOperatingCostCents: null });
    expect(nativeServiceEvidence([f.planned, ...f.originalPlans.values(), ...f.outcomes.values(), ...f.cost, f.closed]))
      .toMatchObject({ dayPlanComplete: false, missingServiceRunIds: [ids[1]], evidenceComplete: false });
  });

  it("unterscheidet fehlenden Close von fehlendem Kostennachweis", () => {
    const f = fixture();
    expect(nativeServiceDayEvidence([f.planned, ...f.cost], f.originalPlans, f.outcomes)?.dayPlanComplete).toBe(false);
    f.cost.pop();
    expect(read(f)).toMatchObject({ dayPlanComplete: true, vehicleCostEvidenceComplete: false, formationOperatingCostCents: null });
  });

  it.each(["worldId", "regionId", "operatorId", "lotId", "serviceDay", "dayIndex", "dayEndMs"])("verwirft abweichende Gruppenzuordnung im Close: %s", (key) => {
    const f = fixture(); f.closed[key] = typeof f.closed[key] === "number" ? Number(f.closed[key]) + 1 : "foreign";
    expect(read(f)?.dayPlanComplete).toBe(false);
  });

  it.each(["worldId", "regionId", "operatorId", "lotId", "serviceDay"])("verwirft fremde Originalplan- oder Outcomezuordnung: %s", (key) => {
    for (const source of ["originalPlans", "outcomes"] as const) {
      const f = fixture(); f[source].get(ids[0]!)![key] = "foreign";
      expect(read(f)?.dayPlanComplete).toBe(false);
    }
  });

  it("verweigert doppelte oder überlappende Tagesgruppen und verfrühten Close", () => {
    const f = fixture();
    for (const extra of [f.planned, f.closed, { ...f.planned, serviceDayId: "different-group" }]) {
      expect(nativeServiceDayEvidence([f.planned, ...f.cost, f.closed, extra], f.originalPlans, f.outcomes)?.dayPlanComplete).toBe(false);
    }
    f.closed.closedAtMs = DAY - 1;
    expect(read(f)?.dayPlanComplete).toBe(false);
  });

  it("verwirft zusätzliche, im Originaltagesplan nicht bestellte Abschlüsse", () => {
    const f = fixture(); f.outcomes.set("foreign-run", { ...f.outcomes.get(ids[0]!), serviceRunId: "foreign-run" });
    expect(read(f)?.dayPlanComplete).toBe(false);
  });

  it.each(["worldId", "regionId", "operatorId", "lotId", "serviceDay", "trainRunId"])("ordnet fremde Kosten keiner tatsächlich abgeschlossenen Fahrt zu: %s", (key) => {
    const f = fixture(); f.cost[0]![key] = "foreign";
    expect(read(f)).toMatchObject({ dayPlanComplete: true, vehicleCostEvidenceComplete: false, formationOperatingCostCents: null });
  });

  it("übernimmt weder doppelte Kostenquittungen noch einen unabhängig erfundenen Closebetrag", () => {
    const duplicate = fixture(); duplicate.cost.push({ ...duplicate.cost[0]! });
    expect(read(duplicate)?.vehicleCostEvidenceComplete).toBe(false);
    const changed = fixture(); changed.closed.formationOperatingCostCents = "5";
    expect(read(changed)).toMatchObject({ vehicleCostEvidenceComplete: false, formationOperatingCostCents: null });
    const unknown = fixture(); unknown.cost[0]!.evidenceComplete = false; unknown.cost[0]!.millimetreCents = null;
    expect(read(unknown)?.vehicleCostEvidenceComplete).toBe(false);
  });

  it("behält Tagesvollständigkeit bei fehlenden Qualitätszusagen, ohne Vertragsvollständigkeit zu erfinden", () => {
    const f = fixture();
    for (const row of f.originalPlans.values()) { row.requiredSeats = null; row.connectionAssessment = "unavailable"; }
    for (const row of f.outcomes.values()) { row.missingSeats = null; row.missedConnections = null; row.evidenceComplete = false; }
    expect(nativeServiceEvidence([f.planned, ...f.originalPlans.values(), ...f.outcomes.values(), ...f.cost, f.closed]))
      .toMatchObject({ dayPlanComplete: true, vehicleCostEvidenceComplete: true, evidenceComplete: false,
        missingSeats: null, missedConnections: null, missingServiceRunIds: [] });
  });

  it("erteilt einem Legacybericht ohne neue Tagesbelege keine zusätzliche Tagesfreigabe", () => {
    const f = fixture();
    expect(nativeServiceDayEvidence([], f.originalPlans, f.outcomes)).toBeUndefined();
  });
});
