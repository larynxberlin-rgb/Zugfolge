import { buildDailyReport } from "@zugfolge/dispatch";
import { describe, expect, it } from "vitest";
import { adaptOperationalDomainEvents, type OperationalNativeEvent } from "./operational-domain-event-adapter.js";
import { decodeOperationalServiceDayEvent } from "./operational-service-day.js";

type Facts = Record<string, unknown>;
const DAY = 86_400_000;
const worldId = "world:service-day", regionId = "region:service-day", operatorId = "operator:1", lotId = "lot:1";
const serviceDay = "2026-09-05";
const serviceRunId = `train:1:service-day:${serviceDay}`;
const common = { worldId, regionId, operatorId, lotId, serviceDay };

function fixtures() {
  const binding = { worldId, operatorId, lotId, serviceDay, trainRunId: "train:1", serviceId: "train:1", serviceRunId, scheduledArrivalMs: 60_000 };
  const group = { ...common, serviceDayId: JSON.stringify([serviceDay, operatorId, lotId]), dayIndex: 0, dayEndMs: DAY, serviceRunIds: [serviceRunId] };
  return {
    planned: { ...group, schemaVersion: "zugfolge-operational-service-day-planned/v1" } as Facts,
    original: { ...binding, schemaVersion: "zugfolge-operational-train-service-planned/v1", requiredSeats: 100, connectionAssessment: "none-contracted" } as Facts,
    outcome: { ...binding, schemaVersion: "zugfolge-operational-train-outcome/v1", status: "completed", actualArrivalMs: 60_000, delaySeconds: 0,
      distanceMm: "1750000", trainKm: "1", minimumSeatsProvided: 100, capacitySources: ["fleet:verified:vehicle:1"], missingSeats: 0, missedConnections: 0, evidenceComplete: true } as Facts,
    cost: { ...common, schemaVersion: "zugfolge-operational-service-vehicle-cost/v1", trainRunId: "train:1", serviceRunId,
      basis: "formation-operating-cost", evidenceComplete: true, millimetreCents: "5250000", economyReleaseHash: "a".repeat(64), fleetAuthorityReleaseHash: "b".repeat(64),
      vehicleUses: [{ vehicleId: "vehicle:1", distanceMm: "1750000", centsPerTrainKm: 3, sourceReference: "fleet:verified:vehicle:1" }] } as Facts,
    closed: { ...group, schemaVersion: "zugfolge-operational-service-day-closed/v1", closedAtMs: DAY, dayPlanComplete: true,
      vehicleCostEvidenceComplete: true, formationOperatingCostCents: "5" } as Facts,
  };
}

function native(kind: string, facts: Facts, sequence: number): OperationalNativeEvent {
  return { kind, eventSequence: sequence, commitSequence: sequence,
    atMs: kind === "service-day-closed" ? DAY : kind === "train-outcome" || kind === "service-vehicle-cost" ? 60_000 : 0,
    subjectId: String(kind.startsWith("service-day-") ? facts.serviceDayId : facts.trainRunId), detail: JSON.stringify(facts) };
}
function events(f = fixtures()) {
  return [native("service-day-planned", f.planned, 1), native("train-service-planned", f.original, 2),
    native("train-outcome", f.outcome, 3), native("service-vehicle-cost", f.cost, 4), native("service-day-closed", f.closed, 5)];
}
function report(input: readonly OperationalNativeEvent[]) {
  const adapted = adaptOperationalDomainEvents(input, [], [], regionId, worldId);
  return buildDailyReport(adapted.map((event, index) => ({ ...event, sequence: index + 1, occurredAt: new Date("2026-09-06T00:00:00Z") })), operatorId, serviceDay);
}

