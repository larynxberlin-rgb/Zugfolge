import { railwayBrand, railwayNavigation, railwayTabs, icon } from "@zugfolge/design-system";
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
  readonly entryConfirmed?: boolean;
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
  const joined = state.hasActiveOperator === true;
  const accepted = joined || state.entryConfirmed === true;
  const duration = contract.duration.kind === "unlimited" ? "Ohne festes Ende" : `${contract.duration.periodCount} Fahrplanperioden à ${contract.schedulePeriodWeeks} Wochen`;
  const capital = contract.startingCapitalPolicy === null ? "Wird noch vorbereitet" : contract.startingCapitalPolicy.kind === "unlimited" ? "Unbegrenzt" : euros(contract.startingCapitalPolicy.amountCents);
  const date = (instant: string): string => new Date(instant).toLocaleString("de-DE", { timeZone: contract.timeBasis.timeZone, dateStyle: "medium", timeStyle: "short" });
  const entryWindow = contract.entry.status === "scheduled" ? `öffnet am ${date(contract.entry.opensAt)}` : contract.entry.closesAt === null ? "Jederzeit einsteigen" : `Einstieg bis ${date(contract.entry.closesAt)}`;
  const conditions = `<details class="world-rules"><summary>Spielregeln & Laufzeit</summary><dl><div><dt>Laufzeit</dt><dd>${escapeHtml(duration)}</dd></div><div><dt>Dein Fortschritt</dt><dd>Bleibt erhalten – keine Neustarts der Welt</dd></div><div><dt>Spielzeit</dt><dd>1:1 Echtzeit ab ${escapeHtml(date(contract.timeBasis.epoch))} · ${escapeHtml(contract.timeBasis.timeZone)}</dd></div><div><dt>Einstieg</dt><dd>${escapeHtml(entryWindow)}</dd></div><div><dt>Fahrplanperiode</dt><dd>${contract.schedulePeriodWeeks} Wochen</dd></div></dl><details><summary>Versionsnachweise</summary><p>Kartengebiet: ${escapeHtml(contract.region.name)}</p><p>Spielstand-Kennung: <code>${escapeHtml(contract.contractHash)}</code></p><dl class="release-pins">${Object.entries(contract.releases).map(([key, hash]) => `<div><dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(hash)}</code></dd></div>`).join("")}</dl></details></details>`;
  const entry = accepted ? `<p class="journey-message journey-message--status" data-world-contract-confirmed>${icon("check")}${joined ? "Dein Unternehmen ist in dieser Welt aktiv." : "Du bist dabei. Jetzt kann deine Bahn an den Start gehen."}</p>${joined ? `<a class="rail-primary" href="${escapeHtml(livemapDestination(state))}">Zur LiveMap ${icon("chevron")}</a>` : ""}` : `<form class="world-contract-entry" data-world-contract-form aria-label="${escapeHtml(contract.name)} beitreten"><input type="hidden" name="worldId" value="${escapeHtml(contract.worldId)}"><input type="hidden" name="contractHash" value="${escapeHtml(contract.contractHash)}"><label><span>Dein Spielername</span><input name="displayName" minlength="1" maxlength="64" autocomplete="nickname" placeholder="So sehen dich andere Spieler" required></label><label class="contract-consent"><input name="confirmed" type="checkbox" value="yes" required> Ich habe Laufzeit, Spielzeit und Startkapital gelesen. Mein Fortschritt bleibt in dieser Welt erhalten.</label><button type="submit"${contract.entry.status !== "open" ? " disabled" : ""}>Spiel starten ${icon("chevron")}</button></form>`;
  return `<section class="world-contracts journey-card" aria-labelledby="world-contract-title"><div class="journey-heading"><div><p class="eyebrow">${accepted ? "DEINE SPIELWELT" : "01 · ANKOMMEN"}</p><h2 id="world-contract-title">${joined ? "Deine Welt" : accepted ? "Willkommen an Bord." : "Dein Einstieg"}</h2></div><span class="state-word">${accepted ? "Bereit" : "Deutschland"}</span></div><h3 class="world-name">${escapeHtml(contract.name)}</h3><div class="entry-capital"><span>Dein Startkapital</span><strong>${escapeHtml(capital)}</strong><small>Für den Aufbau deines Unternehmens</small></div>${conditions}${entry}${contract.entry.status === "configuration-incomplete" ? '<p class="journey-message journey-message--error">Der Einstieg wird noch vorbereitet. Das Startkapital steht noch nicht fest.</p>' : contract.entry.status === "scheduled" ? `<p class="journey-message">Der Einstieg ${escapeHtml(entryWindow)}.</p>` : ""}</section>`;
}

