import { railwayBrand, railwayNavigation, badge, emptyState, escapeHtml, icon, type Density } from "@zugfolge/design-system";
import type {
  PlanningConflictProjection,
  PlanningProjectionV1,
  PlanningTrainProjection,
} from "@zugfolge/planning-projection";

import {
  conflictDistanceMm,
  conflictLabels,
  conflictsForTrain,
  formatDurationS,
  formatSignedShiftS,
  formatTimeS,
  pathPoints,
  phaseLabels,
  positionY,
  stationY,
  timeExtentS,
  timeX,
} from "./diagram.js";

export interface ProjectionViewOptions {
  readonly density: Density;
  readonly showBlockingTimes: boolean;
  readonly selectedTrainId: string;
  readonly selectedConflictId: string;
  readonly message?: string;
  readonly messageTone?: "status" | "error";
  readonly applyingAlternativeId?: string;
  readonly demoMode?: boolean;
  readonly livemapUrl?: string;
  readonly operationsCenterUrl?: string;
  readonly activeOperatorId?: string;
}

export function renderLoadState(
  state: "loading" | "error",
  message: string,
  demoUrl?: string,
): string {
  const role = state === "error" ? "alert" : "status";
  const heading = state === "error" ? "Planungsdaten nicht verfügbar" : "Bildfahrplan";
  const demoLink =
    state === "error" && demoUrl !== undefined
      ? `<p><a href="${escapeHtml(demoUrl)}">Beispieldaten öffnen</a></p>`
      : "";
  return `<a class="skip" href="#planner-state">Zum Inhalt</a><div class="shell"><header class="topbar"><a class="wordmark" href="?view=journey">Zugfolge</a><nav aria-label="Hauptnavigation"><a href="?view=journey">Welt</a><a class="active" aria-current="page" href="?view=diagram">Trassen</a><a href="?view=journey#betrieb">Betrieb</a><a href="?view=journey#postfach">Postfach</a></nav><div class="world">Planung</div></header><main class="state-shell"><section id="planner-state" class="zf-surface state-card" role="${role}" aria-live="polite" tabindex="-1"><p class="eyebrow">${state === "error" ? "VERBINDUNG UNTERBROCHEN" : "PLANUNGSSTAND"}</p><h1>${heading}</h1><p>${escapeHtml(message)}</p>${state === "error" ? '<div class="state-actions"><button class="zf-button primary" id="planner-retry" type="button">Erneut versuchen</button><a class="zf-button" href="?view=journey">Zur Welt</a></div>' : ""}${demoLink}</section></main></div>`;
}

function formatDistanceMm(distanceMm: number): string {
  const kilometres = Math.floor(distanceMm / 1_000_000);
  const metres = Math.floor((distanceMm % 1_000_000) / 1_000);
  return `${kilometres},${String(metres).padStart(3, "0")}`;
}

function ticks(projection: PlanningProjectionV1): readonly number[] {
  const [from, to] = timeExtentS(projection);
  const step = Math.max(300, Math.ceil((to - from) / 20 / 300) * 300);
  return Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);
}

function renderConflictZone(
  projection: PlanningProjectionV1,
  conflict: PlanningConflictProjection,
  active: boolean,
): string {
  const x = timeX(projection, conflict.window.startS);
  const width = Math.max(3, timeX(projection, conflict.window.endS) - x);
  const y = positionY(projection, conflictDistanceMm(projection, conflict)) - 10;
  const label = `${conflictLabels[conflict.kind]} auf ${conflict.resource.label}, ${formatTimeS(conflict.window.startS, projection.timeBasis)} bis ${formatTimeS(conflict.window.endS, projection.timeBasis)}`;
  return `<g role="img" aria-label="${escapeHtml(label)}"><rect class="conflict-zone ${active ? "active" : ""}" x="${x}" y="${y}" width="${width}" height="20"/><text class="conflict-marker" x="${x + 4}" y="${y + 14}">!</text></g>`;
}

