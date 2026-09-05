import type {
  ContractType,
  CooperationPageView,
  CooperationResourceCatalog,
  CooperationResourceOption,
  OperatorContractView,
  OperatorSummary,
  PublicTenderView,
  VehicleAssetView,
  VehicleHistoryEventView,
  VehicleMarketListingView,
} from "./api.js";
import { renderComparisonWorkbench } from "./comparison.js";

export interface CooperationSurfaceState {
  readonly worldId: string;
  readonly worldName: string;
  readonly activeOperatorId: string;
  readonly operators: readonly OperatorSummary[];
  readonly ownOperatorIds: readonly string[];
  readonly contracts: readonly OperatorContractView[];
  readonly listings: readonly VehicleMarketListingView[];
  readonly ownedVehicles: readonly VehicleAssetView[];
  readonly resources?: CooperationResourceCatalog;
  readonly selectedVehicleHistory?: readonly VehicleHistoryEventView[];
  readonly selectedHistoryVehicleId?: string;
  readonly contractType: ContractType;
  readonly marketQuery: string;
  readonly contractPageView: CooperationPageView;
  readonly listingPageView: CooperationPageView;
  readonly contractNextCursor: string | null;
  readonly listingNextCursor: string | null;
  readonly atS: number;
  readonly busy: boolean;
  readonly pathAlternatives?: readonly {
    readonly id: string;
    readonly label: string;
    readonly shift: string;
    readonly compatibility: string;
    readonly provenance: string;
  }[];
  readonly economyRevision?: number;
  readonly tenders?: readonly PublicTenderView[];
  readonly tendersUnavailable?: boolean;
  readonly stationOptions?: readonly { readonly id: string; readonly label: string }[];
  /** Begrenzt die alte Sammelflaeche auf den aktiven Shell-Arbeitsraum. */
  readonly section?: "all" | "markets" | "operations";
}

export interface CooperationSurfaceActions {
  readonly createOperator?: (name: string) => void | Promise<void>;
  readonly submitTenderBid?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly submitPathRequest?: (kind: "schedule" | "empty-run", fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly scheduleMaintenance?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly changeOperator?: (operatorId: string) => void | Promise<void>;
  readonly changeContractType?: (contractType: ContractType) => void;
  readonly changeMarketQuery?: (query: string) => void;
  readonly changeContractPageView?: (view: CooperationPageView) => void | Promise<void>;
  readonly changeListingPageView?: (view: CooperationPageView) => void | Promise<void>;
  readonly loadMoreContracts?: () => void | Promise<void>;
  readonly loadMoreListings?: () => void | Promise<void>;
  readonly refresh?: () => void | Promise<void>;
  readonly offerContract?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly respondToContract?: (contractId: string, response: "accept" | "reject") => void | Promise<void>;
  readonly endContract?: (contractId: string, nonPerformance: boolean, evidenceReference?: string) => void | Promise<void>;
  readonly createListing?: (fields: Readonly<Record<string, string>>) => void | Promise<void>;
  readonly reserveListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly transferListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly reverseListing?: (listingId: string, reasonCode: string) => void | Promise<void>;
  readonly cancelListing?: (listingId: string, expectedRevision: number) => void | Promise<void>;
  readonly loadHistory?: (vehicleId: string) => void | Promise<void>;
}

/** Harte Obergrenze fuer den gleichzeitig gerenderten No-Wipe-Bestand. */
export const MAX_RENDERED_COOPERATION_ITEMS = 200;

export function mergeBoundedItems<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  maximum = MAX_RENDERED_COOPERATION_ITEMS,
): { readonly items: readonly T[]; readonly limitReached: boolean } {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Darstellungsgrenze muss eine positive ganze Zahl sein.");
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...current, ...incoming]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (merged.length < maximum) merged.push(item);
  }
  return { items: merged, limitReached: seen.size > maximum || merged.length >= maximum };
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
  "termination-pending": "Gekündigt · Leistung läuft bis Fristende",
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
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} muss eine nichtnegative ganze Zahl sein.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} liegt außerhalb des sicheren Bereichs.`);
  return parsed;
}

function secondsFromUnits(value: string, multiplier: number, name: string): number {
  const units = safeInteger(value, name);
  const seconds = units * multiplier;
  if (!Number.isSafeInteger(seconds)) throw new Error(`${name} liegt außerhalb des sicheren Zeitbereichs.`);
  return seconds;
}

function addSeconds(atS: number, durationS: number, name: string): number {
  const result = atS + durationS;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} liegt außerhalb des sicheren Zeitbereichs.`);
  return result;
}

function formatRelativeS(targetS: number, atS: number): string {
  const difference = targetS - atS;
  const sign = difference < 0 ? "vor" : "in";
  const absolute = Math.abs(difference);
  if (absolute >= 86_400 && absolute % 86_400 === 0) return `${sign} ${absolute / 86_400} Tag${absolute === 86_400 ? "" : "en"}`;
  if (absolute >= 3_600 && absolute % 3_600 === 0) return `${sign} ${absolute / 3_600} Stunde${absolute === 3_600 ? "" : "n"}`;
  if (absolute >= 60 && absolute % 60 === 0) return `${sign} ${absolute / 60} Minute${absolute === 60 ? "" : "n"}`;
  return `${sign} ${absolute} Sekunden`;
}

