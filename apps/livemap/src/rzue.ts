import type { PublicOperationalRegionFrame } from "@zugfolge/livemap-stream";

import type { PublicTrain } from "./protocol.js";

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scale(value: number, maximum: number, width: number): number {
  if (maximum <= 0) return 0;
  return Math.round((Math.max(0, Math.min(value, maximum)) * width) / maximum);
}

/** Lesende schematische Betriebssicht aus exakt demselben committed train state. */
export function rzueMarkup(
  trains: readonly PublicTrain[],
  operationalRegions: readonly PublicOperationalRegionFrame[],
  expert: boolean,
): string {
  const frames = new Map(operationalRegions.map((frame) => [frame.regionId, frame] as const));
  const exact = trains
    .filter((train) => {
      const state = train.operational;
      if (state === undefined) return false;
      const frame = frames.get(state.regionId);
      return frame !== undefined
        && frame.commitSequence === state.commitSequence
        && frame.simulationTimeMs === state.simulationTimeMs;
    })
    .sort((left, right) => left.trainNumber.localeCompare(right.trainNumber, "de") || left.id.localeCompare(right.id));
  const commitLabel = operationalRegions.length === 1
    ? `COMMIT ${operationalRegions[0]!.commitSequence}`
    : operationalRegions.length === 0
      ? "KEIN REGIONSFRAME"
      : `${operationalRegions.length} REGIONSFRAMES`;
  if (exact.length === 0) {
    return `<div class="rzue-empty"><p class="eyebrow">RZÜ · ${commitLabel}</p><h2>Das Gleisbild wird vorbereitet.</h2><p>Das Gleisbild wartet auf aktuelle Betriebsdaten. Versuche es gleich noch einmal.</p></div>`;
  }
  const maximum = Math.max(...exact.map((train) =>
    Math.max(train.operational!.headRouteMm, train.operational!.authorityEndRouteMm ?? 0),
  ), 1);
  const diagramWidth = 1_200;
  const rowHeight = expert ? 86 : 62;
  const rows = exact.map((train, index) => {
    const state = train.operational!;
    const y = 50 + index * rowHeight;
    const head = scale(state.headRouteMm, maximum, diagramWidth);
    const tail = scale(Math.max(0, state.tailRouteMm), maximum, diagramWidth);
    const authority = state.authorityEndRouteMm === undefined
      ? head
      : scale(state.authorityEndRouteMm, maximum, diagramWidth);
    const blocks = expert
      ? `<text x="14" y="${y + 32}" class="rzue-meta">${escape([
          state.regionId,
          state.occupiedBlocks.join(" · ") || "kein Block",
          ...((frames.get(state.regionId)?.routeLocks ?? [])
            .filter((lock) => lock.trainId === train.id)
            .map((lock) => `Fahrstraße ${lock.id}`)),
        ].join(" · "))}</text>`
      : "";
    const reason = state.waitingReason === undefined
      ? ""
      : `<text x="${Math.min(head + 12, diagramWidth - 220)}" y="${y - 12}" class="rzue-wait">${escape(state.waitingReason)}</text>`;
    return `<g data-train-id="${escape(train.id)}">
      <text x="14" y="${y - 9}" class="rzue-number">${escape(train.trainNumber)}</text>
      <line x1="0" y1="${y}" x2="${diagramWidth}" y2="${y}" class="rzue-track" />
      <line x1="${head}" y1="${y}" x2="${authority}" y2="${y}" class="rzue-authority" />
      <line x1="${tail}" y1="${y}" x2="${head}" y2="${y}" class="rzue-occupied" />
      <path d="M ${authority} ${y - 9} L ${authority + 7} ${y} L ${authority} ${y + 9} Z" class="rzue-authority-end" />
      <circle cx="${head}" cy="${y}" r="7" class="rzue-head" />
      <circle cx="${tail}" cy="${y}" r="4" class="rzue-tail" />
      <text x="${Math.min(head + 11, diagramWidth - 100)}" y="${y + 19}" class="rzue-speed">${Math.round(train.speedMmPerSecond * 36 / 10_000)} km/h</text>
      ${reason}${blocks}
    </g>`;
  }).join("");
  const regionTruth = operationalRegions
    .slice()
    .sort((left, right) => left.regionId.localeCompare(right.regionId, "de"))
    .map((frame) => {
      const signals = Object.entries(frame.signals)
        .sort(([left], [right]) => left.localeCompare(right, "de"))
        .map(([signalId, aspect]) => `<li><code>${escape(signalId)}</code> = ${escape(aspect)}</li>`)
        .join("") || "<li>keine Signale im Regionsframe</li>";
      const locks = frame.routeLocks
        .map((lock) => `<li><code>${escape(lock.id)}</code> → ${escape(lock.trainId)} · ${escape(lock.resources.join(" · "))}</li>`)
        .join("") || "<li>keine verriegelte Fahrstraße</li>";
      const disruptions = frame.activeDisruptions
        .map((disruption) => `<li><code>${escape(disruption.disruptionId)}</code> · ${escape(Object.keys(disruption.effect)[0] ?? "unbekannt")}</li>`)
        .join("") || "<li>keine aktive Störung</li>";
      return `<section class="rzue-region" data-region-id="${escape(frame.regionId)}" data-commit-sequence="${frame.commitSequence}">
        <h3>${escape(frame.regionId)} · COMMIT ${frame.commitSequence}</h3>
        <p>Stand ${frame.simulationTimeMs} ms · sicher bis ${frame.staleAfterMs} ms</p>
        <div><h4>Signalbegriffe</h4><ul>${signals}</ul></div>
        <div><h4>Fahrstraßen</h4><ul>${locks}</ul></div>
        <div><h4>Aktive Störungen</h4><ul>${disruptions}</ul></div>
      </section>`;
    }).join("");
  return `<header class="rzue-header">
    <div><p class="eyebrow">RZÜ · ${commitLabel}</p><h2>Dein Netz im Gleisbild</h2></div>
    <p>${exact.length} exakte Bewegungen · ${operationalRegions.length} Regionsframes · ${expert ? "Expertenebene" : "Übersicht"}</p>
  </header>
  <div class="rzue-regions">${regionTruth}</div>
  <div class="rzue-scroll"><svg class="rzue-diagram" viewBox="0 0 ${diagramWidth} ${Math.max(160, 82 + exact.length * rowHeight)}" role="img" aria-label="Schematischer Dein Netz im Gleisbild mit Zugspitze, Zugschluss und Fahrberechtigung">
    ${rows}
  </svg></div>`;
}
