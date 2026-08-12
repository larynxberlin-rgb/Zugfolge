import type {
  ContractType,
  OperatorContractView,
  OperatorSummary,
  VehicleAssetView,
  VehicleHistoryEventView,
  VehicleMarketListingView,
} from "./api.js";

export interface CooperationSurfaceState {
  readonly worldId: string;
  readonly activeOperatorId: string;
  readonly operators: readonly OperatorSummary[];
  readonly ownOperatorIds: readonly string[];
  readonly contracts: readonly OperatorContractView[];
  readonly listings: readonly VehicleMarketListingView[];
  readonly ownedVehicles: readonly VehicleAssetView[];
  readonly selectedVehicleHistory?: readonly VehicleHistoryEventView[];
  readonly selectedHistoryVehicleId?: string;
  readonly contractType: ContractType;
  readonly marketQuery: string;
  readonly atS: number;
  readonly busy: boolean;
}

export interface CooperationSurfaceActions {
  readonly changeOperator?: (operatorId: string) => void | Promise<void>;
  readonly changeContractType?: (contractType: ContractType) => void;
  readonly changeMarketQuery?: (query: string) => void;
  readonly refresh?: () => void | Promise<void>;
  readonly offerContract?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly respondToContract?: (contractId: string, response: "accept" | "reject") => void | Promise<void>;
  readonly endContract?: (contractId: string, nonPerformance: boolean) => void | Promise<void>;
  readonly createListing?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly reserveListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly transferListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly reverseListing?: (listingId: string) => void | Promise<void>;
  readonly cancelListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly loadHistory?: (vehicleId: string) => void | Promise<void>;
}

const CONTRACT_LABELS: Readonly<Record<ContractType, string>> = {
  traction: "Traktionsleistung",
  "vehicle-rental": "Fahrzeugmiete",
  connection: "Anschlusswartezeit",
  "disruption-assistance": "Ersatzverkehrshilfe",
};

const CONTRACT_STATUS: Readonly<Record<OperatorContractView["status"], string>> = {
  offered: "Angeboten",
  accepted: "Angenommen · wartet auf Beginn",
  rejected: "Abgelehnt",
  active: "Aktiv",
  terminated: "Gekündigt",
  "non-performance": "Nichterfüllung gemeldet",
  completed: "Regulär beendet",
  expired: "Antwortfrist verstrichen",
};

const LISTING_STATUS: Readonly<Record<VehicleMarketListingView["status"], string>> = {
  open: "Offen",
  reserved: "Reserviert",
  transferred: "Übergeben",
  cancelled: "Zurückgezogen",
  expired: "Angebotsfrist verstrichen",
  reversed: "Rückabgewickelt",
};

const HISTORY_LABELS: Readonly<Record<VehicleHistoryEventView["eventType"], string>> = {
  registered: "Registriert",
  "condition-updated": "Zustand fortgeschrieben",
  sale: "Verkauft",
  "rental-start": "Vermietung begonnen",
  "rental-return": "Vermietung beendet",
  reversal: "Rückabgewickelt",
};

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function safeInteger(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} muss eine nichtnegative ganze Simulationssekunde sein.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} liegt außerhalb des sicheren Bereichs.`);
  return parsed;
}

function commaSeparated(value: string, name: string): readonly string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error(`${name} braucht mindestens eine eindeutige Kennung.`);
  }
  return entries;
}

export function parseEuroCents(value: string): string {
  const canonical = value.trim().replaceAll(".", "");
  const match = /^(0|[1-9][0-9]*)(?:,([0-9]{1,2}))?$/.exec(canonical);
  if (match === null) throw new Error("Geldbetrag muss als Eurobetrag mit höchstens zwei Nachkommastellen eingegeben werden.");
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > 9_223_372_036_854_775_807n) throw new Error("Geldbetrag überschreitet den zulässigen Integer-Centbereich.");
  return cents.toString();
}

export function formatCents(value: string): string {
  const cents = BigInt(value);
  const euros = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${euros},${(cents % 100n).toString().padStart(2, "0")} €`;
}

