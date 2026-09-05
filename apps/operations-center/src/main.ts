import "@zugfolge/design-system/styles.css";
import type { ActionName, ComparisonName, Condition, FactName, OperatingProgram, TriggerName } from "@zugfolge/dispatch";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";

import { OperationsApi, type DailyReportRow } from "./api.js";
import { loadOperationsRuntimeConfiguration, operationsAccessToken } from "./auth.js";
import { addRule, moveRule, removeCondition, removeRule, reorderRules, updateCondition, updateRule } from "./model.js";
import { renderApp, type ViewState } from "./view.js";
import { captureEditorFocus, nextProgramVersion, restoreEditorFocus, sameProgramContent, savedProgramMatches } from "./editor.js";
import "./styles.css";
import "./workspace.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) throw new Error("App-Wurzel fehlt.");
const root: HTMLDivElement = rootElement;
mountGlossaryLayer(document.body);

const parameters = new URLSearchParams(location.search);
const worldId = parameters.get("world") ?? "";
const operatorId = parameters.get("operator") ?? "";
const requestedPanel = parameters.get("panel");
const activePanel = requestedPanel === "program" || requestedPanel === "reports" ? requestedPanel : "operations";
const runtime = loadOperationsRuntimeConfiguration();
let api: OperationsApi | undefined;

let state: ViewState = {
  worldId,
  operatorId,
  activePanel,
  pageUrl: window.location.href,
  gameWebUrl: runtime.gameWebUrl,
  livemapUrl: runtime.livemapUrl,
  templates: [],
  versions: [],
  reports: [],
  loading: true,
  saving: false,
  message: "",
  messageTone: "status",
  selectedDecisionId: "",
};
let dragRuleId = "";
let streamController: AbortController | undefined;
let refreshPromise: Promise<void> | undefined;
let refreshPending = false;
let dataRevision = 0;
let overrideDraft = { open: false, decisionId: "", fingerprint: "", action: "request_reroute", reason: "" };
let reportDay = "";
let renderedProgram: OperatingProgram | undefined;

function setState(patch: Partial<ViewState>, rerender = true): void {
  state = { ...state, ...patch };
  if (rerender) render();
}

function render(): void {
  // Live-Lesemodelle beruehren weder Editor noch modalen Entwurf. Damit bleiben
  // auch IME-Komposition und noch nicht durch change uebernommene Werte erhalten.
  if (state.program !== undefined && state.program === renderedProgram && root.querySelector(".shell") !== null) {
    reportDay = root.querySelector<HTMLInputElement>("#report-day")?.value ?? reportDay;
    const template = document.createElement("template");
    template.innerHTML = renderApp(state);
    for (const selector of [".topbar", ".sidebar-note", ".metrics-strip", "#operations", "#reports"]) {
      const previous = root.querySelector(selector);
      const next = template.content.querySelector(selector);
      if (previous !== null && next !== null) previous.replaceWith(next);
    }
    root.querySelector(".message")?.remove();
    const message = template.content.querySelector(".message");
    if (message !== null) root.querySelector(".operations-workspace")?.prepend(message);
    const day = root.querySelector<HTMLInputElement>("#report-day");
    if (day !== null) day.value = reportDay;
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#program input, #program select").forEach((input) => { input.disabled = state.saving; });
    root.querySelectorAll<HTMLButtonElement>("#program .rule-list button, #add-rule").forEach((button) => { button.disabled = state.saving; });
    const saveButton = root.querySelector<HTMLButtonElement>("#save-program");
    if (saveButton !== null) { saveButton.disabled = state.saving; saveButton.textContent = state.saving ? "Speichert …" : "Neue Version speichern"; }
    for (const id of ["#activate-program", "#run-backtest"]) {
      const button = root.querySelector<HTMLButtonElement>(id);
      if (button !== null) button.disabled = state.saving || !savedProgramMatches(state.program, state.savedProgram);
    }
    bindLive();
    return;
  }
  const focus = captureEditorFocus(root);
  const previousDialog = root.querySelector<HTMLDialogElement>("#override-dialog");
  if (previousDialog?.open) {
    overrideDraft = { ...overrideDraft, open: true, action: root.querySelector<HTMLSelectElement>("#override-action")!.value, reason: root.querySelector<HTMLTextAreaElement>("#override-reason")!.value };
  }
  reportDay = root.querySelector<HTMLInputElement>("#report-day")?.value ?? reportDay;
  const scroll = root.querySelector<HTMLElement>("[data-scroll-region]")?.scrollTop ?? 0;
  root.innerHTML = renderApp(state);
  renderedProgram = state.program;
  bind();
  const day = root.querySelector<HTMLInputElement>("#report-day");
  if (day !== null) day.value = reportDay;
  if (overrideDraft.open) {
    root.querySelector<HTMLInputElement>("#override-decision")!.value = overrideDraft.decisionId;
    root.querySelector<HTMLSelectElement>("#override-action")!.value = overrideDraft.action;
    root.querySelector<HTMLTextAreaElement>("#override-reason")!.value = overrideDraft.reason;
    root.querySelector<HTMLDialogElement>("#override-dialog")!.showModal();
  }
  const workspace = root.querySelector<HTMLElement>("[data-scroll-region]");
  if (workspace !== null) workspace.scrollTop = scroll;
  restoreEditorFocus(root, focus);
}

