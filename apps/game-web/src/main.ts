import { badge, escapeHtml, icon, type Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { conflicts, formatMinute, occupation, pathPoints, stations, stationY, timeX, trains } from "./diagram.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app: HTMLDivElement = root;
let density: Density = "control";
let showSteps = true;
let selectedTrainId = "t1";

function diagram(): string {
  const ticks = Array.from({ length: 8 }, (_, index) => 420 + index * 10);
  return `<svg class="diagram" viewBox="0 0 980 460" role="img" aria-labelledby="diagram-title diagram-description">
    <title id="diagram-title">Bildfahrplan Halle–Leipzig</title><desc id="diagram-description">Weg-Zeit-Diagramm mit vier Zugläufen und einem hervorgehobenen Sperrzeitkonflikt.</desc>
    <defs><pattern id="conflict-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6"/></pattern></defs>
    ${ticks.map((minute) => `<g class="time-grid"><line x1="${timeX(minute)}" y1="38" x2="${timeX(minute)}" y2="426"/><text x="${timeX(minute)}" y="25">${formatMinute(minute)}</text></g>`).join("")}
    ${stations.map((station) => `<g class="station-grid"><line x1="140" y1="${stationY(station.id)}" x2="950" y2="${stationY(station.id)}"/><text x="128" y="${stationY(station.id) + 4}">${escapeHtml(station.name)}</text><text class="km" x="956" y="${stationY(station.id) + 4}">${station.km},0</text></g>`).join("")}
    <rect class="conflict-zone" x="${timeX(449)}" y="${stationY("schkeuditz")}" width="${timeX(452) - timeX(449)}" height="${stationY("leutzsch") - stationY("schkeuditz")}" aria-label="Konfliktfenster 07:29 bis 07:32"/>
    ${trains.map((train) => `<g class="train ${train.id === selectedTrainId ? "train--selected" : ""}" data-train="${train.id}" tabindex="0" role="button" aria-label="Zug ${train.number} auswählen"><polyline points="${pathPoints(train)}"/><text x="${timeX(train.calls[0]!.minute) + 5}" y="${stationY(train.calls[0]!.stationId) - 7}">${train.number}</text></g>`).join("")}
    ${showSteps ? `<g class="steps" aria-label="Sperrzeitentreppe von R 74018">${occupation.map((step, index) => { const y = 214 + index * 18; return `<rect x="${timeX(step.startMinute)}" y="${y}" width="${timeX(step.endMinute) - timeX(step.startMinute)}" height="12"><title>${escapeHtml(step.resource)} · ${formatMinute(step.startMinute)}–${formatMinute(step.endMinute)}</title></rect>`; }).join("")}</g>` : ""}
  </svg>`;
}
function render(): void {
  const conflict = conflicts[0]!;
  const selected = trains.find((train) => train.id === selectedTrainId)!;
  app.dataset.density = density;
  app.innerHTML = `<div class="shell"><header class="topbar"><a class="wordmark" href="#">Zugfolge</a><nav aria-label="Hauptnavigation"><a href="#">Welt</a><a class="active" href="#">Trassen</a><a href="#">Betrieb</a><a href="#">Postfach</a></nav><div class="world">Welt LHE 2026 ${badge("veröffentlicht", "success")}</div></header>
  <main><section class="context"><div><p class="eyebrow">Fahrplanperiode 04 · Koordinierung</p><h1>Bildfahrplan <span>Halle–Leipzig</span></h1></div><div class="toolbar"><button class="zf-button" id="density">${icon("layers")} ${density === "control" ? "Leitstelle" : "Dokument"}</button><button class="zf-button ${showSteps ? "pressed" : ""}" id="steps" aria-pressed="${showSteps}">Sperrzeiten</button><button class="zf-button">07:00–08:15</button></div></section>
  <section class="workspace"><article class="diagram-card zf-surface"><div class="legend"><span><i class="line selected"></i> ausgewählt</span><span><i class="line"></i> Zuglauf</span><span><i class="hatch"></i> Konflikt</span></div>${diagram()}</article>
  <aside class="inspector zf-surface"><div class="inspector-head"><div>${badge("Konflikt", "danger", "alert")}<span class="counter">1 von 1</span></div><h2>${escapeHtml(conflict.resource)}</h2><p>${formatMinute(conflict.startMinute)}–${formatMinute(conflict.endMinute)} · Zugfolgefall</p></div>
  <div class="cause"><p class="eyebrow">Beteiligte Zugläufe</p><div class="train-pair"><span>${icon("train")}<strong>${selected.number}</strong><small>beantragte Trasse</small></span><b>×</b><span>${icon("train")}<strong>R 74021</strong><small>bereits eingeplant</small></span></div></div>
  <dl><div><dt>Konfliktressource</dt><dd>Blockabschnitt<br><strong>3. Gleis</strong></dd></div><div><dt>Überlappung</dt><dd><strong>3 min</strong><br>07:29–07:32</dd></div><div><dt>Mindestzugfolgezeit</dt><dd><strong>${conflict.minimumHeadwayMinutes} min</strong><br>aus Belegungsprofil</dd></div></dl>
  <div class="explanation"><h3>Warum entsteht der Konflikt?</h3><p>Die Räumung von <strong>R 74021</strong> endet erst um 07:32. Die Annäherung von <strong>R 74018</strong> beginnt bereits um 07:29 auf derselben Ressource.</p><div class="mini-timeline"><span>R 74021 · Räumung</span><i style="--start: 8%; --width: 62%"></i><span>R 74018 · Annäherung</span><i class="danger" style="--start: 42%; --width: 50%"></i></div></div>
  <div class="proposal"><p class="eyebrow">Zulässige Alternative</p><h3>Abfahrt +${conflict.proposedShiftMinutes} min</h3><p>Keine weitere Abweichung. Der Konflikt ist vollständig aufgelöst.</p><button class="zf-button primary">Alternative prüfen ${icon("chevron")}</button></div></aside></section></main></div>`;
  app.querySelector("#density")?.addEventListener("click", () => { density = density === "control" ? "document" : "control"; render(); });
  app.querySelector("#steps")?.addEventListener("click", () => { showSteps = !showSteps; render(); });
  app.querySelectorAll<SVGGElement>("[data-train]").forEach((node) => { const select = (): void => { selectedTrainId = node.dataset.train ?? "t1"; render(); }; node.addEventListener("click", select); node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") select(); }); });
}
render();
