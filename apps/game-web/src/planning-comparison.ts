import { escapeHtml } from "@zugfolge/design-system";
import type { PlanningProjectionV1, PlanningResultProjection, PlanningTimelineCallProjection } from "@zugfolge/planning-projection";
import { formatDurationS, formatSignedShiftS, formatTimeS } from "./diagram.js";
import "./planning-comparison.css";

export interface PlanningComparisonRow {
  readonly requested?: PlanningTimelineCallProjection;
  readonly planned?: PlanningTimelineCallProjection;
}
export type PlanningComparisonSeverity = "unchanged" | "changed" | "major";
export const PLANNING_COMPARISON_MAJOR_DELTA_S = 300;

/** LCS erhält beide Fahrtreihenfolgen, auch bei unterschiedlichen Fahrwegen. */
export function alignPlanningTimelines(requested: readonly PlanningTimelineCallProjection[], planned: readonly PlanningTimelineCallProjection[]): readonly PlanningComparisonRow[] {
  const width = planned.length + 1;
  const lengths = new Uint16Array((requested.length + 1) * width);
  for (let left = requested.length - 1; left >= 0; left--) {
    for (let right = planned.length - 1; right >= 0; right--) lengths[left * width + right] = requested[left]!.stationId === planned[right]!.stationId
      ? 1 + lengths[(left + 1) * width + right + 1]!
      : Math.max(lengths[(left + 1) * width + right]!, lengths[left * width + right + 1]!);
  }
  const rows: PlanningComparisonRow[] = [];
  let left = 0; let right = 0;
  while (left < requested.length || right < planned.length) {
    if (left < requested.length && right < planned.length && requested[left]!.stationId === planned[right]!.stationId) {
      rows.push({ requested: requested[left++]!, planned: planned[right++]! });
    } else if (left < requested.length && (right === planned.length || lengths[(left + 1) * width + right]! >= lengths[left * width + right + 1]!)) {
      rows.push({ requested: requested[left++]! });
    } else rows.push({ planned: planned[right++]! });
  }
  return rows;
}

export function planningRowDeltas(row: PlanningComparisonRow): { readonly arrivalS: number; readonly departureS: number; readonly dwellS: number } | undefined {
  if (!row.requested || !row.planned) return undefined;
  return { arrivalS: row.planned.arrivalS - row.requested.arrivalS, departureS: row.planned.departureS - row.requested.departureS,
    dwellS: (row.planned.departureS - row.planned.arrivalS) - (row.requested.departureS - row.requested.arrivalS) };
}

export function planningRowSeverity(row: PlanningComparisonRow, planned: readonly PlanningTimelineCallProjection[] | null, status: PlanningResultProjection["status"]): PlanningComparisonSeverity {
  if (status === "rejected") return "major";
  if (planned === null || status === "requested") return "unchanged";
  if (row.requested?.kind === "passenger-stop" && !planned.some((call) => call.stationId === row.requested!.stationId && ["passenger-stop", "origin", "destination"].includes(call.kind))) return "major";
  if (!row.requested && row.planned?.kind === "operational-stop" && row.planned.departureS - row.planned.arrivalS >= PLANNING_COMPARISON_MAJOR_DELTA_S) return "major";
  const deltas = planningRowDeltas(row);
  if (deltas && Object.values(deltas).some((seconds) => Math.abs(seconds) >= PLANNING_COMPARISON_MAJOR_DELTA_S)) return "major";
  if (!row.requested || !row.planned || row.requested.kind !== row.planned.kind || deltas && Object.values(deltas).some((seconds) => seconds !== 0)) return "changed";
  return "unchanged";
}

const callLabels: Readonly<Record<PlanningTimelineCallProjection["kind"], string>> = {
  origin: "Start", destination: "Ziel", "passenger-stop": "Fahrgasthalt", "operational-stop": "Betriebshalt", pass: "Durchfahrt",
};

