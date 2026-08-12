import type {
  CapacityHeatmapCell,
  OnboardingAssistant,
  StartPackageGrant,
  TutorialJourney,
} from "./api.js";

export interface JourneyViewState {
  readonly tutorialWorldId: string;
  readonly publicWorldId: string;
  readonly tutorial?: TutorialJourney;
  readonly grant?: StartPackageGrant;
  readonly heatmap: readonly CapacityHeatmapCell[];
  readonly assistant?: OnboardingAssistant;
  readonly busy: boolean;
  readonly message: string;
  readonly livemapUrl?: string;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}

function tutorial(state: JourneyViewState): string {
  if (state.tutorialWorldId === "") return `<section class="journey-card"><p class="eyebrow">Tutorial</p><h2>Getrennte Tutorialwelt fehlt</h2><p class="muted">Die öffentliche Welt bleibt strikt bei 1:1. Eine beschleunigte Tutorialwelt muss explizit als <code>tutorialWorld</code> übergeben werden.</p></section>`;
  if (state.tutorial === undefined) return `<section class="journey-card" aria-busy="true"><p class="eyebrow">Tutorial</p><h2>Fortschritt wird geladen</h2></section>`;
  const chapters = state.tutorial.chapters.map((chapter) => {
    const evidence = state.tutorial!.evidence[String(chapter.chapter)];
    const completed = evidence?.completed === true;
    const active = !completed && chapter.chapter === state.tutorial!.chapter && state.tutorial!.chapterState !== "completed";
    const label = completed ? "Erledigt" : active ? "Aktiv" : "Offen";
    return `<li class="tutorial-chapter state-${label.toLowerCase()}" data-tutorial-chapter="${chapter.chapter}">
      <span class="chapter-number">${chapter.chapter}</span>
      <span><strong>${escapeHtml(chapter.title)}</strong><small>${escapeHtml(chapter.goal)}</small></span>
      <span class="state-word">${label}</span>
    </li>`;
  }).join("");
  return `<section class="journey-card tutorial-card">
    <div class="journey-heading"><div><p class="eyebrow">Tutorial · ${escapeHtml(state.tutorialWorldId)}</p><h2>Fünf Kapitel, echte Belege</h2></div><span class="mode-label">Beschleunigt nur in der getrennten Tutorialwelt</span></div>
    <p class="assistant-copy">${escapeHtml(state.tutorial.explanation)}</p>
    <ol class="tutorial-list">${chapters}</ol>
    <div class="journey-actions"><button id="tutorial-refresh" type="button">Belege neu prüfen</button><button id="tutorial-reset" class="secondary" type="button">Tutorial zurücksetzen (${state.tutorial.resetCount}/5)</button></div>
  </section>`;
}

function heatmap(cells: readonly CapacityHeatmapCell[]): string {
  if (cells.length === 0) return `<p class="muted">Noch keine autoritative Planner-Projektion für dieses Zeitfenster.</p>`;
  return `<div class="heatmap" role="list" aria-label="Kapazitaets-Heatmap">${cells.map((cell) => `<article class="heatmap-cell pattern-${cell.pattern}" role="listitem">
    <strong>${escapeHtml(cell.resourceId)}</strong><span class="state-word">${escapeHtml(cell.stateLabel)}</span>
    <meter min="0" max="10000" value="${cell.utilizationBasisPoints}">${cell.utilizationBasisPoints / 100}%</meter>
    <small>${cell.utilizationBasisPoints / 100}% belegt · Datenklasse ${cell.qualityClass} · ${cell.orderable ? "bestellbar" : "nicht bestellbar"}</small>
  </article>`).join("")}</div>`;
}

function assistant(value: OnboardingAssistant | undefined): string {
  if (value === undefined) return `<p class="muted">Betriebsassistent wartet auf den Weltzustand.</p>`;
  if (value.warnings.length === 0) return `<div class="assistant-status state-ready"><strong>Betriebsbereit</strong><span>Alle Startpaket-Nachweise sind autoritativ vorhanden.</span></div>`;
  return `<ul class="warning-list">${value.warnings.map((warning) => `<li class="severity-${warning.severity}"><strong>${warning.severity === "blocking" ? "Blockierend" : warning.severity === "warning" ? "Warnung" : "Hinweis"}</strong><span>${escapeHtml(warning.message)}</span></li>`).join("")}</ul>`;
}

function onboarding(state: JourneyViewState): string {
  if (state.publicWorldId === "") return `<section class="journey-card"><p class="eyebrow">Öffentliche Welt</p><h2>Weltkennung fehlt</h2></section>`;
  const grant = state.grant?.grant;
  return `<section class="journey-card onboarding-card">
    <div class="journey-heading"><div><p class="eyebrow">Öffentliche Welt · 1:1</p><h2>Startpaket und Betriebslage</h2></div><span class="state-word">${grant === undefined ? "Noch nicht beansprucht" : "Autoritativ zugeteilt"}</span></div>
    ${grant === undefined ? `<p>Ein kleines Notvergabelos, ein begrenztes Leasingfahrzeug, bestätigte Trasse, Personal und eine aktive Betriebsprogrammvorlage werden in einem weltgesperrten Commit vergeben.</p><button id="claim-start-package" type="button">Startpaket verbindlich beanspruchen</button>` : `<dl class="grant-proof"><div><dt>EVU</dt><dd>${escapeHtml(grant.operatorId)}</dd></div><div><dt>Los</dt><dd>${escapeHtml(grant.emergencyLotId)}</dd></div><div><dt>Fahrzeug</dt><dd>${escapeHtml(grant.vehicleId)}</dd></div><div><dt>Trasse</dt><dd>${escapeHtml(grant.pathReceiptId)}</dd></div></dl>`}
    <h3>Betriebsassistent</h3>${assistant(state.assistant)}
    <div class="journey-heading"><h3>Kapazität der nächsten 24 Stunden</h3><button id="heatmap-refresh" class="secondary compact" type="button">Aktualisieren</button></div>
    ${heatmap(state.heatmap)}
  </section>`;
}

export function renderJourney(state: JourneyViewState): string {
  const livemap = state.livemapUrl === undefined || state.livemapUrl === ""
    ? ""
    : `<a class="primary-map-link" href="${escapeHtml(state.livemapUrl)}">Zur Live-Lage</a>`;
  return `<main class="journey-shell" aria-busy="${state.busy}">
    <header class="journey-top"><div><p class="wordmark">ZUGFOLGE</p><h1>Geschlossene Alpha · Spielerreise</h1></div><nav aria-label="Hauptnavigation">${livemap}<a href="?view=diagram&world=${encodeURIComponent(state.publicWorldId)}">Zum Bildfahrplan</a></nav></header>
    ${state.message === "" ? "" : `<p class="journey-message" role="status">${escapeHtml(state.message)}</p>`}
    <div class="journey-grid">${tutorial(state)}${onboarding(state)}</div>
  </main>`;
}