function commaSeparated(value: string, name: string): readonly string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error(`${name} braucht mindestens eine eindeutige Kennung.`);
  }
  return entries;
}

export function parseEuroCents(value: string): string {
  const canonical = value.trim();
  const match = /^(0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:\.[0-9]{3})+)(?:,([0-9]{1,2}))?$/.exec(canonical);
  if (match === null) throw new Error("Geldbetrag muss als Eurobetrag mit höchstens zwei Nachkommastellen eingegeben werden.");
  const euros = match[1]!.replaceAll(".", "");
  const cents = BigInt(euros) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
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
        maxWaitSeconds: secondsFromUnits(fields["maxWaitMinutes"] ?? "", 60, "Verbindliche Wartezeit"),
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
  const fields: Record<string, string[]> = {};
  for (const [key, value] of new FormData(form).entries()) (fields[key] ??= []).push(String(value));
  return Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, values.join(",")]));
}

function field(name: string, label: string, options: { readonly type?: string; readonly value?: string; readonly min?: number; readonly required?: boolean } = {}): string {
  return `<label class="m12-field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="${escapeHtml(options.type ?? "text")}" value="${escapeHtml(options.value ?? "")}"${options.min === undefined ? "" : ` min="${options.min}"`}${options.required === false ? "" : " required"}></label>`;
}

function resourceOptions(options: readonly CooperationResourceOption[]): string {
  return options.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)} · ${escapeHtml(entry.detail)}</option>`).join("");
}

function singleResourceField(name: string, label: string, options: readonly CooperationResourceOption[]): string {
  return `<label class="m12-field resource-select"><span>${escapeHtml(label)}</span><select name="${escapeHtml(name)}" required><option value="">Bitte auswählen</option>${resourceOptions(options)}</select>${options.length === 0 ? '<small class="resource-empty">Aktuell ist keine passende Ressource verfügbar.</small>' : ""}</label>`;
}

function multipleResourceField(name: string, label: string, options: readonly CooperationResourceOption[]): string {
  const choices = options.map((entry) => `<label class="resource-choice"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(entry.id)}"><span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.detail)}</small></span></label>`).join("");
  return `<fieldset class="resource-picker"><legend>${escapeHtml(label)}</legend>${choices || '<p class="resource-empty">Aktuell ist keine passende Ressource verfügbar.</p>'}</fieldset>`;
}

function subjectFields(contractType: ContractType, resources: CooperationResourceCatalog | undefined): string {
  const empty: readonly CooperationResourceOption[] = [];
  switch (contractType) {
    case "traction": return `${multipleResourceField("trainRunIds", "Traktionszugfahrten", resources?.trainRuns ?? empty)}${multipleResourceField("formationIds", "Formationen", resources?.formations ?? empty)}${multipleResourceField("personnelDutyIds", "Personaldienste", resources?.personnelDuties ?? empty)}${multipleResourceField("pathReceiptIds", "Bestätigte Trassen", resources?.pathReceipts ?? empty)}`;
    case "vehicle-rental": return multipleResourceField("vehicleIds", "Unbelastete eigene Mietfahrzeuge", resources?.rentableVehicles ?? empty);
    case "connection": return `${singleResourceField("arrivalTrainRunId", "Ankommende Zugfahrt", resources?.connectionTrainRuns ?? empty)}${singleResourceField("onwardTrainRunId", "Weiterführende Zugfahrt", resources?.connectionTrainRuns ?? empty)}${field("maxWaitMinutes", "Verbindliche Wartezeit · Minuten", { type: "number", min: 0 })}`;
    case "disruption-assistance": return `${singleResourceField("disruptionId", "Betroffene Störung", resources?.disruptions ?? empty)}${multipleResourceField("trainRunIds", "Ersatzzugfahrten", resources?.trainRuns ?? empty)}${multipleResourceField("vehicleIds", "Verfügbare gehaltene Hilfsfahrzeuge", resources?.assistanceVehicles ?? empty)}`;
  }
}

function hasRequiredResources(contractType: ContractType, resources: CooperationResourceCatalog | undefined): boolean {
  if (resources === undefined) return false;
  switch (contractType) {
    case "traction": return resources.trainRuns.length > 0 && resources.formations.length > 0 && resources.personnelDuties.length > 0 && resources.pathReceipts.length > 0;
    case "vehicle-rental": return resources.rentableVehicles.length > 0;
    case "connection": return resources.connectionTrainRuns.length > 0;
    case "disruption-assistance": return resources.disruptions.length > 0 && resources.trainRuns.length > 0 && resources.assistanceVehicles.length > 0;
  }
}

function operatorName(state: CooperationSurfaceState, operatorId: string): string {
  return state.operators.find((operator) => operator.id === operatorId)?.name ?? "Unbekanntes EVU";
}

