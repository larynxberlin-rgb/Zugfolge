import { badge, escapeHtml, icon } from "@zugfolge/design-system";
import type { Condition, OperatingProgram } from "@zugfolge/dispatch";

import type { DailyReportRow, OperationsDecision, OperationsProjection, ProgramVersion } from "./api.js";
import { ACTIONS, COMPARISONS, FACTS, TRIGGERS } from "./constants.js";

export interface ViewState {
  readonly program?: OperatingProgram;
  readonly templates: readonly { readonly id: string; readonly name: string; readonly program: OperatingProgram }[];
  readonly versions: readonly ProgramVersion[];
  readonly operations?: OperationsProjection;
  readonly reports: readonly DailyReportRow[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly message: string;
  readonly messageTone: "status" | "error";
  readonly selectedDecisionId: string;
}

const labels: Readonly<Record<string, string>> = {
  delay_threshold: "Verspätungsschwelle", connection_risk: "Anschlussgefährdung", vehicle_failure: "Fahrzeugausfall",
  personnel_duty_exceeded: "Personalzeit überschritten", route_closure: "Streckensperrung", platform_change: "Bahnsteigänderung",
  turnaround_shortfall: "Wendezeit unterschritten", ad_hoc_path_conflict: "Ad-hoc-Trassenkonflikt",
  hold_connection: "Anschluss halten", break_connection: "Anschluss brechen", skip_stop: "Halt auslassen", short_turn: "Kurzwenden",
  shorten_train: "Zug schwächen", strengthen_train: "Zug verstärken", cancel_run: "Fahrt ausfallen lassen",
  activate_reserve_rotation: "Reserveumlauf aktivieren", provide_replacement_vehicle: "Ersatzfahrzeug stellen",
  request_reroute: "Umleitung anfragen", return_path: "Trasse zurückgeben", trigger_rail_replacement: "Ersatzverkehr auslösen",
  apply_disruption: "Betriebswirksame Einschränkung",
  delay_seconds: "Verspätung (s)", connection_threatened: "Anschluss gefährdet", vehicle_failed: "Fahrzeug ausgefallen",
  duty_excess_seconds: "Dienstzeitüberschreitung (s)", route_closed: "Strecke gesperrt", platform_changed: "Bahnsteig geändert",
  turnaround_shortfall_seconds: "Fehlende Wendezeit (s)", ad_hoc_conflict: "Trassenkonflikt", affected_train_runs: "Betroffene Fahrten", cost_cents: "Kosten (Cent)",
  equal: "ist gleich", not_equal: "ist ungleich", greater_or_equal: "mindestens", less_or_equal: "höchstens",
};

function option(value: string, selected: string): string {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(labels[value] ?? value)}</option>`;
}

function renderCondition(condition: Condition, path = "root"): string {
  if (condition.type === "predicate") {
    const rawValue = condition.value.value;
    const input = condition.value.type === "boolean"
      ? `<select data-condition-value>${option("true", String(rawValue))}${option("false", String(rawValue))}</select>`
      : `<input data-condition-value type="number" step="1" value="${String(rawValue)}">`;
    return `<li class="condition condition--predicate" data-condition-path="${path}">
      <span class="tree-rail" aria-hidden="true"></span>
      <label>Faktum<select data-condition-fact>${FACTS.map((fact) => option(fact, condition.fact)).join("")}</select></label>
      <label>Vergleich<select data-condition-comparison>${COMPARISONS.map((comparison) => option(comparison, condition.comparison)).join("")}</select></label>
      <label>Wert${input}</label>
      ${path === "root" ? "" : `<button class="icon-button" data-remove-condition title="Bedingung entfernen" aria-label="Bedingung entfernen">${icon("close")}</button>`}
    </li>`;
  }
  if (condition.type === "not") {
    return `<li class="condition condition--group" data-condition-path="${path}"><div class="condition-heading"><strong>Nicht</strong></div><ol>${renderCondition(condition.child, path === "root" ? "0" : `${path}.0`)}</ol></li>`;
  }
  return `<li class="condition condition--group" data-condition-path="${path}">
    <div class="condition-heading"><strong>${condition.type === "all" ? "Alle Bedingungen" : "Mindestens eine Bedingung"}</strong><button class="quiet-button" data-add-condition>+ Bedingung</button></div>
    <ol>${condition.children.map((child, index) => renderCondition(child, path === "root" ? String(index) : `${path}.${index}`)).join("")}</ol>
  </li>`;
}

function renderRule(rule: OperatingProgram["rules"][number], index: number, count: number): string {
  const trigger = rule.trigger.type;
  return `<article class="rule-card" data-rule-id="${escapeHtml(rule.id)}" draggable="true" tabindex="0" aria-label="Regel ${index + 1}: ${escapeHtml(rule.id)}">
    <header class="rule-card__header">
      <button class="drag-handle" data-drag-handle aria-label="Regel ziehen; mit Alt und Pfeiltasten verschieben" title="Ziehen oder Alt+Pfeiltasten">⠿</button>
      <span class="rule-number">${String(index + 1).padStart(2, "0")}</span>
      <label class="rule-id">Regel-ID<input data-rule-id-input value="${escapeHtml(rule.id)}" pattern="[a-z0-9_.-]+"></label>
      <label class="switch"><input data-rule-enabled type="checkbox"${rule.enabled ? " checked" : ""}><span>Aktiv</span></label>
      <button class="icon-button" data-move="up"${index === 0 ? " disabled" : ""} aria-label="Regel nach oben">↑</button>
      <button class="icon-button" data-move="down"${index === count - 1 ? " disabled" : ""} aria-label="Regel nach unten">↓</button>
      <button class="icon-button" data-remove-rule aria-label="Regel löschen" title="Regel löschen">${icon("close")}</button>
    </header>
    <div class="rule-fields">
      <label>Priorität<input data-priority type="number" step="1" value="${rule.priority}"></label>
      <label>Auslöser<select data-trigger>${TRIGGERS.map((value) => option(value, trigger)).join("")}</select></label>
      ${trigger === "delay_threshold" ? `<label>Schwelle (s)<input data-trigger-threshold type="number" min="1" step="1" value="${rule.trigger.type === "delay_threshold" ? rule.trigger.at_least_seconds : 300}"></label>` : ""}
      <label>Maßnahme<select data-action>${ACTIONS.map((value) => option(value, rule.action)).join("")}</select></label>
    </div>
    <section class="condition-tree" aria-label="Bedingungsbaum"><h4>Bedingungen</h4><ol>${renderCondition(rule.condition)}</ol></section>
  </article>`;
}

function renderDecision(entry: OperationsDecision, major: boolean, selected: boolean): string {
  const cost = entry.impact.cost_cents ?? entry.impact.costCents;
  const cause = entry.causeCode === null
    ? entry.cause
    : `${String(entry.causeCode).padStart(2, "0")} · ${entry.causeLabel || entry.cause}${entry.fineCauseId ? ` / ${entry.fineCauseLabel || entry.fineCauseId}` : ""}`;
  return `<article id="event-${entry.sequence}" class="decision-card${major ? " decision-card--major" : ""}${selected ? " is-selected" : ""}" tabindex="0" data-decision-id="${escapeHtml(entry.decisionId)}">
    <header><span class="sequence">#${entry.sequence}</span>${badge(labels[entry.action] ?? entry.action, major ? "danger" : "attention", major ? "alert" : "route")}</header>
    <h4>${escapeHtml(entry.trainRunId || "Betriebsereignis")}</h4>
    <dl><div><dt>Ursache</dt><dd>${escapeHtml(cause || "—")}</dd></div><div><dt>Ressource</dt><dd>${escapeHtml(entry.affectedResource || "—")}</dd></div><div><dt>Folge</dt><dd>${escapeHtml(entry.outcomeReason || "—")}</dd></div><div><dt>Kosten</dt><dd>${cost === undefined ? "—" : `${escapeHtml(String(cost))} ct`}</dd></div></dl>
    <button class="quiet-button" data-open-override="${escapeHtml(entry.decisionId)}">Einzelfall entscheiden</button>
  </article>`;
}

function reportMarkup(report: DailyReportRow): string {
  const value = report.projection;
  const decisions = value.facts.decisions;
  const evidence = decisions.map((entry) => `<li><a href="#event-${entry.eventSequence}">Ereignis #${entry.eventSequence}</a> ${escapeHtml(entry.occurredAt)}: Regel ${escapeHtml(entry.ruleId || "ohne Treffer")} ${entry.programVersion === null ? "" : `in v${entry.programVersion}`} → ${escapeHtml(entry.action)}${entry.manualOverride ? " (manuell übersteuert)" : ""}; ${entry.rejectedAlternatives.length} abgelehnt. ${escapeHtml(entry.outcomeReason)}<details><summary>Prüfpfad und konkrete Wirkung</summary><p>Bedingungen: ${escapeHtml(JSON.stringify(entry.conditions))}</p><p>Grenzen: ${escapeHtml(JSON.stringify(entry.limits))}</p><p>Ablehnungen: ${escapeHtml(JSON.stringify(entry.rejectedAlternatives))}</p><p>Wirkung: ${escapeHtml(JSON.stringify(entry.impact))}</p></details></li>`).join("");
  return `<article class="report-card"><header><h4>${escapeHtml(report.serviceDay)}</h4>${badge(`${value.trainRuns.total} Fahrten`, "neutral", "train")}</header>
    <dl class="metrics"><div><dt>Pünktlich</dt><dd>${value.trainRuns.punctual}</dd></div><div><dt>Verspätet</dt><dd>${value.trainRuns.delayed}</dd></div><div><dt>Ausfälle</dt><dd>${value.trainRuns.cancelled}</dd></div><div><dt>Ersatz</dt><dd>${value.trainRuns.replacementServices}</dd></div></dl>
    <p>Ertrag ${escapeHtml(value.settlements.revenueCents)} ct · Kosten ${escapeHtml(value.settlements.costCents)} ct · Vertragswirkung ${escapeHtml(value.settlements.contractPenaltyCents)} ct</p>
    <details><summary>Wirkungen</summary><p>Infrastruktur: ${escapeHtml(value.infrastructureEffects.join(", ") || "keine")}</p><p>Personal: ${escapeHtml(value.personnelEffects.join(", ") || "keine")}</p><p>Fahrzeuge: ${escapeHtml(value.vehicleEffects.join(", ") || "keine")}</p></details>
    <details><summary>Entscheidungsfakten und Ereignisnachweise</summary>${decisions.length === 0 ? "<p>Keine Regelentscheidung.</p>" : `<ul>${evidence}</ul>`}</details>
    <section aria-label="Abgeleitete Bewertung"><h5>Nächste Hebel <small>(abgeleitete Bewertung)</small></h5><ul>${value.assessment.nextLevers.map((lever) => `<li>${escapeHtml(lever)}</li>`).join("")}</ul></section>
  </article>`;
}

