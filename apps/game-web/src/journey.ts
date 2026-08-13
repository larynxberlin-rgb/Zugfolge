import type { TutorialSessionView } from "./api.js";
import { renderCooperationSurface, type CooperationSurfaceState } from "./cooperation.js";

export interface JourneyViewState {
  readonly publicWorldId: string;
  readonly tutorial?: TutorialSessionView;
  readonly busy: boolean;
  readonly message: string;
  readonly coachDismissed: boolean;
  readonly whyOpen: boolean;
  readonly messageTone?: "status" | "error";
  readonly livemapUrl?: string;
  readonly cooperation?: CooperationSurfaceState;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function value(source: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  const found = source[key];
  return typeof found === "string" || typeof found === "number" ? String(found) : fallback;
}

function integer(source: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
  const found = source[key];
  return typeof found === "number" && Number.isSafeInteger(found) ? found : fallback;
}

function euros(centsValue: unknown): string {
  const cents = BigInt(typeof centsValue === "string" && /^-?[0-9]+$/.test(centsValue) ? centsValue : "0");
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${(absolute / 100n).toLocaleString("de-DE")},${(absolute % 100n).toString().padStart(2, "0")} €`;
}

function progress(session: TutorialSessionView): string {
  return `<ol class="tutorial-progress" aria-label="Tutorialfortschritt">${session.chapters.map((chapter) => {
    const completed = session.evidence[String(chapter.chapter)]?.completed === true;
    const current = chapter.chapter === session.currentChapter && session.lifecycle !== "archived";
    return `<li aria-current="${current ? "step" : "false"}" class="${completed ? "is-complete" : current ? "is-current" : ""}"><span>${completed ? "✓" : chapter.chapter}</span><small>${escapeHtml(chapter.title)}</small><b>${completed ? "Erledigt" : current ? "Aktiv" : "Offen"}</b></li>`;
  }).join("")}</ol>`;
}

function tenderTask(session: TutorialSessionView): string {
  const tender = session.presentation.tender ?? {};
  return `<section class="tutorial-task" id="tutorial-chapter-1" tabindex="-1" aria-labelledby="tutorial-task-title">
    <p class="eyebrow">Hauptaufgabe · Kapitel 1</p><h2 id="tutorial-task-title">Ein tragfähiges Angebot abgeben</h2>
    <div class="tutorial-facts"><div><span>Preis-/Qualität</span><strong>55 / 45</strong></div><div><span>Pönaleschwerpunkt</span><strong>Pünktlichkeit</strong></div><div><span>Auskömmlich bis</span><strong>${euros(value(tender, "viabilityThresholdCentsPerTrainKm"))} / Zug-km</strong></div><div><span>Erwartete Marge</span><strong>${euros(value(tender, "expectedMarginCents"))}</strong></div></div>
    <form id="tutorial-tender-form" class="tutorial-form" data-tutorial-action="submit-bid">
      <label>Bestellerentgelt je Zug-km <input name="orderingFeeCentsPerTrainKm" inputmode="numeric" pattern="[1-9][0-9]{2,3}" value="1450" required><small>Geführter Lösungsraum: höchstens 15,20 €.</small></label>
      <label>Pünktlichkeitsversprechen <input name="punctualityBasisPoints" type="number" min="8800" max="9800" step="50" value="9200" required><small>92,00 % entspricht 9.200 Basispunkten.</small></label>
      <label>Zusätzliche Sitzplätze <input name="extraSeats" type="number" min="0" max="40" value="12" required></label>
      <div class="decision-preview"><span>Eigene Wertung</span><strong>${integer(tender, "ownScoreBasisPoints").toLocaleString("de-DE")} BP vor Abgabe</strong></div>
      <button class="primary-action" type="submit">Angebot verbindlich abgeben</button>
    </form>
  </section>`;
}

function leaseTask(session: TutorialSessionView): string {
  const offers = session.presentation.leases ?? [];
  return `<section class="tutorial-task" id="tutorial-chapter-2" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 2</p><h2 id="tutorial-task-title">Ein Fahrzeug selbst leasen</h2><div id="tutorial-lease-options" class="choice-grid">${offers.map((offer, index) => `<article><p class="eyebrow">Angebot ${index + 1}</p><h3>${escapeHtml(value(offer, "classDesignation", "Tutorialfahrzeug"))}</h3><dl><div><dt>Leasing / Periode</dt><dd>${euros(value(offer, "monthlyCostCents"))}</dd></div><div><dt>Sitzplätze</dt><dd>${escapeHtml(value(offer, "seats"))}</dd></div><div><dt>Zustand</dt><dd>${(integer(offer, "conditionBasisPoints") / 100).toLocaleString("de-DE")} %</dd></div><div><dt>Zuverlässigkeit</dt><dd>${(integer(offer, "reliabilityBasisPoints") / 100).toLocaleString("de-DE")} %</dd></div><div><dt>Margenwirkung</dt><dd>${euros(value(offer, "marginEffectCents"))}</dd></div></dl><button type="button" data-tutorial-offer="${escapeHtml(value(offer, "id"))}">Dieses Angebot annehmen</button></article>`).join("")}</div></section>`;
}

function pathTask(session: TutorialSessionView): string {
  const paths = session.presentation.paths ?? [];
  return `<section class="tutorial-task" id="tutorial-chapter-3" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 3</p><h2 id="tutorial-task-title">Eine berechnete Trasse bestätigen</h2><div id="tutorial-path-options" class="choice-grid">${paths.map((path) => `<article><h3>${escapeHtml(value(path, "label", "Trassenalternative"))}</h3><dl><div><dt>Puffer</dt><dd>${escapeHtml(value(path, "bufferSeconds"))} s</dd></div><div><dt>Trassenkosten</dt><dd>${euros(value(path, "costCents"))}</dd></div><div><dt>Plannerstatus</dt><dd>Konfliktgeprüft</dd></div></dl><button type="button" data-tutorial-path="${escapeHtml(value(path, "id"))}">Trasse verbindlich bestätigen</button></article>`).join("")}</div></section>`;
}

function programmeTask(session: TutorialSessionView): string {
  const programmes = session.presentation.programmes ?? [];
  return `<section class="tutorial-task" id="tutorial-chapter-4" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 4</p><h2 id="tutorial-task-title">Eine Regel ändern und aktivieren</h2><form id="tutorial-program-form" class="tutorial-form" data-tutorial-action="activate-program"><label>Vorlage <select name="templateId">${programmes.map((item) => `<option value="${escapeHtml(value(item, "id"))}">${escapeHtml(value(item, "label"))}</option>`).join("")}</select></label><label>Entscheidungsregel <select name="changedRule"><option value="hold-connections">Anschlüsse abwarten</option><option value="prioritize-punctuality">Pünktlichkeit priorisieren</option><option value="activate-reserve">Reserve aktivieren</option></select></label><label>Regelschwelle in Sekunden <input name="thresholdSeconds" type="number" min="60" max="900" value="240" required></label><div class="decision-preview"><span>Erwartete Wirkung</span><strong>Qualität steigt; Kosten und Pönalerisiko ändern sich.</strong></div><button class="primary-action" type="submit">Geändertes Betriebsprogramm aktivieren</button></form></section>`;
}

function disruptionTask(session: TutorialSessionView): string {
  const options = session.presentation.disruptionOptions ?? [];
  return `<section class="tutorial-task disruption-task" id="tutorial-chapter-5" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 5</p><h2 id="tutorial-task-title">Weichenstörung disponieren</h2><p class="incident-line"><strong>+7 min</strong> · Gleisabschnitt Mühlenbrück–Wiesenrode gesperrt</p><div id="tutorial-dispatch-options" class="choice-grid three">${options.map((option) => `<article><h3>${escapeHtml(value(option, "label"))}</h3><dl><div><dt>Zusatzkosten</dt><dd>${euros(value(option, "costCents"))}</dd></div><div><dt>Pünktlichkeit</dt><dd>${(integer(option, "punctualityBasisPoints") / 100).toLocaleString("de-DE")} %</dd></div><div><dt>Ausfälle</dt><dd>${escapeHtml(value(option, "cancellations"))}</dd></div></dl><button type="button" data-tutorial-dispatch="${escapeHtml(value(option, "action"))}">Diese Reaktion ausführen</button></article>`).join("")}</div></section>`;
}

function summaryTask(session: TutorialSessionView): string {
  const summary = session.summary;
  if (summary === undefined) return `<section class="tutorial-task" id="tutorial-summary" aria-busy="true"><h2>Ergebnis wird autoritativ berechnet …</h2></section>`;
  return `<section class="tutorial-task tutorial-result" id="tutorial-summary" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Ergebnisrechnung</p><h2 id="tutorial-task-title">Ihr erster Betriebszyklus</h2><dl><div><dt>Startliquidität</dt><dd>${euros(summary.startLiquidityCents)}</dd></div><div><dt>Leasingkosten</dt><dd>− ${euros(summary.leasingCostCents)}</dd></div><div><dt>Trassen- und Betriebskosten</dt><dd>− ${euros(summary.pathAndOperatingCostCents)}</dd></div><div><dt>Bestellererlös</dt><dd>+ ${euros(summary.orderingRevenueCents)}</dd></div><div><dt>Störungsfolgen</dt><dd>− ${euros(summary.disruptionCostCents)}</dd></div><div class="result-total"><dt>Ergebnis</dt><dd>${euros(summary.resultCents)}</dd></div></dl><p><strong>${(summary.punctualityBasisPoints / 100).toLocaleString("de-DE")} % pünktlich.</strong> Erfüllt: ${summary.qualityTargetsMet.map(escapeHtml).join(", ")}.</p><button class="primary-action" id="tutorial-summary-confirm" type="button">Ergebnis bestätigen und Tutorialwelt schließen</button></section>`;
}

function activeTask(session: TutorialSessionView): string {
  if (session.lifecycle === "summary") return summaryTask(session);
  if (session.lifecycle === "closing" || session.lifecycle === "archived") return `<section class="tutorial-task tutorial-closed"><p class="eyebrow">Tutorial abgeschlossen</p><h2>Die kurzlebige Welt ist geschlossen</h2><p>Ihre öffentliche Welt blieb vollständig getrennt. Dort gilt ausschließlich die signierte Startkapital-Policy; Fahrzeug, Trasse und Vertrag wurden nicht übertragen.</p><a id="tutorial-public-world-link" class="button-link" href="${escapeHtml(session.publicWorldUrl)}">Öffentliche Welt öffnen</a></section>`;
  if (session.currentChapter === 1) return tenderTask(session);
  if (session.currentChapter === 2) return leaseTask(session);
  if (session.currentChapter === 3) return pathTask(session);
  if (session.currentChapter === 4) return programmeTask(session);
  return disruptionTask(session);
}

function coach(session: TutorialSessionView, dismissed: boolean, whyOpen: boolean): string {
  if (dismissed) return `<button id="tutorial-coach-reopen" class="coach-reopen" type="button" aria-label="Hinweis von Lutz erneut anzeigen"><img src="/assets/tutorial/lutz-avatar-comic-v2.png" width="56" height="56" alt=""><span>Lutz wieder anzeigen</span></button>`;
  const introOrSummary = session.dialogue.trigger === "session.started" || session.dialogue.trigger === "summary.ready";
  return `<aside class="tutorial-coach ${introOrSummary ? "coach-prominent" : ""}" ${introOrSummary ? 'role="dialog" aria-modal="false"' : 'role="complementary"'} aria-labelledby="lutz-name" aria-describedby="lutz-message"><img class="lutz-avatar" src="/assets/tutorial/lutz-avatar-comic-v2.png" width="128" height="128" alt="Lutz, fiktiver und sichtbar genervter Tutorialbegleiter"><div class="coach-copy"><div class="coach-heading"><div><p class="eyebrow">Fiktiver Infrastrukturbetreiber</p><h2 id="lutz-name" tabindex="-1">Lutz</h2></div><span>${escapeHtml(session.progressLabel)}</span></div><p id="lutz-message" aria-live="polite">${escapeHtml(session.dialogue.text)}</p>${session.dialogue.why === undefined ? "" : `<button id="tutorial-why" class="text-button" type="button" aria-expanded="${whyOpen}">Warum?</button><p class="coach-why" ${whyOpen ? "" : "hidden"}>${escapeHtml(session.dialogue.why)}</p>`}<div class="coach-actions">${session.dialogue.target === undefined ? "" : `<button id="tutorial-focus-target" type="button" data-target="${escapeHtml(session.dialogue.target)}">${escapeHtml(session.dialogue.actionLabel ?? "Zur Aufgabe")}</button>`}${session.dialogue.canDismiss ? `<button id="tutorial-dismiss" class="secondary" type="button">Später erneut anzeigen</button>` : ""}<button id="tutorial-hint" class="secondary" type="button">Hinweis</button></div></div></aside>`;
}

function tutorial(state: JourneyViewState): string {
  const session = state.tutorial;
  if (session === undefined) return `<section class="tutorial-start journey-card"><p class="eyebrow">Persönliche Tutorialwelt</p><h2>In etwa zwölf Minuten zum ersten Betrieb</h2><p>Eine private, ungewertete und beschleunigte Welt wird erst beim Start für Sie erzeugt. Nichts davon gelangt in die öffentliche Welt oder nach Odoo.</p><ol><li>Ausschreibung gewinnen</li><li>Fahrzeug leasen</li><li>Trasse bestätigen</li><li>Betriebsprogramm aktivieren</li><li>Störung disponieren</li></ol><button id="tutorial-start" class="primary-action" type="button">Tutorial mit Lutz starten</button></section>`;
  return `<section class="tutorial-experience" data-dialogue-target="${escapeHtml(session.dialogue.target ?? "")}"><header><div><p class="eyebrow">Private Tutorialwelt · ${escapeHtml(session.reference)}</p><h1>Kieselgrund–Fichtenhain</h1></div><div class="tutorial-session-meta"><span>ungewertet</span><span>240× beschleunigt</span><button id="tutorial-restart" class="secondary" type="button">Neu starten</button></div></header>${progress(session)}<div class="tutorial-workspace">${activeTask(session)}${coach(session, state.coachDismissed, state.whyOpen)}</div></section>`;
}

function onboarding(state: JourneyViewState): string {
  if (state.publicWorldId === "") return `<section class="journey-card"><p class="eyebrow">Öffentliche Welt</p><h2>Weltkennung fehlt</h2></section>`;
  return `<section class="journey-card onboarding-card"><div class="journey-heading"><div><p class="eyebrow">Öffentliche Welt · 1:1</p><h2>Öffentlicher Betrieb</h2></div><span class="state-word">Keine Startausstattung</span></div><p>Diese Wettbewerbswelt teilt kein Fahrzeug, keinen Vertrag, keine Trasse, kein Personal und kein Betriebsprogramm automatisch zu. Ihr Geldbestand folgt ausschließlich dem signierten Weltentwurf.</p><p class="boundary-note">Tutorialhandlungen und -kapital werden niemals übertragen.</p></section>`;
}

export function renderJourney(state: JourneyViewState): string {
  const inTutorial = state.tutorial !== undefined;
  const livemap = state.livemapUrl === undefined || state.livemapUrl === "" ? "" : `<a class="primary-map-link" href="${escapeHtml(state.livemapUrl)}">Zur Live-Lage</a>`;
  const message = state.message === "" ? "" : `<p class="journey-message journey-message--${state.messageTone ?? "status"}" role="${state.messageTone === "error" ? "alert" : "status"}" aria-live="polite">${escapeHtml(state.message)}</p>`;
  const cooperation = inTutorial || state.cooperation === undefined ? "" : renderCooperationSurface(state.cooperation);
  const html = `<main class="journey-shell" aria-busy="${state.busy}"><header class="journey-top"><div><p class="wordmark">ZUGFOLGE</p><h1>Geschlossene Alpha · Spielerreise</h1></div><nav aria-label="Hauptnavigation">${livemap}<a href="?view=diagram&world=${encodeURIComponent(state.publicWorldId)}">Zum Bildfahrplan</a></nav></header>${message}<div class="${inTutorial ? "tutorial-shell" : "journey-grid"}">${tutorial(state)}${inTutorial ? "" : onboarding(state)}</div>${cooperation}</main>`;
  return state.busy ? html.replaceAll("<button ", '<button disabled aria-disabled="true" ') : html;
}