describe("native Tagesbelege an der TS- und Berichtsgrenze", () => {
  it("bindet vollständigen Originalplan, Abschluss und Kosten ohne zusätzliche Kostenbuchung", () => {
    const result = report(events());
    expect(result).toMatchObject({ dayPlanComplete: true, knownServicesComplete: true, evidenceComplete: false,
      vehicleCostEvidenceComplete: true, formationOperatingCostCents: "5", missingServiceRunIds: [],
      settlements: { costCents: "0" } });
    expect(result.contracts[lotId]).toMatchObject({ dayPlanComplete: true, evidenceComplete: false,
      formationOperatingCostCents: "5", settlements: { evidenceComplete: false, costCents: "0" } });
  });

  it("trennt vollständige ursprüngliche Tagesmenge von unbekannter Vertragsqualität", () => {
    const f = fixtures();
    f.original.requiredSeats = null; f.original.connectionAssessment = "unavailable";
    f.outcome.missingSeats = null; f.outcome.missedConnections = null; f.outcome.evidenceComplete = false;
    expect(report(events(f))).toMatchObject({ dayPlanComplete: true, knownServicesComplete: false,
      evidenceComplete: false, vehicleCostEvidenceComplete: true, trainRuns: { missingSeats: null, missedConnections: null } });
  });

  it("behält eine nie gestartete Sollfahrt als fehlenden Beleg", () => {
    const f = fixtures(), missing = `train:2:service-day:${serviceDay}`;
    f.planned.serviceRunIds = [serviceRunId, missing]; f.closed.serviceRunIds = [serviceRunId, missing];
    const result = report(events(f));
    expect(result.dayPlanComplete).toBe(false);
    expect(result.missingServiceRunIds).toEqual([missing]);
    expect(result.evidenceComplete).toBe(false);
  });

  it("verlangt tatsächlichen Close und weist fehlende Fahrzeugkosten separat aus", () => {
    expect(report(events().filter((event) => event.kind !== "service-day-closed"))).toMatchObject({ dayPlanComplete: false, evidenceComplete: false });
    expect(report(events().filter((event) => event.kind !== "service-vehicle-cost"))).toMatchObject({ dayPlanComplete: true,
      vehicleCostEvidenceComplete: false, formationOperatingCostCents: null, evidenceComplete: false, settlements: { costCents: "0" } });
  });

  it.each([
    ["Fremdwelt", (row: Facts) => { row.worldId = "world:foreign"; }],
    ["Fremdregion", (row: Facts) => { row.regionId = "region:foreign"; }],
    ["falsche Tagesschranke", (row: Facts) => { row.dayEndMs = DAY - 1; }],
    ["falsche Abschlusszeit", (row: Facts) => { row.closedAtMs = DAY + 1; }],
    ["doppelte Sollfahrt", (row: Facts) => { row.serviceRunIds = [serviceRunId, serviceRunId]; }],
    ["zusätzliches Kostenfeld", (row: Facts) => { row.costCents = "500"; }],
  ] as const)("verwirft manipulierten Tagesabschluss: %s", (_label, change) => {
    const row = fixtures().closed; change(row);
    expect(() => decodeOperationalServiceDayEvent("service-day-closed", JSON.stringify(row), String(row.serviceDayId), DAY, worldId, regionId)).toThrow(TypeError);
  });

  it.each([
    ["falsche Summe", (row: Facts) => { row.millimetreCents = "5250001"; }],
    ["falscher Quellhash", (row: Facts) => { row.economyReleaseHash = "unverified"; }],
    ["unbelegter Vollständigkeitswert", (row: Facts) => { row.fleetAuthorityReleaseHash = null; }],
    ["doppelte Fahrzeugzeile", (row: Facts) => { row.vehicleUses = [...row.vehicleUses as Facts[], ...row.vehicleUses as Facts[]]; }],
    ["negativer Satz", (row: Facts) => { (row.vehicleUses as Facts[])[0]!.centsPerTrainKm = -1; }],
    ["fehlender Quellbezug", (row: Facts) => { (row.vehicleUses as Facts[])[0]!.sourceReference = null; }],
  ] as const)("verwirft manipulierten Fahrzeugkostenbeleg: %s", (_label, change) => {
    const row = fixtures().cost; change(row);
    expect(() => decodeOperationalServiceDayEvent("service-vehicle-cost", JSON.stringify(row), "train:1", 60_000, worldId, regionId)).toThrow(TypeError);
  });

  it("lässt ausdrücklich unbekannte Kostensätze unbekannt", () => {
    const row = fixtures().cost;
    row.vehicleUses = [{ vehicleId: "vehicle:1", distanceMm: "1750000", centsPerTrainKm: null, sourceReference: null }];
    row.evidenceComplete = false; row.millimetreCents = null;
    expect(decodeOperationalServiceDayEvent("service-vehicle-cost", JSON.stringify(row), "train:1", 60_000, worldId, regionId))
      .toMatchObject({ evidenceComplete: false, millimetreCents: null });
  });
});