function currentProgram(): OperatingProgram {
  if (state.program === undefined) throw new Error("Betriebsprogramm fehlt.");
  return state.program;
}

function replaceProgram(program: OperatingProgram): void {
  const saved = state.savedProgram;
  const unchanged = saved !== undefined && sameProgramContent(program, saved.canonicalProgram);
  setState({ program: { ...program, version: unchanged ? saved.version : nextProgramVersion(state.versions) }, message: unchanged ? `Gespeicherte Version ${saved.version}` : "Ungespeicherte Änderung", messageTone: "status" });
}

function bindRuleEditor(): void {
  root.querySelectorAll<HTMLElement>("[data-rule-id]").forEach((node) => {
    const id = node.dataset.ruleId!;
    node.addEventListener("dragstart", () => { dragRuleId = id; node.classList.add("is-dragging"); });
    node.addEventListener("dragend", () => { dragRuleId = ""; node.classList.remove("is-dragging"); });
    node.addEventListener("dragover", (event) => event.preventDefault());
    node.addEventListener("drop", (event) => { event.preventDefault(); if (dragRuleId !== "") replaceProgram(reorderRules(currentProgram(), dragRuleId, id)); });
    node.querySelector<HTMLElement>("[data-drag-handle]")?.addEventListener("pointerdown", () => { dragRuleId = id; });
    node.addEventListener("pointerup", () => { if (dragRuleId !== "" && dragRuleId !== id) replaceProgram(reorderRules(currentProgram(), dragRuleId, id)); dragRuleId = ""; });
    node.addEventListener("keydown", (event) => {
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        replaceProgram(moveRule(currentProgram(), id, event.key === "ArrowUp" ? -1 : 1));
        root.querySelector<HTMLElement>(`[data-rule-id="${CSS.escape(id)}"]`)?.focus();
      }
    });
    node.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => button.addEventListener("click", () => replaceProgram(moveRule(currentProgram(), id, button.dataset.move === "up" ? -1 : 1))));
    node.querySelector<HTMLButtonElement>("[data-remove-rule]")?.addEventListener("click", () => replaceProgram(removeRule(currentProgram(), id)));
    node.querySelector<HTMLInputElement>("[data-rule-enabled]")?.addEventListener("change", (event) => replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, enabled: (event.currentTarget as HTMLInputElement).checked }))));
    node.querySelector<HTMLInputElement>("[data-priority]")?.addEventListener("change", (event) => replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, priority: Number((event.currentTarget as HTMLInputElement).value) }))));
    node.querySelector<HTMLInputElement>("[data-rule-id-input]")?.addEventListener("change", (event) => replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, id: (event.currentTarget as HTMLInputElement).value }))));
    node.querySelector<HTMLSelectElement>("[data-action]")?.addEventListener("change", (event) => replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, action: (event.currentTarget as HTMLSelectElement).value as ActionName }))));
    node.querySelector<HTMLSelectElement>("[data-trigger]")?.addEventListener("change", (event) => {
      const trigger = (event.currentTarget as HTMLSelectElement).value as TriggerName;
      replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, trigger: trigger === "delay_threshold" ? { type: trigger, at_least_seconds: 300 } : { type: trigger } })));
    });
    node.querySelector<HTMLInputElement>("[data-trigger-threshold]")?.addEventListener("change", (event) => replaceProgram(updateRule(currentProgram(), id, (rule) => ({ ...rule, trigger: { type: "delay_threshold", at_least_seconds: Number((event.currentTarget as HTMLInputElement).value) } }))));

    node.querySelectorAll<HTMLElement>("[data-condition-path]").forEach((conditionElement) => {
      const path = conditionElement.dataset.conditionPath!;
      conditionElement.querySelector<HTMLSelectElement>(":scope > label [data-condition-fact]")?.addEventListener("change", (event) => {
        const fact = (event.currentTarget as HTMLSelectElement).value as FactName;
        const booleanFact = ["connection_threatened", "vehicle_failed", "route_closed", "platform_changed", "ad_hoc_conflict"].includes(fact);
        replaceProgram(updateCondition(currentProgram(), id, path, () => ({ type: "predicate", fact, comparison: booleanFact ? "equal" : "greater_or_equal", value: booleanFact ? { type: "boolean", value: true } : { type: "integer", value: 0 } })));
      });
      conditionElement.querySelector<HTMLSelectElement>(":scope > label [data-condition-comparison]")?.addEventListener("change", (event) => replaceProgram(updateCondition(currentProgram(), id, path, (value) => value.type === "predicate" ? { ...value, comparison: (event.currentTarget as HTMLSelectElement).value as ComparisonName } : value)));
      conditionElement.querySelector<HTMLInputElement | HTMLSelectElement>(":scope > label [data-condition-value]")?.addEventListener("change", (event) => replaceProgram(updateCondition(currentProgram(), id, path, (value) => value.type === "predicate" ? { ...value, value: value.value.type === "boolean" ? { type: "boolean", value: (event.currentTarget as HTMLSelectElement).value === "true" } : { type: "integer", value: Number((event.currentTarget as HTMLInputElement).value) } } : value)));
      conditionElement.querySelector<HTMLButtonElement>(":scope > [data-remove-condition]")?.addEventListener("click", () => replaceProgram(removeCondition(currentProgram(), id, path)));
      conditionElement.querySelector<HTMLButtonElement>(":scope > .condition-heading [data-add-condition]")?.addEventListener("click", () => replaceProgram(updateCondition(currentProgram(), id, path, (value): Condition => (value.type === "all" || value.type === "any") ? { ...value, children: [...value.children, { type: "predicate", fact: "delay_seconds", comparison: "greater_or_equal", value: { type: "integer", value: 300 } }] } : value)));
    });
  });
}