function worldSurface(state: JourneyViewState, cooperation: string): string {
  const active = state.hasActiveOperator === true;
  const found = !active && (state.entryConfirmed === true || !state.worldContracts?.length);
  return `<div class="entry-layout"><section class="entry-hero"><div class="entry-hero__copy"><p class="eyebrow">DAS GANZE LAND IST DEIN SPIELFELD</p><h2>${active ? "Deine Bahn.<br>Ein ganzes Land." : "Nächster Halt:<br>dein Unternehmen."}</h2><p>Verbinde Städte. Bewege Menschen.<br>Schreib deine eigene Bahngeschichte.</p></div><div class="entry-route" aria-hidden="true"><span>Hamburg</span><i></i><span>Berlin</span><i></i><span>Frankfurt</span><i></i><span>München</span></div><div class="entry-hero__foot"><span>${icon("clock")} In Echtzeit</span><span>${icon("map")} Deutschlandweit</span><span>${icon("route")} Deine Verbindungen</span></div></section><div class="entry-workspace"><ol class="entry-steps" aria-label="Dein Einstieg"><li class="${!found && !active ? "is-current" : "is-done"}"><b>01</b> Ankommen</li><li class="${found ? "is-current" : active ? "is-done" : ""}"><b>02</b> Bahn gründen</li><li class="${active ? "is-current" : ""}"><b>03</b> Losfahren</li></ol>${found ? cooperation : worldContracts(state)}${found ? `<details class="entry-world-info"><summary>Startkapital & Spielregeln nachlesen</summary>${worldContracts(state)}</details>` : ""}<a class="entry-map-link" href="${escapeHtml(livemapDestination(state))}">${icon("map")} Die LiveMap erkunden ${icon("chevron")}</a></div></div>`;
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
        : message.priority === "acknowledged" ? "Gelesen"
          : message.priority === "information" ? "Information" : "Handlungsbedarf";
    return `<li class="attention-item ${message.acknowledgedAt === null ? "is-open" : "is-read"}" data-priority="${message.priority}"><div><span class="state-word">${stateWord}</span><strong>${escapeHtml(mailboxTitle(message))}</strong><small>${escapeHtml(deadline)}</small></div><div class="attention-actions"><a href="${escapeHtml(mailboxDestination(message))}">Öffnen</a>${message.acknowledgedAt === null ? `<button type="button" class="secondary" data-mailbox-ack="${escapeHtml(message.id)}">Als gelesen markieren</button>` : ""}</div></li>`;
  }).join("");
  return `<section id="postfach" class="attention-rail journey-card" aria-labelledby="attention-title"><div class="journey-heading"><div><p class="eyebrow">DEIN POSTFACH</p><h2 id="attention-title">Das steht als Nächstes an</h2></div><span class="state-word">${open.length} offen</span></div>${items === "" ? `<p class="m12-empty">Alles erledigt. Neue Angebote und Nachrichten findest du hier.</p>` : `<ol>${items}</ol>`}</section>`;
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
  if (state.operatorContext === undefined) return `<section class="journey-card company-overview" id="unternehmen" aria-busy="true"><p class="eyebrow">DEIN UNTERNEHMEN</p><h2>Deine Bahn wird geladen …</h2><p>Kontostand und Fahrzeuge sind gleich da.</p></section>`;
  if (operator === undefined) return `<section class="journey-card company-overview" id="unternehmen"><p class="eyebrow">DEIN START</p><h2>Hier beginnt deine Bahngeschichte.</h2><p>Gib deinem Unternehmen einen Namen und bring deine ersten Züge auf die Schiene.</p><a class="rail-primary" href="${escapeHtml(journeyUrl(state, "world"))}">Unternehmen gründen ${icon("chevron")}</a></section>`;
  const finance = operator.finance;
  const financeRows = finance.mode === "unlimited" ? `<div><dt>Finanzierung</dt><dd>Unbegrenzt</dd></div><div><dt>Verfügbar</dt><dd>Unbegrenzt</dd></div>` : `<div><dt>Kontostand</dt><dd>${escapeHtml(formatEuroCents(finance.ledgerBalanceCents))}</dd></div><div><dt>Vorgemerkte Belastungen</dt><dd>${finance.pendingDebitCents === "0" ? "Keine" : `− ${escapeHtml(formatEuroCents(finance.pendingDebitCents))}`}</dd></div><div class="company-balance-total"><dt>Verfügbar</dt><dd>${escapeHtml(formatEuroCents(finance.availableCents))}</dd></div>`;
  const vehicles = state.cooperation?.ownedVehicles;
  const contracts = state.cooperation?.contracts;
  const fleet = vehicles === undefined ? '<p class="m12-empty">Deine Flotte wird geladen …</p>' : vehicles.length === 0 ? `<div class="fleet-empty">${icon("train")}<h3>Dein erster Zug wartet auf dich.</h3><p>Entdecke Fahrzeuge auf dem Markt oder starte mit einem Verkehrsauftrag.</p><a class="rail-primary" href="${escapeHtml(journeyUrl(state, "markets"))}#vehicle-market">Fahrzeuge entdecken</a></div>` : `<div class="fleet-table-scroll"><table class="fleet-table"><thead><tr><th>Fahrzeug</th><th>Zustand</th><th>Laufleistung</th><th>Im Blick behalten</th><th>Fahrzeugwert</th></tr></thead><tbody>${vehicles.map((vehicle) => `<tr><td><span class="fleet-train-icon">${icon("train")}</span><strong>${escapeHtml(vehicle.classDesignation)}</strong><small>${escapeHtml(vehicle.vehicleId)}</small></td><td><meter min="0" max="10000" value="${vehicle.conditionBasisPoints}" aria-label="Fahrzeugzustand"></meter> ${Math.round(vehicle.conditionBasisPoints / 100)} %</td><td>${(BigInt(vehicle.odometerMetres) / 1000n).toLocaleString("de-DE")} km</td><td>${vehicle.damages.length > 0 ? `${vehicle.damages.length} Schadenhinweise` : "Keine Schäden"} · ${vehicle.maintenanceDeadlines.length} Wartungsfristen</td><td>${escapeHtml(formatEuroCents(vehicle.valueCents))}</td></tr>`).join("")}</tbody></table></div>`;
  return `<section class="company-overview" id="unternehmen"><div class="company-banner"><div><p class="eyebrow">DEINE BAHN IN DEUTSCHLAND</p><h2>${escapeHtml(operator.name)}</h2><p>Deine nächsten Verbindungen beginnen hier.</p></div><a class="rail-primary" href="${escapeHtml(journeyUrl(state, "operations"))}">Fahrt planen ${icon("chevron")}</a></div><div class="company-metrics"><article><span>Verfügbares Geld</span><strong>${escapeHtml(formatAvailableFinance(finance))}</strong><small>Vormerkungen bereits berücksichtigt</small></article><article><span>Deine Flotte</span><strong>${vehicles?.length ?? "—"}<small> Fahrzeuge</small></strong><small>Eigener Fahrzeugbestand</small></article><article><span>Verträge in dieser Ansicht</span><strong>${contracts?.length ?? "—"}</strong><small>Laufende Vorgänge & Angebote</small></article></div>${railwayTabs([{id:"company-finances",label:"Finanzen"},{id:"company-fleet",label:"Deine Flotte"}])}<section id="company-finances" class="company-grid"><article class="company-finance"><p class="eyebrow">DEIN FINANZIELLER SPIELRAUM</p><strong class="company-balance">${escapeHtml(formatAvailableFinance(finance))}</strong><dl>${financeRows}</dl><p>Mit dem verfügbaren Betrag kannst du planen. Vorgemerkte Ausgaben sind bereits abgezogen.</p></article><article class="company-actions"><p class="eyebrow">WAS HAST DU VOR?</p><a href="${escapeHtml(journeyUrl(state, "markets"))}#ausschreibungen">${icon("route")}<span><strong>Neue Aufträge finden</strong><small>Bewirb dich auf Verkehrsleistungen.</small></span>${icon("chevron")}</a><a href="${escapeHtml(journeyUrl(state, "markets"))}#vehicle-market">${icon("train")}<span><strong>Deine Flotte erweitern</strong><small>Vergleiche Kauf- und Mietangebote.</small></span>${icon("chevron")}</a><a href="${escapeHtml(operationsDestination(state))}">${icon("layers")}<span><strong>Den Betrieb steuern</strong><small>Behalte Entscheidungen im Blick.</small></span>${icon("chevron")}</a></article></section><section id="company-fleet" class="journey-card" hidden>${fleet}</section></section>`;
}