function contractActions(state: CooperationSurfaceState, contract: OperatorContractView): string {
  if (contract.status === "offered" && contract.offereeOperatorId === state.activeOperatorId) {
    return `<button type="button" data-contract-id="${escapeHtml(contract.id)}" data-contract-response="accept">Annehmen</button><button class="secondary" type="button" data-contract-id="${escapeHtml(contract.id)}" data-contract-response="reject">Ablehnen</button>`;
  }
  if (["accepted", "active"].includes(contract.status)) {
    return `<button class="secondary" type="button" data-contract-end="${escapeHtml(contract.id)}">Ordentlich kündigen</button><label class="m12-field m12-evidence"><span>Betriebstag des belegten Verstoßes</span><input type="date" data-contract-evidence-day="${escapeHtml(contract.id)}" aria-describedby="contract-evidence-help-${escapeHtml(contract.id)}"><small id="contract-evidence-help-${escapeHtml(contract.id)}">Nur ein serverseitiger Tagesbericht mit gebundener Abweichung erlaubt den sofortigen Abbruch.</small></label><button class="secondary danger-action" type="button" data-contract-non-performance="${escapeHtml(contract.id)}">Nichterfüllung mit Beleg melden</button>`;
  }
  return "";
}

function contractCard(state: CooperationSurfaceState, contract: OperatorContractView): string {
  return `<article class="m12-item status-${escapeHtml(contract.status)}" id="contract-${escapeHtml(contract.id)}" tabindex="-1">
    <div class="m12-item-head"><div><strong>${escapeHtml(CONTRACT_LABELS[contract.contractType])}</strong><small>${escapeHtml(operatorName(state, contract.offerorOperatorId))} → ${escapeHtml(operatorName(state, contract.offereeOperatorId))}</small></div><span class="state-word">${escapeHtml(CONTRACT_STATUS[contract.status])}</span></div>
    <dl><div><dt>Entgelt</dt><dd>${escapeHtml(formatCents(contract.priceCents))}</dd></div><div><dt>Antwortfrist</dt><dd>${escapeHtml(formatRelativeS(contract.responseDeadlineS, state.atS))}</dd></div><div><dt>Gültigkeit</dt><dd>${escapeHtml(formatRelativeS(contract.validFromS, state.atS))}, für ${escapeHtml(formatRelativeS(contract.validUntilS, contract.validFromS).replace(/^in /, ""))}</dd></div>${contract.terminationEffectiveAtS === null || contract.terminationEffectiveAtS === undefined ? "" : `<div><dt>Kündigung wirksam</dt><dd>${escapeHtml(formatRelativeS(contract.terminationEffectiveAtS, state.atS))}</dd></div>`}<div><dt>Technischer Beleg</dt><dd><details><summary>Prüfhash</summary><code>${escapeHtml(contract.termsHash)}</code></details></dd></div></dl>
    <div class="m12-actions">${contractActions(state, contract)}</div>
  </article>`;
}

