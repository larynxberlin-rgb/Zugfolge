import type { DomainEvent } from "@zugfolge/db";
import { describe, expect, it } from "vitest";

import { projectSimulationEventBatch } from "./simulation-event-projection.js";

const WORLD = "11111111-1111-4111-8111-111111111111";

function event(sequence: number, eventType: string, payload: unknown): DomainEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    worldId: WORLD,
    sequence,
    eventType,
    payload,
    occurredAt: new Date(sequence * 1_000),
  };
}

describe("Simulationsevent-Spielerprojektion", () => {
  it("trennt oeffentliche und eigene Ereignisse und verwirft fremde Kosten, Runtime und Adminmetadaten", () => {
    const raw = [
      event(1, "simulation.started", { seed: 42, atS: 0, internalToken: "never" }),
      event(2, "economy.settlement", { operatorId: "operator-a", costCents: "1200", revenueCents: "5000" }),
      event(3, "economy.settlement", { operatorId: "operator-b", costCents: "999999", strategy: "dumping" }),
      event(4, "planning.runtime-state", { processedCommands: { secret: true }, alternatives: { exploit: true } }),
      event(5, "admin.action-audited", { actorReference: "root", commandPayload: { private: true } }),
      event(6, "dispatch.decision", {
        operatorId: "operator-a",
        decisionId: "own",
        runtime_secret: "never",
        commandPayload: { exploit: true },
        impact: { costCents: "42", seedWorld: "never" },
      }),
      event(7, "economy.future-internal", { operatorId: "operator-a", competitorStrategy: "never" }),
    ];

    const projected = projectSimulationEventBatch(raw, new Set(["operator-a"]), 0);

    expect(projected).toMatchObject({ after: 0, nextAfter: 7 });
    expect(projected.events.map((entry) => [entry.sequence, entry.visibility])).toEqual([
      [1, "public"],
      [2, "operator"],
      [6, "operator"],
    ]);
    expect(projected.events[0]?.payload).toEqual({ atS: 0 });
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("1200");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("processedCommands");
    expect(serialized).not.toContain("actorReference");
    expect(serialized).not.toContain("runtime_secret");
    expect(serialized).not.toContain("commandPayload");
    expect(serialized).not.toContain("seedWorld");
    expect(serialized).not.toContain("competitorStrategy");
    expect(serialized).not.toContain("internalToken");
  });

  it("bewegt den Cursor auch ueber einen vollstaendig verborgenen Rohbatch deterministisch weiter", () => {
    const raw = [
      event(11, "planning.runtime-state", { private: true }),
      event(12, "economy.settlement", { operatorId: "operator-b", costCents: "5" }),
    ];
    const first = projectSimulationEventBatch(raw, new Set(["operator-a"]), 10);
    const replay = projectSimulationEventBatch(raw, new Set(["operator-a"]), 10);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ after: 10, nextAfter: 12, events: [] });
  });

  it("projiziert Aktivierung und technische Freigabe einer v2-Stoerung ohne interne Wirkungspayload", () => {
    const raw = [
      event(20, "disruption.applied", {
        schemaVersion: "zugfolge-operational-disruption-event/v2",
        disruptionId: "disruption:1",
        effect: "closure",
        operationalEffect: { "resource-closed": { resourceId: "block:1" } },
        affectedResource: "block:1",
        affectedTrainRunIds: ["train:1"],
        operatorIds: ["operator-a"],
      }),
      event(21, "disruption.cleared", {
        schemaVersion: "zugfolge-operational-disruption-event/v2",
        disruptionId: "disruption:1",
        effect: "closure",
        operationalEffect: { "resource-closed": { resourceId: "block:1" } },
        affectedResource: "block:1",
        releaseReference: "repair-order:42",
        operatorIds: ["operator-a"],
      }),
    ];

    const projected = projectSimulationEventBatch(raw, new Set(["operator-a"]), 19);
    expect(projected.events).toEqual([
      expect.objectContaining({
        sequence: 20,
        eventType: "disruption.applied",
        visibility: "public",
        payload: {
          disruptionId: "disruption:1",
          effect: "closure",
          affectedResource: "block:1",
          affectedTrainRunIds: ["train:1"],
        },
      }),
      expect.objectContaining({
        sequence: 21,
        eventType: "disruption.cleared",
        visibility: "public",
        payload: {
          disruptionId: "disruption:1",
          effect: "closure",
          affectedResource: "block:1",
          releaseReference: "repair-order:42",
        },
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("operationalEffect");
    expect(JSON.stringify(projected)).not.toContain("operatorIds");
  });
});
