import type { MailboxMessageView, PublicWorldContractView } from "./api.js";
import {
  formatAvailableFinance,
  formatEuroCents,
  type PlayerOperatorContextV1,
} from "@zugfolge/player-context";
import { renderCooperationSurface, type CooperationSurfaceState } from "./cooperation.js";
import type { JourneySection } from "./navigation.js";

export interface JourneyViewState {
  readonly publicWorldId: string;
  readonly busy: boolean;
  readonly busyScope?: "initial" | "cooperation" | "mailbox";
  readonly message: string;
  readonly messageTone?: "status" | "error";
  readonly livemapUrl?: string;
  readonly operationsCenterUrl?: string;
  readonly cooperation?: CooperationSurfaceState;
  readonly mailbox?: readonly MailboxMessageView[];
  readonly worldContracts?: readonly PublicWorldContractView[];
  /** Serverseitig geladene EVU-Zuordnung fuer die ausgewaehlte Welt. */
  readonly hasActiveOperator?: boolean;
  readonly confirmation?: { readonly title: string; readonly detail: string };
  readonly bootRecovery?: "authenticate" | "configure" | "retry";
  readonly activeSection?: JourneySection;
  readonly activeOperatorId?: string;
  readonly operatorContext?: PlayerOperatorContextV1;
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

function worldContracts(state: JourneyViewState): string {
  const contract = state.worldContracts?.find((candidate) => candidate.worldId === state.publicWorldId);
  if (contract === undefined) return "";
  const duration = contract.duration.kind === "unlimited"
    ? "Unbefristete Welt"
    : `${contract.duration.periodCount} Fahrplanperioden à ${contract.schedulePeriodWeeks} Wochen`;
  const startCapital = contract.startingCapitalPolicy === null ? "Konfiguration unvollständig"
    : contract.startingCapitalPolicy.kind === "unlimited" ? "Unbegrenztes Startkapital"
      : euros(contract.startingCapitalPolicy.amountCents);
  const joined = state.hasActiveOperator === true;
  const date = (instant: string): string => new Date(instant).toLocaleString("de-DE", { timeZone: contract.timeBasis.timeZone, dateStyle: "medium", timeStyle: "short" });
  const entryWindow = contract.entry.status === "scheduled"
    ? `öffnet am ${date(contract.entry.opensAt)}`
    : contract.entry.closesAt === null
      ? `offen seit ${date(contract.entry.opensAt)}, ohne festes Ende`
      : `${date(contract.entry.opensAt)} bis ${date(contract.entry.closesAt)}`;
  const entry = joined
    ? '<p class="journey-message journey-message--status" data-world-contract-confirmed>Weltvertrag bestätigt · Ihr EVU ist in dieser Welt aktiv.</p>'
    : `<form class="world-contract-entry" data-world-contract-form aria-label="${escapeHtml(contract.name)} beitreten"><input type="hidden" name="worldId" value="${escapeHtml(contract.worldId)}"><input type="hidden" name="contractHash" value="${escapeHtml(contract.contractHash)}"><label><span>Anzeigename in dieser Welt</span><input name="displayName" minlength="1" maxlength="64" autocomplete="nickname" required></label><label class="contract-consent"><input name="confirmed" type="checkbox" value="yes" required> Ich bestätige Laufzeit, No-Wipe-Regel, Weltzeit und Startkapital dieses Weltvertrags.</label><button type="submit"${contract.entry.status !== "open" ? " disabled" : ""}>Weltvertrag bestätigen</button></form>`;
  const card = `<article class="world-contract-card" aria-labelledby="world-contract-${escapeHtml(contract.worldId)}"><div class="m12-item-head"><div><p class="eyebrow">Weltvertrag · ${escapeHtml(contract.region.name)} · Variante ${escapeHtml(contract.region.variant)}</p><h3 id="world-contract-${escapeHtml(contract.worldId)}">${escapeHtml(contract.name)}</h3></div><span class="state-word">${joined ? "Bestätigt" : "Weltvertrag"}</span></div><dl><div><dt>Laufzeit</dt><dd>${escapeHtml(duration)}</dd></div><div><dt>Bestand</dt><dd>Dauerhaft, keine Wipes</dd></div><div><dt>Weltzeit</dt><dd>1:1 Echtzeit ab ${escapeHtml(date(contract.timeBasis.epoch))} · ${escapeHtml(contract.timeBasis.timeZone)}</dd></div><div><dt>Eintrittsfenster</dt><dd>${escapeHtml(entryWindow)}</dd></div><div><dt>Fahrplanperiode</dt><dd>${contract.schedulePeriodWeeks} Wochen</dd></div><div><dt>Startkapital</dt><dd>${escapeHtml(startCapital)}</dd></div></dl><details><summary>Signierte Release-Stände und technische Details</summary><p>Regionskennung: <code>${escapeHtml(contract.region.id)}</code></p><dl class="release-pins">${Object.entries(contract.releases).map(([key, hash]) => `<div><dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(hash)}</code></dd></div>`).join("")}</dl><p>Weltvertrags-Hash: <code>${escapeHtml(contract.contractHash)}</code></p></details>${entry}${contract.entry.status === "configuration-incomplete" ? '<p class="journey-message journey-message--error">Eintritt gesperrt: signierte StartingCapitalPolicy fehlt.</p>' : ""}</article>`;
  const eyebrow = joined ? "Weltstatus" : "Vor dem Eintritt";
  const title = joined ? "Aktive Welt" : "Weltvertrag prüfen";
  const introduction = joined
    ? "Der bestätigte Weltvertrag und seine unveränderlichen Release-Stände bleiben jederzeit nachvollziehbar."
    : "Prüfen Sie die Bedingungen für Ihren Einstieg in diese Welt.";
  return `<section class="world-contracts journey-card" aria-labelledby="world-contract-title"><div class="journey-heading"><div><p class="eyebrow">${eyebrow}</p><h2 id="world-contract-title">${title}</h2></div></div><p>${introduction}</p><div class="world-contract-grid">${card}</div></section>`;
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

function journeyUrl(state: JourneyViewState, section: JourneySection): string {
  const query = new URLSearchParams({ view: "journey", world: state.publicWorldId, section });
  if (state.activeOperatorId !== undefined && state.activeOperatorId !== "") query.set("operator", state.activeOperatorId);
  return `?${query.toString()}`;
}

function plannerUrl(state: JourneyViewState): string {
  const query = new URLSearchParams({ view: "diagram", world: state.publicWorldId });
  if (state.activeOperatorId !== undefined && state.activeOperatorId !== "") query.set("operator", state.activeOperatorId);
  return `?${query.toString()}`;
}

function livemapDestination(state: JourneyViewState): string {
  if (state.livemapUrl === undefined || state.livemapUrl === "") return journeyUrl(state, "world");
  const destination = new URL(state.livemapUrl);
  destination.searchParams.set("world", state.publicWorldId);
  if (state.activeOperatorId !== undefined && state.activeOperatorId !== "") {
    destination.searchParams.set("operator", state.activeOperatorId);
  }
  return destination.href;
}

function operationsDestination(state: JourneyViewState): string {
  if (state.operationsCenterUrl === undefined || state.operationsCenterUrl === "" || state.activeOperatorId === undefined || state.activeOperatorId === "") {
    return journeyUrl(state, "operations");
  }
  const destination = new URL(state.operationsCenterUrl);
  destination.searchParams.set("world", state.publicWorldId);
  destination.searchParams.set("operator", state.activeOperatorId);
  destination.searchParams.set("panel", "operations");
  return destination.href;
}

function shellOperator(state: JourneyViewState) {
  return state.operatorContext?.operators.find((operator) => operator.id === state.activeOperatorId)
    ?? state.operatorContext?.operators[0];
}

function companySurface(state: JourneyViewState): string {
  const operator = shellOperator(state);
  if (state.operatorContext === undefined) {
    return `<section class="journey-card company-overview" id="unternehmen" aria-busy="true"><p class="eyebrow">EVU</p><h2>Unternehmensdaten werden geladen</h2><p>Es wird kein Nullsaldo angenommen, solange die autoritative Finanzprojektion fehlt.</p></section>`;
  }
  if (operator === undefined) {
    return `<section class="journey-card company-overview" id="unternehmen"><p class="eyebrow">EVU</p><h2>Noch kein Unternehmen</h2><p>Nach der EVU-Gründung erscheinen hier Liquidität, Bestand und Verträge.</p><a class="button-link" href="${escapeHtml(journeyUrl(state, "world"))}#evu-gruenden">EVU gründen</a></section>`;
  }
  const finance = operator.finance;
  const financeRows = finance.mode === "unlimited"
    ? `<div><dt>Finanzierungsmodus</dt><dd>Unbegrenzt</dd></div><div><dt>Verfügbar</dt><dd>Unbegrenzt</dd></div>`
    : `<div><dt>Kontostand</dt><dd>${escapeHtml(formatEuroCents(finance.ledgerBalanceCents))}</dd></div><div><dt>Vorgemerkte Belastungen</dt><dd>${finance.pendingDebitCents === "0" ? "Keine" : `− ${escapeHtml(formatEuroCents(finance.pendingDebitCents))}`}</dd></div><div class="company-balance-total"><dt>Verfügbar</dt><dd>${escapeHtml(formatEuroCents(finance.availableCents))}</dd></div>`;
  const contracts = state.cooperation?.contracts.length ?? 0;
  const vehicles = state.cooperation?.ownedVehicles.length ?? 0;
  return `<section class="journey-card company-overview" id="unternehmen" aria-labelledby="company-title"><div class="journey-heading"><div><p class="eyebrow">UNTERNEHMEN</p><h2 id="company-title">${escapeHtml(operator.name)}</h2></div><span class="state-word">aktive Welt</span></div><div class="company-grid"><article class="company-finance"><p class="eyebrow">LIQUIDITÄT</p><strong class="company-balance">${escapeHtml(formatAvailableFinance(finance))}</strong><dl>${financeRows}</dl><p>„Verfügbar“ berücksichtigt bereits vorgemerkte, noch nicht im Kontostand verbuchte Belastungen.</p></article><article><p class="eyebrow">BESTAND</p><dl><div><dt>Eigene Fahrzeuge</dt><dd>${vehicles}</dd></div><div><dt>Laufende und offene Verträge</dt><dd>${contracts}</dd></div></dl><p>Flotte, Personal, Kredite, Ergebnis und Archiv werden hier als Unterbereiche ausgebaut, ohne neue Hauptnavigation.</p></article></div></section>`;
}

function workspaceHeading(section: JourneySection): { readonly eyebrow: string; readonly title: string; readonly description: string } {
  switch (section) {
    case "world": return { eyebrow: "WELTKONTEXT", title: "Welt und Einstieg", description: "Weltvertrag und EVU-Gründung – im täglichen Betrieb bleibt dieser Bereich im Hintergrund." };
    case "operations": return { eyebrow: "BETRIEB", title: "Fahrten und Ressourcen", description: "Operative Aufträge in einer kompakten Arbeitsfläche; Störungen, Regeln und Berichte werden hier zusammengeführt." };
    case "markets": return { eyebrow: "MÄRKTE", title: "Ausschreibungen, Verträge und Fahrzeuge", description: "Vergleichen, auswählen und erst im Detail verbindlich handeln." };
    case "company": return { eyebrow: "EVU", title: "Unternehmen und Finanzen", description: "Liquidität, Bestand und Unternehmensentwicklung ohne Vermischung mit dem Benutzerkonto." };
    case "mailbox": return { eyebrow: "AUFMERKSAMKEIT", title: "Aufgaben und Postfach", description: "Fristen und Entscheidungen nach Dringlichkeit, jeweils direkt mit ihrem Fachobjekt verknüpft." };
  }
}

function playerShell(state: JourneyViewState, content: string, message: string, recovery: string, confirmation: string): string {
  const section = state.activeSection ?? "world";
  const heading = workspaceHeading(section);
  const operator = shellOperator(state);
  const worldName = state.worldContracts?.find((contract) => contract.worldId === state.publicWorldId)?.name ?? "Ausgewählte Welt";
  const openMessages = (state.mailbox ?? []).filter((entry) => entry.acknowledgedAt === null).length;
  const finance = operator === undefined ? "—" : formatAvailableFinance(operator.finance);
  const operatorOptions = state.operatorContext?.operators.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === operator?.id ? " selected" : ""}>${escapeHtml(entry.name)}</option>`).join("") ?? "";
  const active = (target: JourneySection): string => section === target ? ' aria-current="page"' : "";
  const livemap = state.livemapUrl === undefined || state.livemapUrl === "" ? "" : `<a class="shell-nav__item" href="${escapeHtml(livemapDestination(state))}"><span aria-hidden="true">◎</span><span>Lage</span></a>`;
  const operatorDetail = operator === undefined
    ? `<p>In dieser Welt ist noch kein eigenes EVU aktiv.</p><a href="${escapeHtml(journeyUrl(state, "world"))}#evu-gruenden">EVU gründen</a>`
    : `<label${(state.operatorContext?.operators.length ?? 0) < 2 ? ' class="single-operator"' : ""}><span>Handelndes EVU</span><select id="journey-operator"${(state.operatorContext?.operators.length ?? 0) < 2 ? " disabled" : ""}>${operatorOptions}</select></label>${operator.finance.mode === "unlimited" ? '<p>Liquidität ist laut Weltvertrag unbegrenzt.</p>' : `<dl><div><dt>Kontostand</dt><dd>${escapeHtml(formatEuroCents(operator.finance.ledgerBalanceCents))}</dd></div><div><dt>Vorgemerkt</dt><dd>${operator.finance.pendingDebitCents === "0" ? "Keine" : `− ${escapeHtml(formatEuroCents(operator.finance.pendingDebitCents))}`}</dd></div><div><dt>Verfügbar</dt><dd>${escapeHtml(formatEuroCents(operator.finance.availableCents))}</dd></div></dl>`}<a href="${escapeHtml(journeyUrl(state, "company"))}">Finanzen öffnen</a>`;
  return `<main class="journey-shell player-shell" aria-busy="${state.busy}"><header class="player-topbar"><a class="wordmark" href="${escapeHtml(livemapDestination(state))}">ZUGFOLGE</a><a class="shell-world" href="${escapeHtml(journeyUrl(state, "world"))}"><span class="eyebrow">WELT</span><strong>${escapeHtml(worldName)}</strong></a><details class="shell-operator"><summary><span><span class="eyebrow">EVU</span><strong>${escapeHtml(operator?.name ?? (state.operatorContext === undefined ? "wird geladen" : "Kein EVU"))}</strong></span><span class="shell-balance"><span class="eyebrow">VERFÜGBAR</span><strong>${escapeHtml(finance)}</strong></span></summary><div class="shell-operator__popover">${operatorDetail}</div></details><a class="shell-mailbox" href="${escapeHtml(journeyUrl(state, "mailbox"))}"${active("mailbox")}><span>Aufgaben</span><strong>${openMessages}</strong></a></header><div class="player-layout"><nav class="shell-nav" aria-label="Hauptnavigation">${livemap}<a class="shell-nav__item" href="${escapeHtml(plannerUrl(state))}"><span aria-hidden="true">⌁</span><span>Planung</span></a><a class="shell-nav__item" href="${escapeHtml(operationsDestination(state))}"${active("operations")}><span aria-hidden="true">↯</span><span>Betrieb</span></a><a class="shell-nav__item" href="${escapeHtml(journeyUrl(state, "markets"))}"${active("markets")}><span aria-hidden="true">⇄</span><span>Märkte</span></a><a class="shell-nav__item" href="${escapeHtml(journeyUrl(state, "company"))}"${active("company")}><span aria-hidden="true">▦</span><span>EVU</span></a></nav><section class="player-workspace" aria-labelledby="workspace-title"><header class="workspace-heading"><div><p class="eyebrow">${heading.eyebrow}</p><h1 id="workspace-title">${heading.title}</h1><p>${heading.description}</p></div><span class="alpha-badge">ALPHA</span></header>${message}${recovery}<div class="workspace-scroll" data-scroll-region>${content}</div></section></div>${confirmation}</main>`;
}

export function renderJourney(state: JourneyViewState): string {
  const busyScope = state.busy ? (state.busyScope ?? "initial") : undefined;
  const disableButtons = (html: string): string => html.replace(/<button(?![^>]*\bdisabled\b)/g, '<button disabled aria-disabled="true"');
  const livemap = state.livemapUrl === undefined || state.livemapUrl === "" ? "" : `<a class="primary-map-link" href="${escapeHtml(state.livemapUrl)}">Zur Live-Lage</a>`;
  const message = state.message === "" ? "" : `<p class="journey-message journey-message--${state.messageTone ?? "status"}" role="${state.messageTone === "error" ? "alert" : "status"}" aria-live="polite"${state.messageTone === "error" ? ' tabindex="-1"' : ""}>${escapeHtml(state.message)}</p>`;
  const cooperation = state.cooperation === undefined ? "" : renderCooperationSurface(state.cooperation);
  const mailboxContent = busyScope === "mailbox" ? disableButtons(attentionRail(state.mailbox)) : attentionRail(state.mailbox);
  const confirmation = state.confirmation === undefined ? "" : `<dialog id="journey-confirmation" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-detail"><form method="dialog"><p class="eyebrow">Verbindliche Entscheidung</p><h2 id="confirmation-title">${escapeHtml(state.confirmation.title)}</h2><p id="confirmation-detail">${escapeHtml(state.confirmation.detail)}</p><div class="journey-actions"><button id="confirmation-submit" value="confirm" type="submit">Verbindlich bestätigen</button><button id="confirmation-cancel" value="cancel" class="secondary" type="submit" autofocus>Abbrechen</button></div></form></dialog>`;
  const recoveryLabel = state.bootRecovery === "configure" ? "Konfiguration erneut prüfen" : "Erneut versuchen";
  const recovery = state.bootRecovery === undefined ? "" : `<p class="journey-recovery"><button id="journey-retry" type="button">${recoveryLabel}</button></p>`;
  const world = encodeURIComponent(state.publicWorldId);
  if (state.activeSection !== undefined) {
    const sectionContent = state.activeSection === "world"
      ? `${worldContracts(state)}${state.cooperation?.activeOperatorId === "" ? cooperation : ""}`
      : state.activeSection === "mailbox" ? mailboxContent
        : state.activeSection === "company" ? companySurface(state)
          : cooperation;
    const shell = playerShell(state, sectionContent, message, recovery, confirmation);
    return busyScope === "initial" ? disableButtons(shell) : shell;
  }
  const html = `<main class="journey-shell" aria-busy="${state.busy}"><header class="journey-top"><div><p class="wordmark">ZUGFOLGE</p><h1>Geschlossene Alpha · Spielerreise</h1></div><nav aria-label="Hauptnavigation">${livemap}<a href="#world-contract-title">Welt und Einstieg</a><a href="#vehicle-market">Märkte</a><a href="?view=diagram&world=${world}#diagram-card">Betrieb</a><a href="#postfach">Postfach</a></nav></header>${message}${recovery}${worldContracts(state)}${mailboxContent}${cooperation}${confirmation}</main>`;
  return busyScope === "initial" ? disableButtons(html) : html;
}
