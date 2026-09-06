import { describe, expect, it } from "vitest";
import type { OperatingProgram } from "@zugfolge/dispatch";

import type { DailyReportRow } from "./api.js";
import { addRule, moveRule, removeCondition, reorderRules, updateCondition } from "./model.js";
import { renderApp } from "./view.js";

const program: OperatingProgram = {
  schema: "operating-program/v1",
  world_id: "world",
  operator_id: "operator",
  version: 1,
  enabled: true,
  rules: [
    { id: "a", priority: 300, enabled: true, trigger: { type: "route_closure" }, condition: { type: "all", children: [
      { type: "predicate", fact: "route_closed", comparison: "equal", value: { type: "boolean", value: true } },
      { type: "predicate", fact: "cost_cents", comparison: "less_or_equal", value: { type: "integer", value: 10_000 } },
    ] }, action: "request_reroute" },
    { id: "b", priority: 200, enabled: true, trigger: { type: "vehicle_failure" }, condition: { type: "predicate", fact: "vehicle_failed", comparison: "equal", value: { type: "boolean", value: true } }, action: "provide_replacement_vehicle" },
    { id: "c", priority: 100, enabled: false, trigger: { type: "connection_risk" }, condition: { type: "predicate", fact: "connection_threatened", comparison: "equal", value: { type: "boolean", value: true } }, action: "hold_connection" },
  ],
};

const viewContext = {
  worldId: "world",
  operatorId: "operator",
  activePanel: "operations" as const,
  pageUrl: "https://spiel.example/operations/?world=world&operator=operator",
  gameWebUrl: "https://spiel.example/game/",
  livemapUrl: "https://spiel.example/live/",
};

describe("zugängliche Editor-Operationen", () => {
  it("zeigt ohne Programmausführung kein altes Programm als wirksam und erlaubt weiter das Speichern", () => {
    const saved = { version: 1, status: "active" as const, checksum: "a".repeat(64), canonicalProgram: program };
    const html = renderApp({ ...viewContext, activePanel: "program", program, savedProgram: saved, templates: [], versions: [saved], operations: { consumerAvailable: false, throughSequence: 0, decisions: [], cancellations: [], manualInterventions: [], majorEvents: [] }, reports: [], loading: false, saving: false, message: "", messageTone: "status", selectedDecisionId: "" });
    expect(html).toContain("Programmausführung nicht verfügbar");
    expect(html).not.toContain("Programm v1 aktiv");
    expect(html).toContain('id="activate-program" class="danger-button" disabled');
    expect(html).toContain('id="run-backtest" class="quiet-button" disabled');
    expect(html).toContain('id="save-program" class="primary-button">');
  });
  it("bietet im Fehlerzustand Wiederholung und einen Rückweg zur Spielwelt", () => {
    const html = renderApp({ ...viewContext, templates: [], versions: [], reports: [], loading: false, saving: false, message: "Failed to fetch", messageTone: "error", selectedDecisionId: "" });
    expect(html).toContain('id="refresh"');
    expect(html).toContain('href="../"');
    expect(html).toContain("Zur Spielwelt");
  });
  it("liefert für Drag, Touch und Tastatur dieselbe stabile Sortierung", () => {
    const dragged = reorderRules(program, "c", "a");
    const keyboard = moveRule(moveRule(program, "c", -1), "c", -1);
    expect(dragged.rules.map((rule) => rule.id)).toEqual(["c", "a", "b"]);
    expect(keyboard.rules.map((rule) => rule.id)).toEqual(["c", "a", "b"]);
    expect(dragged.rules.map((rule) => rule.priority)).toEqual([300, 200, 100]);
  });

  it("bearbeitet verschachtelte Bedingungen ohne den übrigen Baum zu verlieren", () => {
    const changed = updateCondition(program, "a", "1", (value) => value.type === "predicate" ? { ...value, value: { type: "integer", value: 20_000 } } : value);
    expect(changed.rules[0]?.condition).toMatchObject({ type: "all", children: [{ value: { value: true } }, { value: { value: 20_000 } }] });
    const removed = removeCondition(changed, "a", "0");
    expect(removed.rules[0]?.condition).toMatchObject({ type: "all", children: [{ fact: "cost_cents" }] });
  });

  it("erzeugt eindeutige neue Regeln", () => {
    expect(addRule(program).rules.at(-1)?.id).toBe("regel-4");
  });

  it("zeigt Tagesberichtsfakten, Ereignislink und abgeleitete Hebel getrennt", () => {
    const report = {
      serviceDay: "2026-08-11",
      projection: {
        evidenceComplete: false,
        trainRuns: { total: 1, punctual: 0, delayed: 0, cancelled: 1, replacementServices: 1 },
        settlements: { revenueCents: "0", costCents: "1000", contractPenaltyCents: "200" },
        decisionsByAction: { trigger_rail_replacement: 1 },
        infrastructureEffects: ["Abzweig Gröbers"], personnelEffects: ["Bereitschaft"], vehicleEffects: ["Busreserve"],
        facts: { eventSequences: [11], decisions: [{ eventSequence: 11, occurredAt: "2026-08-11T04:01:00.000Z", eventType: "dispatch.major-event", decisionId: "d-1", trainRunId: "RE-1", programVersion: 3, ruleId: "closure-short-turn", action: "trigger_rail_replacement", conditions: [{ matched: true }], limits: [{ kind: "capacity", accepted: true }], rejectedAlternatives: [{ action: "request_reroute", reason: "Kapazität" }], manualOverride: false, outcomeReason: "Ersatzverkehr", impact: { affected_train_runs: 4 } }] },
        assessment: { nextLevers: ["Ausfallregeln im Rücktest vergleichen."] },
      },
    } satisfies DailyReportRow;
    const html = renderApp({ ...viewContext, activePanel: "reports", program, templates: [], versions: [], reports: [report], loading: false, saving: false, message: "", messageTone: "status", selectedDecisionId: "" });
    expect(html).toContain('href="#event-11"');
    expect(html).toContain("closure-short-turn");
    expect(html).toContain("capacity");
    expect(html).toContain("Das kannst du verbessern");
    expect(html).toContain("Für diesen Bericht fehlen noch Fahrtdaten");
  });

  it("trennt globale Navigation, feste Betriebstabs und lokal scrollenden Inhalt", () => {
    const html = renderApp({
      ...viewContext,
      activePanel: "program",
      program,
      templates: [],
      versions: [],
      reports: [],
      loading: false,
      saving: false,
      message: "",
      messageTone: "status",
      selectedDecisionId: "",
      operatorContext: {
        schemaVersion: "zugfolge-operator-context/v1",
        worldId: "world",
        operators: [{ id: "operator", name: "Saale-Sprinter", finance: { mode: "finite", ledgerBalanceCents: "10000", pendingDebitCents: "2500", availableCents: "7500" } }],
      },
    });
    expect(html).toContain('aria-label="Hauptnavigation"');
    expect(html).toContain('aria-label="Betriebszentrale"');
    expect(html).toContain('class="operations-workspace" data-scroll-region');
    expect(html).toContain("Saale-Sprinter");
    expect(html).toContain("75,00 €");
    expect(html).toContain("https://spiel.example/live/?world=world&amp;operator=operator");
    expect(html).not.toContain('id="operations" class="panel"');
    expect(html).not.toContain('id="reports" class="panel"');
  });
});
