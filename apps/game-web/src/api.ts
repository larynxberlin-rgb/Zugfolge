import {
  createPlanningAlternativeCommand,
  parsePlanningAlternativeCommand,
  parsePlanningProjectionEnvelope,
  type PlanningAlternativeCommandV1,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

export interface AlternativeApplicationOptions {
  readonly queueAttempts?: number;
  readonly queueRetryDelayMs?: number;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export type WaitImplementation = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type TutorialLifecycle = "provisioning" | "running" | "summary" | "closing" | "archived" | "failed";
export const TUTORIAL_SESSION_SCHEMA = "zugfolge-tutorial-session/v1" as const;
export const TUTORIAL_PRESENTATION_SCHEMA = "zugfolge-tutorial-presentation/v1" as const;

export type TutorialAction =
  | { readonly type: "submit-bid"; readonly orderingFeeCentsPerTrainKm: string; readonly punctualityBasisPoints: number; readonly extraSeats: number }
  | { readonly type: "accept-lease"; readonly offerId: string }
  | { readonly type: "confirm-path"; readonly alternativeId: string }
  | { readonly type: "activate-program"; readonly templateId: string; readonly changedRule: "hold-connections" | "prioritize-punctuality" | "activate-reserve"; readonly thresholdSeconds: number }
  | { readonly type: "dispatch"; readonly action: "short_turn" | "request_reroute" | "trigger_rail_replacement" };

export interface TutorialDialogue {
  readonly id: string;
  readonly templateVersion: string;
  readonly chapter: number;
  readonly trigger: string;
  readonly speaker: "lutz";
  readonly text: string;
  readonly why?: string;
  readonly actionLabel?: string;
  readonly target?: string;
  readonly canDismiss: boolean;
}

export interface TutorialResultSummary {
  readonly startLiquidityCents: string;
  readonly leasingCostCents: string;
  readonly pathAndOperatingCostCents: string;
  readonly orderingRevenueCents: string;
  readonly disruptionCostCents: string;
  readonly resultCents: string;
  readonly punctualityBasisPoints: number;
  readonly qualityTargetsMet: readonly string[];
  readonly comparison: Readonly<Record<string, string | number>>;
}

export interface TutorialSessionView {
  readonly schemaVersion: typeof TUTORIAL_SESSION_SCHEMA;
  readonly reference: string;
  readonly tutorialWorldId: string;
  readonly publicWorldId: string;
  readonly lifecycle: TutorialLifecycle;
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly currentChapter: number;
  readonly progressLabel: string;
  readonly chapters: readonly { readonly chapter: number; readonly code: string; readonly title: string; readonly goal: string }[];
  readonly evidence: Readonly<Record<string, { readonly completed: boolean; readonly references: readonly string[] }>>;
  readonly dialogue: TutorialDialogue;
  readonly presentation: TutorialPresentationView;
  readonly summary?: TutorialResultSummary;
  readonly idleExpiresAt: string;
  readonly maximumExpiresAt: string;
  readonly publicWorldUrl: string;
}

export interface TutorialBidLimitsView {
  readonly minimumOrderingFeeCentsPerTrainKm: string;
  readonly maximumOrderingFeeCentsPerTrainKm: string;
  readonly defaultOrderingFeeCentsPerTrainKm: string;
  readonly minimumPunctualityBasisPoints: number;
  readonly maximumPunctualityBasisPoints: number;
  readonly defaultPunctualityBasisPoints: number;
  readonly minimumExtraSeats: number;
  readonly maximumExtraSeats: number;
  readonly defaultExtraSeats: number;
}

export interface TutorialPresentationView {
  readonly schemaVersion: typeof TUTORIAL_PRESENTATION_SCHEMA;
  readonly tender: {
    readonly id: string;
    readonly priceWeightBasisPoints: number;
    readonly qualityWeightBasisPoints: number;
    readonly penaltyFocus: string;
    readonly viabilityThresholdCentsPerTrainKm: string;
    readonly limits: TutorialBidLimitsView;
  };
  readonly leases: readonly {
    readonly id: string; readonly vehicleId: string; readonly classDesignation: string;
    readonly monthlyCostCents: string; readonly seats: number; readonly conditionBasisPoints: number;
    readonly reliabilityBasisPoints: number; readonly marginEffectCents: string;
    readonly contractId?: string; readonly status: string;
  }[];
  readonly paths: readonly {
    readonly id: string; readonly receiptId: string; readonly label: string; readonly desiredDepartureS: number;
    readonly bufferSeconds: number; readonly costCents: string; readonly selected: boolean;
    readonly planning?: { readonly stateHash: string; readonly projectionRevision: number };
  }[];
  readonly programmes: readonly {
    readonly id: string; readonly label: string; readonly baseThresholdSeconds: number; readonly selected: boolean;
    readonly effect?: { readonly costCents: string; readonly qualityBasisPoints: number; readonly penaltyRiskBasisPoints: number };
  }[];
  readonly programmeRuleEffects: readonly {
    readonly rule: "hold-connections" | "prioritize-punctuality" | "activate-reserve";
    readonly label: string;
    readonly effect: { readonly costCents: string; readonly qualityBasisPoints: number; readonly penaltyRiskBasisPoints: number };
  }[];
  readonly disruptionOptions: readonly {
    readonly action: "short_turn" | "request_reroute" | "trigger_rail_replacement";
    readonly label: string; readonly costCents: string; readonly punctualityBasisPoints: number; readonly cancellations: number;
  }[];
}

export interface MailboxMessageView {
  readonly id: string;
  readonly worldId: string;
  readonly messageType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sentAt: string;
  readonly deadlineAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly priority: "overdue" | "due-soon" | "action-required" | "information" | "acknowledged";
  readonly overdue: boolean;
}

export type StartingCapitalPolicy =
  | { readonly mode: "finite"; readonly amountCents: string }
  | { readonly mode: "unlimited" };

export type ContractType = "traction" | "vehicle-rental" | "connection" | "disruption-assistance";
export type ContractStatus = "offered" | "accepted" | "termination-pending" | "rejected" | "active" | "terminated" | "non-performance" | "completed" | "expired";

const CONTRACT_SCHEMA_VERSION = "zugfolge-operator-contract/v1" as const;
const LISTING_SCHEMA_VERSION = "zugfolge-vehicle-market-listing/v1" as const;
const COOPERATION_PAGE_SCHEMA_VERSION = "zugfolge-cooperation-page/v1" as const;
const VEHICLE_TRANSFER_SCHEMA_VERSION = "zugfolge-vehicle-transfer-result/v1" as const;

export interface OperatorSummary {
  readonly id: string;
  readonly worldId: string;
  readonly name: string;
  readonly foundingAccountId?: string;
}

export interface OperatorContractView {
  readonly schemaVersion?: typeof CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly worldId: string;
  readonly offerorOperatorId: string;
  readonly offereeOperatorId: string;
  readonly contractType: ContractType;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly termsHash: string;
  readonly priceCents: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly responseDeadlineS: number;
  readonly terminationNoticeS: number;
  readonly terminationRequestedByOperatorId?: string | null;
  readonly terminationRequestedAtS?: number | null;
  readonly terminatedAtS?: number | null;
  readonly terminationEffectiveAtS?: number | null;
  readonly terminationEvidenceReference?: string | null;
  readonly terminationRuleVersion?: string | null;
  readonly status: ContractStatus;
  readonly offeredAtS: number;
  readonly revision: number;
  readonly endReason?: string | null;
}

export interface VehicleAssetView {
  readonly worldId: string;
  readonly vehicleId: string;
  readonly classDesignation: string;
  readonly ownerOperatorId: string;
  readonly holderOperatorId: string;
  readonly odometerMetres: string;
  readonly conditionBasisPoints: number;
  readonly damages: readonly Readonly<Record<string, unknown>>[];
  readonly maintenanceDeadlines: readonly Readonly<Record<string, unknown>>[];
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly valueCents: string;
  readonly revision: number;
  readonly historyHash: string;
}

export interface VehicleMarketListingView {
  readonly schemaVersion?: typeof LISTING_SCHEMA_VERSION;
  readonly id: string;
  readonly worldId: string;
  readonly vehicleId: string;
  readonly offeringOperatorId: string;
  readonly listingType: "sale" | "rental";
  readonly priceCents: string;
  readonly rentalValidUntilS?: number | null;
  readonly disclosure: Readonly<Record<string, unknown>>;
  readonly disclosureHash: string;
  readonly listedAtS: number;
  readonly expiresAtS: number;
  readonly status: "open" | "reserved" | "transferred" | "cancelled" | "expired" | "reversed";
  readonly reservedByOperatorId?: string | null;
  readonly reservedUntilS?: number | null;
  readonly contractId?: string | null;
  readonly revision: number;
}

export interface VehicleTransferResultView {
  readonly schemaVersion: typeof VEHICLE_TRANSFER_SCHEMA_VERSION;
  readonly transferId: string;
  readonly listing: VehicleMarketListingView;
  readonly vehicle: VehicleAssetView;
  readonly contract?: OperatorContractView;
}

export interface VehicleHistoryEventView {
  readonly id: string;
  readonly worldId: string;
  readonly vehicleId: string;
  readonly eventType: "registered" | "condition-updated" | "sale" | "rental-start" | "rental-return" | "reversal";
  readonly atS: number;
  readonly priorHistoryHash: string | null;
  readonly resultingHistoryHash: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type CooperationPageView = "actionable" | "archive" | "all";

export interface CursorPage<T> {
  readonly schemaVersion?: typeof COOPERATION_PAGE_SCHEMA_VERSION;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CooperationResourceOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface PublicEntryFacilityOption extends CooperationResourceOption {
  readonly lotId: string;
  readonly formationId: string;
  readonly personnelDutyIds: readonly string[];
  readonly pathReservationIds: readonly string[];
}

export interface CooperationResourceCatalog {
  readonly schemaVersion: "zugfolge-cooperation-resource-catalog/v1";
  readonly worldId: string;
  readonly operatorId: string;
  readonly fleetRevision: number | null;
  readonly fleetSnapshotHash: string | null;
  readonly trainRuns: readonly CooperationResourceOption[];
  readonly connectionTrainRuns: readonly CooperationResourceOption[];
  readonly formations: readonly CooperationResourceOption[];
  readonly publicEntryFacilities: readonly PublicEntryFacilityOption[];
  readonly personnelDuties: readonly CooperationResourceOption[];
  readonly pathReceipts: readonly CooperationResourceOption[];
  readonly disruptions: readonly CooperationResourceOption[];
  readonly rentableVehicles: readonly CooperationResourceOption[];
  readonly assistanceVehicles: readonly CooperationResourceOption[];
}

export interface PublicTenderView {
  readonly id: string;
  readonly phase: "announced" | "open" | "awarded" | "failed";
  readonly lotId: string;
  readonly closesAt: number;
  readonly bidCount: number;
  readonly ownBidCount: number;
}

export interface EconomyPlayerStateView {
  readonly revision: number;
  readonly tenders: readonly PublicTenderView[];
}

export interface PublicWorldContractView {
  readonly schemaVersion: "zugfolge-public-world-contract/v1";
  readonly contractHash: string;
  readonly worldId: string;
  readonly name: string;
  readonly region: { readonly id: string; readonly name: string; readonly variant: string };
  readonly noWipe: true;
  readonly schedulePeriodWeeks: number;
  readonly duration: { readonly kind: "unlimited" } | { readonly kind: "periods"; readonly periodCount: number };
  readonly timeBasis: { readonly mode: "realtime"; readonly accelerationFactor: number; readonly epoch: string; readonly timeZone: "Europe/Berlin" };
  readonly entry: {
    readonly status: "open" | "scheduled" | "configuration-incomplete";
    readonly requiresContractConfirmation: true;
    readonly opensAt: string;
    readonly closesAt: string | null;
  };
  readonly startingCapitalPolicy: { readonly kind: "finite"; readonly amountCents: string } | { readonly kind: "unlimited" } | null;
  readonly releases: { readonly infra: string; readonly timetable: string; readonly fleet: string; readonly economy: string };
}

export interface ContractOfferPayload {
  readonly offereeOperatorId: string;
  readonly contractType: ContractType;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly priceCents: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly responseDeadlineS: number;
  readonly terminationNoticeS: number;
  readonly idempotencyKey: string;
}

export class GameApiError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "GameApiError";
  }
}

const wait: WaitImplementation = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Vorgang abgebrochen."));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Vorgang abgebrochen."));
      },
      { once: true },
    );
  });

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} muss eine positive ganze Zahl sein.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} muss eine nichtnegative ganze Zahl sein.`);
  }
  return resolved;
}

const JOURNEY_TIMEOUT_MS = 15_000;
const MAX_I64_CENTS = 9_223_372_036_854_775_807n;

function parseStartingCapitalPolicy(value: unknown): StartingCapitalPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Startkapital-Policy ist kein Objekt.");
  }
  const policy = value as Record<string, unknown>;
  if (policy["mode"] === "unlimited" && Object.keys(policy).length === 1) {
    return { mode: "unlimited" };
  }
  if (
    policy["mode"] === "finite"
    && Object.keys(policy).length === 2
    && typeof policy["amountCents"] === "string"
    && /^(0|[1-9][0-9]*)$/.test(policy["amountCents"])
    && BigInt(policy["amountCents"]) <= MAX_I64_CENTS
  ) {
    return { mode: "finite", amountCents: policy["amountCents"] };
  }
  throw new Error("Erwartet wird finite mit kanonischem i64-Centstring oder unlimited ohne Betrag.");
}

function asRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GameApiError(`${name} hat ein ungültiges Format.`, false);
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string, name: string, nullable = false): string | null {
  const value = record[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new GameApiError(`${name}.${key} ist kein Textwert.`, false);
  return value;
}

function integerValue(record: Readonly<Record<string, unknown>>, key: string, name: string, minimum = 0): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new GameApiError(`${name}.${key} ist keine sichere ganze Zahl.`, false);
  }
  return value as number;
}

function booleanValue(record: Readonly<Record<string, unknown>>, key: string, name: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new GameApiError(`${name}.${key} ist kein Wahrheitswert.`, false);
  return value;
}

function enumValue<const T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  name: string,
  allowed: readonly T[],
): T {
  const value = stringValue(record, key, name);
  if (!allowed.includes(value as T)) throw new GameApiError(`${name}.${key} besitzt einen unbekannten Wert.`, false);
  return value as T;
}

function stringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new GameApiError(`${name} ist keine Textliste.`, false);
  }
  return value as readonly string[];
}

function recordList(value: unknown, name: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new GameApiError(`${name} ist keine Liste.`, false);
  return value.map((entry, index) => asRecord(entry, `${name}[${index}]`));
}

function integerMoney(record: Readonly<Record<string, unknown>>, key: string, name: string, signed = false): string {
  const value = stringValue(record, key, name)!;
  if (!(signed ? /^-?[0-9]+$/ : /^[0-9]+$/).test(value)) {
    throw new GameApiError(`${name}.${key} ist kein ganzzahliger Centbetrag.`, false);
  }
  return value;
}

function parseOperatorSummaries(value: unknown): readonly OperatorSummary[] {
  if (!Array.isArray(value)) throw new GameApiError("EVU-Verzeichnis ist keine Liste.", false);
  return value.map((entry, index) => {
    const name = `EVU-Verzeichnis[${index}]`;
    const record = asRecord(entry, name);
    const foundingAccountId = record["foundingAccountId"];
    if (foundingAccountId !== undefined && typeof foundingAccountId !== "string") {
      throw new GameApiError(`${name}.foundingAccountId ist kein Textwert.`, false);
    }
    return {
      id: stringValue(record, "id", name)!,
      worldId: stringValue(record, "worldId", name)!,
      name: stringValue(record, "name", name)!,
      ...(typeof foundingAccountId === "string" ? { foundingAccountId } : {}),
    };
  });
}

function parseContract(recordValue: unknown, name: string): OperatorContractView {
  const record = asRecord(recordValue, name);
  if (record["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
    throw new GameApiError(`${name} besitzt kein unterstuetztes Vertragsschema.`, false);
  }
  const endReason = record["endReason"];
  if (endReason !== undefined && endReason !== null && typeof endReason !== "string") {
    throw new GameApiError(`${name}.endReason ist kein Textwert.`, false);
  }
  const optionalString = (key: string): string | null | undefined => {
    const value = record[key];
    if (value === undefined || value === null || typeof value === "string") return value as string | null | undefined;
    throw new GameApiError(`${name}.${key} ist kein optionaler Textwert.`, false);
  };
  const optionalSecond = (key: string): number | null | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return value as null | undefined;
    return integerValue(record, key, name);
  };
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    id: stringValue(record, "id", name)!,
    worldId: stringValue(record, "worldId", name)!,
    offerorOperatorId: stringValue(record, "offerorOperatorId", name)!,
    offereeOperatorId: stringValue(record, "offereeOperatorId", name)!,
    contractType: enumValue(record, "contractType", name, ["traction", "vehicle-rental", "connection", "disruption-assistance"]),
    subject: asRecord(record["subject"], `${name}.subject`),
    terms: asRecord(record["terms"], `${name}.terms`),
    termsHash: stringValue(record, "termsHash", name)!,
    priceCents: integerMoney(record, "priceCents", name),
    validFromS: integerValue(record, "validFromS", name),
    validUntilS: integerValue(record, "validUntilS", name),
    responseDeadlineS: integerValue(record, "responseDeadlineS", name),
    terminationNoticeS: integerValue(record, "terminationNoticeS", name),
    status: enumValue(record, "status", name, ["offered", "accepted", "termination-pending", "rejected", "active", "terminated", "non-performance", "completed", "expired"]),
    offeredAtS: integerValue(record, "offeredAtS", name),
    revision: integerValue(record, "revision", name),
    ...(record["terminationRequestedByOperatorId"] === undefined ? {} : { terminationRequestedByOperatorId: optionalString("terminationRequestedByOperatorId") }),
    ...(record["terminationRequestedAtS"] === undefined ? {} : { terminationRequestedAtS: optionalSecond("terminationRequestedAtS") }),
    ...(record["terminatedAtS"] === undefined ? {} : { terminatedAtS: optionalSecond("terminatedAtS") }),
    ...(record["terminationEffectiveAtS"] === undefined ? {} : { terminationEffectiveAtS: optionalSecond("terminationEffectiveAtS") }),
    ...(record["terminationEvidenceReference"] === undefined ? {} : { terminationEvidenceReference: optionalString("terminationEvidenceReference") }),
    ...(record["terminationRuleVersion"] === undefined ? {} : { terminationRuleVersion: optionalString("terminationRuleVersion") }),
    ...(endReason === undefined ? {} : { endReason: endReason as string | null }),
  };
}

function parseVehicle(recordValue: unknown, name: string): VehicleAssetView {
  const record = asRecord(recordValue, name);
  return {
    worldId: stringValue(record, "worldId", name)!,
    vehicleId: stringValue(record, "vehicleId", name)!,
    classDesignation: stringValue(record, "classDesignation", name)!,
    ownerOperatorId: stringValue(record, "ownerOperatorId", name)!,
    holderOperatorId: stringValue(record, "holderOperatorId", name)!,
    odometerMetres: integerMoney(record, "odometerMetres", name),
    conditionBasisPoints: integerValue(record, "conditionBasisPoints", name),
    damages: recordList(record["damages"], `${name}.damages`),
    maintenanceDeadlines: recordList(record["maintenanceDeadlines"], `${name}.maintenanceDeadlines`),
    bindings: asRecord(record["bindings"], `${name}.bindings`),
    valueCents: integerMoney(record, "valueCents", name),
    revision: integerValue(record, "revision", name),
    historyHash: stringValue(record, "historyHash", name)!,
  };
}

function parseVehicles(value: unknown): readonly VehicleAssetView[] {
  if (!Array.isArray(value)) throw new GameApiError("Fahrzeugliste ist keine Liste.", false);
  return value.map((entry, index) => parseVehicle(entry, `Fahrzeugliste[${index}]`));
}

function parseListing(recordValue: unknown, name: string): VehicleMarketListingView {
  const record = asRecord(recordValue, name);
  if (record["schemaVersion"] !== LISTING_SCHEMA_VERSION) {
    throw new GameApiError(`${name} besitzt kein unterstuetztes Marktangebotsschema.`, false);
  }
  const optionalNumber = (key: string): number | null | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return value;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new GameApiError(`${name}.${key} ist keine sichere Simulationssekunde.`, false);
    return value as number;
  };
  const optionalText = (key: string): string | null | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return value;
    if (typeof value !== "string") throw new GameApiError(`${name}.${key} ist kein Textwert.`, false);
    return value;
  };
  const rentalValidUntilS = optionalNumber("rentalValidUntilS");
  const reservedUntilS = optionalNumber("reservedUntilS");
  const reservedByOperatorId = optionalText("reservedByOperatorId");
  const contractId = optionalText("contractId");
  return {
    schemaVersion: LISTING_SCHEMA_VERSION,
    id: stringValue(record, "id", name)!,
    worldId: stringValue(record, "worldId", name)!,
    vehicleId: stringValue(record, "vehicleId", name)!,
    offeringOperatorId: stringValue(record, "offeringOperatorId", name)!,
    listingType: enumValue(record, "listingType", name, ["sale", "rental"]),
    priceCents: integerMoney(record, "priceCents", name),
    ...(rentalValidUntilS === undefined ? {} : { rentalValidUntilS }),
    disclosure: asRecord(record["disclosure"], `${name}.disclosure`),
    disclosureHash: stringValue(record, "disclosureHash", name)!,
    listedAtS: integerValue(record, "listedAtS", name),
    expiresAtS: integerValue(record, "expiresAtS", name),
    status: enumValue(record, "status", name, ["open", "reserved", "transferred", "cancelled", "expired", "reversed"]),
    ...(reservedByOperatorId === undefined ? {} : { reservedByOperatorId }),
    ...(reservedUntilS === undefined ? {} : { reservedUntilS }),
    ...(contractId === undefined ? {} : { contractId }),
    revision: integerValue(record, "revision", name),
  };
}

function parseVehicleTransferResult(value: unknown, name: string): VehicleTransferResultView {
  const record = asRecord(value, name);
  if (record["schemaVersion"] !== VEHICLE_TRANSFER_SCHEMA_VERSION) {
    throw new GameApiError(`${name} besitzt kein unterstuetztes Transferschema.`, false);
  }
  const transferId = stringValue(record, "transferId", name)!;
  if (transferId.trim() === "") throw new GameApiError(`${name}.transferId ist leer.`, false);
  return {
    schemaVersion: VEHICLE_TRANSFER_SCHEMA_VERSION,
    transferId,
    listing: parseListing(record["listing"], `${name}.listing`),
    vehicle: parseVehicle(record["vehicle"], `${name}.vehicle`),
    ...(record["contract"] === undefined ? {} : { contract: parseContract(record["contract"], `${name}.contract`) }),
  };
}

function parseCursorPage<T>(value: unknown, name: string, parseItem: (entry: unknown, name: string) => T): CursorPage<T> {
  const record = asRecord(value, name);
  if (record["schemaVersion"] !== COOPERATION_PAGE_SCHEMA_VERSION) {
    throw new GameApiError(`${name} besitzt kein unterstuetztes Seitenschema.`, false);
  }
  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) throw new GameApiError(`${name}.items ist keine Liste.`, false);
  const nextCursor = record["nextCursor"];
  if (nextCursor !== null && typeof nextCursor !== "string") throw new GameApiError(`${name}.nextCursor ist kein Cursor.`, false);
  return {
    schemaVersion: COOPERATION_PAGE_SCHEMA_VERSION,
    items: rawItems.map((entry, index) => parseItem(entry, `${name}.items[${index}]`)),
    nextCursor,
  };
}

export function parseCooperationResourceCatalog(value: unknown): CooperationResourceCatalog {
  const name = "Kooperationsressourcen";
  const record = asRecord(value, name);
  if (record["schemaVersion"] !== "zugfolge-cooperation-resource-catalog/v1") {
    throw new GameApiError(`${name} besitzt ein unbekanntes Schema.`, false);
  }
  const fleetRevision = record["fleetRevision"];
  if (fleetRevision !== null && (!Number.isSafeInteger(fleetRevision) || (fleetRevision as number) < 0)) {
    throw new GameApiError(`${name}.fleetRevision ist keine sichere Revision.`, false);
  }
  const options = (key: string): readonly CooperationResourceOption[] => recordList(record[key], `${name}.${key}`).map((entry, index) => ({
    id: stringValue(entry, "id", `${name}.${key}[${index}]` )!,
    label: stringValue(entry, "label", `${name}.${key}[${index}]` )!,
    detail: stringValue(entry, "detail", `${name}.${key}[${index}]` )!,
  }));
  const publicEntryFacilities = recordList(record["publicEntryFacilities"], `${name}.publicEntryFacilities`).map((entry, index) => {
    const entryName = `${name}.publicEntryFacilities[${index}]`;
    const identifiers = (key: "personnelDutyIds" | "pathReservationIds"): readonly string[] => {
      const values = stringList(entry[key], `${entryName}.${key}`);
      if (values.length === 0 || values.some((value) => value.trim() === "") || new Set(values).size !== values.length) {
        throw new GameApiError(`${entryName}.${key} ist leer oder enthält ungültige Kennungen.`, false);
      }
      return values;
    };
    return {
      id: stringValue(entry, "id", entryName)!,
      label: stringValue(entry, "label", entryName)!,
      detail: stringValue(entry, "detail", entryName)!,
      lotId: stringValue(entry, "lotId", entryName)!,
      formationId: stringValue(entry, "formationId", entryName)!,
      personnelDutyIds: identifiers("personnelDutyIds"),
      pathReservationIds: identifiers("pathReservationIds"),
    };
  });
  return {
    schemaVersion: "zugfolge-cooperation-resource-catalog/v1",
    worldId: stringValue(record, "worldId", name)!,
    operatorId: stringValue(record, "operatorId", name)!,
    fleetRevision: fleetRevision as number | null,
    fleetSnapshotHash: record["fleetSnapshotHash"] === null || record["fleetSnapshotHash"] === undefined ? null : stringValue(record, "fleetSnapshotHash", name)!,
    trainRuns: options("trainRuns"),
    connectionTrainRuns: options("connectionTrainRuns"),
    formations: options("formations"),
    publicEntryFacilities,
    personnelDuties: options("personnelDuties"),
    pathReceipts: options("pathReceipts"),
    disruptions: options("disruptions"),
    rentableVehicles: options("rentableVehicles"),
    assistanceVehicles: options("assistanceVehicles"),
  };
}

function parseEconomyPlayerState(value: unknown): EconomyPlayerStateView {
  const state = asRecord(value, "Wirtschaftszustand");
  const revision = integerValue(state, "revision", "Wirtschaftszustand", 0);
  const encoded = asRecord(state["tenders"], "Wirtschaftszustand.tenders");
  if (encoded["$zugfolgeType"] !== "map" || !Array.isArray(encoded["entries"])) throw new GameApiError("Ausschreibungen besitzen kein unterstütztes Format.", false);
  const tenders = encoded["entries"].map((entry, index): PublicTenderView => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new GameApiError(`Ausschreibungen[${index}] ist ungültig.`, false);
    const lifecycle = asRecord(entry[1], `Ausschreibungen[${index}]`);
    const tender = asRecord(lifecycle["tender"], `Ausschreibungen[${index}].tender`);
    const phase = lifecycle["phase"];
    if (!["announced", "open", "awarded", "failed"].includes(String(phase))) throw new GameApiError(`Ausschreibungen[${index}].phase ist unbekannt.`, false);
    return {
      id: entry[0],
      phase: phase as PublicTenderView["phase"],
      lotId: stringValue(tender, "lotId", `Ausschreibungen[${index}].tender`)!,
      closesAt: integerValue(tender, "closesAt", `Ausschreibungen[${index}].tender`, 0),
      bidCount: integerValue(lifecycle, "bidCount", `Ausschreibungen[${index}]`, 0),
      ownBidCount: Array.isArray(lifecycle["ownBids"]) ? lifecycle["ownBids"].length : 0,
    };
  });
  return { revision, tenders };
}

function pageQuery(view: CooperationPageView, cursor: string | undefined, limit: number, deadlineBeforeS?: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Seitengröße muss zwischen 1 und 100 liegen.");
  if (deadlineBeforeS !== undefined && (!Number.isSafeInteger(deadlineBeforeS) || deadlineBeforeS < 0)) {
    throw new Error("Fristfilter muss eine sichere nichtnegative Weltsekunde sein.");
  }
  const query = new URLSearchParams({ view, limit: String(limit) });
  if (cursor !== undefined) query.set("cursor", cursor);
  if (deadlineBeforeS !== undefined) query.set("deadlineBeforeS", String(deadlineBeforeS));
  return query.toString();
}

function parsePublicWorldContracts(value: unknown): readonly PublicWorldContractView[] {
  if (!Array.isArray(value)) throw new GameApiError("Weltverträge sind keine Liste.", false);
  return value.map((entry, index) => {
    const name = `Weltverträge[${index}]`;
    const record = asRecord(entry, name);
    if (record["schemaVersion"] !== "zugfolge-public-world-contract/v1" || record["noWipe"] !== true) {
      throw new GameApiError(`${name} besitzt keinen unterstützten No-Wipe-Vertrag.`, false);
    }
    const region = asRecord(record["region"], `${name}.region`);
    const duration = asRecord(record["duration"], `${name}.duration`);
    const timeBasis = asRecord(record["timeBasis"], `${name}.timeBasis`);
    const entryView = asRecord(record["entry"], `${name}.entry`);
    const releases = asRecord(record["releases"], `${name}.releases`);
    const durationView = duration["kind"] === "unlimited" ? { kind: "unlimited" as const }
      : duration["kind"] === "periods" ? { kind: "periods" as const, periodCount: integerValue(duration, "periodCount", `${name}.duration`, 1) }
        : (() => { throw new GameApiError(`${name}.duration.kind ist unbekannt.`, false); })();
    const rawPolicy = record["startingCapitalPolicy"];
    let startingCapitalPolicy: PublicWorldContractView["startingCapitalPolicy"] = null;
    if (rawPolicy !== null) {
      const policy = asRecord(rawPolicy, `${name}.startingCapitalPolicy`);
      if (policy["kind"] === "finite") startingCapitalPolicy = { kind: "finite", amountCents: integerMoney(policy, "amountCents", `${name}.startingCapitalPolicy`) };
      else if (policy["kind"] === "unlimited") startingCapitalPolicy = { kind: "unlimited" };
      else throw new GameApiError(`${name}.startingCapitalPolicy.kind ist unbekannt.`, false);
    }
    const epoch = stringValue(timeBasis, "epoch", `${name}.timeBasis`)!;
    const opensAt = stringValue(entryView, "opensAt", `${name}.entry`)!;
    const closesAt = stringValue(entryView, "closesAt", `${name}.entry`, true);
    if (![epoch, opensAt, ...(closesAt === null ? [] : [closesAt])].every((instant) => Number.isFinite(Date.parse(instant)))) {
      throw new GameApiError(`${name} enthält keinen gültigen ISO-Zeitpunkt.`, false);
    }
    if (closesAt !== null && Date.parse(closesAt) <= Date.parse(opensAt)) {
      throw new GameApiError(`${name}.entry besitzt kein gültiges Eintrittsfenster.`, false);
    }
    return {
      schemaVersion: "zugfolge-public-world-contract/v1",
      contractHash: stringValue(record, "contractHash", name)!,
      worldId: stringValue(record, "worldId", name)!,
      name: stringValue(record, "name", name)!,
      region: {
        id: stringValue(region, "id", `${name}.region`)!,
        name: stringValue(region, "name", `${name}.region`)!,
        variant: stringValue(region, "variant", `${name}.region`)!,
      },
      noWipe: true,
      schedulePeriodWeeks: integerValue(record, "schedulePeriodWeeks", name, 3),
      duration: durationView,
      timeBasis: {
        mode: enumValue(timeBasis, "mode", `${name}.timeBasis`, ["realtime"]),
        accelerationFactor: integerValue(timeBasis, "accelerationFactor", `${name}.timeBasis`, 1),
        epoch,
        timeZone: enumValue(timeBasis, "timeZone", `${name}.timeBasis`, ["Europe/Berlin"]),
      },
      entry: {
        status: enumValue(entryView, "status", `${name}.entry`, ["open", "scheduled", "configuration-incomplete"]),
        requiresContractConfirmation: true,
        opensAt,
        closesAt,
      },
      startingCapitalPolicy,
      releases: {
        infra: stringValue(releases, "infra", `${name}.releases`)!, timetable: stringValue(releases, "timetable", `${name}.releases`)!,
        fleet: stringValue(releases, "fleet", `${name}.releases`)!, economy: stringValue(releases, "economy", `${name}.releases`)!,
      },
    };
  });
}

function parseHistory(value: unknown): readonly VehicleHistoryEventView[] {
  if (!Array.isArray(value)) throw new GameApiError("Fahrzeuglebenslauf ist keine Liste.", false);
  return value.map((entry, index) => {
    const name = `Fahrzeuglebenslauf[${index}]`;
    const record = asRecord(entry, name);
    const priorHistoryHash = record["priorHistoryHash"];
    if (priorHistoryHash !== null && typeof priorHistoryHash !== "string") throw new GameApiError(`${name}.priorHistoryHash ist kein Textwert.`, false);
    return {
      id: stringValue(record, "id", name)!,
      worldId: stringValue(record, "worldId", name)!,
      vehicleId: stringValue(record, "vehicleId", name)!,
      eventType: enumValue(record, "eventType", name, ["registered", "condition-updated", "sale", "rental-start", "rental-return", "reversal"]),
      atS: integerValue(record, "atS", name),
      priorHistoryHash,
      resultingHistoryHash: stringValue(record, "resultingHistoryHash", name)!,
      details: asRecord(record["details"], `${name}.details`),
    };
  });
}

function parseMailbox(value: unknown): readonly MailboxMessageView[] {
  if (!Array.isArray(value)) throw new GameApiError("Postfach ist keine Liste.", false);
  return value.map((item, index) => {
    const record = asRecord(item, `Postfach[${index}]`);
    const payload = asRecord(record["payload"], `Postfach[${index}].payload`);
    return Object.freeze({
      id: stringValue(record, "id", `Postfach[${index}]`)! ,
      worldId: stringValue(record, "worldId", `Postfach[${index}]`)! ,
      messageType: stringValue(record, "messageType", `Postfach[${index}]`)! ,
      payload,
      sentAt: stringValue(record, "sentAt", `Postfach[${index}]`)! ,
      deadlineAt: stringValue(record, "deadlineAt", `Postfach[${index}]`, true),
      acknowledgedAt: stringValue(record, "acknowledgedAt", `Postfach[${index}]`, true),
      priority: enumValue(record, "priority", `Postfach[${index}]`, ["overdue", "due-soon", "action-required", "information", "acknowledged"]),
      overdue: booleanValue(record, "overdue", `Postfach[${index}]`),
    });
  });
}

/** Laufzeitdecoder v1 für den öffentlichen Tutorialvertrag. */
function parseTutorialSessionV1(value: unknown): TutorialSessionView {
  const name = "Tutorialvertrag v1";
  const record = asRecord(value, name);
  if (record["schemaVersion"] !== TUTORIAL_SESSION_SCHEMA) throw new GameApiError(`${name} besitzt ein unbekanntes Schema.`, false);
  const chapterValues = record["chapters"];
  if (!Array.isArray(chapterValues)) throw new GameApiError(`${name}.chapters ist keine Liste.`, false);
  const chapters = chapterValues.map((entry, index) => {
    const chapterName = `${name}.chapters[${index}]`;
    const chapter = asRecord(entry, chapterName);
    return {
      chapter: integerValue(chapter, "chapter", chapterName, 1),
      code: stringValue(chapter, "code", chapterName)!,
      title: stringValue(chapter, "title", chapterName)!,
      goal: stringValue(chapter, "goal", chapterName)!,
    };
  });
  const evidenceRecord = asRecord(record["evidence"], `${name}.evidence`);
  const evidence: Record<string, { readonly completed: boolean; readonly references: readonly string[] }> = {};
  for (const [key, raw] of Object.entries(evidenceRecord)) {
    const entryName = `${name}.evidence.${key}`;
    const entry = asRecord(raw, entryName);
    evidence[key] = {
      completed: booleanValue(entry, "completed", entryName),
      references: stringList(entry["references"], `${entryName}.references`),
    };
  }
  const dialogueRecord = asRecord(record["dialogue"], `${name}.dialogue`);
  const dialogueOptional = (key: "why" | "actionLabel" | "target"): string | undefined => {
    const raw = dialogueRecord[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") throw new GameApiError(`${name}.dialogue.${key} ist kein Textwert.`, false);
    return raw;
  };
  const dialogue: TutorialDialogue = {
    id: stringValue(dialogueRecord, "id", `${name}.dialogue` )!,
    templateVersion: stringValue(dialogueRecord, "templateVersion", `${name}.dialogue` )!,
    chapter: integerValue(dialogueRecord, "chapter", `${name}.dialogue`, 1),
    trigger: stringValue(dialogueRecord, "trigger", `${name}.dialogue` )!,
    speaker: enumValue(dialogueRecord, "speaker", `${name}.dialogue`, ["lutz"]),
    text: stringValue(dialogueRecord, "text", `${name}.dialogue` )!,
    ...(dialogueOptional("why") === undefined ? {} : { why: dialogueOptional("why")! }),
    ...(dialogueOptional("actionLabel") === undefined ? {} : { actionLabel: dialogueOptional("actionLabel")! }),
    ...(dialogueOptional("target") === undefined ? {} : { target: dialogueOptional("target")! }),
    canDismiss: booleanValue(dialogueRecord, "canDismiss", `${name}.dialogue`),
  };
  const presentationName = `${name}.presentation`;
  const presentationRecord = asRecord(record["presentation"], presentationName);
  if (presentationRecord["schemaVersion"] !== TUTORIAL_PRESENTATION_SCHEMA) throw new GameApiError(`${presentationName} besitzt ein unbekanntes Schema.`, false);
  const tenderName = `${presentationName}.tender`;
  const tenderRecord = asRecord(presentationRecord["tender"], tenderName);
  const limitsName = `${tenderName}.limits`;
  const limitsRecord = asRecord(tenderRecord["limits"], limitsName);
  const limits: TutorialBidLimitsView = {
    minimumOrderingFeeCentsPerTrainKm: integerMoney(limitsRecord, "minimumOrderingFeeCentsPerTrainKm", limitsName),
    maximumOrderingFeeCentsPerTrainKm: integerMoney(limitsRecord, "maximumOrderingFeeCentsPerTrainKm", limitsName),
    defaultOrderingFeeCentsPerTrainKm: integerMoney(limitsRecord, "defaultOrderingFeeCentsPerTrainKm", limitsName),
    minimumPunctualityBasisPoints: integerValue(limitsRecord, "minimumPunctualityBasisPoints", limitsName),
    maximumPunctualityBasisPoints: integerValue(limitsRecord, "maximumPunctualityBasisPoints", limitsName),
    defaultPunctualityBasisPoints: integerValue(limitsRecord, "defaultPunctualityBasisPoints", limitsName),
    minimumExtraSeats: integerValue(limitsRecord, "minimumExtraSeats", limitsName),
    maximumExtraSeats: integerValue(limitsRecord, "maximumExtraSeats", limitsName),
    defaultExtraSeats: integerValue(limitsRecord, "defaultExtraSeats", limitsName),
  };
  if (BigInt(limits.minimumOrderingFeeCentsPerTrainKm) > BigInt(limits.defaultOrderingFeeCentsPerTrainKm)
    || BigInt(limits.defaultOrderingFeeCentsPerTrainKm) > BigInt(limits.maximumOrderingFeeCentsPerTrainKm)
    || limits.minimumPunctualityBasisPoints > limits.defaultPunctualityBasisPoints
    || limits.defaultPunctualityBasisPoints > limits.maximumPunctualityBasisPoints
    || limits.minimumExtraSeats > limits.defaultExtraSeats
    || limits.defaultExtraSeats > limits.maximumExtraSeats) {
    throw new GameApiError(`${limitsName} ist widersprüchlich.`, false);
  }
  const leases = recordList(presentationRecord["leases"], `${presentationName}.leases`).map((entry, index) => {
    const itemName = `${presentationName}.leases[${index}]`;
    const contractId = entry["contractId"];
    if (contractId !== undefined && typeof contractId !== "string") throw new GameApiError(`${itemName}.contractId ist kein Textwert.`, false);
    return {
      id: stringValue(entry, "id", itemName)!, vehicleId: stringValue(entry, "vehicleId", itemName)!,
      classDesignation: stringValue(entry, "classDesignation", itemName)!, monthlyCostCents: integerMoney(entry, "monthlyCostCents", itemName),
      seats: integerValue(entry, "seats", itemName), conditionBasisPoints: integerValue(entry, "conditionBasisPoints", itemName),
      reliabilityBasisPoints: integerValue(entry, "reliabilityBasisPoints", itemName), marginEffectCents: integerMoney(entry, "marginEffectCents", itemName, true),
      ...(contractId === undefined ? {} : { contractId }), status: stringValue(entry, "status", itemName)!,
    };
  });
  const paths = recordList(presentationRecord["paths"], `${presentationName}.paths`).map((entry, index) => {
    const itemName = `${presentationName}.paths[${index}]`;
    const rawPlanning = entry["planning"];
    const planningRecord = rawPlanning === undefined ? undefined : asRecord(rawPlanning, `${itemName}.planning`);
    return {
      id: stringValue(entry, "id", itemName)!, receiptId: stringValue(entry, "receiptId", itemName)!,
      label: stringValue(entry, "label", itemName)!, desiredDepartureS: integerValue(entry, "desiredDepartureS", itemName),
      bufferSeconds: integerValue(entry, "bufferSeconds", itemName), costCents: integerMoney(entry, "costCents", itemName),
      selected: booleanValue(entry, "selected", itemName),
      ...(planningRecord === undefined ? {} : { planning: {
        stateHash: stringValue(planningRecord, "stateHash", `${itemName}.planning`)!,
        projectionRevision: integerValue(planningRecord, "projectionRevision", `${itemName}.planning`),
      } }),
    };
  });
  const programmes = recordList(presentationRecord["programmes"], `${presentationName}.programmes`).map((entry, index) => {
    const itemName = `${presentationName}.programmes[${index}]`;
    const rawEffect = entry["effect"];
    const effectRecord = rawEffect === undefined ? undefined : asRecord(rawEffect, `${itemName}.effect`);
    const penaltyRisk = effectRecord?.["penaltyRiskBasisPoints"];
    if (effectRecord !== undefined && !Number.isSafeInteger(penaltyRisk)) throw new GameApiError(`${itemName}.effect.penaltyRiskBasisPoints ist keine sichere ganze Zahl.`, false);
    return {
      id: stringValue(entry, "id", itemName)!, label: stringValue(entry, "label", itemName)!,
      baseThresholdSeconds: integerValue(entry, "baseThresholdSeconds", itemName), selected: booleanValue(entry, "selected", itemName),
      ...(effectRecord === undefined ? {} : { effect: {
        costCents: integerMoney(effectRecord, "costCents", `${itemName}.effect`, true),
        qualityBasisPoints: integerValue(effectRecord, "qualityBasisPoints", `${itemName}.effect`),
        penaltyRiskBasisPoints: penaltyRisk as number,
      } }),
    };
  });
  const programmeRuleEffects = recordList(presentationRecord["programmeRuleEffects"], `${presentationName}.programmeRuleEffects`).map((entry, index) => {
    const itemName = `${presentationName}.programmeRuleEffects[${index}]`;
    const effectName = `${itemName}.effect`;
    const effect = asRecord(entry["effect"], effectName);
    const penaltyRiskBasisPoints = effect["penaltyRiskBasisPoints"];
    if (!Number.isSafeInteger(penaltyRiskBasisPoints)) throw new GameApiError(`${effectName}.penaltyRiskBasisPoints ist keine sichere ganze Zahl.`, false);
    return {
      rule: enumValue(entry, "rule", itemName, ["hold-connections", "prioritize-punctuality", "activate-reserve"]),
      label: stringValue(entry, "label", itemName)!,
      effect: {
        costCents: integerMoney(effect, "costCents", effectName, true),
        qualityBasisPoints: integerValue(effect, "qualityBasisPoints", effectName),
        penaltyRiskBasisPoints: penaltyRiskBasisPoints as number,
      },
    };
  });
  const programmeRules = new Set(programmeRuleEffects.map((entry) => entry.rule));
  if (programmeRuleEffects.length !== 3 || programmeRules.size !== 3
    || !(["hold-connections", "prioritize-punctuality", "activate-reserve"] as const).every((rule) => programmeRules.has(rule))) {
    throw new GameApiError(`${presentationName}.programmeRuleEffects erklärt nicht alle drei Regelauswahlen.`, false);
  }
  const disruptionOptions = recordList(presentationRecord["disruptionOptions"], `${presentationName}.disruptionOptions`).map((entry, index) => {
    const itemName = `${presentationName}.disruptionOptions[${index}]`;
    return {
      action: enumValue(entry, "action", itemName, ["short_turn", "request_reroute", "trigger_rail_replacement"]),
      label: stringValue(entry, "label", itemName)!, costCents: integerMoney(entry, "costCents", itemName),
      punctualityBasisPoints: integerValue(entry, "punctualityBasisPoints", itemName), cancellations: integerValue(entry, "cancellations", itemName),
    };
  });
  const presentation: TutorialPresentationView = {
    schemaVersion: TUTORIAL_PRESENTATION_SCHEMA,
    tender: {
      id: stringValue(tenderRecord, "id", tenderName)!,
      priceWeightBasisPoints: integerValue(tenderRecord, "priceWeightBasisPoints", tenderName),
      qualityWeightBasisPoints: integerValue(tenderRecord, "qualityWeightBasisPoints", tenderName),
      penaltyFocus: stringValue(tenderRecord, "penaltyFocus", tenderName)!,
      viabilityThresholdCentsPerTrainKm: integerMoney(tenderRecord, "viabilityThresholdCentsPerTrainKm", tenderName),
      limits,
    },
    leases, paths, programmes, programmeRuleEffects, disruptionOptions,
  };
  let summary: TutorialResultSummary | undefined;
  if (record["summary"] !== undefined) {
    const summaryName = `${name}.summary`;
    const summaryRecord = asRecord(record["summary"], summaryName);
    const comparisonName = `${summaryName}.comparison`;
    const rawComparison = asRecord(summaryRecord["comparison"], comparisonName);
    const programmePenaltyRiskBasisPoints = rawComparison["programmePenaltyRiskBasisPoints"];
    if (!Number.isSafeInteger(programmePenaltyRiskBasisPoints)) throw new GameApiError(`${comparisonName}.programmePenaltyRiskBasisPoints ist keine sichere ganze Zahl.`, false);
    const comparison: Readonly<Record<string, string | number>> = {
      bidOrderingFeeCentsPerTrainKm: integerMoney(rawComparison, "bidOrderingFeeCentsPerTrainKm", comparisonName),
      bidPunctualityBasisPoints: integerValue(rawComparison, "bidPunctualityBasisPoints", comparisonName),
      bidExtraSeats: integerValue(rawComparison, "bidExtraSeats", comparisonName),
      leaseLabel: stringValue(rawComparison, "leaseLabel", comparisonName)!,
      leaseCostCents: integerMoney(rawComparison, "leaseCostCents", comparisonName),
      leaseSeats: integerValue(rawComparison, "leaseSeats", comparisonName),
      leaseReliabilityBasisPoints: integerValue(rawComparison, "leaseReliabilityBasisPoints", comparisonName),
      pathLabel: stringValue(rawComparison, "pathLabel", comparisonName)!,
      pathCostCents: integerMoney(rawComparison, "pathCostCents", comparisonName),
      pathBufferSeconds: integerValue(rawComparison, "pathBufferSeconds", comparisonName),
      programmeLabel: stringValue(rawComparison, "programmeLabel", comparisonName)!,
      programmeRuleLabel: stringValue(rawComparison, "programmeRuleLabel", comparisonName)!,
      programmeThresholdSeconds: integerValue(rawComparison, "programmeThresholdSeconds", comparisonName),
      programmeCostCents: integerMoney(rawComparison, "programmeCostCents", comparisonName, true),
      programmeQualityBasisPoints: integerValue(rawComparison, "programmeQualityBasisPoints", comparisonName),
      programmePenaltyRiskBasisPoints: programmePenaltyRiskBasisPoints as number,
      disruptionLabel: stringValue(rawComparison, "disruptionLabel", comparisonName)!,
      disruptionCostCents: integerMoney(rawComparison, "disruptionCostCents", comparisonName),
      disruptionPunctualityBasisPoints: integerValue(rawComparison, "disruptionPunctualityBasisPoints", comparisonName),
      disruptionCancellations: integerValue(rawComparison, "disruptionCancellations", comparisonName),
    };
    summary = {
      startLiquidityCents: integerMoney(summaryRecord, "startLiquidityCents", summaryName, true),
      leasingCostCents: integerMoney(summaryRecord, "leasingCostCents", summaryName, true),
      pathAndOperatingCostCents: integerMoney(summaryRecord, "pathAndOperatingCostCents", summaryName, true),
      orderingRevenueCents: integerMoney(summaryRecord, "orderingRevenueCents", summaryName, true),
      disruptionCostCents: integerMoney(summaryRecord, "disruptionCostCents", summaryName, true),
      resultCents: integerMoney(summaryRecord, "resultCents", summaryName, true),
      punctualityBasisPoints: integerValue(summaryRecord, "punctualityBasisPoints", summaryName),
      qualityTargetsMet: stringList(summaryRecord["qualityTargetsMet"], `${summaryName}.qualityTargetsMet`),
      comparison,
    };
  }
  return {
    schemaVersion: TUTORIAL_SESSION_SCHEMA,
    reference: stringValue(record, "reference", name)!,
    tutorialWorldId: stringValue(record, "tutorialWorldId", name)!,
    publicWorldId: stringValue(record, "publicWorldId", name)!,
    lifecycle: enumValue(record, "lifecycle", name, ["provisioning", "running", "summary", "closing", "archived", "failed"]),
    templateVersion: stringValue(record, "templateVersion", name)!,
    templateHash: stringValue(record, "templateHash", name)!,
    currentChapter: integerValue(record, "currentChapter", name, 1),
    progressLabel: stringValue(record, "progressLabel", name)!,
    chapters,
    evidence,
    dialogue,
    presentation,
    ...(summary === undefined ? {} : { summary }),
    idleExpiresAt: stringValue(record, "idleExpiresAt", name)!,
    maximumExpiresAt: stringValue(record, "maximumExpiresAt", name)!,
    publicWorldUrl: stringValue(record, "publicWorldUrl", name)!,
  };
}

/** Authentifizierter Client fuer die serverautoritaere Planner-Projektion. */
export class GameApiClient {
  readonly #baseUrl: string;
  readonly #accessToken: string | ((forceRefresh?: boolean) => Promise<string>);
  readonly #fetch: typeof fetch;
  readonly #wait: WaitImplementation;

  constructor(
    baseUrl: string,
    accessToken: string | ((forceRefresh?: boolean) => Promise<string>),
    fetchImplementation: typeof fetch | undefined = undefined,
    waitImplementation: WaitImplementation = wait,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#accessToken = accessToken;
    this.#fetch = fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));
    this.#wait = waitImplementation;
  }

  #token(forceRefresh = false): Promise<string> {
    return typeof this.#accessToken === "string" ? Promise.resolve(this.#accessToken) : this.#accessToken(forceRefresh);
  }

  async #journeyJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = init.signal === undefined ? new AbortController() : undefined;
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), JOURNEY_TIMEOUT_MS);
    let response: Response;
    try {
      const request = async (forceRefresh = false): Promise<Response> => this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? controller?.signal,
        headers: {
          authorization: `Bearer ${await this.#token(forceRefresh)}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      });
      response = await request();
      if ((response.status === 401 || response.status === 403) && typeof this.#accessToken !== "string") response = await request(true);
    } catch (error) {
      if (controller?.signal.aborted === true) throw new GameApiError("Spielerreise antwortet nicht. Bitte erneut versuchen.", true);
      if (error instanceof TypeError) throw new GameApiError("Verbindung zur Spielerreise wurde unterbrochen. Bitte erneut versuchen.", true);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok) {
      let message = `Spielerreise nicht verfügbar (HTTP ${response.status}).`;
      try {
        const problem = await response.json() as { error?: unknown };
        if (typeof problem.error === "string") message = problem.error;
      } catch { /* HTTP-Status bleibt die erklaerbare Rueckmeldung. */ }
      throw new GameApiError(message, response.status >= 500, response.status);
    }
    try { return await response.json() as T; }
    catch { throw new GameApiError("Spielerreise lieferte kein gültiges JSON.", false); }
  }

  startTutorial(publicWorldId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(publicWorldId)}/tutorial-sessions`, { method: "POST" }).then(parseTutorialSessionV1);
  }

  async loadActiveTutorial(publicWorldId: string): Promise<TutorialSessionView | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JOURNEY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/worlds/${encodeURIComponent(publicWorldId)}/tutorial-sessions/active`, {
        headers: { authorization: `Bearer ${await this.#token()}` }, signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new GameApiError("Tutorialstatus antwortet nicht. Bitte erneut versuchen.", true);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GameApiError(`Tutorialstatus nicht verfügbar (HTTP ${response.status}).`, response.status >= 500, response.status);
    try { return parseTutorialSessionV1(await response.json()); }
    catch (error) {
      if (error instanceof GameApiError) throw error;
      throw new GameApiError("Tutorialstatus lieferte kein gültiges JSON.", false);
    }
  }

  loadTutorial(tutorialWorldId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session`).then(parseTutorialSessionV1);
  }

  tutorialAction(tutorialWorldId: string, action: TutorialAction): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session/actions`, { method: "POST", body: JSON.stringify(action) }).then(parseTutorialSessionV1);
  }

  restartTutorial(tutorialWorldId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session/restart`, { method: "POST" }).then(parseTutorialSessionV1);
  }

  openTutorialHint(tutorialWorldId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session/hints`, { method: "POST" }).then(parseTutorialSessionV1);
  }

  dismissTutorialDialogue(tutorialWorldId: string, dialogueId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session/dialogues/dismiss`, { method: "POST", body: JSON.stringify({ dialogueId }) }).then(parseTutorialSessionV1);
  }

  confirmTutorialSummary(tutorialWorldId: string): Promise<TutorialSessionView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(tutorialWorldId)}/tutorial-session/summary/confirm`, { method: "POST" }).then(parseTutorialSessionV1);
  }

  async loadStartingCapitalPolicy(worldId: string): Promise<StartingCapitalPolicy> {
    const value = await this.#journeyJson<unknown>(
      `/worlds/${encodeURIComponent(worldId)}/starting-capital-policy`,
    );
    try {
      return parseStartingCapitalPolicy(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unbekannter Vertragsfehler";
      throw new GameApiError(`Startkapital-Policy hat ein ungültiges Format: ${detail}`, false);
    }
  }

  loadOwnOperators(): Promise<readonly OperatorSummary[]> {
    return this.#journeyJson<unknown>("/me/operators").then(parseOperatorSummaries);
  }

  createOperator(worldId: string, name: string): Promise<OperatorSummary> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }).then((value) => parseOperatorSummaries([value])[0]!);
  }

  loadPublicWorldContracts(): Promise<readonly PublicWorldContractView[]> {
    return this.#journeyJson<unknown>("/public-world-contracts").then(parsePublicWorldContracts);
  }

  async enterPublicWorld(worldId: string, displayName: string, acceptedWorldContractHash: string): Promise<unknown> {
    try {
      return await this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/access`, {
        method: "POST", body: JSON.stringify({ displayName, acceptedWorldContractHash }),
      });
    } catch (error) {
      if (!(error instanceof GameApiError) || !error.retryable) throw error;
      try {
        return await this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/access`);
      } catch (statusError) {
        if (statusError instanceof GameApiError && statusError.status === 404) throw error;
        throw statusError;
      }
    }
  }

  async loadSimulationTime(worldId: string): Promise<number> {
    const value = await this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/simulation-time`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GameApiError("Weltzeit ist kein Objekt.", false);
    const atS = (value as Record<string, unknown>)["atS"];
    if (!Number.isSafeInteger(atS) || (atS as number) < 0) throw new GameApiError("Weltzeit ist keine sichere Simulationssekunde.", false);
    return atS as number;
  }

  loadEconomyState(worldId: string): Promise<EconomyPlayerStateView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/economy/state`).then(parseEconomyPlayerState);
  }

  submitTenderBid(worldId: string, tenderId: string, operatorId: string, payload: {
    readonly expectedRevision: number; readonly commandId: string; readonly bidId: string;
    readonly orderingFeeCentsPerTrainKm: string;
    readonly vehicleReference: { readonly fleetRevision: number; readonly snapshotHash: string; readonly formationId: string; readonly personnelDutyIds?: readonly string[]; readonly pathReservationIds?: readonly string[]; readonly entryFacility?: { readonly schemaVersion: "zugfolge-public-entry-facility/v1"; readonly providerOperatorId: "public" } };
    readonly promises: { readonly extraSeats: number; readonly punctualityBasisPoints: number; readonly additionalStops: number };
  }): Promise<unknown> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/economy/tenders/${encodeURIComponent(tenderId)}/operators/${encodeURIComponent(operatorId)}/bids`, { method: "POST", body: JSON.stringify(payload) });
  }

  loadWorldOperators(worldId: string): Promise<readonly OperatorSummary[]> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators`).then(parseOperatorSummaries);
  }

  loadMailbox(worldId: string): Promise<readonly MailboxMessageView[]> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/mailbox`).then(parseMailbox);
  }

  acknowledgeMailboxMessage(worldId: string, messageId: string): Promise<MailboxMessageView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/mailbox/${encodeURIComponent(messageId)}/ack`, { method: "POST" })
      .then((value) => parseMailbox([value])[0]!);
  }

  loadContracts(worldId: string, operatorId: string, view: CooperationPageView = "actionable", cursor?: string, limit = 50, deadlineBeforeS?: number): Promise<CursorPage<OperatorContractView>> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts?${pageQuery(view, cursor, limit, deadlineBeforeS)}`)
      .then((value) => parseCursorPage(value, "Vertragsseite", parseContract));
  }

  loadCooperationResources(worldId: string, operatorId: string): Promise<CooperationResourceCatalog> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/cooperation-resources`)
      .then((value) => {
        const catalog = parseCooperationResourceCatalog(value);
        if (catalog.worldId !== worldId || catalog.operatorId !== operatorId) {
          throw new GameApiError("Kooperationsressourcen gehoeren zu einer anderen Welt oder einem anderen EVU.", false);
        }
        return catalog;
      });
  }

  offerContract(worldId: string, operatorId: string, payload: ContractOfferPayload): Promise<OperatorContractView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts`, {
      method: "POST", body: JSON.stringify(payload),
    }).then((value) => parseContract(value, "Vertragsantwort"));
  }

  respondToContract(worldId: string, operatorId: string, contractId: string, response: "accept" | "reject", idempotencyKey: string): Promise<OperatorContractView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts/${encodeURIComponent(contractId)}/respond`, {
      method: "POST", body: JSON.stringify({ response, idempotencyKey }),
    }).then((value) => parseContract(value, "Vertragsantwort"));
  }

  endContract(worldId: string, operatorId: string, contractId: string, reason: string, nonPerformance: boolean, idempotencyKey: string, evidenceReference?: string): Promise<OperatorContractView> {
    if (nonPerformance && evidenceReference === undefined) {
      throw new GameApiError("Nichterfüllung braucht einen serverautoritativen Betriebsbeleg.", false);
    }
    const action = nonPerformance ? "non-performance" : "end";
    const body = nonPerformance ? { reason, evidenceReference, idempotencyKey } : { reason, idempotencyKey };
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts/${encodeURIComponent(contractId)}/${action}`, {
      method: "POST", body: JSON.stringify(body),
    }).then((value) => parseContract(value, "Vertragsantwort"));
  }

  loadVehicleMarket(worldId: string, view: CooperationPageView = "actionable", cursor?: string, limit = 50, deadlineBeforeS?: number): Promise<CursorPage<VehicleMarketListingView>> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings?${pageQuery(view, cursor, limit, deadlineBeforeS)}`)
      .then((value) => parseCursorPage(value, "Marktseite", parseListing));
  }

  loadOwnedVehicles(worldId: string, operatorId: string): Promise<readonly VehicleAssetView[]> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicles`).then(parseVehicles);
  }

  createVehicleListing(worldId: string, operatorId: string, vehicleId: string, payload: {
    readonly listingType: "sale" | "rental"; readonly priceCents: string; readonly rentalValidUntilS?: number;
    readonly expiresAtS: number; readonly idempotencyKey: string;
  }): Promise<VehicleMarketListingView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicles/${encodeURIComponent(vehicleId)}/listings`, {
      method: "POST", body: JSON.stringify(payload),
    }).then((value) => parseListing(value, "Fahrzeugangebot"));
  }

  reserveVehicleListing(worldId: string, listingId: string, buyerOperatorId: string, expectedRevision: number, idempotencyKey: string): Promise<VehicleMarketListingView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/reserve`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, expectedRevision, idempotencyKey }),
    }).then((value) => parseListing(value, "Fahrzeugreservierung"));
  }

  transferVehicleListing(worldId: string, listingId: string, buyerOperatorId: string, expectedRevision: number, idempotencyKey: string): Promise<VehicleTransferResultView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/transfer`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, expectedRevision, idempotencyKey }),
    }).then((value) => parseVehicleTransferResult(value, "Fahrzeugübertragung"));
  }

  reverseVehicleTransfer(worldId: string, listingId: string, buyerOperatorId: string, reasonCode: string, idempotencyKey: string): Promise<VehicleTransferResultView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/reverse`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, reasonCode, idempotencyKey }),
    }).then((value) => parseVehicleTransferResult(value, "Fahrzeugrückabwicklung"));
  }

  cancelVehicleListing(worldId: string, operatorId: string, listingId: string, expectedRevision: number, idempotencyKey: string): Promise<VehicleMarketListingView> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/cancel`, {
      method: "POST", body: JSON.stringify({ expectedRevision, idempotencyKey }),
    }).then((value) => parseListing(value, "Fahrzeugangebot"));
  }

  loadVehicleHistory(worldId: string, vehicleId: string): Promise<readonly VehicleHistoryEventView[]> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/vehicles/${encodeURIComponent(vehicleId)}/history`).then(parseHistory);
  }

  scheduleMaintenance(worldId: string, operatorId: string, payload: {
    readonly formationId: string;
    readonly durationHours: number;
    readonly idempotencyKey: string;
  }): Promise<void> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/fleet/maintenance`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then(() => undefined);
  }

  submitPlanningPathRequest(worldId: string, payload: {
    readonly schemaVersion: "planning.player-path-request/v2";
    readonly requestId: string;
    readonly formationId: string;
    readonly trainCategory: "long-distance" | "suburban" | "regional" | "freight" | "supplementary";
    readonly originStationId: string;
    readonly destinationStationId: string;
    readonly desiredDepartureS: number;
    readonly operatingDays: "daily" | "workdays" | "weekend";
    readonly stops: readonly { readonly stationId: string; readonly minimumDwellS: number }[];
    readonly earlierS: number;
    readonly laterS: number;
    readonly stepS: number;
    readonly extraRunningTimeS: number;
    readonly maxOperationalStops: number;
  }): Promise<{ readonly trainNumber: number }> {
    return this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/planning/path-requests`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((value) => {
      if (typeof value !== "object" || value === null || !("payload" in value)) throw new Error("Planungsantwort enthält keine Zugnummer.");
      const commandPayload = (value as { payload?: unknown }).payload;
      if (typeof commandPayload !== "object" || commandPayload === null || !("trainNumber" in commandPayload)) throw new Error("Planungsantwort enthält keine Zugnummer.");
      const trainNumber = (commandPayload as { trainNumber?: unknown }).trainNumber;
      if (!Number.isSafeInteger(trainNumber) || (trainNumber as number) < 1) throw new Error("Planungsantwort enthält eine ungültige Zugnummer.");
      return { trainNumber: trainNumber as number };
    });
  }

  async loadProjection(worldId: string, signal?: AbortSignal): Promise<PlanningProjectionV1> {
    const response = await this.#fetch(
      `${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/diagram`,
      {
        headers: { authorization: `Bearer ${await this.#token()}` },
        signal,
      },
    );
    if (!response.ok) {
      throw new GameApiError(
        `Planungsdaten nicht verfügbar (HTTP ${response.status}).`,
        response.status >= 500,
        response.status,
      );
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new GameApiError("Planungsdaten besitzen kein gültiges Austauschformat.", false);
    }
    try {
      const parsedEnvelope = parsePlanningProjectionEnvelope(envelope);
      const projection: PlanningProjectionV1 = { ...parsedEnvelope.data, timeBasis: parsedEnvelope.timeBasis };
      if (projection.worldId !== worldId) {
        throw new Error("Die Planungsdaten gehören zu einer anderen Welt.");
      }
      return projection;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unbekannter Vertragsfehler";
      throw new GameApiError(`Planungsdaten haben ein ungültiges Format: ${message}`, false);
    }
  }

  async queueAlternative(
    worldId: string,
    commandValue: PlanningAlternativeCommandV1,
    options: AlternativeApplicationOptions = {},
  ): Promise<void> {
    const command = parsePlanningAlternativeCommand(commandValue);
    const attempts = positiveInteger(options.queueAttempts, 3, "queueAttempts");
    const retryDelayMs = nonNegativeInteger(
      options.queueRetryDelayMs,
      250,
      "queueRetryDelayMs",
    );
    const body = JSON.stringify(command);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.#fetch(
          `${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/alternatives`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${await this.#token()}`,
              "content-type": "application/json",
            },
            body,
            signal: options.signal,
          },
        );
        if (response.ok) return;
        if (response.status < 500 || attempt === attempts) {
          throw new GameApiError(
            `Alternative wurde nicht angenommen (HTTP ${response.status}).`,
            false,
            response.status,
          );
        }
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        if (error instanceof GameApiError && !error.retryable) throw error;
        if (attempt === attempts) {
          const message = error instanceof Error ? error.message : "Netzwerkfehler";
          throw new GameApiError(`Alternative konnte nicht eingereiht werden: ${message}`, false);
        }
      }
      if (retryDelayMs > 0) await this.#wait(retryDelayMs, options.signal);
    }
  }

  async waitForNewerProjection(
    worldId: string,
    previousRevision: number,
    options: AlternativeApplicationOptions = {},
  ): Promise<PlanningProjectionV1> {
    const attempts = positiveInteger(options.pollAttempts, 40, "pollAttempts");
    const intervalMs = nonNegativeInteger(options.pollIntervalMs, 250, "pollIntervalMs");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const projection = await this.loadProjection(worldId, options.signal);
        if (projection.projectionRevision < previousRevision) {
          throw new GameApiError(
            "Der bestätigte Planungsstand ist unerwartet zurückgefallen.",
            false,
          );
        }
        if (projection.projectionRevision > previousRevision) return projection;
      } catch (error) {
        if (!(error instanceof GameApiError) || !error.retryable || attempt === attempts) {
          throw error;
        }
      }
      if (attempt < attempts && intervalMs > 0) {
        await this.#wait(intervalMs, options.signal);
      }
    }
    throw new GameApiError(
      `Die Planung hat nach ${attempts} Abrufen noch keinen neueren bestätigten Stand geliefert.`,
      false,
    );
  }

  async applyAlternative(
    worldId: string,
    projectionRevision: number,
    alternativeId: string,
    options: AlternativeApplicationOptions = {},
  ): Promise<PlanningProjectionV1> {
    const command = createPlanningAlternativeCommand(projectionRevision, alternativeId);
    await this.queueAlternative(worldId, command, options);
    return this.waitForNewerProjection(worldId, projectionRevision, options);
  }
}
