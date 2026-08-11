import { describe, expect, it } from "vitest";

import {
  buildDailyReport,
  canonicalizeProgram,
  MAJOR_DISRUPTION_AFFECTED_TRAIN_RUNS,
  operatingProgramTemplates,
  OperationsFeed,
  ProgramValidationError,
  projectOperations,
  type LoggedEvent,
} from "./index.js";

const worldId = "11111111-1111-1111-1111-111111111111";
const operatorId = "22222222-2222-2222-2222-222222222222";

function events(): LoggedEvent[] {
  return [
    {
      sequence: 10,
      eventType: "operations.train-outcome",
      occurredAt: new Date("2026-08-11T04:00:00Z"),
      payload: { operatorId, status: "completed", delaySeconds: 120 },
    },
    {
      sequence: 11,
      eventType: "dispatch.major-event",
      occurredAt: new Date("2026-08-11T04:01:00Z"),
      payload: {
        operatorId,
        trainRunId: "RE-1",
        decisionId: "d-1",
        action: "trigger_rail_replacement",
        major: true,
        manualOverride: false,
        cause: "Streckensperrung",
        affectedResource: "Abzweig Gröbers",
        outcomeReason: "Ersatzverkehr ausgelöst",
        impact: { affected_train_runs: 4, cost_cents: 1_000, contract_penalty_cents: 200, personnel_effect: "Bereitschaft", vehicle_effect: "Busreserve" },
        explanation: { program_version: 3, selected_rule_id: "closure-short-turn", conditions: [{ path: "root", matched: true }], limits: [{ kind: "capacity", accepted: true }], rejected_alternatives: [{ action: "request_reroute", reason: "Kapazität" }] },
      },
    },
    {
      sequence: 12,
      eventType: "economy.settlement",
      occurredAt: new Date("2026-08-11T23:59:00Z"),
      payload: { operatorId, revenueCents: "5000", costCents: "250", contractPenaltyCents: "50" },
    },
    {
      sequence: 13,
      eventType: "dispatch.decision",
      occurredAt: new Date("2026-08-11T23:59:30Z"),
      payload: { operatorId: "33333333-3333-3333-3333-333333333333", decisionId: "foreign", action: "cancel_run" },
    },
    {
      sequence: 14,
      eventType: "dispatch.manual-override",
      occurredAt: new Date("2026-08-11T23:59:40Z"),
      payload: { operatorId, trainRunId: "RE-2", decisionId: "d-2", action: "request_reroute", manualOverride: true, outcomeReason: "Autorisierter Einzelfall", impact: { affected_train_runs: 1 } },
    },
  ];
}