export function renderApp(state: ViewState): string {
  if (state.loading) return `<main class="load-state"><span class="spinner" aria-hidden="true"></span><h1>Betriebszentrale wird geladen</h1><p>Serverautoritative Programme und Ereignisprojektionen werden abgerufen.</p></main>`;
  if (state.program === undefined) return `<main class="load-state"><p class="eyebrow">ZUGFOLGE · BETRIEBSZENTRALE</p><h1>Betriebszentrale nicht verfügbar</h1><p>${escapeHtml(state.message)}</p><div class="load-state__actions"><button id="refresh" class="quiet-button">Erneut versuchen</button><a class="quiet-button" href="../">Zur Spielwelt</a></div></main>`;
  const active = state.versions.find((version) => version.status === "active");
  const operations = state.operations ?? { throughSequence: 0, decisions: [], cancellations: [], manualInterventions: [], majorEvents: [] };
  const important = [...operations.majorEvents, ...operations.decisions.filter((entry) => !operations.majorEvents.some((major) => major.decisionId === entry.decisionId))];
  return `<div class="shell">
    <aside class="sidebar" aria-label="Bereichsnavigation"><div class="wordmark">ZUGFOLGE</div><nav><a class="active" href="#operations">${icon("alert")}<span>Betrieb</span></a><a href="#program">${icon("layers")}<span>Regelwerk</span></a><a href="#reports">${icon("clock")}<span>Tagesberichte</span></a></nav><p class="sidebar-note">Serverautoritative Welt<br><span>Live · Sequenz ${operations.throughSequence}</span></p></aside>
    <main id="main">
      <header class="topbar"><div><p class="eyebrow">EVU-BETRIEBSZENTRALE</p><h1>Betrieb steuern, bevor er entgleist.</h1></div><div class="topbar-actions">${active === undefined ? badge("Kein aktives Programm", "danger", "warning") : badge(`Programm v${active.version} aktiv`, "success", "check")}<button id="refresh" class="quiet-button">Aktualisieren</button></div></header>
      ${state.message === "" ? "" : `<div class="message message--${state.messageTone}" role="${state.messageTone === "error" ? "alert" : "status"}">${escapeHtml(state.message)}</div>`}
      <section class="metrics-strip" aria-label="Aktuelle Betriebskennzahlen"><div><span>Entscheidungen</span><strong>${operations.decisions.length}</strong></div><div><span>Großereignisse</span><strong>${operations.majorEvents.length}</strong></div><div><span>Ausfälle</span><strong>${operations.cancellations.length}</strong></div><div><span>Manuell</span><strong>${operations.manualInterventions.length}</strong></div></section>
      <section id="operations" class="panel"><header class="section-header"><div><p class="eyebrow">LIVE-BETRIEB</p><h2>Abweichungen und Entscheidungen</h2></div>${badge("EVU-gefiltert", "neutral", "lock")}</header><div class="decision-grid">${important.length === 0 ? `<div class="empty"><strong>Keine Abweichungen</strong><span>Neue Kernereignisse erscheinen hier sofort.</span></div>` : important.map((entry) => renderDecision(entry, operations.majorEvents.some((major) => major.decisionId === entry.decisionId), entry.decisionId === state.selectedDecisionId)).join("")}</div></section>
      <section id="program" class="panel"><header class="section-header"><div><p class="eyebrow">BETRIEBSPROGRAMM v${state.program.version}</p><h2>Regelwerk</h2><p>Höhere Regeln gewinnen. Gleiche Priorität wird stabil nach Regel-ID aufgelöst.</p></div><label class="switch program-switch"><input id="program-enabled" type="checkbox"${state.program.enabled ? " checked" : ""}><span>Programm aktiv</span></label></header>
        <div class="editor-toolbar"><label>Vorlage<select id="template"><option value="">Vorlage wählen …</option>${state.templates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`).join("")}</select></label><button id="add-rule" class="quiet-button">+ Regel</button><button id="run-backtest" class="quiet-button">Rücktest</button><button id="save-program" class="primary-button"${state.saving ? " disabled" : ""}>${state.saving ? "Speichert …" : "Neue Version speichern"}</button><button id="activate-program" class="danger-button">Version aktivieren</button></div>
        <div class="rule-list" aria-label="Sortierbare Regeln">${state.program.rules.map((rule, index) => renderRule(rule, index, state.program!.rules.length)).join("")}</div>
      </section>
      <section id="reports" class="panel"><header class="section-header"><div><p class="eyebrow">EREIGNISPROJEKTION</p><h2>Tagesberichte</h2></div><div class="report-action"><input id="report-day" type="date" aria-label="Betriebstag"><button id="generate-report" class="quiet-button">Bericht erzeugen</button></div></header><div class="reports">${state.reports.length === 0 ? `<div class="empty"><strong>Noch kein Tagesbericht</strong><span>Berichte werden ausschließlich aus dem Event-Log aufgebaut.</span></div>` : state.reports.map(reportMarkup).join("")}</div></section>
    </main>
    <dialog id="override-dialog"><form method="dialog"><header><div><p class="eyebrow">EINZELFALL</p><h2>Entscheidung übersteuern</h2></div><button value="cancel" class="icon-button" aria-label="Dialog schließen">${icon("close")}</button></header><p>Der Override gilt nur für die gewählte Entscheidung und durchläuft dieselben Kapazitäts-, Fahrzeug-, Personal-, Vertrags- und Kostengrenzen.</p><input id="override-decision" type="hidden" value="${escapeHtml(state.selectedDecisionId)}"><label>Maßnahme<select id="override-action">${ACTIONS.map((value) => option(value, "request_reroute")).join("")}</select></label><label>Begründung<textarea id="override-reason" minlength="8" maxlength="500" required></textarea></label><footer><button value="cancel" class="quiet-button">Abbrechen</button><button id="submit-override" value="default" class="danger-button">Einzelfall senden</button></footer></form></dialog>
  </div>`;
}
