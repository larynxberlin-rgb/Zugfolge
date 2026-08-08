import { badge, escapeHtml, icon, type Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import {
  conflictsForTrain,
  extent,
  formatMinute,
  pathPoints,
  phaseLabels,
  sampleData,
  shiftedData,
  stationY,
  timeX,
  type Conflict,
  type DiagramData,
} from "./diagram.js";
import "./styles.css";
const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("App-Wurzel fehlt");
const app = root;
let density: Density = "control",
  showSteps = true,
  selectedTrainId = "t1",
  selectedConflictId = "c1",
  data: DiagramData = sampleData,
  message = "";
const train = (id: string) => data.trains.find((t) => t.id === id)!;
function conflictLabel(c: Conflict): string {
  return c.kind === "sequence" ? "Zugfolgekonflikt" : "Fahrstraßenausschluss";
}
function diagram(): string {
  const [from, to] = extent(data),
    ticks = Array.from(
      { length: Math.floor((to - from) / 10) + 1 },
      (_, i) => from + i * 10,
    );
  const active = data.conflicts.find((c) => c.id === selectedConflictId);
  return `<svg class="diagram" viewBox="0 0 980 460" role="img" aria-labelledby="diagram-title diagram-description"><title id="diagram-title">Bildfahrplan ${escapeHtml(data.corridor)}</title><desc id="diagram-description">Weg-Zeit-Diagramm mit ${data.trains.length} Zugläufen und ${data.conflicts.length} Konflikten.</desc><defs><pattern id="conflict-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
${ticks.map((m) => `<g class="time-grid"><line x1="${timeX(data, m)}" y1="38" x2="${timeX(data, m)}" y2="426"/><text x="${timeX(data, m)}" y="25">${formatMinute(m)}</text></g>`).join("")}${data.stations.map((s) => `<g class="station-grid"><line x1="140" y1="${stationY(data, s.id)}" x2="950" y2="${stationY(data, s.id)}"/><text x="128" y="${stationY(data, s.id) + 4}">${escapeHtml(s.name)}</text><text class="km" x="956" y="${stationY(data, s.id) + 4}">${s.km},0</text></g>`).join("")}
${data.conflicts.map((c) => `<rect class="conflict-zone ${c.id === selectedConflictId ? "active" : ""}" x="${timeX(data, c.startMinute)}" y="${Math.min(...c.trainIds.map((id) => stationY(data, train(id).calls[1]!.stationId))) - 10}" width="${Math.max(8, timeX(data, c.endMinute) - timeX(data, c.startMinute))}" height="55"><title>${escapeHtml(conflictLabel(c))}: ${formatMinute(c.startMinute)}–${formatMinute(c.endMinute)}</title></rect>`).join("")}
${data.trains.map((t) => `<g class="train ${t.id === selectedTrainId ? "train--selected" : ""}" data-train="${t.id}" tabindex="0" role="button" aria-pressed="${t.id === selectedTrainId}" aria-label="Zug ${escapeHtml(t.number)} auswählen"><polyline points="${pathPoints(data, t)}"/><text x="${timeX(data, t.calls[0]!.minute) + 5}" y="${stationY(data, t.calls[0]!.stationId) - 7}">${escapeHtml(t.number)}</text></g>`).join("")}
${
  showSteps
    ? `<g class="steps" aria-label="Sechsteilige Sperrzeitentreppe">${data.occupations
        .filter((o) => o.trainId === selectedTrainId)
        .map(
          (o) =>
            `<rect class="phase-${o.phase}" x="${timeX(data, o.startMinute)}" y="${stationY(data, o.stationId) - 8}" width="${Math.max(3, timeX(data, o.endMinute) - timeX(data, o.startMinute))}" height="12"><title>${phaseLabels[o.phase]} · ${escapeHtml(o.resource)} · ${formatMinute(o.startMinute)}–${formatMinute(o.endMinute)}</title></rect>`,
        )
        .join("")}</g>`
    : ""
}${active ? `<text class="conflict-marker" x="${timeX(data, active.startMinute)}" y="445">⚠ ${formatMinute(active.startMinute)}</text>` : ""}</svg>`;
}
function inspector(): string {
  const available = conflictsForTrain(data, selectedTrainId),
    conflict =
      available.find((c) => c.id === selectedConflictId) ?? available[0];
  if (!conflict)
    return `<aside class="inspector zf-surface"><div class="no-conflict">${badge("Konfliktfrei", "success", "check")}<h2>${escapeHtml(train(selectedTrainId).number)}</h2><p>Für diesen Zuglauf liegen keine Belegungsüberschneidungen vor.</p></div></aside>`;
  selectedConflictId = conflict.id;
  const [a, b] = conflict.trainIds.map(train);
  return `<aside class="inspector zf-surface"><div class="inspector-head"><div>${badge(conflictLabel(conflict), "danger", "alert")}<span class="counter">${available.indexOf(conflict) + 1} von ${available.length}</span></div><h2>${escapeHtml(conflict.resource)}</h2><p>${formatMinute(conflict.startMinute)}–${formatMinute(conflict.endMinute)}</p></div><div class="conflict-nav">${available.map((c) => `<button class="zf-button ${c.id === conflict.id ? "pressed" : ""}" data-conflict="${c.id}">${escapeHtml(conflictLabel(c))}</button>`).join("")}</div><div class="cause"><p class="eyebrow">Beteiligte Zugläufe</p><div class="train-pair"><span>${icon("train")}<strong>${escapeHtml(a!.number)}</strong><small>beantragte Trasse</small></span><b>×</b><span>${icon("train")}<strong>${escapeHtml(b!.number)}</strong><small>bereits eingeplant</small></span></div></div><dl><div><dt>Konfliktressource</dt><dd><strong>${escapeHtml(conflict.resource)}</strong></dd></div><div><dt>Überlappung</dt><dd><strong>${conflict.endMinute - conflict.startMinute} min</strong><br>${formatMinute(conflict.startMinute)}–${formatMinute(conflict.endMinute)}</dd></div><div><dt>Mindestzugfolgezeit</dt><dd><strong>${conflict.minimumHeadwayMinutes} min</strong><br>aus Belegungsprofil</dd></div></dl><div class="explanation"><h3>Warum entsteht der Konflikt?</h3><p>Die Belegungsprofile von <strong>${escapeHtml(a!.number)}</strong> und <strong>${escapeHtml(b!.number)}</strong> überschneiden sich auf derselben Ressource.</p></div><div class="proposal"><p class="eyebrow">Zulässige Alternative</p><h3>Abfahrt +${conflict.proposedShiftMinutes} min</h3><p>Die hinterlegte konfliktfreie Alternative verschiebt Zuglauf und Sperrzeiten gemeinsam.</p><button class="zf-button primary" id="alternative">Alternative anwenden ${icon("chevron")}</button></div></aside>`;
}
function render(): void {
  app.dataset.density = density;
  const [from, to] = extent(data);
  app.innerHTML = `<a class="skip" href="#diagram-card">Zum Bildfahrplan</a><div class="shell"><header class="topbar"><a class="wordmark" href="#">Zugfolge</a><nav aria-label="Hauptnavigation"><a href="#">Welt</a><a class="active" href="#">Trassen</a><a href="#">Betrieb</a><a href="#">Postfach</a></nav><div class="world">Welt LHE 2026 ${badge("veröffentlicht", "success", "check")}</div></header><main><section class="context"><div><p class="eyebrow">Fahrplanperiode 04 · Koordinierung</p><h1>Bildfahrplan <span>${escapeHtml(data.corridor)}</span></h1></div><div class="toolbar"><button class="zf-button" id="density">${icon("layers")} ${density === "control" ? "Leitstelle" : "Dokument"}</button><button class="zf-button ${showSteps ? "pressed" : ""}" id="steps" aria-pressed="${showSteps}">Sperrzeiten</button><span class="period">${formatMinute(from)}–${formatMinute(to)}</span></div></section>${message ? `<p class="notice" role="status">${icon("check")} ${escapeHtml(message)}</p>` : ""}<section class="workspace"><article id="diagram-card" class="diagram-card zf-surface"><div class="legend"><span><i class="line selected"></i> ausgewählt</span><span><i class="line"></i> Zuglauf</span><span><i class="hatch"></i> Konflikt</span></div>${diagram()}</article>${inspector()}</section></main></div>`;
  bind();
}
function bind(): void {
  app.querySelector("#density")?.addEventListener("click", () => {
    density = density === "control" ? "document" : "control";
    render();
  });
  app.querySelector("#steps")?.addEventListener("click", () => {
    showSteps = !showSteps;
    render();
  });
  app.querySelectorAll<HTMLElement>("[data-train]").forEach((n) => {
    const select = () => {
      selectedTrainId = n.dataset.train ?? "t1";
      selectedConflictId =
        conflictsForTrain(data, selectedTrainId)[0]?.id ?? "";
      message = "";
      render();
    };
    n.addEventListener("click", select);
    n.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-conflict]").forEach((n) =>
    n.addEventListener("click", () => {
      selectedConflictId = n.dataset.conflict ?? "";
      render();
    }),
  );
  app.querySelector("#alternative")?.addEventListener("click", () => {
    const c = data.conflicts.find((x) => x.id === selectedConflictId);
    if (c) {
      data = shiftedData(data, selectedTrainId, c.proposedShiftMinutes);
      message = `Alternative für ${train(selectedTrainId).number} angewendet: +${c.proposedShiftMinutes} min.`;
      render();
    }
  });
}
render();