function bind(): void {
  bindLive();
  root.querySelector<HTMLInputElement>("#program-enabled")?.addEventListener("change", (event) => replaceProgram({ ...currentProgram(), enabled: (event.currentTarget as HTMLInputElement).checked }));
  root.querySelector<HTMLSelectElement>("#template")?.addEventListener("change", (event) => {
    const template = state.templates.find((entry) => entry.id === (event.currentTarget as HTMLSelectElement).value);
    if (template !== undefined) replaceProgram({ ...template.program, version: currentProgram().version });
  });
  root.querySelector<HTMLButtonElement>("#add-rule")?.addEventListener("click", () => replaceProgram(addRule(currentProgram())));
  root.querySelector<HTMLButtonElement>("#save-program")?.addEventListener("click", () => void save());
  root.querySelector<HTMLButtonElement>("#activate-program")?.addEventListener("click", () => void activate());
  root.querySelector<HTMLButtonElement>("#run-backtest")?.addEventListener("click", () => void backtest());
  root.querySelector<HTMLDialogElement>("#override-dialog")?.addEventListener("close", () => { overrideDraft.open = false; });
  root.querySelector<HTMLDialogElement>("#override-dialog")?.addEventListener("cancel", () => { overrideDraft.open = false; });
  root.querySelector<HTMLButtonElement>("#submit-override")?.addEventListener("click", (event) => { event.preventDefault(); void submitOverride(); });
  bindRuleEditor();
}

