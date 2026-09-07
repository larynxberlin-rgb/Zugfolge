import type { DomainEvent } from "@zugfolge/db";
import { describe, expect, it } from "vitest";
import { adaptOperationalDomainEvents, type OperationalNativeEvent } from "./operational-domain-event-adapter.js";
import { projectSimulationEventBatch } from "./simulation-event-projection.js";

const world = "11111111-1111-4111-8111-111111111111";
const cause = "authority.police.fare-control";
const facts = { schemaVersion: "zugfolge-fare-control-hold-event/v1", worldId: world, trainRunId: "test-train", holdId: "private-hold",
  targetStopId: "test-stop", atMs: 1000, status: "active", outcome: null, revision: 2, cause, causalityId: "private-causality" };
const event: OperationalNativeEvent = { eventSequence: 1, commitSequence: 2, atMs: 1000, kind: "fare-control-hold-activated", subjectId: "test-train", detail: JSON.stringify(facts) };
describe("Betriebliche Kontrollhaltereignisse", () => {
  it("persistiert typisierte Tatsachen und veröffentlicht ausschließlich Ursache und Status", () => {
    const native = [event, { ...event, eventSequence: 2, kind: "departure-authority-withheld", detail: cause }];
    const adapted = adaptOperationalDomainEvents(native, [], [], "test-region", world);
    expect(adapted.map((row) => row.eventType)).toEqual(["operations.fare-control-hold-activated", "operations.departure-authority-withheld"]);
    expect(adapted[0]!.payload["holdId"]).toBe("private-hold");
    const domain = adapted.map((row, index): DomainEvent => ({ id: String(index), worldId: world, sequence: index + 1, occurredAt: new Date(1000), ...row }));
    const projected = projectSimulationEventBatch(domain, new Set(), 0);
    expect(projected.events).toHaveLength(2);
    expect(projected.events[0]!.payload).toEqual({ trainRunId: "test-train", status: "active", cause, causeLabel: "Polizeiliche Maßnahme nach Fahrkartenkontrolle" });
    expect(JSON.stringify(projected)).not.toContain("private-");
    expect(JSON.stringify(projected)).not.toContain("outcome");
  });
  it("weist fremde Welten, manipulierte Übergänge und private Zusatzfelder zurück", () => {
    for (const payload of [{ ...facts, worldId: "other" }, { ...facts, status: "requested" }, { ...facts, caseIds: ["private"] }, { ...facts, atMs: 999 }]) {
      expect(() => adaptOperationalDomainEvents([{ ...event, detail: JSON.stringify(payload) }], [], [], "test-region", world)).toThrow();
    }
    expect(() => adaptOperationalDomainEvents([event], [], [], "test-region")).toThrow();
    expect(() => adaptOperationalDomainEvents([{ ...event, kind: "departure-authority-withheld", detail: "unproven" }], [], [], "test-region", world)).toThrow();
  });
  it("bindet die tatsächliche Haltplanabsage an Planhash und Weltzeit", () => {
    const cancelled = { ...event, kind: "passenger-stop-plan-cancelled", detail: JSON.stringify({ worldId: world, trainRunId: "test-train", stopPlanHash: "a".repeat(64), cancelledAtMs: 1000, causalityId: "test-disposition" }) };
    expect(adaptOperationalDomainEvents([cancelled], [], [], "test-region", world)[0]!.eventType).toBe("operations.passenger-stop-plan-cancelled");
    expect(() => adaptOperationalDomainEvents([{ ...cancelled, atMs: 1001 }], [], [], "test-region", world)).toThrow();
  });
});