function workspaceHeading(section: JourneySection): { readonly eyebrow: string; readonly title: string; readonly description: string } {
  switch (section) {
    case "world": return { eyebrow: "WILLKOMMEN BEI ZUGFOLGE", title: "Deine Bahngeschichte beginnt hier.", description: "Ein ganzes Land wartet auf deine Verbindungen." };
    case "operations": return { eyebrow: "RAUF AUF DIE SCHIENE", title: "Deine nächsten Fahrten.", description: "Plane eine Verbindung, verschiebe einen Zug oder buche einen Werkstatttermin." };
    case "markets": return { eyebrow: "CHANCEN FÜR DEINE BAHN", title: "Mach mehr aus deinem Netz.", description: "Finde Aufträge, passende Fahrzeuge und starke Partner." };
    case "company": return { eyebrow: "DEIN UNTERNEHMEN", title: "Alles, was deine Bahn bewegt.", description: "Geld, Fahrzeuge und deine nächsten Schritte auf einen Blick." };
    case "mailbox": return { eyebrow: "GUT INFORMIERT", title: "Deine Bahn hat Post.", description: "Angebote, Fristen und Entscheidungen – das Wichtigste zuerst." };
  }
}

function playerShell(state: JourneyViewState, content: string, message: string, recovery: string, confirmation: string): string {
  const section = state.activeSection ?? "world";
  const heading = workspaceHeading(section);
  const operator = shellOperator(state);
  const worldName = state.worldContracts?.find((contract) => contract.worldId === state.publicWorldId)?.name ?? "Deutschland";
  const openMessages = (state.mailbox ?? []).filter((entry) => entry.acknowledgedAt === null).length;
  const finance = operator === undefined ? "—" : formatAvailableFinance(operator.finance);
  const operatorOptions = state.operatorContext?.operators.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === operator?.id ? " selected" : ""}>${escapeHtml(entry.name)}</option>`).join("") ?? "";
  const active = (target: JourneySection): string => section === target ? ' aria-current="page"' : "";
  const navigation = railwayNavigation([
    ...(state.livemapUrl ? [{ page: "map" as const, href: livemapDestination(state) }] : []),
    {page:"planner",href:plannerUrl(state)}, {page:"operations",href:operationsDestination(state)},
    {page:"markets",href:journeyUrl(state,"markets")}, {page:"company",href:journeyUrl(state,"company")},
  ], section === "world" ? "company" : section);

  const operatorDetail = operator === undefined
    ? `<p>Deine eigene Bahn wartet noch auf ihren Start.</p><a href="${escapeHtml(journeyUrl(state, "world"))}#evu-gruenden">Unternehmen gründen</a>`
    : `<label${(state.operatorContext?.operators.length ?? 0) < 2 ? ' class="single-operator"' : ""}><span>Dein Unternehmen</span><select id="journey-operator"${(state.operatorContext?.operators.length ?? 0) < 2 ? " disabled" : ""}>${operatorOptions}</select></label>${operator.finance.mode === "unlimited" ? '<p>In dieser Welt kannst du mit unbegrenztem Geld spielen.</p>' : `<dl><div><dt>Kontostand</dt><dd>${escapeHtml(formatEuroCents(operator.finance.ledgerBalanceCents))}</dd></div><div><dt>Vorgemerkt</dt><dd>${operator.finance.pendingDebitCents === "0" ? "Keine" : `− ${escapeHtml(formatEuroCents(operator.finance.pendingDebitCents))}`}</dd></div><div><dt>Verfügbar</dt><dd>${escapeHtml(formatEuroCents(operator.finance.availableCents))}</dd></div></dl>`}<a href="${escapeHtml(journeyUrl(state, "company"))}">Finanzen öffnen</a>`;
  return `<main class="journey-shell player-shell" aria-busy="${state.busy}"><a class="skip" href="#workspace-title">Zum Arbeitsbereich</a><header class="player-topbar">${railwayBrand(livemapDestination(state))}<a class="shell-world" href="${escapeHtml(journeyUrl(state, "world"))}"><span class="eyebrow">DEINE SPIELWELT</span><strong>${escapeHtml(worldName)}</strong></a><details class="shell-operator"><summary><span><span class="eyebrow">DEINE BAHN</span><strong>${escapeHtml(operator?.name ?? (state.operatorContext === undefined ? "wird geladen" : "Dein Einstieg"))}</strong></span><span class="shell-balance"><span class="eyebrow">VERFÜGBAR</span><strong>${escapeHtml(finance)}</strong></span></summary><div class="shell-operator__popover">${operatorDetail}</div></details><a class="shell-mailbox" href="${escapeHtml(journeyUrl(state, "mailbox"))}"${active("mailbox")}>${icon("mail")}<span>Postfach</span><strong>${openMessages}</strong></a></header><div class="player-layout">${navigation}<section class="player-workspace" aria-labelledby="workspace-title" data-section="${section}"><header class="workspace-heading"><div><p class="eyebrow">${heading.eyebrow}</p><h1 id="workspace-title" tabindex="-1">${heading.title}</h1><p>${heading.description}</p></div><a class="workspace-map-return" href="${escapeHtml(livemapDestination(state))}">${icon("map")} Zur LiveMap</a></header>${message}${recovery}<div class="workspace-scroll" data-scroll-region>${content}</div></section></div><footer class="player-footer"><span>DEUTSCHLAND · DEINE BAHN. DEINE WELT.</span><span>Alles für deinen nächsten Zug.</span></footer>${confirmation}</main>`;

}

export function renderJourney(state: JourneyViewState): string {
  const busyScope = state.busy ? (state.busyScope ?? "initial") : undefined;
  const disableButtons = (html: string): string => html.replace(/<button(?![^>]*\bdisabled\b)/g, '<button disabled aria-disabled="true"');
  const livemap = state.livemapUrl === undefined || state.livemapUrl === "" ? "" : `<a class="primary-map-link" href="${escapeHtml(state.livemapUrl)}">Zur LiveMap</a>`;
  const message = state.message === "" ? "" : `<p class="journey-message journey-message--${state.messageTone ?? "status"}" role="${state.messageTone === "error" ? "alert" : "status"}" aria-live="polite"${state.messageTone === "error" ? ' tabindex="-1"' : ""}>${escapeHtml(state.message)}</p>`;
  const cooperation = state.cooperation === undefined ? "" : renderCooperationSurface(state.cooperation);
  const mailboxContent = busyScope === "mailbox" ? disableButtons(attentionRail(state.mailbox)) : attentionRail(state.mailbox);
  const confirmation = state.confirmation === undefined ? "" : `<dialog id="journey-confirmation" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-detail"><form method="dialog"><p class="eyebrow">DEINE ENTSCHEIDUNG</p><h2 id="confirmation-title">${escapeHtml(state.confirmation.title)}</h2><p id="confirmation-detail">${escapeHtml(state.confirmation.detail)}</p><div class="journey-actions"><button id="confirmation-submit" value="confirm" type="submit">Bestätigen</button><button id="confirmation-cancel" value="cancel" class="secondary" type="submit" autofocus>Abbrechen</button></div></form></dialog>`;
  const recoveryLabel = state.bootRecovery === "configure" ? "Verbindung erneut prüfen" : "Erneut versuchen";
  const recovery = state.bootRecovery === undefined ? "" : `<p class="journey-recovery"><button id="journey-retry" type="button">${recoveryLabel}</button></p>`;
  const world = encodeURIComponent(state.publicWorldId);
  if (state.activeSection !== undefined) {
    const sectionContent = state.activeSection === "world"
      ? worldSurface(state, state.cooperation?.activeOperatorId === "" ? cooperation : "")
      : state.activeSection === "mailbox" ? mailboxContent
        : state.activeSection === "company" ? companySurface(state)
          : cooperation;
    const shell = playerShell(state, sectionContent, message, recovery, confirmation);
    return busyScope === "initial" ? disableButtons(shell) : shell;
  }
  const html = `<main class="journey-shell" aria-busy="${state.busy}"><header class="journey-top"><div><p class="wordmark">ZUGFOLGE</p><h1>Geschlossene Alpha · Spielerreise</h1></div><nav aria-label="Hauptnavigation">${livemap}<a href="#world-contract-title">Welt und Einstieg</a><a href="#vehicle-market">Märkte</a><a href="?view=diagram&world=${world}#diagram-card">Betrieb</a><a href="#postfach">Postfach</a></nav></header>${message}${recovery}${worldContracts(state)}${mailboxContent}${cooperation}${confirmation}</main>`;
  return busyScope === "initial" ? disableButtons(html) : html;
}
