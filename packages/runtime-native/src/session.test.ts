import { describe, expect, it } from "vitest";
import { parseConductorSessionSnapshot } from "./session.js";
import type { ConductorSessionSnapshotV1 } from "./session-types.js";

const hash = "a".repeat(64);
// Ausschließlich Parser-Gegentests; kein positiver Betriebs- oder Freigabebeleg.
function snapshot(): ConductorSessionSnapshotV1 {
  return {
    schemaVersion: "conductor-session-snapshot/v1", worldId: "world", trainRunId: "train",
    sessionId: "session", operatorId: "operator", status: "active", revision: 2, sequence: 2,
    nowMs: 100, leaseUntilMs: 5000, endReason: null,
    position: { vehicleId: "vehicle", bodyId: "body", deckId: "main", xMm: 1000, yMm: 1000 },
    pins: { periodId: "period", operationalWorldHash: hash, operationalFormationId: "operational-formation",
      formationId: "formation", vehicleIds: ["vehicle"], interiorLayoutHash: hash, demandStateHash: hash,
      manifestRevision: 1, projectionHash: hash, dialogueReleaseHash: hash, policyHash: hash },
    passengers: {
      schemaVersion: "passenger-projection/v2", binding: { worldId: "world", periodId: "period", demandReleaseId: "demand",
        releaseHash: hash, seedHash: hash, trainRunId: "train", operatorId: "operator", manifestRevision: 1,
        demandStateHash: hash, operationalReceiptId: "receipt" },
      segmentId: "segment", fromStopId: "from", toStopId: "to", layoutId: "layout", sourceLayoutHash: hash,
      layoutHash: hash, asOfMs: 100, phase: "in_transit", currentStopId: null, stateHash: hash,
      passengers: ["first", "second"].map((passengerKey, index) => ({ passengerKey, placeId: `seat-${index}`, spaceId: null,
        vehicleId: "vehicle", bodyId: "body", deckId: "main", xMm: 2000 + index * 1000, yMm: 1000,
        comfortClass: "standard", spaceNeeds: "ordinary", posture: "seated", appearanceVariant: index, activity: "onboard" })),
    },
    activeEncounter: { schemaVersion: "passenger-encounter/v1", encounterId: "encounter", revision: 1, status: "active",
      passengerText: "Guten Tag.", options: [{ optionId: "check", text: "Fahrschein zeigen", timeCostMs: 1000 }],
      hints: { documentStatus: "unchecked", acquisitionException: "unknown", identityStatus: "unknown", concreteDanger: false },
      availableAtMs: 100 },
    activePassengerKey: "first", snapshotHash: hash,
  };
}

describe("öffentliche Zuordnung der aktiven Begegnung", () => {
  it("erhält die native Zuordnung unabhängig von einer anderen lokalen Auswahl", () => {
    const value = snapshot();
    const serialized = JSON.stringify(value);
    const parsed = parseConductorSessionSnapshot(value);
    const localSelection = "second";
    expect(parsed.activePassengerKey).toBe("first");
    expect(parsed.activePassengerKey).not.toBe(localSelection);
    expect(parsed).toBe(value);
    expect(JSON.stringify(parsed)).toBe(serialized);
    expect(parseConductorSessionSnapshot({ ...value, status: "detached" }).activePassengerKey).toBe("first");
  });

  it("liest alte Receipt- und SSE-Snapshots ohne Ergänzung oder Hashänderung", () => {
    const value = snapshot();
    delete (value as { activePassengerKey?: string | null }).activePassengerKey;
    const original = JSON.stringify(value);
    const parsed = parseConductorSessionSnapshot(JSON.parse(original));
    expect(parsed.activeEncounter).not.toBeNull();
    expect(Object.hasOwn(parsed, "activePassengerKey")).toBe(false);
    expect(parsed.snapshotHash).toBe(hash);
    expect(JSON.stringify(parsed)).toBe(original);
  });

  it("akzeptiert beendete Snapshots ohne Personenzuordnung", () => {
    const value = { ...snapshot(), status: "ended", endReason: "requested", activeEncounter: null };
    delete (value as { activePassengerKey?: string | null }).activePassengerKey;
    expect(parseConductorSessionSnapshot(value).activePassengerKey).toBeUndefined();
    expect(parseConductorSessionSnapshot({ ...value, activePassengerKey: null }).activePassengerKey).toBeNull();
  });

  it("weist widersprüchliche Zuordnungen und private Zusatzfelder zurück", () => {
    for (const mutate of [
      (value: any) => { value.activePassengerKey = "foreign-passenger"; },
      (value: any) => { value.activePassengerKey = null; },
      (value: any) => { value.activePassengerKey = undefined; },
      (value: any) => { value.activeEncounter = null; },
      (value: any) => { value.activeEncounter.status = "closed"; },
      (value: any) => { value.passengers.passengers[0].activity = "alighting"; },
      (value: any) => { value.status = "ended"; value.endReason = "requested"; },
      (value: any) => { value.selectedKey = "second"; },
      (value: any) => { value.activeEncounter.fareFact = "private"; },
    ]) {
      const value = snapshot(); mutate(value);
      expect(() => parseConductorSessionSnapshot(value)).toThrow("autoritativen Kern");
    }
  });
});