describe("M7-Plattformvertrag", () => {
  it("kanonisiert dieselben Vorlagen wie der Rust-Vertrag und bindet Welt plus EVU", () => {
    const [template] = operatingProgramTemplates(worldId, operatorId, 3);
    const first = canonicalizeProgram(template, { worldId, operatorId });
    const second = canonicalizeProgram({ ...template, rules: [...template!.rules].reverse() }, { worldId, operatorId });
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(() => canonicalizeProgram(template, { worldId, operatorId: "fremd" })).toThrow(ProgramValidationError);
  });

  it("isoliert Betriebsprojektion und Tagesbericht strikt je EVU", () => {
    const projection = projectOperations(events(), operatorId);
    expect(projection.decisions.map((entry) => entry.decisionId)).toEqual(["d-1", "d-2"]);
    expect(projection.majorEvents).toHaveLength(1);
    const report = buildDailyReport(events(), operatorId, "2026-08-11");
    expect(report.trainRuns).toEqual({ total: 1, punctual: 1, delayed: 0, cancelled: 0, replacementServices: 1 });
    expect(report.settlements).toEqual({ revenueCents: "5000", costCents: "1250", contractPenaltyCents: "250" });
    expect(report.infrastructureEffects).toEqual(["Abzweig Gröbers"]);
    expect(report.facts.eventSequences).toEqual([10, 11, 12, 14]);
    expect(report.facts.decisions).toMatchObject([
      { eventSequence: 11, programVersion: 3, ruleId: "closure-short-turn", action: "trigger_rail_replacement", manualOverride: false },
      { eventSequence: 14, ruleId: "", action: "request_reroute", manualOverride: true },
    ]);
    expect(report.facts.decisions[0]!.rejectedAlternatives).toHaveLength(1);
    expect(report.assessment.nextLevers).toEqual(expect.arrayContaining([
      "Abgelehnte Maßnahmen an den protokollierten Betriebsgrenzen prüfen.",
      "Manuellen Einzelfall als mögliche, weiterhin grenzgeprüfte Regelanpassung bewerten.",
    ]));
  });

  it("klassifiziert die dokumentierte Großstörungsschwelle ohne Client-Heuristik", () => {
    const disruption = (affectedTrainRuns: number): LoggedEvent => ({
      sequence: affectedTrainRuns,
      eventType: "dispatch.decision",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
      payload: { operatorId, decisionId: `threshold-${affectedTrainRuns}`, action: "short_turn", impact: { affected_train_runs: affectedTrainRuns } },
    });
    expect(MAJOR_DISRUPTION_AFFECTED_TRAIN_RUNS).toBe(3);
    expect(projectOperations([disruption(2)], operatorId).majorEvents).toHaveLength(0);
    expect(projectOperations([disruption(3)], operatorId).majorEvents).toHaveLength(1);
  });

  it("projiziert Verspätungsursachencode, Ersatzentscheidung und Kosten lückenlos", () => {
    const disruption: LoggedEvent = {
      sequence: 20,
      eventType: "disruption.replacement-plan",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
      payload: {
        operatorId,
        trainRunId: "RE-9",
        decisionId: "replacement-9",
        action: "trigger_rail_replacement",
        cause: "signaltechnische Störung",
        causeCode: 25,
        causeLabel: "Anlagen Leit- und Sicherungstechnik",
        affectedResource: "block:Leipzig-Wahren:2",
        outcomeReason: "Umleitung wegen belegter Restkapazität abgelehnt; SEV gewählt",
        rejectedAlternatives: [{ action: "request_reroute", reason: "Restkapazität vergeben" }],
        impact: { cost_cents: "600000", contract_penalty_cents: "50000", affected_train_runs: 4 },
      },
    };
    const projection = projectOperations([disruption], operatorId);
    expect(projection.decisions[0]).toMatchObject({
      causeCode: 25,
      causeLabel: "Anlagen Leit- und Sicherungstechnik",
      action: "trigger_rail_replacement",
    });
    const report = buildDailyReport([disruption], operatorId, "2026-08-11");
    expect(report.trainRuns.replacementServices).toBe(1);
    expect(report.settlements).toMatchObject({ costCents: "600000", contractPenaltyCents: "50000" });
    expect(report.facts.eventSequences).toEqual([20]);
  });

  it("projiziert die echte Single-Writer-Störungswirkung EVU-gefiltert bis in den Tagesbericht", () => {
    const applied: LoggedEvent = {
      sequence: 21,
      eventType: "disruption.applied",
      occurredAt: new Date("2026-08-11T10:05:00Z"),
      payload: {
        operatorIds: [operatorId, "other-operator"],
        affectedTrainRunIds: ["RE-9"],
        action: "apply_disruption",
        causeCode: 25,
        causeLabel: "Anlagen Leit- und Sicherungstechnik",
        fineCauseId: "signalling.interlocking",
        fineCauseLabel: "Stellwerk gestört",
        affectedResource: "block:Leipzig-Wahren:2",
        effect: "closure",
        outcomeReason: "Betriebswirksame Einschränkung im regionalen Single-Writer angewendet",
        impact: {
          affected_train_runs: 1,
          affected_resource: "block:Leipzig-Wahren:2",
          infrastructure_effect: "closure",
        },
      },
    };
    expect(projectOperations([applied], operatorId).decisions[0]).toMatchObject({
      causeCode: 25,
      fineCauseId: "signalling.interlocking",
      action: "apply_disruption",
      affectedResource: "block:Leipzig-Wahren:2",
    });
    expect(projectOperations([applied], "unaffected-operator").decisions).toEqual([]);
    expect(buildDailyReport([applied], operatorId, "2026-08-11")).toMatchObject({
      decisionsByAction: { apply_disruption: 1 },
      infrastructureEffects: ["block:Leipzig-Wahren:2"],
    });
  });

  it("liefert Resume-Replay und erzwingt eine begrenzte Historie", () => {
    const feed = new OperationsFeed(2);
    const decision = projectOperations(events(), operatorId).decisions[0]!;
    feed.publish({ worldId, operatorId, sequence: 10, decision });
    feed.publish({ worldId, operatorId, sequence: 11, decision });
    feed.publish({ worldId, operatorId, sequence: 12, decision });
    expect(feed.eventsAfter(10)?.map((entry) => entry.sequence)).toEqual([11, 12]);
    expect(feed.eventsAfter(9)).toBeUndefined();
  });
});
