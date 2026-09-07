import { railwayTabs } from "@zugfolge/design-system";
import { routeImportMarkup } from "./route-import.js";
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
  VehicleRegistryEntryView,
  VehicleRegistryEventView,
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
  readonly marketType?: "all" | "sale" | "rental";
  readonly marketSort?: "newest" | "price" | "deadline";
  readonly vehicleRegistry?: readonly VehicleRegistryEntryView[];
  readonly registryQuery?: string;
  readonly registryNextCursor?: string | null;
  readonly selectedVehiclePassport?: VehicleRegistryEntryView;
  readonly vehicleRegistryHistory?: readonly VehicleRegistryEventView[];
  readonly registryHistoryNextCursor?: string | null;
  readonly registryHistoryPage?: number;
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
  readonly changeMarketType?: (value: "all" | "sale" | "rental") => void;
  readonly changeMarketSort?: (value: "newest" | "price" | "deadline") => void;
  readonly changeRegistryQuery?: (value: string) => void | Promise<void>;
  readonly loadMoreRegistry?: () => void | Promise<void>;
  readonly loadMoreRegistryHistory?: () => void | Promise<void>;
  readonly loadPreviousRegistryHistory?: () => void | Promise<void>;
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

function field(name: string, label: string, options: { readonly type?: string; readonly value?: string; readonly min?: number; readonly max?: number; readonly required?: boolean } = {}): string {
  return `<label class="m12-field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="${escapeHtml(options.type ?? "text")}" value="${escapeHtml(options.value ?? "")}"${options.min === undefined ? "" : ` min="${options.min}"`}${options.max === undefined ? "" : ` max="${options.max}"`}${options.required === false ? "" : " required"}></label>`;
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
  return state.operators.find((operator) => operator.id === operatorId)?.name ?? "Unbekanntes Unternehmen";
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
  const contracts = visibleContracts.length === 0 ? `<p class="m12-empty">Noch keine Zusammenarbeit. Erstelle ein Angebot, um mit anderen Unternehmen gemeinsam zu fahren.</p>` : visibleContracts.map((contract) => contractCard(state, contract)).join("");
  return `<section class="journey-card m12-card" id="cooperation-contracts">
    <div class="journey-heading"><div><p class="eyebrow">GEMEINSAM WEITERKOMMEN</p><h2>Deine Zusammenarbeit</h2></div><span class="state-word">${state.contracts.length} geladen</span></div>
    <label class="m12-filter"><span>Vertragsansicht</span><select id="m12-contract-view"><option value="actionable"${state.contractPageView === "actionable" ? " selected" : ""}>Offen und laufend</option><option value="archive"${state.contractPageView === "archive" ? " selected" : ""}>Abgeschlossenes Archiv</option></select></label>
    <details class="market-compose" data-preserve-disclosure="contract-compose"><summary>Neues Kooperationsangebot</summary><form id="m12-contract-form" class="m12-form" data-preserve-draft>
      <label class="m12-field"><span>Leistungsart</span><select id="m12-contract-type" name="contractType">${Object.entries(CONTRACT_LABELS).map(([value, label]) => `<option value="${value}"${state.contractType === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
      <label class="m12-field"><span>Partnerunternehmen</span><select name="offereeOperatorId" required>${targetOperators.map((operator) => `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.name)}</option>`).join("")}</select></label>
      <div class="resource-provenance">Auswahl aus dem bestätigten Weltstand${state.resources?.fleetRevision === null || state.resources?.fleetRevision === undefined ? "" : ` <details><summary>Technische Details</summary><code>Flottenrevision ${state.resources.fleetRevision}</code></details>`}</div>
      ${subjectFields(state.contractType, state.resources)}
      ${field("termsSummary", "Vereinbarte Leistung / Qualität")}
      ${field("priceEuros", "Entgelt · Euro", { value: "0,00" })}
      ${field("responseHours", "Antwort innerhalb · Stunden", { type: "number", min: 0, value: "1" })}
      ${field("startsInHours", "Beginn in · Stunden", { type: "number", min: 0, value: "2" })}
      ${field("durationDays", "Laufzeit · Tage", { type: "number", min: 1, value: "7" })}
      ${field("terminationMinutes", "Kündigungsfrist · Minuten", { type: "number", min: 0, value: "60" })}
      <button type="submit"${targetOperators.length === 0 || !resourcesAvailable ? " disabled" : ""}>Verbindliches Angebot senden</button>
      ${resourcesAvailable ? "" : '<p class="resource-empty">Für dieses Angebot brauchst du noch passende Fahrzeuge oder Leistungen.</p>'}
    </form></details>
    <div class="m12-list">${contracts}</div>${state.contracts.length >= MAX_RENDERED_COOPERATION_ITEMS ? '<p class="m12-empty">Viele Verträge auf einmal? Wechsle zwischen offenen Vorgängen und Archiv.</p>' : state.contractNextCursor === null ? "" : '<button id="m12-contract-more" class="secondary" type="button">Weitere Verträge laden</button>'}
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

function listingMatches(state: CooperationSurfaceState, listing: VehicleMarketListingView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("de");
  if (needle === "") return true;
  return `${listing.vehicleId} ${JSON.stringify(listing.disclosure)} ${listing.listingType === "sale" ? "Kauf Verkauf" : "Miete Vermietung"} ${LISTING_STATUS[listing.status]} ${operatorName(state, listing.offeringOperatorId)}`.toLocaleLowerCase("de").includes(needle);
}

function listingActions(state: CooperationSurfaceState, listing: VehicleMarketListingView): string {
  if (state.activeOperatorId === "") return '<p class="market-note">Gründe ein Unternehmen, um Fahrzeuge zu übernehmen.</p>';
  const own = listing.offeringOperatorId === state.activeOperatorId;
  if (own && listing.status === "reserved") return '<span class="market-note">Für ein anderes Unternehmen reserviert</span>';
  if (own && listing.status === "open" && listing.expiresAtS > state.atS) {
    return `<button class="secondary" type="button" data-listing-cancel="${escapeHtml(listing.id)}" data-revision="${listing.revision}">Angebot zurückziehen</button>`;
  }
  if (listing.status === "open" && listing.expiresAtS > state.atS) {
    return `<button type="button" data-listing-reserve="${escapeHtml(listing.id)}" data-revision="${listing.revision}">10 Minuten reservieren</button>`;
  }
  if (listing.status === "reserved" && listing.reservedByOperatorId === state.activeOperatorId && (listing.reservedUntilS === undefined || listing.reservedUntilS === null || listing.reservedUntilS > state.atS)) {
    return `<button type="button" data-listing-transfer="${escapeHtml(listing.id)}" data-revision="${listing.revision}">${listing.listingType === "sale" ? "Verbindlich kaufen" : "Verbindlich mieten"}</button>`;
  }
  if (listing.status === "transferred" && listing.reservedByOperatorId === state.activeOperatorId) {
    return `<form id="listing-reversal-${escapeHtml(listing.id)}" class="reversal-request" data-preserve-draft data-listing-reversal="${escapeHtml(listing.id)}"><label><span>Bestätigter Mangelgrund</span><input name="reasonCode" minlength="1" maxlength="200" autocomplete="off" required placeholder="Begründung aus dem Mangelbeleg"></label><button class="secondary danger-action" type="submit">Rückabwicklung beantragen</button><small>Ausführung nur mit einem zeitlich und fachlich passenden Mangelbeleg.</small></form>`;
  }
  return "";
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

export function marketDeadline(targetS: unknown, atS: number): string {
  if (typeof targetS !== "number" || !Number.isSafeInteger(targetS) || targetS < 0) return "Frist nicht belegt";
  const delta = targetS - atS;
  const absolute = Math.abs(delta);
  const days = Math.floor(absolute / 86_400);
  const hours = Math.floor(absolute % 86_400 / 3_600);
  const minutes = Math.floor(absolute % 3_600 / 60);
  const duration = absolute < 60 ? "unter 1 Min." : absolute < 3_600 ? `${minutes} Min.` : absolute < 86_400 ? `${hours} Std.${minutes === 0 ? "" : ` ${minutes} Min.`}` : `${days} Tag${days === 1 ? "" : "en"}${hours === 0 ? "" : ` ${hours} Std.`}`;
  const clock = `${String(Math.floor(targetS % 86_400 / 3_600)).padStart(2, "0")}:${String(Math.floor(targetS % 3_600 / 60)).padStart(2, "0")}`;
  return `Tag ${Math.floor(targetS / 86_400) + 1}, ${clock} · ${delta === 0 ? "jetzt fällig" : delta < 0 ? `seit ${duration} fällig` : `in ${duration}`}`;
}

function maintenanceSummary(disclosure: Readonly<Record<string, unknown>>, atS: number): string {
  const deadlines = disclosure["maintenanceDeadlines"];
  if (!Array.isArray(deadlines)) return "Fristen nicht belegt";
  if (deadlines.length === 0) return "Keine Fristen offengelegt";
  const times = deadlines.map((entry) => recordValue(entry)["dueAtS"]).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  if (times.length === 0) return `${deadlines.length} Frist${deadlines.length === 1 ? "" : "en"} · Termin nicht belegt`;
  const nearest = Math.min(...times);
  return `${nearest <= atS ? "Wartung fällig" : "Nächste Wartung"} · ${marketDeadline(nearest, atS)}`;
}

function vehicleCondition(disclosure: Readonly<Record<string, unknown>>): string {
  const profile = recordValue(disclosure["conditionProfile"]);
  return `<div class="vehicle-condition">${[["Mechanik", "mechanicsBasisPoints"], ["Antrieb", "driveBasisPoints"], ["Bremsen", "brakesBasisPoints"]].map(([label, key]) => `<div><span>${label}</span><strong>${conditionPercent(profile[key!])}</strong></div>`).join("")}</div>`;
}

function vehicleDisclosure(disclosure: Readonly<Record<string, unknown>>, atS: number): string {
  const deadlines = disclosure["maintenanceDeadlines"];
  const damages = disclosure["damages"];
  const deadlineList = !Array.isArray(deadlines) ? "Fristen nicht belegt" : deadlines.length === 0 ? "Keine Fristen offengelegt" : `<ul>${deadlines.map((entry) => { const deadline = recordValue(entry); return `<li><strong>${escapeHtml(deadline["kind"] ?? deadline["code"] ?? "Wartung")}</strong><span>${escapeHtml(marketDeadline(deadline["dueAtS"], atS))}</span>${deadline["dueOdometerMetres"] === undefined ? "" : `<span>bei ${escapeHtml(odometerKilometres(deadline["dueOdometerMetres"]))}</span>`}</li>`; }).join("")}</ul>`;
  const damageList = !Array.isArray(damages) ? "Schäden nicht belegt" : damages.length === 0 ? "Keine Schäden offengelegt" : `<ul>${damages.map((entry) => { const damage = recordValue(entry); return `<li><strong>${escapeHtml(damage["description"] ?? damage["code"] ?? "Schadenhinweis")}</strong>${damage["severity"] === undefined ? "" : `<span>Schweregrad: ${escapeHtml(damage["severity"])}</span>`}</li>`; }).join("")}</ul>`;
  return `${vehicleCondition(disclosure)}<div class="vehicle-pass-grid"><section><h4>Wartung & Fristen</h4>${deadlineList}</section><section><h4>Offengelegte Schäden</h4>${damageList}</section><section><h4>Ausstattung & Einsatz</h4><dl><div><dt>Sitzplätze</dt><dd>${escapeHtml(disclosedValue(disclosure, "seats") ?? "Nicht belegt")}</dd></div><div><dt>Zulassung</dt><dd>${escapeHtml(compatibilityExplanation(disclosure))}</dd></div><div><dt>Betriebliche Grenzen</dt><dd>${escapeHtml(disclosureList(disclosure["operatingLimits"], "Keine offengelegt"))}</dd></div></dl></section></div>`;
}

function listingPriceNote(listing: VehicleMarketListingView, atS: number): string {
  if (listing.listingType === "rental") return `Gesamtmiete · Mietende ${marketDeadline(listing.rentalValidUntilS, atS)}`;
  const value = listing.disclosure["valueCents"];
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "Einmaliger Kaufpreis · Fahrzeugwert nicht belegt";
  return `Einmaliger Kaufpreis · Fahrzeugwert ${formatCents(value)}`;
}

function listingCard(state: CooperationSurfaceState, listing: VehicleMarketListingView): string {
  const disclosure = listing.disclosure;
  const reserved = listing.status === "reserved";
  const status = reserved && listing.reservedByOperatorId === state.activeOperatorId ? "Für dich reserviert" : LISTING_STATUS[listing.status];
  const deadline = reserved ? listing.reservedUntilS : listing.expiresAtS;
  const damageCount = Array.isArray(disclosure["damages"]) ? disclosure["damages"].length : undefined;
  return `<article class="m12-item market-item status-${escapeHtml(listing.status)}" id="listing-${escapeHtml(listing.id)}" tabindex="-1">
    <div class="market-trade-row"><div class="market-identity"><span class="market-kind">${listing.listingType === "sale" ? "KAUF" : "MIETE"}</span><h3>${escapeHtml(String(disclosure["classDesignation"] ?? "Baureihe unbekannt"))}</h3><small>${escapeHtml(listing.vehicleId)} · ${escapeHtml(operatorName(state, listing.offeringOperatorId))}</small></div><div class="market-quote"><strong>${escapeHtml(formatCents(listing.priceCents))}</strong><small>${escapeHtml(listingPriceNote(listing, state.atS))}</small></div><div class="market-condition"><strong>${escapeHtml(conditionPercent(disclosure["conditionBasisPoints"]))}</strong><small>Zustand · ${damageCount === undefined ? "Schäden nicht belegt" : `${damageCount} Schadenhinweise`}</small></div><div class="market-mileage"><strong>${escapeHtml(odometerKilometres(disclosure["odometerMetres"]))}</strong><small>${escapeHtml(String(disclosedValue(disclosure, "seats") ?? "–"))} Sitzplätze</small></div></div>
    <div class="market-decision"><span class="state-word">${escapeHtml(status)}</span><span>${reserved ? "Reservierung" : "Angebotsende"}: ${escapeHtml(marketDeadline(deadline, state.atS))}</span><span>${escapeHtml(maintenanceSummary(disclosure, state.atS))}</span></div>
    <details class="vehicle-offer-disclosure" data-preserve-disclosure="offer-${escapeHtml(listing.id)}"><summary id="offer-pass-${escapeHtml(listing.id)}">Zustand, Fristen & Ausstattung prüfen</summary>${vehicleDisclosure(disclosure, state.atS)}<details class="vehicle-technical" data-preserve-disclosure="technical-${escapeHtml(listing.id)}"><summary>Technische Details</summary><dl><div><dt>Release</dt><dd><code>${escapeHtml(String(disclosure["authorityReleaseId"] ?? "nicht angegeben"))}</code></dd></div><div><dt>Fachrevision</dt><dd>${listing.revision}</dd></div><div><dt>Offenlegungsbeleg</dt><dd><code>${escapeHtml(listing.disclosureHash)}</code></dd></div></dl></details></details>
    <div class="m12-actions">${listingActions(state, listing)}<button id="history-${escapeHtml(listing.id)}" class="secondary" type="button" data-vehicle-history="${escapeHtml(listing.vehicleId)}">Fahrzeugpass & Lebenslauf</button></div>
  </article>`;
}

function historySurface(state: CooperationSurfaceState): string {
  if (state.selectedVehicleHistory === undefined) return "";
  const transactions = state.selectedVehicleHistory.filter((event) => event.eventType !== "registered" && event.eventType !== "condition-updated");
  if (transactions.length === 0) return "";
  const entries = transactions.map((event) => {
    const details = event.details;
    const from = details["fromOwnerOperatorId"] ?? details["fromHolderOperatorId"];
    const to = details["toOwnerOperatorId"] ?? details["toHolderOperatorId"];
    const parties = typeof from === "string" && typeof to === "string" ? `${operatorName(state, from)} → ${operatorName(state, to)}` : "";
    return `<li><span>Tag ${Math.floor(event.atS / 86_400) + 1}</span><div><strong>${escapeHtml(HISTORY_LABELS[event.eventType])}</strong>${parties === "" ? "" : `<p>${escapeHtml(parties)}</p>`}${typeof details["priceCents"] === "string" && /^\d+$/.test(details["priceCents"]) ? `<p>${escapeHtml(formatCents(details["priceCents"]))}</p>` : ""}</div><details><summary>Technische Details</summary><code>${escapeHtml(event.resultingHistoryHash)}</code></details></li>`;
  }).join("");
  return `<section class="vehicle-history"><div class="journey-heading"><h3>Handel & Überlassung</h3></div><p class="market-note">Jeder Eintrag gehört zu demselben Fahrzeug. Besitzwechsel und Rückgaben setzen seinen Lebenslauf nicht zurück.</p><ol>${entries}</ol></section>`;
}

export function vehiclePassportFragment(vehicleId: string): string {
  return `#vehicle-${encodeURIComponent(vehicleId)}`;
}

function registryEventSummary(state: CooperationSurfaceState, event: VehicleRegistryEventView): string {
  const source = recordValue(event.details["source"]);
  const holding = recordValue(event.details["holding"]);
  const condition = recordValue(source["condition"]);
  const owner = holding["ownerOperatorId"];
  const holder = holding["holderOperatorId"];
  const lines: string[] = [];
  if (typeof owner === "string") lines.push(`Eigentümer: ${operatorName(state, owner)}`);
  if (typeof holder === "string") lines.push(`Halter: ${operatorName(state, holder)}`);
  if (Object.keys(condition).length > 0) {
    lines.push(`Mechanik ${conditionPercent(condition["mechanicsBasisPoints"])} · Antrieb ${conditionPercent(condition["driveBasisPoints"])} · Bremsen ${conditionPercent(condition["brakesBasisPoints"])}`);
    if (typeof condition["kilometresSinceMaintenance"] === "number") lines.push(`${condition["kilometresSinceMaintenance"].toLocaleString("de-DE")} km seit der letzten Wartung`);
    if (typeof condition["openObservations"] === "number") lines.push(`${condition["openObservations"]} offene Befunde`);
  }
  const deadlines = source["maintenanceDeadlines"];
  if (Array.isArray(deadlines)) for (const deadline of deadlines) {
    const value = recordValue(deadline);
    lines.push(`${String(value["kind"] ?? "Wartung")}: ${marketDeadline(value["dueAt"], event.atS)}`);
  }
  if (Array.isArray(source["history"])) for (const item of source["history"]) if (typeof item === "string") lines.push(item);
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function registrySurface(state: CooperationSurfaceState): string {
  const entries = state.vehicleRegistry;
  const listing = entries === undefined ? '<p class="m12-empty">Das Fahrzeugregister wird geladen …</p>' : entries.length === 0 ? '<p class="m12-empty">Keine Fahrzeuge für diese Suche gefunden.</p>' : `<div class="vehicle-register-list">${entries.map((vehicle) => `<button class="vehicle-register-entry secondary" type="button" data-vehicle-history="${escapeHtml(vehicle.vehicleId)}"><span><strong>${escapeHtml(vehicle.classDesignation)}</strong><small>${escapeHtml(vehicle.vehicleId)}</small></span><span>${escapeHtml(operatorName(state, vehicle.ownerOperatorId))}</span><span class="state-word">${vehicle.retiredAtS !== null && vehicle.retiredAtS <= state.atS ? "Ausgemustert" : vehicle.introducedAtS > state.atS ? "Noch nicht geliefert" : vehicle.holderOperatorId !== vehicle.ownerOperatorId ? "Vermietet" : "Im Bestand"}</span><span aria-hidden="true">→</span></button>`).join("")}</div>`;
  const selected = state.selectedVehiclePassport;
  let passport = "";
  if (selected !== undefined) {
    const source = recordValue(selected.facts["source"]);
    const holding = recordValue(selected.facts["holding"]);
    const profile = recordValue(source["condition"]);
    const passenger = recordValue(source["passenger"]);
    const technical = recordValue(source["technical"]);
    const disclosure = { conditionProfile: profile, maintenanceDeadlines: Array.isArray(source["maintenanceDeadlines"]) ? source["maintenanceDeadlines"].map((entry) => ({ ...recordValue(entry), dueAtS: recordValue(entry)["dueAt"] })) : undefined, approvals: source["approvedLineIds"], actualConfiguration: passenger, operatingLimits: Object.keys(recordValue(source["restrictions"])) };
    const events = state.vehicleRegistryHistory;
    const eventLabels: Readonly<Record<string, string>> = { registered: "In die Spielwelt aufgenommen", "condition-updated": "Fahrzeugstand fortgeschrieben", "operator-exit": "Rücklauf nach Betriebsende" };
    const chronology = events === undefined ? '<p class="market-note">Lebenslauf wird geladen …</p>' : `<ol>${events.map((event) => `<li><span>Tag ${Math.floor(event.atS / 86_400) + 1}</span><div><strong>${escapeHtml(eventLabels[event.eventType] ?? event.eventType)}</strong>${registryEventSummary(state, event)}<details data-preserve-disclosure="registry-event-${escapeHtml(event.id)}"><summary>Technische Details dieses Eintrags</summary><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre></details></div></li>`).join("") || "<li>Keine Einträge vorhanden.</li>"}</ol>`;
    const sourceHistory = Array.isArray(source["history"]) && source["history"].length > 0 ? `<section><h4>Dokumentierte Vorgeschichte</h4><ul>${source["history"].map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></section>` : "";
    passport = `<article class="vehicle-passport" id="vehicle-${escapeHtml(selected.vehicleId)}" tabindex="-1" aria-labelledby="vehicle-passport-title"><div class="journey-heading"><div><p class="eyebrow">ÖFFENTLICHER FAHRZEUGPASS · ${escapeHtml(selected.vehicleId)}</p><h3 id="vehicle-passport-title">${escapeHtml(selected.classDesignation)}</h3></div><span class="state-word">${(selected.retiredAtS === null || selected.retiredAtS > state.atS) ? selected.introducedAtS > state.atS ? "Bestellt · noch nicht geliefert" : "In der Spielwelt" : "Ausgemustert"}</span></div><p class="market-note">Ein Fahrzeug, ein Lebenslauf – auch nach der Ausmusterung. Für alle in dieser Welt einsehbar. Datenstand: Tag ${Math.floor(selected.dataAtS / 86400) + 1}, ${String(Math.floor(selected.dataAtS % 86400 / 3600)).padStart(2, "0")}:${String(Math.floor(selected.dataAtS % 3600 / 60)).padStart(2, "0")} Uhr.</p><dl class="vehicle-identity-data"><div><dt>Eigentümer</dt><dd>${escapeHtml(operatorName(state, selected.ownerOperatorId))}</dd></div><div><dt>Halter</dt><dd>${escapeHtml(operatorName(state, selected.holderOperatorId))}</dd></div><div><dt>Baujahr</dt><dd>${escapeHtml(source["buildYear"] ?? "Nicht belegt")}</dd></div><div><dt>Höchstgeschwindigkeit</dt><dd>${technical["maximumSpeedKph"] === undefined ? "Nicht belegt" : `${escapeHtml(technical["maximumSpeedKph"])} km/h`}</dd></div><div><dt>${selected.introducedAtS > state.atS ? "Vorgesehene Lieferung" : "In der Spielwelt seit"}</dt><dd>Tag ${Math.floor(selected.introducedAtS / 86_400) + 1}</dd></div>${(selected.retiredAtS === null || selected.retiredAtS > state.atS) ? "" : `<div><dt>Ausgemustert</dt><dd>Tag ${Math.floor(selected.retiredAtS / 86_400) + 1}</dd></div>`}${holding["validUntilS"] == null ? "" : `<div><dt>Mietende</dt><dd>${escapeHtml(marketDeadline(holding["validUntilS"], state.atS))}</dd></div>`}</dl>${vehicleDisclosure(disclosure, state.atS)}<dl class="vehicle-identity-data"><div><dt>Seit letzter Wartung</dt><dd>${typeof profile["kilometresSinceMaintenance"] === "number" ? `${profile["kilometresSinceMaintenance"].toLocaleString("de-DE")} km` : "Nicht belegt"}</dd></div><div><dt>Betriebsstunden seit Wartung</dt><dd>${escapeHtml(profile["operatingHoursSinceMaintenance"] ?? "Nicht belegt")}</dd></div><div><dt>Offene Befunde</dt><dd>${escapeHtml(profile["openObservations"] ?? "Nicht belegt")}</dd></div></dl>${sourceHistory}<section class="vehicle-history"><h3>Der vollständige Lebenslauf</h3>${chronology}<div class="m12-actions">${(state.registryHistoryPage ?? 1) > 1 ? '<button id="vehicle-registry-history-previous" class="secondary" type="button">Vorherige Lebenslaufseite</button>' : ""}<span class="market-note">Seite ${state.registryHistoryPage ?? 1}</span>${state.registryHistoryNextCursor ? '<button id="vehicle-registry-history-more" class="secondary" type="button">Weitere Lebenslaufeinträge laden</button>' : ""}</div></section>${historySurface(state)}<details class="vehicle-technical" data-preserve-disclosure="passport-proof-${escapeHtml(selected.vehicleId)}"><summary>Technische Details & Herkunft</summary><dl><div><dt>Fahrzeugkennung</dt><dd>${escapeHtml(selected.vehicleId)}</dd></div><div><dt>Flottenrevision</dt><dd>${selected.fleetRevision}</dd></div><div><dt>Lebenslaufbeleg</dt><dd><code>${escapeHtml(selected.historyHash)}</code></dd></div></dl><pre>${escapeHtml(JSON.stringify(selected.facts, null, 2))}</pre></details><a class="vehicle-pass-link" href="${escapeHtml(vehiclePassportFragment(selected.vehicleId))}">Dauerhafter Link zu diesem Fahrzeug</a></article>`;
  }
  return `<section class="journey-card m12-card" id="vehicle-register"><div class="journey-heading"><div><p class="eyebrow">DAS GEDÄCHTNIS DER FLOTTE</p><h2>Jeder Zug bleibt Teil dieser Welt.</h2></div></div><p class="market-note">Neu gekauft, weiterverkauft, zurückgegeben oder ausgemustert: Suche jedes Fahrzeug unabhängig vom aktuellen Marktangebot.</p><form id="vehicle-registry-search" class="vehicle-register-search" data-preserve-draft><label class="m12-search"><span>Öffentliches Fahrzeugregister durchsuchen</span><input id="vehicle-registry-query" name="query" type="search" value="${escapeHtml(state.registryQuery ?? "")}" placeholder="Baureihe oder Fahrzeugkennung"></label><button type="submit">Suchen</button></form>${passport}${selected === undefined ? historySurface(state) : ""}${listing}${state.registryNextCursor ? '<button id="vehicle-registry-more" class="secondary" type="button">Weitere Fahrzeuge laden</button>' : ""}</section>`;
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
  const marketType = state.marketType ?? "all";
  const marketSort = state.marketSort ?? "newest";
  const filtered = state.listings.filter((listing) => (marketType === "all" || listing.listingType === marketType) && listingMatches(state, listing, state.marketQuery)).sort((a, b) => {
    if (marketSort === "deadline") return a.expiresAtS - b.expiresAtS || a.id.localeCompare(b.id);
    if (marketSort === "price") {
      if (a.listingType !== b.listingType) return a.listingType === "sale" ? -1 : 1;
      const difference = BigInt(a.priceCents) - BigInt(b.priceCents);
      return difference < 0n ? -1 : difference > 0n ? 1 : a.id.localeCompare(b.id);
    }
    return b.listedAtS - a.listedAtS || a.id.localeCompare(b.id);
  }).slice(0, MAX_RENDERED_COOPERATION_ITEMS);
  const marketAlternatives = filtered.slice(0, 8).map((listing) => ({ id: listing.id, label: String(listing.disclosure["classDesignation"] ?? "Fahrzeugangebot"), dimensions: { price: formatCents(listing.priceCents), type: listing.listingType === "sale" ? "Fahrzeugkauf" : "Leasing", capacity: `${String(disclosedValue(listing.disclosure, "seats") ?? "–")} Sitzplätze`, condition: conditionPercent(listing.disclosure["conditionBasisPoints"]), mileage: odometerKilometres(listing.disclosure["odometerMetres"]), maintenance: disclosureList(listing.disclosure["maintenanceDeadlines"], "Keine Frist offengelegt"), robustness: robustnessExplanation(listing.disclosure), penaltyRisk: "Nicht berechenbar: noch kein Einsatzvertrag gebunden", compatibility: compatibilityExplanation(listing.disclosure), provenance: listing.disclosure["authorityReleaseId"] === undefined ? "Bestätigter Weltstand" : "Gepinnter Flottenrelease" } }));
  const pathAlternatives = (state.pathAlternatives ?? []).slice(0, 8).map((path) => ({ id: path.id, label: path.label, dimensions: { price: "Getrennte Trassenabrechnung", type: "Trassenalternative", capacity: "Fahrt geprüft", condition: "Nicht anwendbar", mileage: "Nicht anwendbar", maintenance: "Nicht anwendbar", robustness: `Konfliktgeprüfte Zeitlage ${path.shift} · Reserve nicht separat ausgewiesen`, penaltyRisk: "Nicht berechenbar: noch kein Leistungsvertrag gebunden", compatibility: path.compatibility, provenance: path.provenance, shift: path.shift } }));
  const comparison = renderComparisonWorkbench("Fahrzeuge, Leasing und Trassen in dieser Welt", { type: "Entscheidungsart", price: "Kosten", capacity: "Kapazität", condition: "Zustand", mileage: "Laufleistung", maintenance: "Wartung", robustness: "Robustheit", penaltyRisk: "Pönalerisiko", shift: "Zeitlage", compatibility: "Zulassung und Kompatibilität", provenance: "Datenherkunft" }, [...marketAlternatives, ...pathAlternatives]);
  return `<section class="journey-card m12-card" id="vehicle-market">
    <div class="journey-heading"><div><p class="eyebrow">FAHRZEUGE MIT GESCHICHTE</p><h2>Dein nächster Zug. Sein nächstes Kapitel.</h2></div><span class="state-word">${filtered.length} Treffer</span></div>
    <details class="market-compose" data-preserve-disclosure="listing-compose"><summary>Eigenes Fahrzeug anbieten</summary><form id="m12-listing-form" class="m12-form compact-form" data-preserve-draft>
      <label class="m12-field"><span>Eigenes Fahrzeug</span><select name="vehicleId" required>${state.ownedVehicles.map((vehicle) => `<option value="${escapeHtml(vehicle.vehicleId)}">${escapeHtml(vehicle.classDesignation)} · Zustand ${conditionPercent(vehicle.conditionBasisPoints)}</option>`).join("")}</select></label>
      <label class="m12-field"><span>Angebotsart</span><select name="listingType"><option value="sale">Verkauf</option><option value="rental">Vermietung</option></select></label>
      ${field("priceEuros", "Preis · Euro", { value: "1,00" })}
      ${field("expiresInDays", "Angebotsdauer · Tage", { type: "number", min: 1, value: "1" })}
      ${field("rentalDurationDays", "Mietdauer · Tage (nur Vermietung)", { type: "number", min: 1, value: "7", required: false })}
      <button type="submit"${state.ownedVehicles.length === 0 ? " disabled" : ""}>Fahrzeug verbindlich anbieten</button>
    </form></details>
    <div class="m12-filter-row market-filters"><label class="m12-search"><span>Fahrzeugmarkt durchsuchen</span><input id="m12-market-query" type="search" value="${escapeHtml(state.marketQuery)}" placeholder="Baureihe, Fahrzeug oder Anbieter"></label><label><span>Beschaffung</span><select id="m12-market-type">${[["all", "Kauf & Miete"], ["sale", "Kaufen"], ["rental", "Mieten"]].map(([value, label]) => `<option value="${value}"${marketType === value ? " selected" : ""}>${label}</option>`).join("")}</select></label><label class="m12-filter"><span>Marktansicht</span><select id="m12-listing-view"><option value="actionable"${state.listingPageView === "actionable" ? " selected" : ""}>Offen und reserviert</option><option value="archive"${state.listingPageView === "archive" ? " selected" : ""}>Abgeschlossenes Archiv</option></select></label><label><span>Reihenfolge</span><select id="m12-market-sort">${[["newest", "Neueste Angebote"], ["price", "Preis je Angebotsart"], ["deadline", "Angebotsende"]].map(([value, label]) => `<option value="${value}"${marketSort === value ? " selected" : ""}>${label}</option>`).join("")}</select></label></div>
    <details class="market-comparison"><summary>Angebote im Detail vergleichen</summary>${comparison}</details><div class="m12-list">${filtered.length === 0 ? `<p class="m12-empty">Keine Marktangebote entsprechen der Suche.</p>` : filtered.map((listing) => listingCard(state, listing)).join("")}</div>${state.listings.length >= MAX_RENDERED_COOPERATION_ITEMS ? '<p class="m12-empty">Nutze die Suche oder das Archiv, um weitere Angebote zu finden.</p>' : state.listingNextCursor === null ? "" : '<button id="m12-listing-more" class="secondary" type="button">Weitere Marktangebote laden</button>'}
  </section>`;
}

function operationsSurface(state: CooperationSurfaceState): string {
  const formations = state.resources?.formations ?? [];
  const formationOptions = formations.map((formation) => `<option value="${escapeHtml(formation.id)}">${escapeHtml(formation.label)}</option>`).join("");
  const stationOptions = (state.stationOptions ?? []).map((station) => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.label)}</option>`).join("");
  const stationInput = (name: string, label: string) => `<label class="m12-field"><span>${label}</span><input name="${name}" list="planning-stations" required maxlength="200" autocomplete="off" placeholder="Bahnhof auswählen"></label>`;
  const pathForm = (kind: "schedule" | "empty-run", title: string, leadMinutes: number) => `<form id="${kind === "schedule" ? "schedule-request-form" : "empty-run-request-form"}" class="m12-form compact-form" data-path-request="${kind}" data-preserve-draft><h3>${title}</h3><label class="m12-field"><span>Zugverband</span><select name="formationId" required>${formationOptions}</select></label><p class="form-hint">Deine Fahrt bekommt automatisch eine Zugnummer.</p>${stationInput("originStationId", "Start")}${stationInput("destinationStationId", "Ziel")}<div data-route-import>${routeImportMarkup()}</div>${field("departureInMinutes", "Gewünschte Abfahrt in Minuten", { type: "number", min: 1, value: String(leadMinutes) })}<fieldset class="planning-flexibility"><legend>Spielraum bei Konflikten</legend>${field("departureDelayMinutes", "Abfahrt bis zu … Minuten später", { type: "number", min: 0, max: 120, value: kind === "schedule" ? "30" : "5" })}${field("extraRunningMinutes", "Zusätzliche Fahrzeit bis zu … Minuten", { type: "number", min: 0, max: 60, value: kind === "schedule" ? "15" : "5" })}<p class="form-hint">Die Planung kann Betriebshalte einfügen, Aufenthalte verlängern und die Abfahrt verschieben. Prüfe die vorgeschlagenen Änderungen anschließend im Fahrplan.</p></fieldset><button type="submit"${formations.length === 0 ? " disabled" : ""}>${kind === "schedule" ? "Fahrt anmelden" : "Leerfahrt anfragen"}</button></form>`;
  return `<section class="journey-card m12-card" id="betriebsplanung"><div class="journey-heading"><div><p class="eyebrow">BETRIEB</p><h2>Fahrten und Werkstatt</h2></div><span class="state-word">Deine nächste Verbindung</span></div><datalist id="planning-stations">${stationOptions}</datalist><div class="m12-operating-grid">${pathForm("schedule", "Fahrplan planen", 30)}${pathForm("empty-run", "Spontane Leerfahrt", 5)}<form id="maintenance-form" class="m12-form compact-form" data-preserve-draft><h3>Ab in die Werkstatt</h3><label class="m12-field"><span>Zugverband</span><select name="formationId" required>${formationOptions}</select></label>${field("durationHours", "Werkstattdauer · Stunden", { type: "number", min: 1, value: "4" })}<p class="resource-note">Wir prüfen, ob dein Zug und die Werkstatt im gewählten Zeitraum frei sind.</p><button type="submit"${formations.length === 0 ? " disabled" : ""}>Werkstatttermin buchen</button></form></div></section>`;
}

function tenderLabel(tender: PublicTenderView): string {
  return tender.serviceLines?.length
    ? tender.serviceLines.map((line) => `${line.designation} · ${line.origin} – ${line.destination}`).join(" / ")
    : `Los ${tender.lotId}`;
}

export function renderCooperationSurface(state: CooperationSurfaceState): string {
  if (state.activeOperatorId === "" && state.section !== "markets") {
    return `<section class="journey-card m12-card" id="evu-gruenden" tabindex="-1"><p class="eyebrow">02 · DEINE EIGENE BAHN</p><h2>Unternehmen gründen</h2><p>Wie heißt deine Bahn? Diesen Namen sehen auch andere Spieler. Dein Startkapital erhältst du mit der Gründung.</p><form id="operator-foundation-form" data-preserve-draft><label class="m12-field"><span>Unternehmensname</span><input name="name" minlength="1" maxlength="64" required autocomplete="organization" placeholder="z. B. Nordlicht Bahn"></label><button type="submit"${state.busy ? " disabled" : ""}>Unternehmen gründen</button></form></section>`;
  }
  const own = state.operators.filter((operator) => state.ownOperatorIds.includes(operator.id));
  const openTenders = state.tendersUnavailable ? [] : (state.tenders ?? []).filter((tender) => tender.phase === "open");
  const ownFormationOptions = (state.resources?.formations ?? []).map((formation) => `<option value="own:${escapeHtml(formation.id)}" data-lot-id="">Dein Zug · ${escapeHtml(formation.label)}</option>`).join("");
  const facilityOptions = (state.resources?.publicEntryFacilities ?? []).map((facility) => `<option value="public:${escapeHtml(facility.id)}" data-lot-id="${escapeHtml(facility.lotId)}">${escapeHtml(facility.label)}</option>`).join("");
  const resourcesReady = !state.busy && state.resources?.fleetRevision !== null && state.resources?.fleetRevision !== undefined && state.resources.fleetSnapshotHash !== null;
  const initialLotId = openTenders[0]?.lotId ?? "";
  const hasInitialTenderFormation = ownFormationOptions !== "" || (state.resources?.publicEntryFacilities ?? []).some((facility) => facility.lotId === initialLotId);
  const tenderSurface = state.tendersUnavailable
    ? '<section class="journey-card m12-card" id="ausschreibungen"><h2>Ausschreibungen</h2><p role="alert">Ausschreibungen konnten nicht geladen werden. Versuche es mit „Aktualisieren“ noch einmal.</p></section>'
    : `<section class="journey-card m12-card" id="ausschreibungen"><div class="journey-heading"><div><p class="eyebrow">VERKEHRSVERTRÄGE</p><h2>Finde deinen nächsten Auftrag.</h2></div><span class="state-word">${openTenders.length} offen</span></div>${openTenders.length === 0 ? '<p class="m12-empty">Derzeit ist keine Ausschreibung zur Angebotsabgabe geöffnet.</p>' : `<form id="tender-bid-form" class="m12-form" data-preserve-draft><label class="m12-field"><span>Ausschreibung</span><select id="tender-bid-tender" name="tenderId">${openTenders.map((tender) => `<option value="${escapeHtml(tender.id)}" data-lot-id="${escapeHtml(tender.lotId)}">${escapeHtml(tenderLabel(tender))} · ${tender.bidCount} Angebot(e)</option>`).join("")}</select></label><label class="m12-field"><span>Zug für diesen Auftrag</span><select id="tender-bid-formation" name="formationId">${ownFormationOptions}${facilityOptions}</select></label>${facilityOptions === "" ? "" : '<p class="resource-note">Bei einem Zuschlag erhältst du ein Startpaket aus Zug, Personal und Trasse. Dein Unternehmen trägt die laufenden Betriebskosten.</p>'}${field("orderingFeeEuros", "Dein Preis · Euro je Zug-km", { value: "10,00" })}${field("punctualityPercent", "Versprochene Pünktlichkeit · Prozent", { type: "number", min: 0, value: "95" })}${field("extraSeats", "Zusätzliche Sitzplätze", { type: "number", min: 0, value: "0" })}<button id="tender-bid-submit" type="submit" data-resources-ready="${resourcesReady}"${!resourcesReady || !hasInitialTenderFormation ? " disabled" : ""}>Angebot verbindlich abgeben</button></form>`}</section>`;
  const section = state.section ?? "all";
  const panels = section === "markets"
    ? `${tenderSurface}${contractSurface(state)}${marketSurface(state)}${registrySurface(state)}`
    : section === "operations"
      ? operationsSurface(state)
      : `${tenderSurface}${operationsSurface(state)}${contractSurface(state)}${marketSurface(state)}${registrySurface(state)}`;
  const operatorPicker = section === "all"
    ? `<label><span>Dein Unternehmen in ${escapeHtml(state.worldName)}</span><select id="m12-operator">${own.map((operator) => `<option value="${escapeHtml(operator.id)}"${operator.id === state.activeOperatorId ? " selected" : ""}>${escapeHtml(operator.name)}</option>`).join("")}</select></label>`
    : "";
  const html = `<section class="m12-surface m12-surface--${section}" aria-busy="${state.busy}">
    <div class="m12-toolbar">${operatorPicker}<div class="m12-clock"><span>SPIELTAG</span><output id="m12-time">Betriebstag ${Math.floor(state.atS / 86_400) + 1}</output></div><button id="m12-refresh" class="secondary" type="button">Aktualisieren</button></div>
    ${section === "markets" ? railwayTabs([{id:"ausschreibungen",label:"Aufträge"},{id:"vehicle-market",label:"Fahrzeuge"},{id:"cooperation-contracts",label:"Zusammenarbeit"},{id:"vehicle-register",label:"Fahrzeugregister"}]) : ""}<div class="m12-grid">${panels}</div>
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
  root.querySelectorAll<HTMLDetailsElement>(".vehicle-offer-disclosure, .vehicle-technical").forEach((details) => details.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !details.open) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    details.querySelector<HTMLElement>(":scope > summary")?.focus();
  }));
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
  root.querySelector<HTMLInputElement>("#m12-market-query")?.addEventListener("input", (event) => actions.changeMarketQuery?.((event.currentTarget as HTMLInputElement).value));
  root.querySelector<HTMLSelectElement>("#m12-market-type")?.addEventListener("change", (event) => actions.changeMarketType?.((event.currentTarget as HTMLSelectElement).value as "all" | "sale" | "rental"));
  root.querySelector<HTMLSelectElement>("#m12-market-sort")?.addEventListener("change", (event) => actions.changeMarketSort?.((event.currentTarget as HTMLSelectElement).value as "newest" | "price" | "deadline"));
  root.querySelector<HTMLFormElement>("#vehicle-registry-search")?.addEventListener("submit", (event) => { event.preventDefault(); invoke(() => actions.changeRegistryQuery?.(String(new FormData(event.currentTarget as HTMLFormElement).get("query") ?? "").trim())); });
  root.querySelector<HTMLButtonElement>("#vehicle-registry-more")?.addEventListener("click", () => invoke(actions.loadMoreRegistry));
  root.querySelector<HTMLButtonElement>("#vehicle-registry-history-previous")?.addEventListener("click", () => invoke(actions.loadPreviousRegistryHistory));
  root.querySelector<HTMLButtonElement>("#vehicle-registry-history-more")?.addEventListener("click", () => invoke(actions.loadMoreRegistryHistory));
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
  if (offereeOperatorId === "") throw new Error("Partnerunternehmen fehlt.");
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