function renderCall(call: PlanningTimelineCallProjection | undefined, side: "requested" | "planned", row: PlanningComparisonRow,
  result: PlanningResultProjection, projection: PlanningProjectionV1, severity: PlanningComparisonSeverity): string {
  const allocated = result.status === "allocated";
  const sideLabel = side === "requested" ? "Ursprüngliche Planung" : result.status === "proposed" ? "Trassenvorschlag" : allocated ? "Zugewiesene Trasse" : "Trassenplanung";
  if (!call) {
    const missing = side === "requested" ? "Im ursprünglichen Fahrweg nicht enthalten"
      : result.status === "requested" ? "Noch keine Trasse zugeteilt" : result.status === "rejected" ? "Keine Trasse zugeteilt" : "In diesem Fahrweg nicht enthalten";
    return `<div class="planning-comparison-call planning-comparison-call--empty${side === "planned" ? ` planning-comparison-call--${severity}` : ""}" role="group" aria-label="${sideLabel}" data-comparison-side="${side}"><span aria-hidden="true">—</span><p>${missing}</p></div>`;
  }
  const station = projection.stations.find((station) => station.id === call.stationId)?.name ?? "Betriebsstelle nicht verfügbar";
  const times = call.kind === "origin" ? [["Abfahrt", call.departureS]] as const
    : call.kind === "destination" ? [["Ankunft", call.arrivalS]] as const
      : call.kind === "pass" ? [["Durchfahrt", call.arrivalS]] as const : [["Ankunft", call.arrivalS], ["Abfahrt", call.departureS]] as const;
  const dwell = call.kind === "passenger-stop" || call.kind === "operational-stop" ? `<p class="planning-comparison-dwell">Aufenthalt <strong>${formatDurationS(call.departureS - call.arrivalS)}</strong></p>` : "";
  const deltas = side === "planned" ? planningRowDeltas(row) : undefined;
  const deltaLabels: string[] = [];
  if (deltas) {
    if (call.kind !== "origin" && deltas.arrivalS !== 0) deltaLabels.push(`${call.kind === "pass" ? "Durchfahrt" : "Ankunft"} ${formatSignedShiftS(deltas.arrivalS)}`);
    if (call.kind !== "destination" && call.kind !== "pass" && deltas.departureS !== 0) deltaLabels.push(`Abfahrt ${formatSignedShiftS(deltas.departureS)}`);
    if (deltas.dwellS !== 0) deltaLabels.push(`Aufenthalt ${formatSignedShiftS(deltas.dwellS)}`);
  }
  const structural = side !== "planned" ? "" : !row.requested ? "Zusätzliche Betriebsstelle"
    : row.requested.kind !== call.kind ? `${callLabels[row.requested.kind]} → ${callLabels[call.kind]}` : "";
  const changes = deltaLabels.length || structural ? `<p class="planning-comparison-deltas">${[structural, ...deltaLabels].filter(Boolean).map(escapeHtml).join("<br>")}</p>` : "";
  const explanations = side === "planned" ? [...new Set(result.adjustments.filter((change) => change.stationId === call.stationId).map((change) => change.explanation))] : [];
  return `<div class="planning-comparison-call${side === "planned" ? ` planning-comparison-call--${severity}` : ""}" role="group" aria-label="${sideLabel} · ${escapeHtml(station)}" data-comparison-side="${side}"><span class="planning-comparison-dot" aria-hidden="true"></span><p class="planning-comparison-kind">${callLabels[call.kind]}${side === "planned" && severity !== "unchanged" ? ` · ${severity === "major" ? "Starke Änderung !" : "Geändert △"}` : ""}</p><h3>${escapeHtml(station)}</h3><dl class="planning-comparison-times">${times.map(([label, seconds]) => `<div><dt>${label}</dt><dd>${formatTimeS(seconds, projection.timeBasis)}</dd></div>`).join("")}</dl>${dwell}${changes}${explanations.map((text) => `<p class="planning-comparison-reason">${escapeHtml(text)}</p>`).join("")}${call.kind === "operational-stop" ? '<p class="planning-comparison-reason">Ohne Fahrgastwechsel</p>' : ""}${side === "planned" && !allocated ? '<span class="planning-comparison-proposal">Vorschlag</span>' : ""}</div>`;
}