export function contractSubjectFromFields(
  contractType: ContractType,
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  switch (contractType) {
    case "traction":
      return {
        trainRunIds: commaSeparated(fields["trainRunIds"] ?? "", "Traktionszugfahrten"),
        formationIds: commaSeparated(fields["formationIds"] ?? "", "Formationen"),
        personnelDutyIds: commaSeparated(fields["personnelDutyIds"] ?? "", "Personaldienste"),
        pathReceiptIds: commaSeparated(fields["pathReceiptIds"] ?? "", "Trassenbelege"),
      };
    case "vehicle-rental":
      return { vehicleIds: commaSeparated(fields["vehicleIds"] ?? "", "Mietfahrzeuge") };
    case "connection":
      return { connections: [{
        arrivalTrainRunId: (fields["arrivalTrainRunId"] ?? "").trim(),
        onwardTrainRunId: (fields["onwardTrainRunId"] ?? "").trim(),
        maxWaitSeconds: safeInteger(fields["maxWaitSeconds"] ?? "", "Verbindliche Wartezeit"),
      }] };
    case "disruption-assistance": {
      const disruptionId = (fields["disruptionId"] ?? "").trim();
      if (disruptionId === "") throw new Error("Störungskennung fehlt.");
      return {
        disruptionId,
        trainRunIds: commaSeparated(fields["trainRunIds"] ?? "", "Ersatzzugfahrten"),
        vehicleIds: commaSeparated(fields["vehicleIds"] ?? "", "Hilfsfahrzeuge"),
      };
    }
  }
}

export function formFields(form: HTMLFormElement): Readonly<Record<string, string>> {
  return Object.fromEntries(Array.from(new FormData(form).entries()).map(([key, value]) => [key, String(value)]));
}

function field(name: string, label: string, options: { readonly type?: string; readonly value?: string; readonly min?: number; readonly required?: boolean } = {}): string {
  return `<label class="m12-field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="${escapeHtml(options.type ?? "text")}" value="${escapeHtml(options.value ?? "")}"${options.min === undefined ? "" : ` min="${options.min}"`}${options.required === false ? "" : " required"}></label>`;
}

function subjectFields(contractType: ContractType): string {
  switch (contractType) {
    case "traction": return `${field("trainRunIds", "Traktionszugfahrten · Kennungen, komma-separiert")}${field("formationIds", "Formationen · Kennungen")}${field("personnelDutyIds", "Personaldienste · Kennungen")}${field("pathReceiptIds", "Trassenbelege · Kennungen")}`;
    case "vehicle-rental": return field("vehicleIds", "Mietfahrzeuge · Kennungen, komma-separiert");
    case "connection": return `${field("arrivalTrainRunId", "Ankommende Zugfahrt")}${field("onwardTrainRunId", "Weiterführende Zugfahrt")}${field("maxWaitSeconds", "Verbindliche Wartezeit · Sekunden", { type: "number", min: 0 })}`;
    case "disruption-assistance": return `${field("disruptionId", "Störungskennung")}${field("trainRunIds", "Ersatzzugfahrten · Kennungen")}${field("vehicleIds", "Hilfsfahrzeuge · Kennungen")}`;
  }
}

function operatorName(state: CooperationSurfaceState, operatorId: string): string {
  return state.operators.find((operator) => operator.id === operatorId)?.name ?? operatorId;
}

function contractActions(state: CooperationSurfaceState, contract: OperatorContractView): string {
  if (contract.status === "offered" && contract.offereeOperatorId === state.activeOperatorId) {
    return `<button type="button" data-contract-id="${escapeHtml(contract.id)}" data-contract-response="accept">Annehmen</button><button class="secondary" type="button" data-contract-id="${escapeHtml(contract.id)}" data-contract-response="reject">Ablehnen</button>`;
  }
  if (["accepted", "active"].includes(contract.status)) {
    return `<button class="secondary" type="button" data-contract-end="${escapeHtml(contract.id)}">Vertrag beenden</button><button class="secondary danger-action" type="button" data-contract-non-performance="${escapeHtml(contract.id)}">Nichterfüllung melden</button>`;
  }
  return "";
}

function contractCard(state: CooperationSurfaceState, contract: OperatorContractView): string {
  return `<article class="m12-item status-${escapeHtml(contract.status)}">
    <div class="m12-item-head"><div><strong>${escapeHtml(CONTRACT_LABELS[contract.contractType])}</strong><small>${escapeHtml(operatorName(state, contract.offerorOperatorId))} → ${escapeHtml(operatorName(state, contract.offereeOperatorId))}</small></div><span class="state-word">${escapeHtml(CONTRACT_STATUS[contract.status])}</span></div>
    <dl><div><dt>Entgelt</dt><dd>${escapeHtml(formatCents(contract.priceCents))}</dd></div><div><dt>Antwortfrist</dt><dd>T+${contract.responseDeadlineS}s</dd></div><div><dt>Gültigkeit</dt><dd>T+${contract.validFromS}s bis T+${contract.validUntilS}s</dd></div><div><dt>Vertragsbeleg</dt><dd><code>${escapeHtml(contract.termsHash.slice(0, 12))}…</code></dd></div></dl>
    <div class="m12-actions">${contractActions(state, contract)}</div>
  </article>`;
}