function renderBlockingTimes(
  projection: PlanningProjectionV1,
  selectedTrainId: string,
): string {
  const occupations = projection.occupations.filter(
    (occupation) => occupation.trainId === selectedTrainId,
  );
  if (occupations.length === 0) return "";
  return `<g class="steps" role="group" aria-label="Sechsteilige Sperrzeitentreppe">${occupations
    .map((occupation) => {
      const x = timeX(projection, occupation.startS);
      const width = Math.max(2, timeX(projection, occupation.endS) - x);
      const firstY = positionY(projection, occupation.startDistanceMm);
      const secondY = positionY(projection, occupation.endDistanceMm);
      const y = Math.min(firstY, secondY) - 4;
      const height = Math.max(8, Math.abs(secondY - firstY) + 8);
      const label = `${phaseLabels[occupation.phase]} ${formatTimeS(occupation.startS, projection.timeBasis)} bis ${formatTimeS(occupation.endS, projection.timeBasis)}`;
      return `<rect class="phase-${occupation.phase}" x="${x}" y="${y}" width="${width}" height="${height}"><title>${escapeHtml(label)}</title></rect>`;
    })
    .join("")}</g>`;
}

function renderDiagram(
  projection: PlanningProjectionV1,
  options: ProjectionViewOptions,
): string {
  const activeConflict = projection.conflicts.find(
    (conflict) => conflict.id === options.selectedConflictId,
  );
  return `<svg class="diagram" viewBox="0 0 980 460" role="img" aria-labelledby="diagram-title diagram-description"><title id="diagram-title">Bildfahrplan ${escapeHtml(projection.corridor.name)}</title><desc id="diagram-description">Weg-Zeit-Diagramm mit ${projection.trains.length} Zugläufen und ${projection.conflicts.length} Konflikten.</desc><defs><pattern id="conflict-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
${ticks(projection)
  .map(
    (timeS) =>
      `<g class="time-grid"><line x1="${timeX(projection, timeS)}" y1="38" x2="${timeX(projection, timeS)}" y2="426"/><text x="${timeX(projection, timeS)}" y="25">${formatTimeS(timeS, projection.timeBasis)}</text></g>`,
  )
  .join("")}
${projection.stations
  .map(
    (station) =>
      `<g class="station-grid"><line x1="140" y1="${stationY(projection, station.id)}" x2="950" y2="${stationY(projection, station.id)}"/><text x="128" y="${stationY(projection, station.id) + 4}">${escapeHtml(station.name)}</text><text class="km" x="956" y="${stationY(projection, station.id) + 4}">${formatDistanceMm(station.distanceMm)}</text></g>`,
  )
  .join("")}
${projection.conflicts
  .map((conflict) => renderConflictZone(projection, conflict, conflict.id === activeConflict?.id))
  .join("")}
${options.showBlockingTimes ? renderBlockingTimes(projection, options.selectedTrainId) : ""}
${projection.trains
  .map((train) => {
    const selected = train.id === options.selectedTrainId;
    const firstCall = train.calls[0]!;
    return `<g class="train ${selected ? "train--selected" : ""}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="Zuglauf ${escapeHtml(train.number)} auswählen" data-train="${escapeHtml(train.id)}"><polyline points="${pathPoints(projection, train)}"/><text x="${timeX(projection, firstCall.timeS) + 5}" y="${stationY(projection, firstCall.stationId) - 6}">${escapeHtml(train.number)} ${train.direction === "with-chainage" ? "→" : "←"}</text></g>`;
  })
  .join("")}