function bindLive(): void {
  root.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => void refresh());
  root.querySelector<HTMLButtonElement>("#generate-report")?.addEventListener("click", () => void generateReport());
  root.querySelectorAll<HTMLElement>("[data-decision-id]").forEach((node) => node.addEventListener("focus", () => setState({ selectedDecisionId: node.dataset.decisionId ?? "" }, false)));
  root.querySelectorAll<HTMLButtonElement>("[data-open-override]").forEach((button) => button.addEventListener("click", () => {
    const selectedDecisionId = button.dataset.openOverride ?? "";
    setState({ selectedDecisionId }, false);
    const dialog = root.querySelector<HTMLDialogElement>("#override-dialog");
    const input = root.querySelector<HTMLInputElement>("#override-decision");
    if (input !== null) input.value = selectedDecisionId;
    const decision = state.operations?.decisions.find((entry) => entry.decisionId === selectedDecisionId);
    overrideDraft = { open: true, decisionId: selectedDecisionId, fingerprint: JSON.stringify(decision), action: "request_reroute", reason: "" };
    root.querySelector<HTMLSelectElement>("#override-action")!.value = overrideDraft.action;
    root.querySelector<HTMLTextAreaElement>("#override-reason")!.value = "";
    dialog?.showModal();
    root.querySelector<HTMLSelectElement>("#override-action")?.focus();
  }));
}

