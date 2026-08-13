import type { MailboxMessageView, PublicWorldContractView, TutorialSessionView } from "./api.js";
import { renderComparisonWorkbench } from "./comparison.js";
import { renderCooperationSurface, type CooperationSurfaceState } from "./cooperation.js";

export interface JourneyViewState {
  readonly publicWorldId: string;
  readonly tutorial?: TutorialSessionView;
  readonly busy: boolean;
  readonly busyScope?: "initial" | "tutorial" | "cooperation" | "mailbox";
  readonly message: string;
  readonly coachDismissed: boolean;
  readonly whyOpen: boolean;
  readonly messageTone?: "status" | "error";
  readonly livemapUrl?: string;
  readonly cooperation?: CooperationSurfaceState;
  readonly tutorialStartAvailable?: boolean;
  readonly mailbox?: readonly MailboxMessageView[];
  readonly worldContracts?: readonly PublicWorldContractView[];
  readonly confirmation?: { readonly title: string; readonly detail: string };
  readonly bootRecovery?: "authenticate" | "configure" | "retry";
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function euros(centsValue: unknown): string {
  const cents = BigInt(typeof centsValue === "string" && /^-?[0-9]+$/.test(centsValue) ? centsValue : "0");
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${(absolute / 100n).toLocaleString("de-DE")},${(absolute % 100n).toString().padStart(2, "0")} €`;
}

function euroInput(centsValue: string): string {
  const cents = BigInt(centsValue);
  return `${cents / 100n},${(cents % 100n).toString().padStart(2, "0")}`;
}

function percentInput(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)},${String(basisPoints % 100).padStart(2, "0")}`;
}

function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

function signedPercentagePoints(basisPoints: number): string {
  const sign = basisPoints > 0 ? "+" : basisPoints < 0 ? "−" : "±";
  return `${sign}${(Math.abs(basisPoints) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Prozentpunkte`;
}

function comparisonRows(comparison: Readonly<Record<string, string | number>>): string {
  const text = (key: string): string => typeof comparison[key] === "string" ? comparison[key] as string : "nicht verfügbar";
  const number = (key: string): number => typeof comparison[key] === "number" && Number.isSafeInteger(comparison[key]) ? comparison[key] as number : 0;
  const decisions = [
    {
      key: "tender",
      title: "1. Ausschreibung",
      detail: `Sie boten ${euros(text("bidOrderingFeeCentsPerTrainKm"))} je Zug-km, versprachen ${percent(number("bidPunctualityBasisPoints"))} Pünktlichkeit und ${number("bidExtraSeats")} zusätzliche Sitzplätze. Dieses Angebot erhielt den Zuschlag.`,
    },
    {
      key: "lease",
      title: "2. Fahrzeugleasing",
      detail: `${text("leaseLabel")} stellt ${number("leaseSeats")} Sitzplätze bei ${percent(number("leaseReliabilityBasisPoints"))} Zuverlässigkeit bereit und kostet ${euros(text("leaseCostCents"))} je Periode.`,
    },
    {
      key: "path",
      title: "3. Trassenwahl",
      detail: `${text("pathLabel")} bindet ${number("pathBufferSeconds")} Sekunden Puffer und verursacht ${euros(text("pathCostCents"))} Trassenkosten.`,
    },
    {
      key: "programme",
      title: "4. Betriebsprogramm",
      detail: `${text("programmeRuleLabel")} wurde im Programm „${text("programmeLabel")}“ mit ${number("programmeThresholdSeconds")} Sekunden Schwelle aktiviert. Verbindlich berechnete Wirkung: ${euros(text("programmeCostCents"))} Kosten, Qualität ${signedPercentagePoints(number("programmeQualityBasisPoints"))}, Pönalerisiko ${signedPercentagePoints(number("programmePenaltyRiskBasisPoints"))}.`,
    },
    {
      key: "disruption",
      title: "5. Störungsreaktion",
      detail: `${text("disruptionLabel")} kostete ${euros(text("disruptionCostCents"))}, erreichte ${percent(number("disruptionPunctualityBasisPoints"))} Pünktlichkeit und führte zu ${number("disruptionCancellations")} ${number("disruptionCancellations") === 1 ? "Ausfall" : "Ausfällen"}.`,
    },
  ] as const;
  return `<h3>Wirkung Ihrer Entscheidungen</h3><p>Alle fünf Entscheidungen bleiben getrennt nachvollziehbar; es gibt bewusst keinen Gesamtscore.</p><div class="tutorial-comparison">${decisions.map((decision) => `<article data-decision="${decision.key}"><h4>${decision.title}</h4><p>${escapeHtml(decision.detail)}</p></article>`).join("")}</div>`;
}

function progress(session: TutorialSessionView): string {
  return `<ol class="tutorial-progress" aria-label="Tutorialfortschritt">${session.chapters.map((chapter) => {
    const completed = session.evidence[String(chapter.chapter)]?.completed === true;
    const current = chapter.chapter === session.currentChapter && session.lifecycle !== "archived";
    return `<li aria-current="${current ? "step" : "false"}" class="${completed ? "is-complete" : current ? "is-current" : ""}"><span>${completed ? "✓" : chapter.chapter}</span><small>${escapeHtml(chapter.title)}</small><b>${completed ? "Erledigt" : current ? "Aktiv" : "Offen"}</b></li>`;
  }).join("")}</ol>`;
}

function tenderTask(session: TutorialSessionView): string {
  const tender = session.presentation.tender;
  const limits = tender.limits;
  const penaltyFocus = tender.penaltyFocus === "punctuality" ? "Pünktlichkeit" : tender.penaltyFocus;
  return `<section class="tutorial-task" id="tutorial-chapter-1" tabindex="-1" aria-labelledby="tutorial-task-title">
    <p class="eyebrow">Hauptaufgabe · Kapitel 1</p><h2 id="tutorial-task-title">Ein tragfähiges Angebot abgeben</h2>
    <div class="tutorial-facts"><div><span>Preis-/Qualität</span><strong>${tender.priceWeightBasisPoints / 100} / ${tender.qualityWeightBasisPoints / 100}</strong></div><div><span>Pönaleschwerpunkt</span><strong>${escapeHtml(penaltyFocus)}</strong></div><div><span>Auskömmlich bis</span><strong>${euros(tender.viabilityThresholdCentsPerTrainKm)} / Zug-km</strong></div></div>
    <form id="tutorial-tender-form" class="tutorial-form" data-tutorial-action="submit-bid">
      <label>Bestellerentgelt je Zug-km <input name="orderingFeeEuro" inputmode="decimal" pattern="[0-9]+,[0-9]{2}" value="${euroInput(limits.defaultOrderingFeeCentsPerTrainKm)}" aria-describedby="tutorial-fee-help" title="Zulässig sind ${euroInput(limits.minimumOrderingFeeCentsPerTrainKm)} bis ${euroInput(limits.maximumOrderingFeeCentsPerTrainKm)} Euro." required><small id="tutorial-fee-help">Euro mit zwei Nachkommastellen; mindestens ${euros(limits.minimumOrderingFeeCentsPerTrainKm)}, höchstens ${euros(limits.maximumOrderingFeeCentsPerTrainKm)}.</small></label>
      <label>Pünktlichkeitsversprechen <input name="punctualityPercent" inputmode="decimal" pattern="[0-9]+,[0-9]{2}" value="${percentInput(limits.defaultPunctualityBasisPoints)}" aria-describedby="tutorial-punctuality-help" title="Zulässig sind ${percentInput(limits.minimumPunctualityBasisPoints)} bis ${percentInput(limits.maximumPunctualityBasisPoints)} Prozent." required><small id="tutorial-punctuality-help">Erwarteter Anteil pünktlicher Ankünfte; ${percentInput(limits.minimumPunctualityBasisPoints)} bis ${percentInput(limits.maximumPunctualityBasisPoints)} Prozent.</small></label>
      <label>Zusätzliche Sitzplätze <input name="extraSeats" type="number" min="${limits.minimumExtraSeats}" max="${limits.maximumExtraSeats}" value="${limits.defaultExtraSeats}" required></label>
      <div class="decision-preview"><span>Verbindliche Berechnung</span><strong>Wertung und wirtschaftliche Wirkung werden nach der Abgabe vom Spiel berechnet und getrennt ausgewiesen – ohne Gesamtscore.</strong></div>
      <button class="primary-action" type="submit">Angebot verbindlich abgeben</button>
    </form>
  </section>`;
}

function leaseTask(session: TutorialSessionView): string {
  const offers = session.presentation.leases;
  const comparison = renderComparisonWorkbench("Leasingangebote", { cost: "Kosten je Periode", capacity: "Sitzplätze", condition: "Zustand", reliability: "Zuverlässigkeit", margin: "Margenwirkung" }, offers.map((offer) => ({ id: offer.id, label: offer.classDesignation, dimensions: { cost: euros(offer.monthlyCostCents), capacity: String(offer.seats), condition: `${(offer.conditionBasisPoints / 100).toLocaleString("de-DE")} %`, reliability: `${(offer.reliabilityBasisPoints / 100).toLocaleString("de-DE")} %`, margin: euros(offer.marginEffectCents) } })));
  return `<section class="tutorial-task" id="tutorial-chapter-2" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 2</p><h2 id="tutorial-task-title">Ein Fahrzeug selbst leasen</h2>${comparison}<div id="tutorial-lease-options" class="choice-grid">${offers.map((offer, index) => `<article><p class="eyebrow">Angebot ${index + 1}</p><h3>${escapeHtml(offer.classDesignation)}</h3><dl><div><dt>Leasing / Periode</dt><dd>${euros(offer.monthlyCostCents)}</dd></div><div><dt>Sitzplätze</dt><dd>${offer.seats}</dd></div><div><dt>Zustand</dt><dd>${(offer.conditionBasisPoints / 100).toLocaleString("de-DE")} %</dd></div><div><dt>Zuverlässigkeit</dt><dd>${(offer.reliabilityBasisPoints / 100).toLocaleString("de-DE")} %</dd></div><div><dt>Margenwirkung</dt><dd>${euros(offer.marginEffectCents)}</dd></div></dl><button type="button" data-tutorial-offer="${escapeHtml(offer.id)}">Dieses Angebot annehmen</button></article>`).join("")}</div></section>`;
}

function pathTask(session: TutorialSessionView): string {
  const paths = session.presentation.paths;
  const comparison = renderComparisonWorkbench("Trassenalternativen", { cost: "Trassenkosten", buffer: "Betrieblicher Puffer", compatibility: "Kompatibilität" }, paths.map((path) => ({ id: path.id, label: path.label, dimensions: { cost: euros(path.costCents), buffer: `${path.bufferSeconds} s`, compatibility: "Konfliktgeprüft" } })));
  return `<section class="tutorial-task" id="tutorial-chapter-3" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 3</p><h2 id="tutorial-task-title">Eine berechnete Trasse bestätigen</h2>${comparison}<div id="tutorial-path-options" class="choice-grid">${paths.map((path) => `<article><h3>${escapeHtml(path.label)}</h3><dl><div><dt>Puffer</dt><dd>${path.bufferSeconds} s</dd></div><div><dt>Trassenkosten</dt><dd>${euros(path.costCents)}</dd></div><div><dt>Trassenprüfung</dt><dd>Konfliktgeprüft</dd></div></dl><button type="button" data-tutorial-path="${escapeHtml(path.id)}">Trasse verbindlich bestätigen</button></article>`).join("")}</div></section>`;
}

function programmeTask(session: TutorialSessionView): string {
  const programmes = session.presentation.programmes;
  const ruleEffects = session.presentation.programmeRuleEffects;
  return `<section class="tutorial-task" id="tutorial-chapter-4" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 4</p><h2 id="tutorial-task-title">Eine Regel ändern und aktivieren</h2><form id="tutorial-program-form" class="tutorial-form" data-tutorial-action="activate-program"><label>Vorlage <select name="templateId">${programmes.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}</select></label><label>Entscheidungsregel <select name="changedRule">${ruleEffects.map((item) => `<option value="${escapeHtml(item.rule)}">${escapeHtml(item.label)}</option>`).join("")}</select></label><label>Regelschwelle in Minuten <input name="thresholdMinutes" inputmode="decimal" pattern="[1-9][0-9]?(,[05])?" value="4,0" required></label><div class="decision-preview" id="tutorial-program-preview"><span>Vom Spiel berechnete Wirkungen</span><dl>${ruleEffects.map((item) => `<div data-programme-rule-effect="${escapeHtml(item.rule)}"><dt>${escapeHtml(item.label)}</dt><dd>${euros(item.effect.costCents)} Kosten · Qualität ${signedPercentagePoints(item.effect.qualityBasisPoints)} · Pönalerisiko ${signedPercentagePoints(item.effect.penaltyRiskBasisPoints)}</dd></div>`).join("")}</dl></div><button class="primary-action" type="submit">Geändertes Betriebsprogramm aktivieren</button></form></section>`;
}

function disruptionTask(session: TutorialSessionView): string {
  const options = session.presentation.disruptionOptions;
  const selectedProgramme = session.presentation.programmes.find((programme) => programme.selected && programme.effect !== undefined);
  const programmeEffect = selectedProgramme?.effect === undefined ? "" : `<aside class="decision-preview"><span>Wirkung des aktivierten Betriebsprogramms</span><strong>${escapeHtml(selectedProgramme.label)}: ${euros(selectedProgramme.effect.costCents)} Kosten · Qualität ${signedPercentagePoints(selectedProgramme.effect.qualityBasisPoints)} · Pönalerisiko ${signedPercentagePoints(selectedProgramme.effect.penaltyRiskBasisPoints)}</strong></aside>`;
  return `<section class="tutorial-task disruption-task" id="tutorial-chapter-5" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Hauptaufgabe · Kapitel 5</p><h2 id="tutorial-task-title">Weichenstörung disponieren</h2>${programmeEffect}<p class="incident-line"><strong>+7 min</strong> · Gleisabschnitt Mühlenbrück–Wiesenrode gesperrt</p><div id="tutorial-dispatch-options" class="choice-grid three">${options.map((option) => `<article><h3>${escapeHtml(option.label)}</h3><dl><div><dt>Zusatzkosten</dt><dd>${euros(option.costCents)}</dd></div><div><dt>Pünktlichkeit</dt><dd>${percent(option.punctualityBasisPoints)}</dd></div><div><dt>Ausfälle</dt><dd>${option.cancellations}</dd></div></dl><button type="button" data-tutorial-dispatch="${escapeHtml(option.action)}">Diese Reaktion ausführen</button></article>`).join("")}</div></section>`;
}

function summaryTask(session: TutorialSessionView): string {
  const summary = session.summary;
  if (summary === undefined) return `<section class="tutorial-task" id="tutorial-summary" aria-busy="true"><h2>Ergebnis wird autoritativ berechnet …</h2></section>`;
  return `<section class="tutorial-task tutorial-result" id="tutorial-summary" tabindex="-1" aria-labelledby="tutorial-task-title"><p class="eyebrow">Ergebnisrechnung</p><h2 id="tutorial-task-title">Ihr erster Betriebszyklus</h2><dl><div><dt>Startliquidität</dt><dd>${euros(summary.startLiquidityCents)}</dd></div><div><dt>Leasingkosten</dt><dd>− ${euros(summary.leasingCostCents)}</dd></div><div><dt>Trassen- und Betriebskosten</dt><dd>− ${euros(summary.pathAndOperatingCostCents)}</dd></div><div><dt>Bestellererlös</dt><dd>+ ${euros(summary.orderingRevenueCents)}</dd></div><div><dt>Störungsfolgen</dt><dd>− ${euros(summary.disruptionCostCents)}</dd></div><div class="result-total"><dt>Ergebnis</dt><dd>${euros(summary.resultCents)}</dd></div></dl><p><strong>${(summary.punctualityBasisPoints / 100).toLocaleString("de-DE")} % pünktlich.</strong> Erfüllt: ${summary.qualityTargetsMet.map(escapeHtml).join(", ")}.</p>${comparisonRows(summary.comparison)}<p>Danach können Sie in der öffentlichen Welt Kapazität prüfen, ein Fahrzeugangebot vergleichen oder eine Ausschreibung beobachten. Aus dieser Tutorialwelt wird nichts übertragen.</p><button class="primary-action" id="tutorial-summary-confirm" type="button">Ergebnis bestätigen und Tutorialwelt schließen</button></section>`;
}

function activeTask(session: TutorialSessionView): string {
  if (session.lifecycle === "summary") return summaryTask(session);
  if (session.lifecycle === "closing" || session.lifecycle === "archived") return `<section class="tutorial-task tutorial-closed"><p class="eyebrow">Tutorial abgeschlossen</p><h2>Die kurzlebige Welt ist geschlossen</h2><p>Ihre öffentliche Welt blieb vollständig getrennt. Dort gilt ausschließlich die signierte Startkapitalregel; Fahrzeug, Trasse und Vertrag wurden nicht übertragen.</p><a id="tutorial-public-world-link" class="button-link" href="${escapeHtml(session.publicWorldUrl)}">Öffentliche Welt öffnen</a></section>`;
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
  if (session === undefined) {
    const disabled = state.tutorialStartAvailable === false ? ' disabled aria-disabled="true"' : "";
    return `<section class="tutorial-start journey-card"><p class="eyebrow">Persönliche Tutorialwelt</p><h2>In etwa zwölf Minuten zum ersten Betrieb</h2><p>Eine private, ungewertete und beschleunigte Welt wird erst beim Start für Sie erzeugt. Nichts davon gelangt in die öffentliche Welt oder in das Verwaltungssystem.</p><ol><li>Ausschreibung gewinnen</li><li>Fahrzeug leasen</li><li><button type="button" class="zf-glossary-term" data-glossary-code="TrainPath">Trasse</button> bestätigen</li><li><button type="button" class="zf-glossary-term" data-glossary-code="OperatingProgram">Betriebsprogramm</button> aktivieren</li><li>Störung disponieren</li></ol><button id="tutorial-start" class="primary-action" type="button"${disabled}>Tutorial mit Lutz starten</button></section>`;
  }
  return `<section class="tutorial-experience" data-dialogue-target="${escapeHtml(session.dialogue.target ?? "")}"><header><div><p class="eyebrow">Private Tutorialwelt</p><h1>Kieselgrund–Fichtenhain</h1><details><summary>Technische Sitzungsdetails</summary><code>${escapeHtml(session.reference)}</code></details></div><div class="tutorial-session-meta"><span>ungewertet</span><span>240× beschleunigt</span><button id="tutorial-restart" class="secondary" type="button">Neu starten</button></div></header>${progress(session)}<div class="tutorial-workspace">${activeTask(session)}${coach(session, state.coachDismissed, state.whyOpen)}</div></section>`;
}

function onboarding(state: JourneyViewState): string {
  if (state.publicWorldId === "") return `<section class="journey-card"><p class="eyebrow">Öffentliche Welt</p><h2>Weltkennung fehlt</h2></section>`;
  return `<section class="journey-card onboarding-card" id="betrieb" tabindex="-1"><div class="journey-heading"><div><p class="eyebrow">Öffentliche Welt · 1:1</p><h2>Öffentlicher Betrieb</h2></div><span class="state-word">Keine Startausstattung</span></div><p>Diese Wettbewerbswelt teilt kein Fahrzeug, keinen Vertrag, keine <button type="button" class="zf-glossary-term" data-glossary-code="TrainPath">Trasse</button>, kein Personal und kein <button type="button" class="zf-glossary-term" data-glossary-code="OperatingProgram">Betriebsprogramm</button> automatisch zu. Ihr Geldbestand folgt ausschließlich dem signierten Weltentwurf.</p><p class="boundary-note">Tutorialhandlungen und -kapital werden niemals übertragen.</p></section>`;
}

function worldContracts(state: JourneyViewState): string {
  const contracts = state.worldContracts ?? [];
  if (contracts.length === 0) return "";
  const cards = contracts.map((contract) => {
    const duration = contract.duration.kind === "unlimited"
      ? "Unbefristete Welt"
      : `${contract.duration.periodCount} Fahrplanperioden à ${contract.schedulePeriodWeeks} Wochen`;
    const startCapital = contract.startingCapitalPolicy === null ? "Konfiguration unvollständig"
      : contract.startingCapitalPolicy.kind === "unlimited" ? "Unbegrenztes Startkapital"
        : euros(contract.startingCapitalPolicy.amountCents);
    const selected = contract.worldId === state.publicWorldId;
    const date = (instant: string): string => new Date(instant).toLocaleString("de-DE", { timeZone: contract.timeBasis.timeZone, dateStyle: "medium", timeStyle: "short" });
    const entryWindow = contract.entry.closesAt === null ? `offen seit ${date(contract.entry.opensAt)}, ohne festes Ende` : `${date(contract.entry.opensAt)} bis ${date(contract.entry.closesAt)}`;
    return `<article class="world-contract-card${selected ? " is-selected" : ""}" aria-labelledby="world-contract-${escapeHtml(contract.worldId)}"><div class="m12-item-head"><div><p class="eyebrow">Weltvertrag · ${escapeHtml(contract.region.name)} · Variante ${escapeHtml(contract.region.variant)}</p><h3 id="world-contract-${escapeHtml(contract.worldId)}">${escapeHtml(contract.name)}</h3></div><span class="state-word">${selected ? "Ausgewählt" : "Verfügbar"}</span></div><dl><div><dt>Laufzeit</dt><dd>${escapeHtml(duration)}</dd></div><div><dt>Bestand</dt><dd>Dauerhaft, keine Wipes</dd></div><div><dt>Weltzeit</dt><dd>1:1 Echtzeit ab ${escapeHtml(date(contract.timeBasis.epoch))} · ${escapeHtml(contract.timeBasis.timeZone)}</dd></div><div><dt>Eintrittsfenster</dt><dd>${escapeHtml(entryWindow)}</dd></div><div><dt>Fahrplanperiode</dt><dd>${contract.schedulePeriodWeeks} Wochen</dd></div><div><dt>Startkapital</dt><dd>${escapeHtml(startCapital)}</dd></div></dl><details><summary>Signierte Release-Stände und technische Details</summary><p>Regionskennung: <code>${escapeHtml(contract.region.id)}</code></p><dl class="release-pins">${Object.entries(contract.releases).map(([key, hash]) => `<div><dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(hash)}</code></dd></div>`).join("")}</dl><p>Weltvertrags-Hash: <code>${escapeHtml(contract.contractHash)}</code></p></details><form class="world-contract-entry" data-world-contract-form aria-label="${escapeHtml(contract.name)} beitreten"><input type="hidden" name="worldId" value="${escapeHtml(contract.worldId)}"><input type="hidden" name="contractHash" value="${escapeHtml(contract.contractHash)}"><label><span>Anzeigename in dieser Welt</span><input name="displayName" minlength="1" maxlength="64" autocomplete="nickname" required></label><label class="contract-consent"><input name="confirmed" type="checkbox" value="yes" required> Ich bestätige Laufzeit, No-Wipe-Regel, Weltzeit und Startkapital dieses Weltvertrags.</label><button type="submit"${contract.entry.status !== "open" ? " disabled" : ""}>${selected ? "Weltvertrag bestätigen" : "Diesen Weltvertrag wählen"}</button></form>${contract.entry.status === "configuration-incomplete" ? '<p class="journey-message journey-message--error">Eintritt gesperrt: signierte StartingCapitalPolicy fehlt.</p>' : ""}</article>`;
  }).join("");
  return `<section class="world-contracts journey-card" aria-labelledby="world-contract-title"><div class="journey-heading"><div><p class="eyebrow">Vor dem Eintritt</p><h2 id="world-contract-title">Öffentliche Welten vergleichen</h2></div><span class="state-word">${contracts.length} Weltverträge</span></div><p>Kosten, Laufzeit und Release-Stände bleiben getrennt sichtbar; es gibt bewusst keinen Gesamtscore.</p><div class="world-contract-grid">${cards}</div></section>`;
}