function contractSurface(state: CooperationSurfaceState): string {
  const targetOperators = state.operators.filter((operator) => operator.id !== state.activeOperatorId);
  const resourcesAvailable = hasRequiredResources(state.contractType, state.resources);
  const visibleContracts = state.contracts.slice(0, MAX_RENDERED_COOPERATION_ITEMS);
  const contracts = visibleContracts.length === 0 ? `<p class="m12-empty">Noch keine EVU-Verträge. Angebote und Antworten erscheinen hier mit Frist und Zustandswort.</p>` : visibleContracts.map((contract) => contractCard(state, contract)).join("");
  return `<section class="journey-card m12-card" id="cooperation-contracts">
    <div class="journey-heading"><div><p class="eyebrow">EVU-zu-EVU</p><h2>Kooperationsverträge</h2></div><span class="state-word">${state.contracts.length} geladen</span></div>
    <label class="m12-filter"><span>Vertragsansicht</span><select id="m12-contract-view"><option value="actionable"${state.contractPageView === "actionable" ? " selected" : ""}>Offen und laufend</option><option value="archive"${state.contractPageView === "archive" ? " selected" : ""}>Abgeschlossenes Archiv</option></select></label>
    <form id="m12-contract-form" class="m12-form" data-preserve-draft>
      <label class="m12-field"><span>Leistungsart</span><select id="m12-contract-type" name="contractType">${Object.entries(CONTRACT_LABELS).map(([value, label]) => `<option value="${value}"${state.contractType === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
      <label class="m12-field"><span>Empfangendes EVU</span><select name="offereeOperatorId" required>${targetOperators.map((operator) => `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.name)}</option>`).join("")}</select></label>
      <div class="resource-provenance">Auswahl aus dem bestätigten Weltstand${state.resources?.fleetRevision === null || state.resources?.fleetRevision === undefined ? "" : ` <details><summary>Technische Details</summary><code>Flottenrevision ${state.resources.fleetRevision}</code></details>`}</div>
      ${subjectFields(state.contractType, state.resources)}
      ${field("termsSummary", "Vereinbarte Leistung / Qualität")}
      ${field("priceEuros", "Entgelt · Euro", { value: "0,00" })}
      ${field("responseHours", "Antwort innerhalb · Stunden", { type: "number", min: 0, value: "1" })}
      ${field("startsInHours", "Beginn in · Stunden", { type: "number", min: 0, value: "2" })}
      ${field("durationDays", "Laufzeit · Tage", { type: "number", min: 1, value: "7" })}
      ${field("terminationMinutes", "Kündigungsfrist · Minuten", { type: "number", min: 0, value: "60" })}
      <button type="submit"${targetOperators.length === 0 || !resourcesAvailable ? " disabled" : ""}>Verbindliches Angebot senden</button>
      ${resourcesAvailable ? "" : '<p class="resource-empty">Das Angebot kann erst gesendet werden, wenn alle benötigten Ressourcen im autoritativen Weltstand verfügbar sind.</p>'}
    </form>
    <div class="m12-list">${contracts}</div>${state.contracts.length >= MAX_RENDERED_COOPERATION_ITEMS ? '<p class="m12-empty">Die Darstellungsgrenze ist erreicht. Wechseln Sie zwischen laufenden Vorgängen und Archiv, um den Bestand weiter einzugrenzen.</p>' : state.contractNextCursor === null ? "" : '<button id="m12-contract-more" class="secondary" type="button">Weitere Verträge laden</button>'}
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

function conditionPercent(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? `${(value / 100).toLocaleString("de-DE")} %` : "Unbekannt";
}

function odometerKilometres(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return "Unbekannt";
  return `${(BigInt(value) / 1_000n).toLocaleString("de-DE")} km`;
}

function disclosedValue(disclosure: Readonly<Record<string, unknown>>, key: string): unknown {
  if (disclosure[key] !== undefined) return disclosure[key];
  const configuration = disclosure["actualConfiguration"];
  return typeof configuration === "object" && configuration !== null && !Array.isArray(configuration)
    ? (configuration as Readonly<Record<string, unknown>>)[key] : undefined;
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
    return `<form id="listing-reversal-${escapeHtml(listing.id)}" class="reversal-request" data-preserve-draft data-listing-reversal="${escapeHtml(listing.id)}"><label><span>Bestätigter Mangelgrund</span><input name="reasonCode" minlength="1" maxlength="200" autocomplete="off" required placeholder="Begründung aus dem Mangelbeleg"></label><button class="secondary danger-action" type="submit">Rückabwicklung beantragen</button><small>Ausführung nur mit einem zeitlich und fachlich passenden Mangelbeleg.</small></form>`;
  }
  return "";
}

function listingCard(state: CooperationSurfaceState, listing: VehicleMarketListingView): string {
  const disclosure = listing.disclosure;
  return `<article class="m12-item market-item status-${escapeHtml(listing.status)}" id="listing-${escapeHtml(listing.id)}" tabindex="-1">
    <div class="m12-item-head"><div><strong>${escapeHtml(String(disclosure["classDesignation"] ?? "Baureihe unbekannt"))}</strong><small>${listing.listingType === "sale" ? "Verkauf" : "Vermietung"} von ${escapeHtml(operatorName(state, listing.offeringOperatorId))}</small></div><span class="state-word">${escapeHtml(LISTING_STATUS[listing.status])}</span></div>
    <dl><div><dt>Preis</dt><dd>${escapeHtml(formatCents(listing.priceCents))}</dd></div><div><dt>Zustand</dt><dd>${escapeHtml(conditionPercent(disclosure["conditionBasisPoints"]))}</dd></div><div><dt>Laufleistung</dt><dd>${escapeHtml(odometerKilometres(disclosure["odometerMetres"]))}</dd></div><div><dt>Schäden</dt><dd>${escapeHtml(disclosureList(disclosure["damages"], "Keine offengelegt"))}</dd></div><div><dt>Wartungsfristen</dt><dd>${escapeHtml(disclosureList(disclosure["maintenanceDeadlines"], "Keine offengelegt"))}</dd></div><div><dt>Zulassung</dt><dd>${escapeHtml(compatibilityExplanation(disclosure))}</dd></div><div><dt>Technischer Beleg</dt><dd><details><summary>Technische Details</summary><dl><div><dt>Fahrzeugkennung</dt><dd><code>${escapeHtml(listing.vehicleId)}</code></dd></div><div><dt>Fachrevision</dt><dd><code>${listing.revision}</code></dd></div><div><dt>Release</dt><dd><code>${escapeHtml(String(disclosure["authorityReleaseId"] ?? "nicht angegeben"))}</code></dd></div><div><dt>Offenlegungsbeleg</dt><dd><code>${escapeHtml(listing.disclosureHash)}</code></dd></div></dl></details></dd></div></dl>
    <div class="m12-actions">${listingActions(state, listing)}<button class="secondary" type="button" data-vehicle-history="${escapeHtml(listing.vehicleId)}">Lebenslauf ansehen</button></div>
  </article>`;
}

function historySurface(state: CooperationSurfaceState): string {
  if (state.selectedVehicleHistory === undefined) return "";
  const entries = state.selectedVehicleHistory.map((event) => `<li><span>${escapeHtml(formatRelativeS(event.atS, state.atS))}</span><strong>${escapeHtml(HISTORY_LABELS[event.eventType])}</strong><details><summary>Technische Details</summary><code>${escapeHtml(event.resultingHistoryHash)}</code></details></li>`).join("");
  return `<section class="vehicle-history"><div class="journey-heading"><h3>Unveränderlicher Fahrzeuglebenslauf</h3></div><ol>${entries || "<li>Keine Historieneinträge.</li>"}</ol></section>`;
}

function compatibilityExplanation(disclosure: Readonly<Record<string, unknown>>): string {
  const incompatible = disclosureList(disclosure["incompatibilities"], "");
  if (incompatible !== "") return `Nicht kompatibel: ${incompatible}`;
  const approvals = disclosureList(disclosure["approvals"], "");
  return approvals === "" ? "Kompatibilität nicht belegt; vor Einsatz prüfen" : `Freigegeben: ${approvals}`;
}

function robustnessExplanation(disclosure: Readonly<Record<string, unknown>>): string {
  const damages = Array.isArray(disclosure["damages"]) ? disclosure["damages"].length : 0;
  const deadlines = Array.isArray(disclosure["maintenanceDeadlines"]) ? disclosure["maintenanceDeadlines"].length : 0;
  const condition = conditionPercent(disclosure["conditionBasisPoints"]);
  if (damages === 0 && deadlines === 0) return `${condition} Zustand · keine Schäden oder Wartungsfristen offengelegt`;
  return `${condition} Zustand · ${damages} Schadenhinweis${damages === 1 ? "" : "e"} · ${deadlines} Wartungsfrist${deadlines === 1 ? "" : "en"}`;
}

function marketSurface(state: CooperationSurfaceState): string {
  const filtered = state.listings.filter((listing) => listingMatches(listing, state.marketQuery)).slice(0, MAX_RENDERED_COOPERATION_ITEMS);
  const marketAlternatives = filtered.slice(0, 8).map((listing) => ({ id: listing.id, label: String(listing.disclosure["classDesignation"] ?? "Fahrzeugangebot"), dimensions: { price: formatCents(listing.priceCents), type: listing.listingType === "sale" ? "Fahrzeugkauf" : "Leasing", capacity: `${String(disclosedValue(listing.disclosure, "seats") ?? "–")} Sitzplätze`, condition: conditionPercent(listing.disclosure["conditionBasisPoints"]), mileage: odometerKilometres(listing.disclosure["odometerMetres"]), maintenance: disclosureList(listing.disclosure["maintenanceDeadlines"], "Keine Frist offengelegt"), robustness: robustnessExplanation(listing.disclosure), penaltyRisk: "Nicht berechenbar: noch kein Einsatzvertrag gebunden", compatibility: compatibilityExplanation(listing.disclosure), provenance: listing.disclosure["authorityReleaseId"] === undefined ? "Bestätigter Weltstand" : "Gepinnter Flottenrelease" } }));
  const pathAlternatives = (state.pathAlternatives ?? []).slice(0, 8).map((path) => ({ id: path.id, label: path.label, dimensions: { price: "Getrennte Trassenabrechnung", type: "Trassenalternative", capacity: "Vom Planner geprüft", condition: "Nicht anwendbar", mileage: "Nicht anwendbar", maintenance: "Nicht anwendbar", robustness: `Konfliktgeprüfte Zeitlage ${path.shift} · Reserve nicht separat ausgewiesen`, penaltyRisk: "Nicht berechenbar: noch kein Leistungsvertrag gebunden", compatibility: path.compatibility, provenance: path.provenance, shift: path.shift } }));
  const comparison = renderComparisonWorkbench("Fahrzeuge, Leasing und Trassen in dieser Welt", { type: "Entscheidungsart", price: "Kosten", capacity: "Kapazität", condition: "Zustand", mileage: "Laufleistung", maintenance: "Wartung", robustness: "Robustheit", penaltyRisk: "Pönalerisiko", shift: "Zeitlage", compatibility: "Zulassung und Kompatibilität", provenance: "Datenherkunft" }, [...marketAlternatives, ...pathAlternatives]);
  return `<section class="journey-card m12-card" id="vehicle-market">
    <div class="journey-heading"><div><p class="eyebrow">Persistenter Fahrzeugmarkt</p><h2>Angebot, Reservierung und Übergabe</h2></div><span class="state-word">${filtered.length} Treffer</span></div>
    <form id="m12-listing-form" class="m12-form compact-form" data-preserve-draft>
      <label class="m12-field"><span>Eigenes Fahrzeug</span><select name="vehicleId" required>${state.ownedVehicles.map((vehicle) => `<option value="${escapeHtml(vehicle.vehicleId)}">${escapeHtml(vehicle.classDesignation)} · Zustand ${conditionPercent(vehicle.conditionBasisPoints)}</option>`).join("")}</select></label>
      <label class="m12-field"><span>Angebotsart</span><select name="listingType"><option value="sale">Verkauf</option><option value="rental">Vermietung</option></select></label>
      ${field("priceEuros", "Preis · Euro", { value: "1,00" })}
      ${field("expiresInDays", "Angebotsdauer · Tage", { type: "number", min: 1, value: "1" })}
      ${field("rentalDurationDays", "Mietdauer · Tage (nur Vermietung)", { type: "number", min: 1, value: "7", required: false })}
      <button type="submit"${state.ownedVehicles.length === 0 ? " disabled" : ""}>Fahrzeug verbindlich anbieten</button>
    </form>
    <div class="m12-filter-row"><label class="m12-filter"><span>Marktansicht</span><select id="m12-listing-view"><option value="actionable"${state.listingPageView === "actionable" ? " selected" : ""}>Offen und reserviert</option><option value="archive"${state.listingPageView === "archive" ? " selected" : ""}>Abgeschlossenes Archiv</option></select></label><label class="m12-search"><span>Fahrzeugmarkt durchsuchen</span><input id="m12-market-query" type="search" value="${escapeHtml(state.marketQuery)}" placeholder="Baureihe, Fahrzeug, Zustand oder Schaden"></label></div>
    ${comparison}<div class="m12-list">${filtered.length === 0 ? `<p class="m12-empty">Keine Marktangebote entsprechen der Suche.</p>` : filtered.map((listing) => listingCard(state, listing)).join("")}</div>${state.listings.length >= MAX_RENDERED_COOPERATION_ITEMS ? '<p class="m12-empty">Die Darstellungsgrenze ist erreicht. Nutzen Sie Suche oder Archivansicht, um den Bestand weiter einzugrenzen.</p>' : state.listingNextCursor === null ? "" : '<button id="m12-listing-more" class="secondary" type="button">Weitere Marktangebote laden</button>'}
    ${historySurface(state)}
  </section>`;
}

function operationsSurface(state: CooperationSurfaceState): string {
  const formations = state.resources?.formations ?? [];
  const formationOptions = formations.map((formation) => `<option value="${escapeHtml(formation.id)}">${escapeHtml(formation.label)}</option>`).join("");
  const stationOptions = (state.stationOptions ?? []).map((station) => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.label)}</option>`).join("");
  const stationInput = (name: string, label: string) => `<label class="m12-field"><span>${label}</span><input name="${name}" list="planning-stations" required maxlength="200" autocomplete="off" placeholder="Betriebsstellenkennung"></label>`;
  const pathForm = (kind: "schedule" | "empty-run", title: string, leadMinutes: number) => `<form id="${kind === "schedule" ? "schedule-request-form" : "empty-run-request-form"}" class="m12-form compact-form" data-path-request="${kind}" data-preserve-draft><h3>${title}</h3><label class="m12-field"><span>Formation</span><select name="formationId" required>${formationOptions}</select></label><p class="form-hint">Die Zugnummer wird bei der Planung automatisch und eindeutig vergeben.</p>${stationInput("originStationId", "Start")}${stationInput("destinationStationId", "Ziel")}${field("departureInMinutes", "Abfahrt in Minuten", { type: "number", min: 1, value: String(leadMinutes) })}<button type="submit"${formations.length === 0 ? " disabled" : ""}>${kind === "schedule" ? "Fahrplan verbindlich anmelden" : "Leerfahrt konfliktgeprüft anfordern"}</button></form>`;
  return `<section class="journey-card m12-card" id="betriebsplanung"><div class="journey-heading"><div><p class="eyebrow">BETRIEB</p><h2>Fahrten und Werkstatt</h2></div><span class="state-word">servergeprüft</span></div><datalist id="planning-stations">${stationOptions}</datalist><div class="m12-operating-grid">${pathForm("schedule", "Fahrplan planen", 30)}${pathForm("empty-run", "Spontane Leerfahrt", 5)}<form id="maintenance-form" class="m12-form compact-form" data-preserve-draft><h3>Formation in die Werkstatt</h3><label class="m12-field"><span>Formation</span><select name="formationId" required>${formationOptions}</select></label>${field("durationHours", "Werkstattdauer · Stunden", { type: "number", min: 1, value: "4" })}<p class="resource-note">Die öffentliche Werkstatt wird gegen den autoritativen Flottenzustand und bestehende Belegungen geprüft.</p><button type="submit"${formations.length === 0 ? " disabled" : ""}>Werkstattauftrag verbindlich erteilen</button></form></div></section>`;
}

function tenderLabel(tender: PublicTenderView): string {
  return tender.serviceLines?.length
    ? tender.serviceLines.map((line) => `${line.designation} · ${line.origin} – ${line.destination}`).join(" / ")
    : `Los ${tender.lotId}`;
}

export function renderCooperationSurface(state: CooperationSurfaceState): string {
  if (state.activeOperatorId === "") {
    return `<section class="journey-card m12-card" id="evu-gruenden" tabindex="-1"><p class="eyebrow">IHR UNTERNEHMEN</p><h2>EVU gründen</h2><p>Wählen Sie den sichtbaren Namen Ihres Eisenbahnverkehrsunternehmens. Die Gründung und das Startkapital werden serverseitig gemeinsam gebucht.</p><form id="operator-foundation-form" data-preserve-draft><label class="m12-field"><span>Name des EVU</span><input name="name" minlength="1" maxlength="64" required autocomplete="organization" placeholder="z. B. Elbe-Saale-Bahn"></label><button type="submit"${state.busy ? " disabled" : ""}>EVU verbindlich gründen</button></form></section>`;
  }
  const own = state.operators.filter((operator) => state.ownOperatorIds.includes(operator.id));
  const openTenders = state.tendersUnavailable ? [] : (state.tenders ?? []).filter((tender) => tender.phase === "open");
  const ownFormationOptions = (state.resources?.formations ?? []).map((formation) => `<option value="own:${escapeHtml(formation.id)}" data-lot-id="">Eigene Formation · ${escapeHtml(formation.label)}</option>`).join("");
  const facilityOptions = (state.resources?.publicEntryFacilities ?? []).map((facility) => `<option value="public:${escapeHtml(facility.id)}" data-lot-id="${escapeHtml(facility.lotId)}">${escapeHtml(facility.label)}</option>`).join("");
  const resourcesReady = !state.busy && state.resources?.fleetRevision !== null && state.resources?.fleetRevision !== undefined && state.resources.fleetSnapshotHash !== null;
  const initialLotId = openTenders[0]?.lotId ?? "";
  const hasInitialTenderFormation = ownFormationOptions !== "" || (state.resources?.publicEntryFacilities ?? []).some((facility) => facility.lotId === initialLotId);
  const tenderSurface = state.tendersUnavailable
    ? '<section class="journey-card m12-card" id="ausschreibungen"><h2>Ausschreibungen</h2><p role="alert">Ausschreibungen konnten nicht geladen werden. Bitte den Arbeitsraum aktualisieren.</p></section>'
    : `<section class="journey-card m12-card" id="ausschreibungen"><div class="journey-heading"><div><p class="eyebrow">VERKEHRSVERTRÄGE</p><h2>An Ausschreibung teilnehmen</h2></div><span class="state-word">${openTenders.length} offen</span></div>${openTenders.length === 0 ? '<p class="m12-empty">Derzeit ist keine Ausschreibung zur Angebotsabgabe geöffnet.</p>' : `<form id="tender-bid-form" class="m12-form" data-preserve-draft><label class="m12-field"><span>Ausschreibung</span><select id="tender-bid-tender" name="tenderId">${openTenders.map((tender) => `<option value="${escapeHtml(tender.id)}" data-lot-id="${escapeHtml(tender.lotId)}">${escapeHtml(tenderLabel(tender))} · ${tender.bidCount} Angebot(e)</option>`).join("")}</select></label><label class="m12-field"><span>Betriebsbereitstellung</span><select id="tender-bid-formation" name="formationId">${ownFormationOptions}${facilityOptions}</select></label>${facilityOptions === "" ? "" : '<p class="resource-note">Der öffentliche Anschubvertrag ist ein zuschlagsgebundener Wet-Lease. Erst bei Zuschlag werden Formation, Personal und Trasse bereitgestellt; die Betriebskosten trägt Ihr EVU.</p>'}${field("orderingFeeEuros", "Bestellentgelt · Euro je Zug-km", { value: "10,00" })}${field("punctualityPercent", "Pünktlichkeitszusage · Prozent", { type: "number", min: 0, value: "95" })}${field("extraSeats", "Zusätzliche Sitzplätze", { type: "number", min: 0, value: "0" })}<button id="tender-bid-submit" type="submit" data-resources-ready="${resourcesReady}"${!resourcesReady || !hasInitialTenderFormation ? " disabled" : ""}>Angebot verbindlich abgeben</button></form>`}</section>`;
  const section = state.section ?? "all";
  const panels = section === "markets"
    ? `${tenderSurface}${contractSurface(state)}${marketSurface(state)}`
    : section === "operations"
      ? operationsSurface(state)
      : `${tenderSurface}${operationsSurface(state)}${contractSurface(state)}${marketSurface(state)}`;
  const operatorPicker = section === "all"
    ? `<label><span>Handelndes EVU in ${escapeHtml(state.worldName)}</span><select id="m12-operator">${own.map((operator) => `<option value="${escapeHtml(operator.id)}"${operator.id === state.activeOperatorId ? " selected" : ""}>${escapeHtml(operator.name)}</option>`).join("")}</select></label>`
    : "";
  const html = `<section class="m12-surface m12-surface--${section}" aria-busy="${state.busy}">
    <div class="m12-toolbar">${operatorPicker}<div class="m12-clock"><span>Synchronisierte Weltzeit</span><output id="m12-time">Betriebstag ${Math.floor(state.atS / 86_400) + 1}</output></div><button id="m12-refresh" class="secondary" type="button">Arbeitsraum aktualisieren</button></div>
    <div class="m12-grid">${panels}</div>
  </section>`;
  return state.busy ? html.replace(/<button(?![^>]*\bdisabled\b)/g, '<button disabled aria-disabled="true"') : html;
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
  const tender = root.querySelector<HTMLSelectElement>("#tender-bid-tender");
  const formation = root.querySelector<HTMLSelectElement>("#tender-bid-formation");
  const submit = root.querySelector<HTMLButtonElement>("#tender-bid-submit");
  const syncTenderFacilities = (): void => {
    if (tender === null || formation === null) return;
    const lotId = tender.selectedOptions[0]?.dataset["lotId"] ?? "";
    let firstEnabled: HTMLOptionElement | undefined;
    for (const option of formation.options) {
      const enabled = option.dataset["lotId"] === "" || option.dataset["lotId"] === lotId;
      option.disabled = !enabled;
      option.hidden = !enabled;
      if (enabled && firstEnabled === undefined) firstEnabled = option;
    }
    if (formation.selectedOptions[0]?.disabled === true && firstEnabled !== undefined) formation.value = firstEnabled.value;
    if (submit !== null) submit.disabled = submit.dataset["resourcesReady"] !== "true" || firstEnabled === undefined;
  };
  tender?.addEventListener("change", syncTenderFacilities);
  syncTenderFacilities();
  root.querySelector<HTMLFormElement>("#operator-foundation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    invoke(() => actions.createOperator?.(String(new FormData(event.currentTarget as HTMLFormElement).get("name") ?? "").trim()));
  });
  root.querySelector<HTMLFormElement>("#tender-bid-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.submitTenderBid?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelectorAll<HTMLFormElement>("[data-path-request]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    invoke(() => actions.submitPathRequest?.(form.dataset["pathRequest"] as "schedule" | "empty-run", formFields(form)));
  }));
  root.querySelector<HTMLFormElement>("#maintenance-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.scheduleMaintenance?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelector<HTMLSelectElement>("#m12-operator")?.addEventListener("change", (event) => invoke(() => actions.changeOperator?.((event.currentTarget as HTMLSelectElement).value)));
  root.querySelector<HTMLSelectElement>("#m12-contract-type")?.addEventListener("change", (event) => actions.changeContractType?.((event.currentTarget as HTMLSelectElement).value as ContractType));
  root.querySelector<HTMLInputElement>("#m12-market-query")?.addEventListener("change", (event) => actions.changeMarketQuery?.((event.currentTarget as HTMLInputElement).value));
  root.querySelector<HTMLSelectElement>("#m12-contract-view")?.addEventListener("change", (event) => invoke(() => actions.changeContractPageView?.((event.currentTarget as HTMLSelectElement).value as CooperationPageView)));
  root.querySelector<HTMLSelectElement>("#m12-listing-view")?.addEventListener("change", (event) => invoke(() => actions.changeListingPageView?.((event.currentTarget as HTMLSelectElement).value as CooperationPageView)));
  root.querySelector<HTMLButtonElement>("#m12-contract-more")?.addEventListener("click", () => invoke(actions.loadMoreContracts));
  root.querySelector<HTMLButtonElement>("#m12-listing-more")?.addEventListener("click", () => invoke(actions.loadMoreListings));
  root.querySelector<HTMLButtonElement>("#m12-refresh")?.addEventListener("click", () => invoke(actions.refresh));
  root.querySelector<HTMLFormElement>("#m12-contract-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.offerContract?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelector<HTMLFormElement>("#m12-listing-form")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.createListing?.(formFields(event.currentTarget as HTMLFormElement))); });
  root.querySelectorAll<HTMLElement>("[data-contract-response]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.respondToContract?.(element.dataset["contractId"]!, element.dataset["contractResponse"] as "accept" | "reject"))));
  root.querySelectorAll<HTMLElement>("[data-contract-end]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.endContract?.(element.dataset["contractEnd"]!, false))));
  root.querySelectorAll<HTMLElement>("[data-contract-non-performance]").forEach((element) => element.addEventListener("click", () => {
    const contractId = element.dataset["contractNonPerformance"]!;
    const serviceDay = root.querySelector<HTMLInputElement>(`[data-contract-evidence-day="${contractId}"]`)?.value.trim() ?? "";
    invoke(() => actions.endContract?.(contractId, true, serviceDay === "" ? undefined : `daily-operation-report/v1:${serviceDay}`));
  }));
  root.querySelectorAll<HTMLElement>("[data-listing-reserve]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.reserveListing?.(element.dataset["listingReserve"]!, integerDataset(element.dataset["revision"])))));
  root.querySelectorAll<HTMLElement>("[data-listing-transfer]").forEach((element) => element.addEventListener("click", () => invoke(() => actions.transferListing?.(element.dataset["listingTransfer"]!, integerDataset(element.dataset["revision"])))));
  root.querySelectorAll<HTMLFormElement>("[data-listing-reversal]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const reasonCode = String(new FormData(form).get("reasonCode") ?? "").trim();
    if (reasonCode !== "") invoke(() => actions.reverseListing?.(form.dataset["listingReversal"]!, reasonCode));
  }));
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
  const responseDeadlineS = addSeconds(offeredAtS, secondsFromUnits(fields["responseHours"] ?? "", 3_600, "Antwortfrist"), "Antwortfrist");
  const validFromS = addSeconds(offeredAtS, secondsFromUnits(fields["startsInHours"] ?? "", 3_600, "Gültigkeitsbeginn"), "Gültigkeitsbeginn");
  const validUntilS = addSeconds(validFromS, secondsFromUnits(fields["durationDays"] ?? "", 86_400, "Laufzeit"), "Gültigkeitsende");
  const terminationNoticeS = secondsFromUnits(fields["terminationMinutes"] ?? "", 60, "Kündigungsfrist");
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