async function refresh(): Promise<void> {
  if (api === undefined) return;
  refreshPending = true;
  if (refreshPromise !== undefined) return refreshPromise;
  const client = api;
  refreshPromise = (async () => {
    while (refreshPending) {
      refreshPending = false;
      const revision = dataRevision;
      try {
        const [versions, operations, reports, operatorContext] = await Promise.all([client.versions(), client.operations(), client.reports(), client.context()]);
        if (revision !== dataRevision) { refreshPending = true; continue; }
        if (operations.throughSequence < (state.operations?.throughSequence ?? 0)) continue;
        setState({ versions, operations, reports, operatorContext });
      } catch (error) { setState({ message: error instanceof Error ? error.message : "Aktualisierung fehlgeschlagen.", messageTone: "error" }); }
    }
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

async function save(): Promise<void> {
  if (api === undefined || state.saving) return;
  const draft = currentProgram();
  setState({ saving: true, message: "Programm wird kanonisch geprüft und gespeichert.", messageTone: "status" });
  try {
    let versions = await api.versions();
    // Auch ein verlorenes POST-Ack ist damit wiederholbar, ohne einen lokalen Entwurf zu ersetzen.
    let saved = [...versions].reverse().find((entry) => sameProgramContent(draft, entry.canonicalProgram));
    if (saved === undefined) {
      const attempt = { ...draft, version: nextProgramVersion(versions) };
      try { saved = await api.save(attempt); }
      catch (error) {
        versions = await api.versions();
        saved = versions.find((entry) => entry.version === attempt.version && sameProgramContent(attempt, entry.canonicalProgram));
        if (saved === undefined) {
          ++dataRevision;
          setState({ versions, program: { ...currentProgram(), version: nextProgramVersion(versions) } }, false);
          throw error;
        }
      }
    }
    versions = [...versions.filter((entry) => entry.version !== saved.version), saved];
    const program = sameProgramContent(currentProgram(), draft) ? saved.canonicalProgram : { ...currentProgram(), version: nextProgramVersion(versions) };
    ++dataRevision;
    setState({ saving: false, versions, savedProgram: saved, program, message: `Version ${saved.version} gespeichert · ${saved.checksum.slice(0, 12)}…`, messageTone: "status" });
  } catch (error) { setState({ saving: false, message: error instanceof Error ? error.message : "Speichern fehlgeschlagen.", messageTone: "error" }); }
}

async function activate(): Promise<void> {
  if (api === undefined) return;
  if (!savedProgramMatches(state.program, state.savedProgram) || state.saving) { setState({ message: "Bitte den sichtbaren Entwurf zuerst speichern.", messageTone: "error" }); return; }
  const saved = state.savedProgram!;
  try { await api.activate(saved.version); await refresh(); setState({ message: `Aktivierung von Version ${saved.version} · ${saved.checksum.slice(0, 12)}… wurde dem Single Writer übergeben.`, messageTone: "status" }); }
  catch (error) { setState({ message: error instanceof Error ? error.message : "Aktivierung fehlgeschlagen.", messageTone: "error" }); }
}

async function backtest(): Promise<void> {
  if (api === undefined) return;
  if (!savedProgramMatches(state.program, state.savedProgram) || state.saving) { setState({ message: "Bitte den sichtbaren Entwurf zuerst speichern.", messageTone: "error" }); return; }
  const saved = state.savedProgram!;
  try { await api.backtest(saved.version, state.operations?.throughSequence ?? 1); setState({ message: `Rücktest für Version ${saved.version} · ${saved.checksum.slice(0, 12)}… wurde eingereiht.`, messageTone: "status" }); }
  catch (error) { setState({ message: error instanceof Error ? error.message : "Rücktest fehlgeschlagen.", messageTone: "error" }); }
}

async function submitOverride(): Promise<void> {
  if (api === undefined) return;
  const decisionId = root.querySelector<HTMLInputElement>("#override-decision")?.value ?? "";
  const action = root.querySelector<HTMLSelectElement>("#override-action")?.value ?? "";
  const reason = root.querySelector<HTMLTextAreaElement>("#override-reason")?.value ?? "";
  try {
    const current = (await api.operations()).decisions.find((entry) => entry.decisionId === decisionId);
    if (current === undefined || JSON.stringify(current) !== overrideDraft.fingerprint) throw new Error("Die Entscheidung hat sich geändert oder ist nicht mehr verfügbar. Der Entwurf bleibt erhalten; bitte die aktuelle Betriebslage prüfen.");
    await api.override(decisionId, action, reason);
    overrideDraft.open = false;
    root.querySelector<HTMLDialogElement>("#override-dialog")?.close();
    setState({ message: "Einzelfall wurde protokolliert und zur vollständigen Grenzprüfung eingereiht.", messageTone: "status" });
  }
  catch (error) { setState({ message: error instanceof Error ? error.message : "Override fehlgeschlagen.", messageTone: "error" }); }
}

async function generateReport(): Promise<void> {
  if (api === undefined) return;
  const day = root.querySelector<HTMLInputElement>("#report-day")?.value ?? "";
  if (day === "") { setState({ message: "Bitte einen Betriebstag wählen.", messageTone: "error" }); return; }
  try { await api.generateReport(day); const reports: readonly DailyReportRow[] = await api.reports(); setState({ reports, message: `Tagesbericht ${day} aus dem Event-Log erzeugt.`, messageTone: "status" }); }
  catch (error) { setState({ message: error instanceof Error ? error.message : "Tagesbericht fehlgeschlagen.", messageTone: "error" }); }
}

function startStream(): void {
  if (api === undefined) return;
  streamController?.abort();
  streamController = new AbortController();
  const signal = streamController.signal;
  void api.stream(
    signal,
    state.operations?.throughSequence ?? 0,
    () => { void refresh(); },
    () => { void refresh(); },
  ).catch((error: unknown) => {
    if (!signal.aborted) setState({ message: error instanceof Error ? error.message : "Live-Verbindung unterbrochen.", messageTone: "error" });
  });
}

async function boot(): Promise<void> {
  render();
  if (worldId === "" || operatorId === "") {
    setState({ loading: false, message: "Weltkennung oder EVU-Kennung fehlt. Öffnen Sie die Betriebszentrale aus Ihrer Welt.", messageTone: "error" });
    return;
  }
  try {
    const accessToken = await operationsAccessToken(runtime);
    if (accessToken === "") return;
    api = new OperationsApi(runtime.gameApiUrl, (forceRefresh) => operationsAccessToken(runtime, forceRefresh), worldId, operatorId);
    const [templates, versions, operations, reports, operatorContext] = await Promise.all([api.templates(), api.versions(), api.operations(), api.reports(), api.context()]);
    const source: OperatingProgram | undefined = versions.find((version) => version.status === "active")?.canonicalProgram ?? versions[0]?.canonicalProgram ?? templates[0]?.program;
    if (source === undefined) throw new Error("Server lieferte weder Betriebsprogramm noch Vorlage.");
    const savedProgram = versions.find((version) => version.status === "active") ?? versions[0];
    if (!operatorContext.operators.some((operator) => operator.id === operatorId)) throw new Error("EVU-Kontext stimmt nicht mit der geöffneten Betriebszentrale überein.");
    state = { ...state, templates, versions, operations, reports, operatorContext, program: source, ...(savedProgram === undefined ? {} : { savedProgram }), loading: false };
    render();
    startStream();
  } catch (error) { setState({ loading: false, message: error instanceof Error ? error.message : "Betriebszentrale konnte nicht geladen werden.", messageTone: "error" }); }
}

window.addEventListener("beforeunload", () => streamController?.abort());
void boot();