export function renderPlanningComparison(result: PlanningResultProjection | undefined, projection: PlanningProjectionV1, trainNumber: string): string {
  const timeline = result?.timeline;
  const rightTitle = result?.status === "proposed" ? "Trassenvorschlag" : result?.status === "allocated" ? "Zugewiesene Trasse" : "Trassenplanung";
  const status = !result ? "Für diese Fahrt liegen keine vollständigen Vergleichsangaben vor." : result.status === "allocated" ? "Diese Trasse wurde zugeteilt."
    : result?.status === "proposed" ? "Prüfe die Änderungen. Der Vorschlag gilt erst nach deiner Übernahme."
      : result?.status === "rejected" ? "Für diese Fahrt wurde keine passende Trasse zugeteilt." : "Die ursprüngliche Planung ist noch nicht zugeteilt.";
  const rows = timeline && result ? alignPlanningTimelines(timeline.requested, timeline.planned ?? []) : [];
  const body = !timeline || !result ? '<p class="planning-comparison-unavailable">Für diese Fahrt fehlt der vollständige Verlauf zum Vergleich. Die verfügbaren Planungsangaben findest du unter „Weitere Angaben zur Fahrt“.</p>'
    : `<div class="planning-comparison-columns"><h2>Ursprüngliche Planung</h2><h2>${rightTitle}</h2></div><ol class="planning-comparison-route" aria-label="Ursprüngliche Planung und Trassenplanung im Vergleich">${rows.map((row) => {
      const severity = planningRowSeverity(row, timeline.planned, result.status);
      const missingPassenger = row.requested?.kind === "passenger-stop" && timeline.planned !== null && !timeline.planned.some((call) => call.stationId === row.requested!.stationId && ["passenger-stop", "origin", "destination"].includes(call.kind));
      return `<li class="planning-comparison-row">${renderCall(row.requested, "requested", row, result, projection, severity)}${renderCall(row.planned, "planned", row, result, projection, severity)}${missingPassenger ? '<p class="planning-comparison-row-warning">! Der gewünschte Fahrgasthalt fehlt in der geplanten Fahrt.</p>' : ""}</li>`;
    }).join("")}</ol>`;
  return `<article class="planning-comparison zf-surface" id="planning-comparison" tabindex="-1" aria-labelledby="planning-comparison-title"><header class="planning-comparison-header"><div><h2 id="planning-comparison-title">${escapeHtml(trainNumber)}</h2><p${result?.status === "rejected" ? ' class="planning-comparison-rejection"' : ""}>${status}</p></div><ul class="planning-comparison-legend" aria-label="Farben der Änderungen"><li><i class="comparison-key-neutral"></i>Unverändert</li><li><i class="comparison-key-changed"></i>Gelb: Änderung unter 5 Minuten oder anderer Fahrweg</li><li><i class="comparison-key-major"></i>Rot: ab 5 Minuten, entfallender Fahrgasthalt oder Ablehnung</li></ul><p class="planning-comparison-note">Die Farben zeigen die Stärke der Änderung; dein Planungsspielraum bleibt maßgeblich.</p><details class="planning-comparison-note"><summary>Woher stammen die ursprünglichen Zeiten?</summary><p>Die Spielplanung berechnet sie ohne Belegungskonflikte. Fahrzeiten im Trassenfinder sind unverbindlich.</p></details></header>${result?.routeChange ? `<p class="planning-comparison-route-change">△ Fahrweg geändert: ${escapeHtml(result.routeChange.explanation)}</p>` : ""}${body}</article>`;
}