const ARCHIVED_CONTRACT_MESSAGES = new Set([
  "cooperation.contract-rejected",
  "cooperation.contract-terminated",
  "cooperation.contract-non-performance",
  "cooperation.contract-completed",
  "cooperation.contract-expired",
]);
const ARCHIVED_LISTING_MESSAGES = new Set([
  "vehicle-market.transferred",
  "vehicle-market.reversed",
]);

function journeyDestination(message: MailboxMessageView): URLSearchParams {
  return new URLSearchParams({ view: "journey", world: message.worldId });
}

function mailboxDestination(message: MailboxMessageView): string {
  const contractId = typeof message.payload["contractId"] === "string" ? message.payload["contractId"] : undefined;
  const listingId = typeof message.payload["listingId"] === "string" ? message.payload["listingId"] : undefined;
  const trainId = typeof message.payload["trainId"] === "string" ? message.payload["trainId"] : undefined;
  if (message.messageType.includes("contract") || message.messageType.includes("cooperation")) {
    const query = journeyDestination(message);
    query.set("contractView", ARCHIVED_CONTRACT_MESSAGES.has(message.messageType) ? "archive" : "actionable");
    return `?${query.toString()}#${contractId === undefined ? "cooperation-contracts" : `contract-${encodeURIComponent(contractId)}`}`;
  }
  if (message.messageType.includes("vehicle") || message.messageType.includes("market")) {
    const query = journeyDestination(message);
    query.set("listingView", ARCHIVED_LISTING_MESSAGES.has(message.messageType) ? "archive" : "actionable");
    return `?${query.toString()}#${listingId === undefined ? "vehicle-market" : `listing-${encodeURIComponent(listingId)}`}`;
  }
  if (message.messageType.includes("path") || message.messageType.includes("planning")) {
    const query = new URLSearchParams({ view: "diagram", world: message.worldId });
    if (trainId !== undefined) query.set("train", trainId);
    return `?${query.toString()}#diagram-card`;
  }
  return "#postfach";
}