function contractSurface(state: CooperationSurfaceState): string {
  const targetOperators = state.operators.filter((operator) => operator.id !== state.activeOperatorId);
  const contracts = state.contracts.length === 0 ? `<p class="m12-empty">Noch keine EVU-Verträge. Angebote und Antworten erscheinen hier mit Frist und Zustandswort.</p>` : state.contracts.map((contract) => contractCard(state, contract)).join("");
  return `<section class="journey-card m12-card" id="cooperation-contracts">
    <div class="journey-heading"><div><p class="eyebrow">M12.1 · EVU-zu-EVU</p><h2>Kooperationsverträge</h2></div><span class="state-word">${state.contracts.filter((contract) => ["offered", "accepted", "active"].includes(contract.status)).length} laufend/offen</span></div>
    <form id="m12-contract-form" class="m12-form">
      <label class="m12-field"><span>Leistungsart</span><select id="m12-contract-type" name="contractType">${Object.entries(CONTRACT_LABELS).map(([value, label]) => `<option value="${value}"${state.contractType === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
      <label class="m12-field"><span>Empfangendes EVU</span><select name="offereeOperatorId" required>${targetOperators.map((operator) => `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.name)}</option>`).join("")}</select></label>
      ${subjectFields(state.contractType)}
      ${field("termsSummary", "Vereinbarte Leistung / Qualität")}
      ${field("priceEuros", "Entgelt · Euro", { value: "0,00" })}
      ${field("responseDeadlineS", "Antwortfrist · Simulationssekunde", { type: "number", min: 0, value: String(state.atS + 3_600) })}
      ${field("validFromS", "Gültigkeitsbeginn · Simulationssekunde", { type: "number", min: 0, value: String(state.atS + 7_200) })}
      ${field("validUntilS", "Gültigkeitsende · Simulationssekunde", { type: "number", min: 1, value: String(state.atS + 86_400) })}
      ${field("terminationNoticeS", "Kündigungsfrist · Sekunden", { type: "number", min: 0, value: "3600" })}
      <button type="submit"${targetOperators.length === 0 ? " disabled" : ""}>Verbindliches Angebot senden</button>
    </form>
    <div class="m12-list">${contracts}</div>
  </section>`;
}

function disclosureList(value: unknown, empty: string): string {
  if (!Array.isArray(value) || value.length === 0) return empty;
  return value.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      return String(record["code"] ?? record["kind"] ?? JSON.stringify(record));
    }
    return String(entry);
  }).join(", ");
}

function listingMatches(listing: VehicleMarketListingView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("de");
  if (needle === "") return true;
  return `${listing.vehicleId} ${JSON.stringify(listing.disclosure)} ${listing.listingType} ${listing.status}`.toLocaleLowerCase("de").includes(needle);
}

function listingActions(state: CooperationSurfaceState, listing: VehicleMarketListingView): string {
  const own = listing.offeringOperatorId === state.activeOperatorId;
  if (own && ["open", "reserved"].includes(listing.status)) {
    return `<button class="secondary" type="button" data-listing-cancel="${escapeHtml(listing.id)}" data-revision="${listing.revision}">Angebot zurückziehen</button>`;
  }
  if (listing.status === "open") {
    return `<button type="button" data-listing-reserve="${escapeHtml(listing.id)}" data-revision="${listing.revision}">10 Minuten reservieren</button>`;
  }
  if (listing.status === "reserved" && listing.reservedByOperatorId === state.activeOperatorId) {
    return `<button type="button" data-listing-transfer="${escapeHtml(listing.id)}" data-revision="${listing.revision}">Übergabe verbindlich ausführen</button>`;
  }
  if (listing.status === "transferred" && listing.reservedByOperatorId === state.activeOperatorId) {
    return `<button class="secondary danger-action" type="button" data-listing-reverse="${escapeHtml(listing.id)}">Nicht offengelegten Mangel rückabwickeln</button>`;
  }
  return "";
}

function listingCard(state: CooperationSurfaceState, listing: VehicleMarketListingView): string {
  const disclosure = listing.disclosure;
  return `<article class="m12-item market-item status-${escapeHtml(listing.status)}">
    <div class="m12-item-head"><div><strong>${escapeHtml(String(disclosure["classDesignation"] ?? "Baureihe unbekannt"))} · ${escapeHtml(listing.vehicleId)}</strong><small>${listing.listingType === "sale" ? "Verkauf" : "Vermietung"} von ${escapeHtml(operatorName(state, listing.offeringOperatorId))}</small></div><span class="state-word">${escapeHtml(LISTING_STATUS[listing.status])}</span></div>
    <dl><div><dt>Preis</dt><dd>${escapeHtml(formatCents(listing.priceCents))}</dd></div><div><dt>Zustand</dt><dd>${escapeHtml(String(disclosure["conditionBasisPoints"] ?? "?"))} / 10000</dd></div><div><dt>Laufleistung</dt><dd>${escapeHtml(String(disclosure["odometerMetres"] ?? "?"))} m</dd></div><div><dt>Schäden</dt><dd>${escapeHtml(disclosureList(disclosure["damages"], "Keine offengelegt"))}</dd></div><div><dt>Wartungsfristen</dt><dd>${escapeHtml(disclosureList(disclosure["maintenanceDeadlines"], "Keine offengelegt"))}</dd></div><div><dt>Offenlegungsbeleg</dt><dd><code>${escapeHtml(listing.disclosureHash.slice(0, 12))}…</code></dd></div></dl>
    <div class="m12-actions">${listingActions(state, listing)}<button class="secondary" type="button" data-vehicle-history="${escapeHtml(listing.vehicleId)}">Lebenslauf ansehen</button></div>
  </article>`;
}

function historySurface(state: CooperationSurfaceState): string {
  if (state.selectedVehicleHistory === undefined) return "";
  const entries = state.selectedVehicleHistory.map((event) => `<li><span>T+${event.atS}s</span><strong>${escapeHtml(HISTORY_LABELS[event.eventType])}</strong><code>${escapeHtml(event.resultingHistoryHash.slice(0, 12))}…</code></li>`).join("");
  return `<section class="vehicle-history"><div class="journey-heading"><h3>Unveränderlicher Fahrzeuglebenslauf</h3><span class="state-word">${escapeHtml(state.selectedHistoryVehicleId ?? "Fahrzeug")}</span></div><ol>${entries || "<li>Keine Historieneinträge.</li>"}</ol></section>`;
}

function marketSurface(state: CooperationSurfaceState): string {
  const filtered = state.listings.filter((listing) => listingMatches(listing, state.marketQuery));
  return `<section class="journey-card m12-card" id="vehicle-market">
    <div class="journey-heading"><div><p class="eyebrow">M12.2 · Persistenter Fahrzeugmarkt</p><h2>Angebot, Reservierung und Übergabe</h2></div><span class="state-word">${filtered.length} Treffer</span></div>
    <form id="m12-listing-form" class="m12-form compact-form">
      <label class="m12-field"><span>Eigenes Fahrzeug</span><select name="vehicleId" required>${state.ownedVehicles.map((vehicle) => `<option value="${escapeHtml(vehicle.vehicleId)}">${escapeHtml(vehicle.classDesignation)} · ${escapeHtml(vehicle.vehicleId)} · Zustand ${vehicle.conditionBasisPoints}/10000</option>`).join("")}</select></label>
      <label class="m12-field"><span>Angebotsart</span><select name="listingType"><option value="sale">Verkauf</option><option value="rental">Vermietung</option></select></label>
      ${field("priceEuros", "Preis · Euro", { value: "1,00" })}
      ${field("expiresAtS", "Angebotsende · Simulationssekunde", { type: "number", min: 1, value: String(state.atS + 86_400) })}
      ${field("rentalValidUntilS", "Mietende · nur Vermietung", { type: "number", min: 1, value: String(state.atS + 604_800), required: false })}
      <button type="submit"${state.ownedVehicles.length === 0 ? " disabled" : ""}>Fahrzeug verbindlich anbieten</button>
    </form>
    <label class="m12-search"><span>Fahrzeugmarkt durchsuchen</span><input id="m12-market-query" type="search" value="${escapeHtml(state.marketQuery)}" placeholder="Baureihe, Fahrzeug, Zustand oder Schaden"></label>
    <div class="m12-list">${filtered.length === 0 ? `<p class="m12-empty">Keine Marktangebote entsprechen der Suche.</p>` : filtered.map((listing) => listingCard(state, listing)).join("")}</div>
    ${historySurface(state)}
  </section>`;
}

export function renderCooperationSurface(state: CooperationSurfaceState): string {
  if (state.activeOperatorId === "") {
    return `<section class="journey-card m12-card"><p class="eyebrow">M12 · Kooperation</p><h2>Kein eigenes EVU in dieser Welt</h2><p class="m12-empty">Kooperationsverträge und Fahrzeugmarkt werden freigeschaltet, sobald das angemeldete Konto ein EVU führt.</p></section>`;
  }
  const own = state.operators.filter((operator) => state.ownOperatorIds.includes(operator.id));
  return `<section class="m12-surface" aria-busy="${state.busy}">
    <div class="m12-toolbar"><label><span>Handelndes EVU</span><select id="m12-operator">${own.map((operator) => `<option value="${escapeHtml(operator.id)}"${operator.id === state.activeOperatorId ? " selected" : ""}>${escapeHtml(operator.name)}</option>`).join("")}</select></label><div class="m12-clock"><span>Serverautoritative Simulationssekunde</span><output id="m12-time">T+${state.atS}s</output></div><button id="m12-refresh" class="secondary" type="button">Kooperation und Markt aktualisieren</button></div>
    <div class="m12-grid">${contractSurface(state)}${marketSurface(state)}</div>
  </section>`;
}

function integerDataset(value: string | undefined): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Ungültige Fachrevision am Bedienelement.");
  return revision;
}

function invoke(action: (() => void | Promise<void>) | undefined): void {
  if (action !== undefined) void action();
}

export function bindCooperationSurface(root: ParentNode, actions: CooperationSurfaceActions): void {
  root.querySelector<HTMLSelectElement>("#m12-operator")?.addEventListener("change", (event) => invoke(() => actions.changeOperator?.((event.currentTarget as HTMLSelectElement).value)));
  root.querySelector<HTMLSelectElement>("#m12-contract-type")?.addEventListener("change", (event) => actions.changeContractType?.((event.currentTarget as HTMLSelectElement).value as ContractType));
  root.querySelector<HTMLInputElement>("#m12-market-query")?.addEventListener("change", (event) => actions.changeMarketQuery?.((event.currentTarget as HTMLInputElement).value));
  root.querySelector<HTMLButtonElement>("#m12-refresh")?.addEventListener("click", () => invoke(actions.refresh));
  root.querySelector<HTMLFormElement>("#m12-contract-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.offerContract?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelector<HTMLFormElement>("#m12-listing-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.createListing?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelectorAll<HTMLElement>("[data-contract-response]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.respondToContract?.(element.dataset["contractId"]!, element.dataset["contractResponse"] as "accept" | "reject"))));
  root.querySelectorAll<HTMLElement>("[data-contract-end]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.endContract?.(element.dataset["contractEnd"]!, false))));
  root.querySelectorAll<HTMLElement>("[data-contract-non-performance]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.endContract?.(element.dataset["contractNonPerformance"]!, true))));
  root.querySelectorAll<HTMLElement>("[data-listing-reserve]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.reserveListing?.(element.dataset["listingReserve"]!, integerDataset(element.dataset["revision"])))));
  root.querySelectorAll<HTMLElement>("[data-listing-transfer]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.transferListing?.(element.dataset["listingTransfer"]!, integerDataset(element.dataset["revision"])))));
  root.querySelectorAll<HTMLElement>("[data-listing-reverse]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.reverseListing?.(element.dataset["listingReverse"]!))));
  root.querySelectorAll<HTMLElement>("[data-listing-cancel]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.cancelListing?.(element.dataset["listingCancel"]!, integerDataset(element.dataset["revision"])))));
  root.querySelectorAll<HTMLElement>("[data-vehicle-history]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.loadHistory?.(element.dataset["vehicleHistory"]!))));
}

export function parseContractOfferFields(
  contractType: ContractType,
  fields: Readonly<Record<string, string>>,
  offeredAtS: number,
): {
  readonly offereeOperatorId: string;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly priceCents: string;
  readonly responseDeadlineS: number;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly terminationNoticeS: number;
} {
  const offereeOperatorId = (fields["offereeOperatorId"] ?? "").trim();
  if (offereeOperatorId === "") throw new Error("Empfangendes EVU fehlt.");
  const responseDeadlineS = safeInteger(fields["responseDeadlineS"] ?? "", "Antwortfrist");
  const validFromS = safeInteger(fields["validFromS"] ?? "", "Gültigkeitsbeginn");
  const validUntilS = safeInteger(fields["validUntilS"] ?? "", "Gültigkeitsende");
  const terminationNoticeS = safeInteger(fields["terminationNoticeS"] ?? "", "Kündigungsfrist");
  if (responseDeadlineS < offeredAtS || responseDeadlineS > validFromS || validUntilS <= validFromS) {
    throw new Error("Antwort- und Gültigkeitsfristen bilden kein zulässiges Vertragsfenster.");
  }
  return {
    offereeOperatorId,
    subject: contractSubjectFromFields(contractType, fields),
    terms: { summary: (fields["termsSummary"] ?? "").trim() },
    priceCents: parseEuroCents(fields["priceEuros"] ?? ""),
    responseDeadlineS, validFromS, validUntilS, terminationNoticeS,
  };
}
