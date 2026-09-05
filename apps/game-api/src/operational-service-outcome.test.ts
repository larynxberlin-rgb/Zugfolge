import { buildDailyReport } from "@zugfolge/dispatch";
import { describe, expect, it } from "vitest";
import { adaptOperationalDomainEvents, type OperationalNativeEvent } from "./operational-domain-event-adapter.js";

const binding = { worldId: "world:1", operatorId: "operator:1", lotId: "lot:1", trainRunId: "train:day-0", serviceId: "train", serviceRunId: "train:service-day:2026-09-05", serviceDay: "2026-09-05", scheduledArrivalMs: 86_400_000 };
const plan = { ...binding, schemaVersion: "zugfolge-operational-train-service-planned/v1", requiredSeats: 100, connectionAssessment: "none-contracted" };
const outcome = { ...binding, schemaVersion: "zugfolge-operational-train-outcome/v1", status: "completed", actualArrivalMs: 86_500_000, delaySeconds: 100, distanceMm: "1750000", trainKm: "1", minimumSeatsProvided: 80, capacitySources: ["fleet:verified:vehicle:1"], missingSeats: 20, missedConnections: 0, evidenceComplete: true };
function native(kind: "train-service-planned" | "train-outcome", facts: Record<string, unknown>, sequence: number): OperationalNativeEvent {
  return { kind, eventSequence: sequence, commitSequence: sequence, atMs: kind === "train-outcome" ? 86_500_000 : 0, subjectId: String(facts["trainRunId"]), detail: JSON.stringify(facts) };
}
function report(events: readonly OperationalNativeEvent[]) {
  const adapted = adaptOperationalDomainEvents(events, [], [], "region:1", "world:1");
  return buildDailyReport(adapted.map((event, index) => ({ ...event, sequence: index + 1, occurredAt: new Date("2026-09-06T01:00:00Z") })), "operator:1", "2026-09-05");
}

describe("native Tagesfahrtbelege", () => {
  it("ordnet echte Abschluesse trotz Folgetag ihrem signierten Betriebstag zu", () => {
    const result = report([native("train-service-planned", plan, 1), native("train-outcome", outcome, 2)]);
    expect(result.knownServicesComplete).toBe(true);
    expect(result.dayPlanComplete).toBe(false);
    expect(result.evidenceComplete).toBe(false);
    expect(result.trainRuns).toMatchObject({ total: 1, punctual: 1, distanceMm: "1750000", trainKm: "1", minimumSeatsProvided: 80, missingSeats: 20 });
    expect(result.contracts["lot:1"]?.settlements.evidenceComplete).toBe(false);
  });
  it("haelt fehlende Abschluesse und fehlende Vertragsfakten ausdruecklich offen", () => {
    const missing = report([native("train-service-planned", plan, 1)]);
    expect(missing.evidenceComplete).toBe(false);
    expect(missing.missingServiceRunIds).toEqual([binding.serviceRunId]);
    expect(missing.trainRuns.missingSeats).toBeNull();
    const unknown = report([native("train-service-planned", { ...plan, requiredSeats: null, connectionAssessment: "unavailable" }, 1), native("train-outcome", { ...outcome, missingSeats: null, missedConnections: null, evidenceComplete: false }, 2)]);
    expect(unknown.evidenceComplete).toBe(false);
    expect(unknown.trainRuns.minimumSeatsProvided).toBe(80);
    expect(unknown.trainRuns.missingSeats).toBeNull();
    expect(unknown.assessment.nextLevers.join(" ")).toContain("unvollstaendig");
  });
  it("akzeptiert wiederholte Handoverplaene, aber keine doppelten Abschlussbelege", () => {
    expect(report([native("train-service-planned", plan, 1), native("train-service-planned", plan, 2), native("train-outcome", outcome, 3)]).knownServicesComplete).toBe(true);
    expect(report([native("train-service-planned", plan, 1), native("train-outcome", outcome, 2), native("train-outcome", outcome, 3)]).knownServicesComplete).toBe(false);
  });
  it("verwirft fremde Welten, fehlende Sitzbelege und widerspruechliche Millimeter", () => {
    for (const bad of [{ ...outcome, worldId: "world:foreign" }, { ...outcome, minimumSeatsProvided: undefined }, { ...outcome, trainKm: "2" }]) {
      expect(() => report([native("train-outcome", bad, 1)])).toThrow();
    }
  });
  it("summiert Millimeter vor der Umrechnung zu ganzen Zugkilometern", () => {
    const second = { trainRunId: "train:second", serviceId: "train:second", serviceRunId: "train:second:service-day:2026-09-05" };
    const result = report([native("train-service-planned", plan, 1), native("train-outcome", outcome, 2), native("train-service-planned", { ...plan, ...second }, 3), native("train-outcome", { ...outcome, ...second }, 4)]);
    expect(result.trainRuns.distanceMm).toBe("3500000");
    expect(result.contracts["lot:1"]?.trainRuns.trainKm).toBe("3");
  });
});