function mailboxTitle(message: MailboxMessageView): string {
  const payloadTitle = message.payload["title"] ?? message.payload["summary"] ?? message.payload["reason"];
  if (typeof payloadTitle === "string" && payloadTitle.trim() !== "") return payloadTitle;
  const labels: Readonly<Record<string, string>> = {
    "cooperation.contract-offer": "Neues Kooperationsangebot",
    "cooperation.contract-offered": "Neues Kooperationsangebot",
    "cooperation.contract-accepted": "Kooperationsangebot angenommen",
    "cooperation.contract-rejected": "Kooperationsangebot abgelehnt",
    "cooperation.contract-termination-scheduled": "Kündigung vorgemerkt",
    "cooperation.contract-terminated": "Kooperationsvertrag beendet",
    "cooperation.contract-non-performance": "Nichterfüllung gemeldet",
    "cooperation.contract-completed": "Kooperationsvertrag erfüllt",
    "cooperation.contract-expired": "Kooperationsangebot abgelaufen",
    "vehicle-market.reserved": "Fahrzeugangebot reserviert",
    "vehicle-market.transferred": "Fahrzeug übergeben",
    "vehicle-market.reversed": "Fahrzeugübertragung rückabgewickelt",
  };
  return labels[message.messageType] ?? message.messageType.replaceAll(/[._-]+/g, " ");
}