${activeConflict === undefined ? "" : `<text class="conflict-marker active-label" x="${timeX(projection, activeConflict.window.startS)}" y="448">! ${escapeHtml(conflictLabels[activeConflict.kind])} ${formatTimeS(activeConflict.window.startS, projection.timeBasis)}</text>`}</svg>`;
}

function trainById(
  projection: PlanningProjectionV1,
  trainId: string,
): PlanningTrainProjection | undefined {
  return projection.trains.find((train) => train.id === trainId);
}

function renderBoundaryWindows(train: PlanningTrainProjection, projection: PlanningProjectionV1): string {
  if (train.boundaryWindows === undefined || train.boundaryWindows.length === 0) return "";
  return `<div class="boundary-windows"><p class="eyebrow">Durchgehende Fahrt</p><h3>Feste Grenzfenster</h3><p>Sie planen die Trasse innerhalb der Welt. Der gepinnte Infrastrukturrelease gibt die Übergabe am Grenzportal vor; der Außenlauf bleibt Teil derselben Zugfahrt und ist nicht bearbeitbar.</p><dl>${train.boundaryWindows.map((window) => `<div><dt>${window.direction === "entry" ? "Einfahrt an der Netzgrenze" : "Ausfahrt an der Netzgrenze"}<details><summary>Technische Details</summary><code>${escapeHtml(window.portalId)}</code></details></dt><dd><strong>${formatTimeS(window.targetS, projection.timeBasis)}</strong><br>${formatTimeS(window.earliestS, projection.timeBasis)}–${formatTimeS(window.latestS, projection.timeBasis)}</dd></div>`).join("")}</dl></div>`;
}

function renderInspector(
  projection: PlanningProjectionV1,
  train: PlanningTrainProjection,
  options: ProjectionViewOptions,
): string {
  const available = conflictsForTrain(projection, train.id);
  const conflict =
    available.find((candidate) => candidate.id === options.selectedConflictId) ?? available[0];
  const boundaryWindows = renderBoundaryWindows(train, projection);
  if (conflict === undefined) {
    return `<aside class="inspector zf-surface"><div class="no-conflict">${badge("Konfliktfrei", "neutral", "check")}<h2>${escapeHtml(train.number)}</h2><p>Die Strecke ist frei für diesen Zug. Dein Fahrplan passt zu den anderen Fahrten.</p></div>${boundaryWindows}</aside>`;
  }
  const firstTrain = trainById(projection, conflict.trainIds[0])!;
  const secondTrain = trainById(projection, conflict.trainIds[1])!;
  const alternative = conflict.alternative;
  const proposal =
    alternative === null
      ? `<div class="proposal proposal--unavailable"><p class="eyebrow">DEINE OPTIONEN</p><h3>Noch keine passende Alternative</h3><p>Mit den gewählten Zeiten lässt sich dieser Konflikt noch nicht lösen. Passe deine Fahrtplanung an.</p></div>`
      : `<div class="proposal"><p class="eyebrow">Zulässige Alternative</p><h3>Zeitlage ${formatSignedShiftS(alternative.departureShiftS)}</h3><p>${escapeHtml(alternative.explanation)}</p><button class="zf-button primary" data-apply-alternative="${escapeHtml(alternative.alternativeId)}"${options.applyingAlternativeId === alternative.alternativeId ? " disabled" : ""}>${options.applyingAlternativeId === alternative.alternativeId ? "Planung wird geprüft …" : "Neue Zeit übernehmen"} ${icon("chevron")}</button></div>`;
  return `<aside class="inspector zf-surface"><div class="inspector-head"><div>${badge(conflictLabels[conflict.kind], "danger", "alert")}<span class="counter">${available.indexOf(conflict) + 1} von ${available.length}</span></div><h2>${escapeHtml(conflict.resource.label)}</h2><p>${formatTimeS(conflict.window.startS, projection.timeBasis)}–${formatTimeS(conflict.window.endS, projection.timeBasis)}</p></div><div class="conflict-nav">${available
    .map(
      (candidate) =>
        `<button class="zf-button ${candidate.id === conflict.id ? "pressed" : ""}" aria-pressed="${candidate.id === conflict.id}" data-conflict="${escapeHtml(candidate.id)}">${escapeHtml(conflictLabels[candidate.kind])}</button>`,
    )
    .join("")}</div><div class="cause"><p class="eyebrow">Diese Züge treffen aufeinander</p><div class="train-pair"><span>${icon("train")}<strong>${escapeHtml(firstTrain.number)}</strong></span><b aria-hidden="true">×</b><span>${icon("train")}<strong>${escapeHtml(secondTrain.number)}</strong></span></div></div><dl><div><dt>Engstelle</dt><dd><strong>${escapeHtml(conflict.resource.label)}</strong></dd></div><div><dt>Überlappung</dt><dd><strong>${formatDurationS(conflict.window.endS - conflict.window.startS)}</strong><br>${formatTimeS(conflict.window.startS, projection.timeBasis)}–${formatTimeS(conflict.window.endS, projection.timeBasis)}</dd></div><div><dt>Planungsstand</dt><dd><strong>${options.demoMode === true ? "Beispieldaten · nicht serverbestätigt" : "Vom Server bestätigt"}</strong><br><details><summary>Technische Details</summary><code>Welt ${escapeHtml(projection.worldId)} · Revision ${projection.projectionRevision} · Züge ${escapeHtml(firstTrain.id)}, ${escapeHtml(secondTrain.id)} · Ressourcentyp ${escapeHtml(conflict.resource.kind)}</code></details></dd></div></dl><div class="explanation"><h3>Warum entsteht der Konflikt?</h3><p>${escapeHtml(conflict.explanation)}</p></div>${proposal}${boundaryWindows}</aside>`;
}

function renderHeader(projection: PlanningProjectionV1, options: ProjectionViewOptions): string {
  const query = new URLSearchParams({world:projection.worldId});
  if (options.demoMode) query.set("demo", "1");
  if (options.activeOperatorId) query.set("operator",options.activeOperatorId);
  const destination = (view: string, section?: string): string => {
    const params = new URLSearchParams(query);
    params.set("view",view);
    if (section !== undefined) params.set("section",section);
    return `?${params}`;
  };
  const live = options.livemapUrl || destination("journey","world");
  const operations = options.operationsCenterUrl && options.activeOperatorId ? (() => {const url = new URL(options.operationsCenterUrl);url.searchParams.set("world",projection.worldId);url.searchParams.set("operator",options.activeOperatorId);return url.href;})() : destination("journey","operations");
  return `<header class="topbar">${railwayBrand(live)}<span class="planner-header-title">FAHRPLANWERKSTATT</span><div class="world">${escapeHtml(projection.corridor.name)}</div></header>${railwayNavigation([{page:"map",href:live},{page:"planner",href:destination("diagram")},{page:"operations",href:operations},{page:"markets",href:destination("journey","markets")},{page:"company",href:destination("journey","company")}],"planner")}`;
}

export function renderProjection(
  projection: PlanningProjectionV1,
  options: ProjectionViewOptions,
): string {
  const message =
    options.message === undefined || options.message === ""
      ? ""
      : `<p class="notice notice--${options.messageTone ?? "status"}" role="${options.messageTone === "error" ? "alert" : "status"}">${options.messageTone === "error" ? icon("alert") : icon("check")} ${escapeHtml(options.message)}</p>`;
  const demoBanner = options.demoMode === true ? '<p class="demo-banner" role="status"><strong>Demo · Beispieldaten</strong> Dieser Planungsstand ist nicht serverbestätigt.</p>' : "";
  const context = `<section class="context"><div><p class="eyebrow">${options.demoMode === true ? "BEISPIEL-PLANUNGSSTAND" : "DEINE NÄCHSTE VERBINDUNG"}</p><h1>Bildfahrplan <span>${escapeHtml(projection.corridor.name)}</span></h1></div><div class="toolbar"><button class="zf-button" id="density">${icon("layers")} ${options.density === "control" ? "Leitstelle" : "Dokument"}</button><button class="zf-button ${options.showBlockingTimes ? "pressed" : ""}" id="steps" aria-pressed="${options.showBlockingTimes}">Sperrzeiten</button>${projection.trains.length === 0 ? "" : `<span class="period">${formatTimeS(timeExtentS(projection)[0], projection.timeBasis)}–${formatTimeS(timeExtentS(projection)[1], projection.timeBasis)}${projection.timeBasis === undefined ? "" : ` · Weltzeit ${escapeHtml(projection.timeBasis.timeZone)}`}</span>`}</div></section>`;
  if (projection.stations.length === 0 || projection.trains.length === 0) {
    return `<a class="skip" href="#planner-empty">Zum Inhalt</a><div class="shell planner-shell">${renderHeader(projection, options)}<main>${demoBanner}${context}${message}<section id="planner-empty" class="zf-surface empty-card" tabindex="-1">${emptyState("Dein Fahrplan wartet auf dich.", "Für diese Strecke gibt es noch keine geplanten Fahrten. Melde im Bereich Betrieb deine erste Verbindung an.")}</section></main></div>`;
  }
  const selectedTrain = trainById(projection, options.selectedTrainId) ?? projection.trains[0]!;
  return `<a class="skip" href="#diagram-card">Zum Bildfahrplan</a><div class="shell planner-shell">${renderHeader(projection, options)}<main>${demoBanner}${context}${message}<section class="workspace"><article id="diagram-card" class="diagram-card zf-surface" role="region" aria-labelledby="diagram-title" tabindex="-1"><div class="legend"><span><i class="line selected"></i> ausgewählt</span><span><i class="line"></i> Zuglauf</span><span><i class="hatch"></i> Konflikt !</span></div>${renderDiagram(projection, { ...options, selectedTrainId: selectedTrain.id })}</article>${renderInspector(projection, selectedTrain, options)}</section></main></div>`;
}