function attentionRail(messages: readonly MailboxMessageView[] | undefined): string {
  const sorted = messages ?? [];
  const open = sorted.filter((message) => message.acknowledgedAt === null);
  const items = sorted.slice(0, 8).map((message) => {
    const deadlineAt = message.deadlineAt === null ? undefined : new Date(message.deadlineAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
    const deadline = deadlineAt === undefined ? "ohne Frist" : message.overdue ? `Überfällig seit ${deadlineAt}` : `Frist ${deadlineAt}`;
    const stateWord = message.priority === "overdue" ? "Überfällig"
      : message.priority === "due-soon" ? "Bald fällig"
        : message.priority === "acknowledged" ? "Quittiert"
          : message.priority === "information" ? "Information" : "Handlungsbedarf";
    return `<li class="attention-item ${message.acknowledgedAt === null ? "is-open" : "is-read"}" data-priority="${message.priority}"><div><span class="state-word">${stateWord}</span><strong>${escapeHtml(mailboxTitle(message))}</strong><small>${escapeHtml(deadline)}</small></div><div class="attention-actions"><a href="${escapeHtml(mailboxDestination(message))}">Öffnen</a>${message.acknowledgedAt === null ? `<button type="button" class="secondary" data-mailbox-ack="${escapeHtml(message.id)}">Quittieren</button>` : ""}</div></li>`;
  }).join("");
  return `<section id="postfach" class="attention-rail journey-card" aria-labelledby="attention-title"><div class="journey-heading"><div><p class="eyebrow">Aufmerksamkeit</p><h2 id="attention-title">Fristen, Meldungen und Antworten</h2></div><span class="state-word">${open.length} offen</span></div>${items === "" ? `<p class="m12-empty">Keine offenen Nachrichten. Neue Fristen und Entscheidungen erscheinen hier direkt an der Live-Lage.</p>` : `<ol>${items}</ol>`}</section>`;
}

export function renderJourney(state: JourneyViewState): string {
  const inTutorial = state.tutorial !== undefined;
  const busyScope = state.busy ? (state.busyScope ?? "initial") : undefined;
  const disableButtons = (html: string): string => html.replace(/<button(?![^>]*\bdisabled\b)/g, '<button disabled aria-disabled="true"');
  const livemap = state.livemapUrl === undefined || state.livemapUrl === "" ? "" : `<a class="primary-map-link" href="${escapeHtml(state.livemapUrl)}">Zur Live-Lage</a>`;
  const message = state.message === "" ? "" : `<p class="journey-message journey-message--${state.messageTone ?? "status"}" role="${state.messageTone === "error" ? "alert" : "status"}" aria-live="polite"${state.messageTone === "error" ? ' tabindex="-1"' : ""}>${escapeHtml(state.message)}</p>`;
  const cooperation = inTutorial || state.cooperation === undefined ? "" : renderCooperationSurface(state.cooperation);
  const tutorialContent = busyScope === "tutorial" ? disableButtons(tutorial(state)) : tutorial(state);
  const mailboxContent = inTutorial ? "" : busyScope === "mailbox" ? disableButtons(attentionRail(state.mailbox)) : attentionRail(state.mailbox);
  const confirmation = state.confirmation === undefined ? "" : `<dialog id="journey-confirmation" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-detail"><form method="dialog"><p class="eyebrow">Verbindliche Entscheidung</p><h2 id="confirmation-title">${escapeHtml(state.confirmation.title)}</h2><p id="confirmation-detail">${escapeHtml(state.confirmation.detail)}</p><div class="journey-actions"><button id="confirmation-submit" value="confirm" type="submit">Verbindlich bestätigen</button><button id="confirmation-cancel" value="cancel" class="secondary" type="submit" autofocus>Abbrechen</button></div></form></dialog>`;
  const recoveryLabel = state.bootRecovery === "authenticate" ? "Anmeldung neu beginnen"
    : state.bootRecovery === "configure" ? "Konfiguration erneut prüfen" : "Erneut versuchen";
  const recovery = state.bootRecovery === undefined ? "" : `<p class="journey-recovery"><button id="journey-retry" type="button">${recoveryLabel}</button></p>`;
  const world = encodeURIComponent(state.publicWorldId);
  const html = `<main class="journey-shell" aria-busy="${state.busy}"><header class="journey-top"><div><p class="wordmark">ZUGFOLGE</p><h1>Geschlossene Alpha · Spielerreise</h1></div><nav aria-label="Hauptnavigation">${livemap}<a href="#world-contract-title">Welt und Einstieg</a><a href="#vehicle-market">Märkte</a><a href="?view=diagram&world=${world}#diagram-card">Betrieb</a><a href="#postfach">Postfach</a></nav></header>${message}${recovery}${inTutorial ? "" : worldContracts(state)}${mailboxContent}<div class="${inTutorial ? "tutorial-shell" : "journey-grid"}">${tutorialContent}${inTutorial ? "" : onboarding(state)}</div>${cooperation}${confirmation}</main>`;
  return busyScope === "initial" ? disableButtons(html) : html;
}
