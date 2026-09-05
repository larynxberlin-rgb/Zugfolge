import {
  dailyOperationReports,
  domainEvents,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  mailboxMessages,
  operatorContracts,
  operatorStartingCapital,
  operators,
  vehicleAssetHistoryEvents,
  vehicleAssets,
  vehicleMarketListings,
  vehicleMarketTransfers,
  worlds,
  type OperatorContract,
  type VehicleAsset,
  type VehicleMarketListing,
} from "@zugfolge/db";
import {
  assertOperatorActionAllowed,
  EconomyCashWriterBindingError,
  loadEconomyCashAvailabilityForUpdate,
  loadEconomyWorldStateForUpdate,
  lockEconomyCashWriter,
} from "@zugfolge/economy";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  CooperationAuthorizationError,
  CooperationConflictError,
  CooperationNotFoundError,
  CooperationValidationError,
} from "./errors.js";
import { cooperationHash } from "./hash.js";
import {
  CONTRACT_NON_PERFORMANCE_RULE,
  parseDailyOperationEvidenceReference,
  provesContractNonPerformanceV1,
} from "./non-performance.js";
import type {
  ContractActionInput,
  ContractAuthorityDecision,
  ContractOfferInput,
  CooperationAuthority,
  CreateListingInput,
  RegisterVehicleInput,
  VehicleTransferResult,
} from "./types.js";

export type CooperationDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export type CooperationPageView = "actionable" | "archive" | "all";

export interface CooperationPageOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly view?: CooperationPageView;
  readonly deadlineBeforeS?: number;
}

export interface CooperationPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CooperationValidationError("Seitengröße muss zwischen 1 und 100 liegen.", "invalid_page");
  }
  return limit;
}

function pageCursor(value: string | undefined): { readonly atS: number; readonly id: string } | undefined {
  if (value === undefined) return undefined;
  const match = /^v1\.([0-9]+)\.([0-9a-f-]{36})$/.exec(value);
  if (match === null) throw new CooperationValidationError("Seitencursor ist ungültig.", "invalid_page");
  const atS = Number(match[1]);
  if (!Number.isSafeInteger(atS)) throw new CooperationValidationError("Seitencursor liegt außerhalb des sicheren Zeitbereichs.", "invalid_page");
  return { atS, id: match[2]! };
}

function pageDeadline(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CooperationValidationError("Fristfilter muss eine sichere nichtnegative Weltsekunde sein.", "invalid_page");
  }
  return value;
}

function nextPageCursor(row: { readonly id: string; readonly atS: number } | undefined): string | null {
  return row === undefined ? null : `v1.${row.atS}.${row.id}`;
}

export interface FleetAssetTransferIntent {
  readonly worldId: string;
  readonly commandId: string;
  readonly atS: number;
  readonly vehicleId: string;
  readonly transferType: "sale" | "rental-start" | "rental-return" | "reversal";
  readonly fromOwnerOperatorId: string;
  readonly toOwnerOperatorId: string;
  readonly fromHolderOperatorId: string;
  readonly toHolderOperatorId: string;
  readonly lessorOperatorId: string | null;
  readonly contractId: string | null;
  readonly validUntilS: number | null;
  readonly transferReceiptHash: string;
}

/** Commit-Hook in den autoritativen Rust-Fleet-Single-Writer. */
export interface FleetAssetTransferWriter {
  apply(
    tx: CooperationDatabase,
    intent: FleetAssetTransferIntent,
  ): Promise<{ readonly resultingStateHash: string; readonly resultingRevision: number }>;
}

const ACTIVE_CONTRACT_STATUSES = ["accepted", "active"] as const;
export const VEHICLE_MARKET_RESERVATION_SECONDS = 600;

function safeSimSecond(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CooperationValidationError(`${name} ist keine gültige Simulationssekunde.`);
  }
}

function nonEmpty(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 200) {
    throw new CooperationValidationError(`${name} ist leer oder zu lang.`);
  }
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CooperationValidationError(`${name} muss ein Objekt sein.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new CooperationValidationError(`${name} muss eine nichtleere, begrenzte Liste sein.`);
  }
  const strings = value.map((item) => {
    if (typeof item !== "string") throw new CooperationValidationError(`${name} enthält keine Zeichenkette.`);
    nonEmpty(item, name);
    return item;
  });
  if (new Set(strings).size !== strings.length) throw new CooperationValidationError(`${name} enthält Duplikate.`);
  return strings;
}

function validateContractSubject(input: ContractOfferInput): void {
  const subject = record(input.subject, "Leistungsgegenstand");
  switch (input.contractType) {
    case "traction":
      stringArray(subject["trainRunIds"], "Zugfahrten");
      stringArray(subject["formationIds"], "Formationen");
      stringArray(subject["personnelDutyIds"], "Personaldienste");
      stringArray(subject["pathReceiptIds"], "Trassenbelege");
      break;
    case "vehicle-rental":
      stringArray(subject["vehicleIds"], "Fahrzeuge");
      break;
    case "connection": {
      const connections = subject["connections"];
      if (!Array.isArray(connections) || connections.length === 0 || connections.length > 500) {
        throw new CooperationValidationError("Anschlussvertrag braucht mindestens einen Anschluss.");
      }
      for (const [index, connection] of connections.entries()) {
        const value = record(connection, `Anschluss ${index + 1}`);
        if (typeof value["arrivalTrainRunId"] !== "string" || typeof value["onwardTrainRunId"] !== "string") {
          throw new CooperationValidationError("Anschluss braucht ankommende und weiterführende Zugfahrt.");
        }
        const maxWaitSeconds = value["maxWaitSeconds"];
        if (!Number.isSafeInteger(maxWaitSeconds) || (maxWaitSeconds as number) < 0 || (maxWaitSeconds as number) > 7_200) {
          throw new CooperationValidationError("Verbindliche Wartezeit muss zwischen 0 und 7.200 Sekunden liegen.");
        }
      }
      break;
    }
    case "disruption-assistance":
      if (typeof subject["disruptionId"] !== "string") {
        throw new CooperationValidationError("Ersatzverkehrshilfe braucht eine Störungskennung.");
      }
      stringArray(subject["trainRunIds"], "Ersatzzugfahrten");
      stringArray(subject["vehicleIds"], "Hilfsfahrzeuge");
      break;
  }
}

function validateOffer(input: ContractOfferInput): void {
  if (input.offerorOperatorId === input.offereeOperatorId) {
    throw new CooperationValidationError("Anbieter und Empfänger müssen getrennte EVU sein.");
  }
  nonEmpty(input.idempotencyKey, "Idempotenzschlüssel");
  safeSimSecond(input.offeredAtS, "Angebotszeit");
  safeSimSecond(input.responseDeadlineS, "Antwortfrist");
  safeSimSecond(input.validFromS, "Gültigkeitsbeginn");
  safeSimSecond(input.validUntilS, "Gültigkeitsende");
  safeSimSecond(input.terminationNoticeS, "Kündigungsfrist");
  if (input.responseDeadlineS < input.offeredAtS || input.responseDeadlineS > input.validFromS) {
    throw new CooperationValidationError("Antwortfrist liegt außerhalb des zulässigen Angebotsfensters.");
  }
  if (input.validUntilS <= input.validFromS) throw new CooperationValidationError("Vertrag braucht ein positives Gültigkeitsfenster.");
  if (input.priceCents < 0n) throw new CooperationValidationError("Vertragspreis darf nicht negativ sein.");
  record(input.terms, "Vertragsbedingungen");
  validateContractSubject(input);
}

function bindingValues(bindings: unknown): readonly unknown[] {
  const value = record(bindings, "Fahrzeugbindungen");
  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : [entry])).filter((entry) => entry !== null);
}

export class DatabaseCooperationAuthority implements CooperationAuthority {
  async verifyContract(_input: ContractOfferInput): Promise<ContractAuthorityDecision> {
    return { permitted: true, code: "verified", explanation: "Formale Fachprüfung erfolgreich." };
  }

  async verifyContractPayment(): Promise<ContractAuthorityDecision> {
    return { permitted: true, code: "verified", explanation: "Formale Zahlungsprüfung erfolgreich." };
  }

  async verifyVehicleListing(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listingType: "sale" | "rental";
    readonly atS: number;
  }): Promise<ContractAuthorityDecision> {
    if (bindingValues(input.vehicle.bindings).length > 0) {
      return { permitted: false, code: "vehicle_bound", explanation: "Fahrzeug besitzt laufende Umlauf-, Vertrags-, Werkstatt- oder Sicherungsbindungen." };
    }
    if (input.vehicle.ownerOperatorId !== input.vehicle.holderOperatorId) {
      return { permitted: false, code: "vehicle_leased", explanation: "Ein bereits vermietetes Fahrzeug kann nicht erneut angeboten werden." };
    }
    return { permitted: true, code: "verified", explanation: `${input.listingType} ist durchführbar.` };
  }

  async verifyVehicleTransfer(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listing: VehicleMarketListing;
    readonly buyerOperatorId: string;
    readonly atS: number;
  }): Promise<ContractAuthorityDecision> {
    if (input.vehicle.ownerOperatorId !== input.listing.offeringOperatorId) {
      return { permitted: false, code: "ownership_changed", explanation: "Eigentümer hat sich seit Veröffentlichung geändert." };
    }
    if (bindingValues(input.vehicle.bindings).length > 0) {
      return { permitted: false, code: "vehicle_bound", explanation: "Fahrzeug ist inzwischen fachlich gebunden." };
    }
    if (input.buyerOperatorId === input.listing.offeringOperatorId) {
      return { permitted: false, code: "same_party", explanation: "Anbieter kann das eigene Fahrzeug nicht übernehmen." };
    }
    return { permitted: true, code: "verified", explanation: "Eigentum, Verfügbarkeit und Bindungen sind geprüft." };
  }

  async verifyVehicleReversal(_input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listing: VehicleMarketListing;
    readonly originalTransferId: string;
    readonly originalTransferredAtS: number;
    readonly assetBeforeHash: string;
    readonly reasonCode: string;
    readonly atS: number;
  }): Promise<ContractAuthorityDecision> {
    return {
      permitted: false,
      code: "reversal_evidence_missing",
      explanation: "Rückabwicklung braucht einen serverautoritativ bestätigten, an Angebot und Offenlegungsbeleg gebundenen Mangel.",
    };
  }
}

async function assertOperatorAccount(
  db: CooperationDatabase,
  worldId: string,
  operatorId: string,
  accountId: string,
): Promise<void> {
  const [operator] = await db
    .select({ foundingAccountId: operators.foundingAccountId })
    .from(operators)
    .where(and(eq(operators.worldId, worldId), eq(operators.id, operatorId)))
    .limit(1);
  if (operator === undefined) throw new CooperationNotFoundError(`EVU '${operatorId}' wurde in dieser Welt nicht gefunden.`);
  if (operator.foundingAccountId !== accountId) {
    throw new CooperationAuthorizationError(`Konto darf nicht für EVU '${operatorId}' handeln.`);
  }
}

async function worldSimDate(db: CooperationDatabase, worldId: string, atS: number): Promise<Date> {
  safeSimSecond(atS, "Ereigniszeit");
  const [world] = await db.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (world === undefined) throw new CooperationNotFoundError(`Welt '${worldId}' wurde nicht gefunden.`);
  const millis = world.epoch.getTime() + atS * 1_000;
  if (!Number.isSafeInteger(millis)) throw new CooperationValidationError("Ereigniszeit liegt außerhalb des Datumsbereichs.");
  return new Date(millis);
}

async function appendEvent(
  db: CooperationDatabase,
  worldId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  occurredAt: Date,
): Promise<void> {
  await db.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
  const [head] = await db
    .select({ sequence: domainEvents.sequence })
    .from(domainEvents)
    .where(eq(domainEvents.worldId, worldId))
    .orderBy(desc(domainEvents.sequence))
    .limit(1);
  await db.insert(domainEvents).values({
    worldId,
    sequence: (head?.sequence ?? 0) + 1,
    eventType,
    payload,
    occurredAt,
  });
}

interface CooperationCommandDescriptor {
  readonly kind: "contract-response" | "contract-end" | "listing-reserve" | "listing-cancel";
  readonly targetId: string;
  readonly actingOperatorId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface CooperationCommandReceipt {
  readonly replayed: boolean;
  readonly commandHash: string;
}

/**
 * Serialisiert Wiederholungen desselben Client-Kommandos innerhalb der
 * laufenden Fachdatenbank-Transaktion. Der gesperrte Weltkopf schliesst auch das
 * Rennen aus, in dem derselbe Schluessel gleichzeitig fuer zwei verschiedene
 * Objekte benutzt wird. Der gemeinsam mit der Fachwirkung gespeicherte
 * Domain-Event ist anschliessend der dauerhafte Receipt.
 */
async function claimCooperationCommand(
  db: CooperationDatabase,
  worldId: string,
  idempotencyKey: string,
  descriptor: CooperationCommandDescriptor,
): Promise<CooperationCommandReceipt> {
  nonEmpty(idempotencyKey, "Idempotenzschluessel");
  const commandHash = cooperationHash("cooperation-command/v1", descriptor);
  await db.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
  const [existing] = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
    eq(domainEvents.worldId, worldId),
    sql`${domainEvents.payload} ->> 'idempotencyKey' = ${idempotencyKey}`,
  )).orderBy(asc(domainEvents.sequence)).limit(1);
  if (existing === undefined) return { replayed: false, commandHash };
  const payload = typeof existing.payload === "object" && existing.payload !== null && !Array.isArray(existing.payload)
    ? existing.payload as Readonly<Record<string, unknown>>
    : undefined;
  if (payload?.["commandHash"] !== commandHash) {
    throw new CooperationConflictError(
      "Idempotenzschluessel gehoert zu einem anderen Kooperationskommando.",
      "idempotency_conflict",
    );
  }
  return { replayed: true, commandHash };
}

function commandReceiptPayload(
  idempotencyKey: string | undefined,
  receipt: CooperationCommandReceipt | undefined,
): Readonly<Record<string, unknown>> {
  return idempotencyKey === undefined || receipt === undefined
    ? {}
    : { idempotencyKey, commandHash: receipt.commandHash };
}

async function notifyOperators(
  db: CooperationDatabase,
  input: {
    readonly worldId: string;
    readonly operatorIds: readonly string[];
    readonly messageType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly sentAt: Date;
    readonly deadlineAt?: Date;
    readonly idempotencyKey: string;
  },
): Promise<void> {
  const recipients = await db
    .select({ operatorId: operators.id, accountId: operators.foundingAccountId })
    .from(operators)
    .where(and(eq(operators.worldId, input.worldId), or(...input.operatorIds.map((id) => eq(operators.id, id)))));
  if (recipients.length !== new Set(input.operatorIds).size) {
    throw new CooperationNotFoundError("Mindestens ein Nachrichtenempfänger existiert nicht in der Welt.");
  }
  await db.insert(mailboxMessages).values(recipients.map((recipient) => ({
    worldId: input.worldId,
    recipientAccountId: recipient.accountId,
    idempotencyKey: `${input.idempotencyKey}:${recipient.operatorId}`,
    messageType: input.messageType,
    payload: input.payload,
    sentAt: input.sentAt,
    deadlineAt: input.deadlineAt,
  }))).onConflictDoNothing({
    target: [mailboxMessages.worldId, mailboxMessages.recipientAccountId, mailboxMessages.idempotencyKey],
  });
}

async function ensureLedgerAccount(
  db: CooperationDatabase,
  worldId: string,
  operatorId: string,
  name: string,
): Promise<string> {
  const [created] = await db.insert(ledgerAccounts).values({ worldId, operatorId, name }).onConflictDoNothing({
    target: [ledgerAccounts.worldId, ledgerAccounts.operatorId, ledgerAccounts.name],
  }).returning({ id: ledgerAccounts.id });
  if (created !== undefined) return created.id;
  const [existing] = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, worldId),
    eq(ledgerAccounts.operatorId, operatorId),
    eq(ledgerAccounts.name, name),
  )).limit(1);
  if (existing === undefined) throw new Error("Ledger-Konto konnte nicht materialisiert werden.");
  return existing.id;
}

const CASH_LEDGER_ACCOUNT_NAMES = ["Economy:Kasse", "Bank"] as const;

/**
 * Loest das bereits provisionierte Cash-Konto fail-closed auf. Der
 * versionierte Economy-Standard gewinnt deterministisch; `Bank` bleibt nur
 * fuer bestehende Spielwelten lesbar. Cash wird hier niemals
 * materialisiert, weil das sonst beim Kauf Geld ausserhalb des Economy-Writers
 * erzeugen koennte.
 */
async function resolveCashLedgerAccount(
  db: CooperationDatabase,
  worldId: string,
  operatorId: string,
): Promise<string> {
  const rows = await db.select({ id: ledgerAccounts.id, name: ledgerAccounts.name }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, worldId),
    eq(ledgerAccounts.operatorId, operatorId),
    inArray(ledgerAccounts.name, [...CASH_LEDGER_ACCOUNT_NAMES]),
  ));
  const byName = new Map(rows.map((row) => [row.name, row.id] as const));
  const accountId = byName.get(CASH_LEDGER_ACCOUNT_NAMES[0]) ?? byName.get(CASH_LEDGER_ACCOUNT_NAMES[1]);
  if (accountId === undefined) {
    throw new CooperationConflictError(
      "EVU besitzt kein autoritativ provisioniertes Cash-Konto.",
      "cash_account_missing",
    );
  }
  return accountId;
}

interface InteroperatorCashAccounts {
  readonly payerCashAccountId: string;
  readonly payeeCashAccountId: string;
}

async function resolveInteroperatorCashAccounts(
  db: CooperationDatabase,
  input: {
    readonly worldId: string;
    readonly payerOperatorId: string;
    readonly payeeOperatorId: string;
  },
): Promise<InteroperatorCashAccounts> {
  return {
    payerCashAccountId: await resolveCashLedgerAccount(db, input.worldId, input.payerOperatorId),
    payeeCashAccountId: await resolveCashLedgerAccount(db, input.worldId, input.payeeOperatorId),
  };
}

async function postPartyLedger(
  db: CooperationDatabase,
  input: {
    readonly worldId: string;
    readonly operatorId: string;
    readonly amountCents: bigint;
    readonly direction: "pay" | "receive";
    readonly description: string;
    readonly postedAt: Date;
    readonly idempotencyKey: string;
    readonly costCentreId: string;
    readonly cashAccountId: string;
  },
): Promise<void> {
  const counterparty = await ensureLedgerAccount(db, input.worldId, input.operatorId, "EVU-Verträge");
  const [created] = await db.insert(ledgerTransactions).values({
    worldId: input.worldId,
    operatorId: input.operatorId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    postedAt: input.postedAt,
  }).onConflictDoNothing({
    target: [ledgerTransactions.worldId, ledgerTransactions.operatorId, ledgerTransactions.idempotencyKey],
  }).returning({ id: ledgerTransactions.id });
  if (created === undefined) return;
  const cashAmount = input.direction === "pay" ? -input.amountCents : input.amountCents;
  await db.insert(ledgerEntries).values([
    {
      worldId: input.worldId,
      transactionId: created.id,
      ledgerAccountId: input.cashAccountId,
      amountCents: cashAmount,
      costType: input.direction === "pay" ? "contract-payment" : "contract-income",
      costCentreId: input.costCentreId,
    },
    {
      worldId: input.worldId,
      transactionId: created.id,
      ledgerAccountId: counterparty,
      amountCents: -cashAmount,
      costType: input.direction === "pay" ? "contract-payment" : "contract-income",
      costCentreId: input.costCentreId,
    },
  ]);
}

async function postInteroperatorPayment(
  db: CooperationDatabase,
  input: {
    readonly worldId: string;
    readonly payerOperatorId: string;
    readonly payeeOperatorId: string;
    readonly priceCents: bigint;
    readonly postedAt: Date;
    readonly reference: string;
    readonly description: string;
  },
  resolvedAccounts?: InteroperatorCashAccounts,
): Promise<void> {
  if (input.priceCents === 0n) return;
  const cashAccounts = resolvedAccounts ?? await resolveInteroperatorCashAccounts(db, input);
  await postPartyLedger(db, {
    ...input,
    operatorId: input.payerOperatorId,
    amountCents: input.priceCents,
    direction: "pay",
    idempotencyKey: `${input.reference}:payer`,
    costCentreId: input.reference,
    cashAccountId: cashAccounts.payerCashAccountId,
  });
  await postPartyLedger(db, {
    ...input,
    operatorId: input.payeeOperatorId,
    amountCents: input.priceCents,
    direction: "receive",
    idempotencyKey: `${input.reference}:payee`,
    costCentreId: input.reference,
    cashAccountId: cashAccounts.payeeCashAccountId,
  });
}

async function assertSufficientCashBalance(
  db: CooperationDatabase,
  input: {
    readonly worldId: string;
    readonly operatorId: string;
    readonly cashAccountId: string;
    readonly requiredCents: bigint;
  },
): Promise<void> {
  // Economy-Outbox, Ledgerprojektion und Kooperation teilen diese
  // weltgebundene EVU-Sperre; kein Cash-Writer kann die Prüfung überholen.
  await lockEconomyCashWriter(db as never, input);
  const [startingCapital] = await db.select({ policyKind: operatorStartingCapital.policyKind })
    .from(operatorStartingCapital)
    .where(and(
      eq(operatorStartingCapital.worldId, input.worldId),
      eq(operatorStartingCapital.operatorId, input.operatorId),
    ))
    .limit(1);
  // `unlimited` ist ein eigener Finanzierungsmodus, kein Centwert. Reale
  // Zahlungen bleiben normale, ausgeglichene i64-Buchungen; nur die
  // Deckungsgrenze des Cash-Kontos entfaellt in dieser Weltvertragsvariante.
  if (startingCapital?.policyKind === "unlimited") return;
  let availableCents: bigint;
  try {
    availableCents = (await loadEconomyCashAvailabilityForUpdate(db as never, input)).availableCents;
  } catch (error) {
    if (error instanceof EconomyCashWriterBindingError) {
      throw new CooperationConflictError(
        "Autoritative Cash-Projektion ist nicht eindeutig an Welt, EVU und Konto gebunden.",
        "cash_projection_invalid",
      );
    }
    throw error;
  }
  if (availableCents <= 0n || availableCents < input.requiredCents) {
    throw new CooperationConflictError("Cash-Guthaben reicht für diesen Kauf nicht aus.", "insufficient_funds");
  }
}

async function assertEconomyPurchaseAllowed(
  db: CooperationDatabase,
  worldId: string,
  operatorId: string,
): Promise<void> {
  const economy = await loadEconomyWorldStateForUpdate(db as never, worldId);
  if (economy === undefined) {
    throw new CooperationConflictError(
      "Autoritativer Economy-Zustand der Welt fehlt; neue Zahlungsverpflichtung wird nicht eingegangen.",
      "economy_state_missing",
    );
  }
  try {
    assertOperatorActionAllowed(economy, operatorId, "purchase");
  } catch {
    throw new CooperationConflictError(
      "Economy-Zustand sperrt neue Kaeufe und Zahlungsverpflichtungen dieses EVU.",
      "purchase_blocked",
    );
  }
}

function discloseVehicle(vehicle: VehicleAsset): Readonly<Record<string, unknown>> {
  return {
    vehicleId: vehicle.vehicleId,
    authorityReleaseId: vehicle.authorityReleaseId,
    classDesignation: vehicle.classDesignation,
    actualConfiguration: vehicle.actualConfiguration,
    ownerOperatorId: vehicle.ownerOperatorId,
    holderOperatorId: vehicle.holderOperatorId,
    odometerMetres: vehicle.odometerMetres.toString(),
    conditionBasisPoints: vehicle.conditionBasisPoints,
    damages: vehicle.damages,
    maintenanceDeadlines: vehicle.maintenanceDeadlines,
    approvals: vehicle.approvals,
    operatingLimits: vehicle.operatingLimits,
    bindings: vehicle.bindings,
    valuationSpecId: vehicle.valuationSpecId,
    valueCents: vehicle.valueCents.toString(),
    assetRevision: vehicle.revision,
    historyHash: vehicle.historyHash,
  };
}

export class CooperationService {
  constructor(
    private readonly db: CooperationDatabase,
    private readonly authority: CooperationAuthority = new DatabaseCooperationAuthority(),
    private readonly fleetWriter?: FleetAssetTransferWriter,
  ) {}

  private async applyFleetTransfer(
    tx: CooperationDatabase,
    intent: FleetAssetTransferIntent,
  ): Promise<void> {
    if (this.fleetWriter === undefined) {
      throw new CooperationConflictError(
        "Der autoritative Flotten-Single-Writer ist fuer Fahrzeuguebertragungen nicht verfuegbar.",
        "fleet_single_writer_unavailable",
      );
    }
    await this.fleetWriter.apply(tx, intent);
  }

  private async appendVehicleHistory(
    tx: CooperationDatabase,
    input: {
      readonly worldId: string;
      readonly vehicleId: string;
      readonly eventType: "registered" | "condition-updated" | "sale" | "rental-start" | "rental-return" | "reversal";
      readonly atS: number;
      readonly priorHistoryHash: string | null;
      readonly resultingHistoryHash: string;
      readonly listingId?: string;
      readonly contractId?: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly idempotencyKey: string;
    },
  ): Promise<void> {
    await tx.insert(vehicleAssetHistoryEvents).values(input).onConflictDoNothing({
      target: [vehicleAssetHistoryEvents.worldId, vehicleAssetHistoryEvents.idempotencyKey],
    });
  }

  private async startContractRental(tx: CooperationDatabase, contract: OperatorContract, atS: number): Promise<void> {
    if (contract.contractType !== "vehicle-rental") return;
    const vehicleIds = stringArray(record(contract.subject, "Leistungsgegenstand")["vehicleIds"], "Mietfahrzeuge");
    for (const vehicleId of vehicleIds) {
      await tx.execute(sql`select ${vehicleAssets.vehicleId} from ${vehicleAssets} where ${vehicleAssets.worldId} = ${contract.worldId} and ${vehicleAssets.vehicleId} = ${vehicleId} for update`);
      const [vehicle] = await tx.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, contract.worldId), eq(vehicleAssets.vehicleId, vehicleId))).limit(1);
      if (vehicle === undefined) throw new CooperationNotFoundError(`Mietfahrzeug '${vehicleId}' fehlt.`);
      if (vehicle.ownerOperatorId !== contract.offerorOperatorId || vehicle.holderOperatorId !== contract.offerorOperatorId || vehicle.lessorOperatorId !== null || bindingValues(vehicle.bindings).length > 0) {
        throw new CooperationConflictError(`Mietfahrzeug '${vehicleId}' ist nicht frei beim Anbieter.`, "rental_vehicle_unavailable");
      }
      const transferReceiptHash = cooperationHash("operator-contract-rental-start/v1", { contractId: contract.id, vehicleId, atS });
      await this.applyFleetTransfer(tx, {
        worldId: contract.worldId, commandId: `contract-rental-start:${contract.id}:${vehicleId}`, atS, vehicleId,
        transferType: "rental-start", fromOwnerOperatorId: vehicle.ownerOperatorId, toOwnerOperatorId: vehicle.ownerOperatorId,
        fromHolderOperatorId: vehicle.holderOperatorId, toHolderOperatorId: contract.offereeOperatorId,
        lessorOperatorId: contract.offerorOperatorId, contractId: contract.id, validUntilS: contract.validUntilS, transferReceiptHash,
      });
      const historyHash = cooperationHash("vehicle-asset-history/v1", { vehicleId, previousHistoryHash: vehicle.historyHash, contractId: contract.id, transferType: "rental-start", atS });
      const [updated] = await tx.update(vehicleAssets).set({
        holderOperatorId: contract.offereeOperatorId, lessorOperatorId: contract.offerorOperatorId,
        revision: vehicle.revision + 1, historyHash,
      }).where(and(eq(vehicleAssets.worldId, contract.worldId), eq(vehicleAssets.vehicleId, vehicleId), eq(vehicleAssets.revision, vehicle.revision))).returning();
      if (updated === undefined) throw new CooperationConflictError("Mietfahrzeug wurde parallel geaendert.", "vehicle_revision_conflict");
      await this.appendVehicleHistory(tx, {
        worldId: contract.worldId, vehicleId, eventType: "rental-start", atS,
        priorHistoryHash: vehicle.historyHash, resultingHistoryHash: historyHash, contractId: contract.id,
        details: { fromHolderOperatorId: vehicle.holderOperatorId, toHolderOperatorId: contract.offereeOperatorId, validUntilS: contract.validUntilS },
        idempotencyKey: `contract-rental-start:${contract.id}:${vehicleId}`,
      });
    }
  }

  private async returnContractRental(tx: CooperationDatabase, contract: OperatorContract, atS: number): Promise<void> {
    if (contract.contractType !== "vehicle-rental") return;
    const vehicleIds = stringArray(record(contract.subject, "Leistungsgegenstand")["vehicleIds"], "Mietfahrzeuge");
    for (const vehicleId of vehicleIds) {
      await tx.execute(sql`select ${vehicleAssets.vehicleId} from ${vehicleAssets} where ${vehicleAssets.worldId} = ${contract.worldId} and ${vehicleAssets.vehicleId} = ${vehicleId} for update`);
      const [vehicle] = await tx.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, contract.worldId), eq(vehicleAssets.vehicleId, vehicleId))).limit(1);
      if (vehicle === undefined) throw new CooperationNotFoundError(`Mietfahrzeug '${vehicleId}' fehlt.`);
      if (vehicle.ownerOperatorId !== contract.offerorOperatorId || vehicle.holderOperatorId !== contract.offereeOperatorId || vehicle.lessorOperatorId !== contract.offerorOperatorId) {
        throw new CooperationConflictError(`Mietfahrzeug '${vehicleId}' besitzt keinen passenden Halterzustand.`, "rental_holding_conflict");
      }
      const transferReceiptHash = cooperationHash("operator-contract-rental-return/v1", { contractId: contract.id, vehicleId, atS });
      await this.applyFleetTransfer(tx, {
        worldId: contract.worldId, commandId: `contract-rental-return:${contract.id}:${vehicleId}:${atS}`, atS, vehicleId,
        transferType: "rental-return", fromOwnerOperatorId: vehicle.ownerOperatorId, toOwnerOperatorId: vehicle.ownerOperatorId,
        fromHolderOperatorId: vehicle.holderOperatorId, toHolderOperatorId: vehicle.ownerOperatorId,
        lessorOperatorId: null, contractId: null, validUntilS: null, transferReceiptHash,
      });
      const historyHash = cooperationHash("vehicle-asset-history/v1", { vehicleId, previousHistoryHash: vehicle.historyHash, contractId: contract.id, transferType: "rental-return", atS });
      const [updated] = await tx.update(vehicleAssets).set({
        holderOperatorId: vehicle.ownerOperatorId, lessorOperatorId: null,
        revision: vehicle.revision + 1, historyHash,
      }).where(and(eq(vehicleAssets.worldId, contract.worldId), eq(vehicleAssets.vehicleId, vehicleId), eq(vehicleAssets.revision, vehicle.revision))).returning();
      if (updated === undefined) throw new CooperationConflictError("Mietfahrzeug wurde parallel geaendert.", "vehicle_revision_conflict");
      await this.appendVehicleHistory(tx, {
        worldId: contract.worldId, vehicleId, eventType: "rental-return", atS,
        priorHistoryHash: vehicle.historyHash, resultingHistoryHash: historyHash, contractId: contract.id,
        details: { fromHolderOperatorId: vehicle.holderOperatorId, toHolderOperatorId: vehicle.ownerOperatorId },
        idempotencyKey: `contract-rental-return:${contract.id}:${vehicleId}:${atS}`,
      });
    }
  }

  async offerContract(input: ContractOfferInput): Promise<OperatorContract> {
    validateOffer(input);
    const decision = await this.authority.verifyContract(input);
    if (!decision.permitted) throw new CooperationConflictError(decision.explanation, decision.code);
    const occurredAt = await worldSimDate(this.db, input.worldId, input.offeredAtS);
    const deadlineAt = await worldSimDate(this.db, input.worldId, input.responseDeadlineS);
    const termsHash = cooperationHash("operator-contract/v1", {
      contractType: input.contractType,
      subject: input.subject,
      terms: input.terms,
      priceCents: input.priceCents,
      validFromS: input.validFromS,
      validUntilS: input.validUntilS,
      responseDeadlineS: input.responseDeadlineS,
      terminationNoticeS: input.terminationNoticeS,
    });
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.offerorOperatorId, input.offeredByAccountId);
      const [offeree] = await tx.select({ id: operators.id }).from(operators).where(and(
        eq(operators.worldId, input.worldId), eq(operators.id, input.offereeOperatorId),
      )).limit(1);
      if (offeree === undefined) throw new CooperationNotFoundError("Angebotsempfänger existiert nicht in dieser Welt.");
      let [contract] = await tx.insert(operatorContracts).values({
        ...input,
        termsHash,
        status: "offered",
      }).onConflictDoNothing({
        target: [operatorContracts.worldId, operatorContracts.offerorOperatorId, operatorContracts.idempotencyKey],
      }).returning();
      if (contract === undefined) {
        [contract] = await tx.select().from(operatorContracts).where(and(
          eq(operatorContracts.worldId, input.worldId),
          eq(operatorContracts.offerorOperatorId, input.offerorOperatorId),
          eq(operatorContracts.idempotencyKey, input.idempotencyKey),
        )).limit(1);
        if (contract === undefined) throw new Error("Idempotentes Vertragsangebot konnte nicht gelesen werden.");
        if (contract.termsHash !== termsHash || contract.offereeOperatorId !== input.offereeOperatorId) {
          throw new CooperationConflictError("Idempotenzschlüssel gehört zu einem anderen Vertragsinhalt.", "idempotency_conflict");
        }
        return contract;
      }
      await appendEvent(tx, input.worldId, "cooperation.contract-offered", {
        contractId: contract.id,
        contractType: contract.contractType,
        offerorOperatorId: contract.offerorOperatorId,
        offereeOperatorId: contract.offereeOperatorId,
        termsHash,
        priceCents: input.priceCents.toString(),
        validFromS: input.validFromS,
        validUntilS: input.validUntilS,
      }, occurredAt);
      await notifyOperators(tx, {
        worldId: input.worldId,
        operatorIds: [input.offereeOperatorId],
        messageType: "cooperation.contract-offer",
        payload: { contractId: contract.id, contractType: contract.contractType, termsHash },
        sentAt: occurredAt,
        deadlineAt,
        idempotencyKey: `contract-offer:${contract.id}`,
      });
      return contract;
    });
  }

  async respondToContract(input: ContractActionInput & { readonly response: "accept" | "reject" }): Promise<OperatorContract> {
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${operatorContracts.id} from ${operatorContracts} where ${operatorContracts.worldId} = ${input.worldId} and ${operatorContracts.id} = ${input.contractId} for update`);
      const [contract] = await tx.select().from(operatorContracts).where(and(
        eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, input.contractId),
      )).limit(1);
      if (contract === undefined) throw new CooperationNotFoundError("Vertrag wurde in dieser Welt nicht gefunden.");
      if (contract.offereeOperatorId !== input.actingOperatorId) {
        throw new CooperationAuthorizationError("Antwortendes EVU ist nicht die empfangende Vertragspartei.");
      }
      await assertOperatorAccount(tx, input.worldId, input.actingOperatorId, input.actingAccountId);
      const commandReceipt = input.idempotencyKey === undefined ? undefined : await claimCooperationCommand(
        tx,
        input.worldId,
        input.idempotencyKey,
        {
          kind: "contract-response",
          targetId: input.contractId,
          actingOperatorId: input.actingOperatorId,
          parameters: { response: input.response },
        },
      );
      if (commandReceipt?.replayed === true) return contract;
      if (contract.status !== "offered") throw new CooperationConflictError("Vertrag wurde bereits beantwortet.");
      if (input.atS > contract.responseDeadlineS) throw new CooperationConflictError("Antwortfrist ist abgelaufen.", "response_deadline_elapsed");
      if (input.response === "accept") {
        const authorityInput: ContractOfferInput = {
          worldId: contract.worldId,
          offerorOperatorId: contract.offerorOperatorId,
          offereeOperatorId: contract.offereeOperatorId,
          offeredByAccountId: contract.offeredByAccountId,
          contractType: contract.contractType,
          subject: record(contract.subject, "Leistungsgegenstand"),
          terms: record(contract.terms, "Vertragsbedingungen"),
          priceCents: contract.priceCents,
          validFromS: contract.validFromS,
          validUntilS: contract.validUntilS,
          responseDeadlineS: contract.responseDeadlineS,
          terminationNoticeS: contract.terminationNoticeS,
          offeredAtS: contract.offeredAtS,
          idempotencyKey: contract.idempotencyKey,
        };
        const decision = await this.authority.verifyContract(authorityInput);
        if (!decision.permitted) throw new CooperationConflictError(decision.explanation, decision.code);
        const paymentAccounts = contract.priceCents === 0n
          ? undefined
          : await (async () => {
              // Sperrstatus, Kontodeckung, Buchung und Vertragswirkung bleiben
              // auf derselben Economy-Revision und in derselben DB-Transaktion.
              await assertEconomyPurchaseAllowed(tx, input.worldId, contract.offereeOperatorId);
              const paymentDecision = await this.authority.verifyContractPayment({
                worldId: input.worldId,
                contractId: contract.id,
                payerOperatorId: contract.offereeOperatorId,
                priceCents: contract.priceCents,
                atS: input.atS,
              });
              if (!paymentDecision.permitted) {
                throw new CooperationConflictError(paymentDecision.explanation, paymentDecision.code);
              }
              return resolveInteroperatorCashAccounts(tx, {
                worldId: input.worldId,
                payerOperatorId: contract.offereeOperatorId,
                payeeOperatorId: contract.offerorOperatorId,
              });
            })();
        if (paymentAccounts !== undefined) {
          await assertSufficientCashBalance(tx, {
            worldId: input.worldId,
            operatorId: contract.offereeOperatorId,
            cashAccountId: paymentAccounts.payerCashAccountId,
            requiredCents: contract.priceCents,
          });
        }
        await postInteroperatorPayment(tx, {
          worldId: input.worldId,
          payerOperatorId: contract.offereeOperatorId,
          payeeOperatorId: contract.offerorOperatorId,
          priceCents: contract.priceCents,
          postedAt: occurredAt,
          reference: `contract:${contract.id}:accept`,
          description: `EVU-Vertrag ${contract.id}`,
        }, paymentAccounts);
        await this.startContractRental(tx, contract, input.atS);
      }
      const status = input.response === "reject" ? "rejected" : input.atS >= contract.validFromS ? "active" : "accepted";
      const [updated] = await tx.update(operatorContracts).set({
        status,
        respondedByAccountId: input.actingAccountId,
        respondedAtS: input.atS,
        revision: contract.revision + 1,
      }).where(and(eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, input.contractId))).returning();
      if (updated === undefined) throw new Error("Vertragsantwort konnte nicht gespeichert werden.");
      await appendEvent(tx, input.worldId, `cooperation.contract-${input.response === "accept" ? "accepted" : "rejected"}`, {
        contractId: contract.id,
        contractType: contract.contractType,
        offerorOperatorId: contract.offerorOperatorId,
        offereeOperatorId: contract.offereeOperatorId,
        termsHash: contract.termsHash,
        status,
        ...commandReceiptPayload(input.idempotencyKey, commandReceipt),
      }, occurredAt);
      await notifyOperators(tx, {
        worldId: input.worldId,
        operatorIds: [contract.offerorOperatorId, contract.offereeOperatorId],
        messageType: `cooperation.contract-${input.response === "accept" ? "accepted" : "rejected"}`,
        payload: { contractId: contract.id, status },
        sentAt: occurredAt,
        idempotencyKey: `contract-response:${contract.id}:${input.response}`,
      });
      return updated;
    });
  }

  private async assertContractNonPerformanceEvidence(
    tx: CooperationDatabase,
    input: {
      readonly worldId: string;
      readonly contract: OperatorContract;
      readonly actingOperatorId: string;
      readonly atS: number;
      readonly evidenceReference: string;
    },
  ): Promise<void> {
    const serviceDay = parseDailyOperationEvidenceReference(input.evidenceReference);
    if (serviceDay === undefined) {
      throw new CooperationValidationError(
        "Belegreferenz muss auf einen versionierten serverseitigen Tagesbericht zeigen.",
        "non_performance_evidence_reference_invalid",
      );
    }
    const accusedOperatorId = input.actingOperatorId === input.contract.offerorOperatorId
      ? input.contract.offereeOperatorId
      : input.contract.offerorOperatorId;
    const [report] = await tx.select().from(dailyOperationReports).where(and(
      eq(dailyOperationReports.worldId, input.worldId),
      eq(dailyOperationReports.operatorId, accusedOperatorId),
      eq(dailyOperationReports.serviceDay, serviceDay),
    )).limit(1);
    if (report === undefined) {
      throw new CooperationConflictError(
        "Serverautoritiver Betriebsbeleg für Gegenpartei und Betriebstag fehlt.",
        "non_performance_evidence_missing",
      );
    }

    const projection = typeof report.projection === "object" && report.projection !== null && !Array.isArray(report.projection)
      ? report.projection as Readonly<Record<string, unknown>>
      : undefined;
    const contracts = projection !== undefined
      && typeof projection["contracts"] === "object" && projection["contracts"] !== null && !Array.isArray(projection["contracts"])
      ? projection["contracts"] as Readonly<Record<string, unknown>>
      : undefined;
    const contractProjection = contracts !== undefined
      && typeof contracts[input.contract.id] === "object" && contracts[input.contract.id] !== null && !Array.isArray(contracts[input.contract.id])
      ? contracts[input.contract.id] as Readonly<Record<string, unknown>>
      : undefined;
    const projectedTrainRuns = contractProjection !== undefined
      && typeof contractProjection["trainRuns"] === "object" && contractProjection["trainRuns"] !== null && !Array.isArray(contractProjection["trainRuns"])
      ? contractProjection["trainRuns"] as Readonly<Record<string, unknown>>
      : undefined;
    const projectedSettlements = contractProjection !== undefined
      && typeof contractProjection["settlements"] === "object" && contractProjection["settlements"] !== null && !Array.isArray(contractProjection["settlements"])
      ? contractProjection["settlements"] as Readonly<Record<string, unknown>>
      : undefined;
    const facts = projection !== undefined
      && typeof projection["facts"] === "object" && projection["facts"] !== null && !Array.isArray(projection["facts"])
      ? projection["facts"] as Readonly<Record<string, unknown>>
      : undefined;
    const factSequences = Array.isArray(facts?.["eventSequences"])
      ? facts["eventSequences"].filter((value): value is number => Number.isSafeInteger(value) && (value as number) >= 0)
      : [];
    const projectedInteger = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
    const projectedPenalty = projectedSettlements?.["contractPenaltyCents"];
    const projectedBreach = projectedTrainRuns !== undefined
      && (
        projectedInteger(projectedTrainRuns["cancelled"]) > 0
        || projectedInteger(projectedTrainRuns["missingSeats"]) > 0
        || projectedInteger(projectedTrainRuns["missedConnections"]) > 0
        || (typeof projectedPenalty === "string" && /^[1-9][0-9]*$/.test(projectedPenalty))
      );
    if (projection?.["schema"] !== "daily-operations-report/v1"
      || projection["serviceDay"] !== report.serviceDay
      || projection["sourceFromSequence"] !== report.sourceFromSequence
      || projection["sourceThroughSequence"] !== report.sourceThroughSequence
      || report.sourceFromSequence > report.sourceThroughSequence
      || factSequences.length === 0
      || !projectedBreach) {
      throw new CooperationConflictError(
        "Serverautoritiver Betriebsbeleg ist unvollständig oder wurde nicht konsistent projiziert.",
        "non_performance_evidence_invalid",
      );
    }

    const validFrom = await worldSimDate(tx, input.worldId, input.contract.validFromS);
    const validThrough = await worldSimDate(tx, input.worldId, Math.min(input.atS, input.contract.validUntilS));
    const events = await tx.select().from(domainEvents).where(and(
      eq(domainEvents.worldId, input.worldId),
      gte(domainEvents.sequence, report.sourceFromSequence),
      lte(domainEvents.sequence, report.sourceThroughSequence),
    ));
    const provesBreach = events.some((event) => factSequences.includes(event.sequence)
      && event.occurredAt >= validFrom
      && event.occurredAt <= validThrough
      && event.occurredAt.toISOString().slice(0, 10) === report.serviceDay
      && provesContractNonPerformanceV1(event, { contractId: input.contract.id, accusedOperatorId }));
    if (!provesBreach) {
      throw new CooperationConflictError(
        "Tagesbericht enthält keinen unveränderlichen, exakt gebundenen Nichterfüllungsbeleg.",
        "non_performance_evidence_unproven",
      );
    }
  }

  async terminateContract(input: ContractActionInput & { readonly evidenceReference?: string }): Promise<OperatorContract> {
    if (input.reason === undefined || input.reason.trim().length < 8) {
      throw new CooperationValidationError("Kündigung oder Nichterfüllung braucht eine nachvollziehbare Begründung.");
    }
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select ${operatorContracts.id} from ${operatorContracts} where ${operatorContracts.worldId} = ${input.worldId} and ${operatorContracts.id} = ${input.contractId} for update`);
      const [contract] = await tx.select().from(operatorContracts).where(and(
        eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, input.contractId),
      )).limit(1);
      if (contract === undefined) throw new CooperationNotFoundError("Vertrag wurde in dieser Welt nicht gefunden.");
      const [actor] = await tx.select({ operatorId: operators.id }).from(operators).where(and(
        eq(operators.worldId, input.worldId),
        eq(operators.id, input.actingOperatorId),
        or(eq(operators.id, contract.offerorOperatorId), eq(operators.id, contract.offereeOperatorId)),
        eq(operators.foundingAccountId, input.actingAccountId),
      )).limit(1);
      if (actor === undefined) throw new CooperationAuthorizationError("Nur eine Vertragspartei darf kündigen oder Nichterfüllung melden.");
      const commandReceipt = input.idempotencyKey === undefined ? undefined : await claimCooperationCommand(
        tx,
        input.worldId,
        input.idempotencyKey,
        {
          kind: "contract-end",
          targetId: input.contractId,
          actingOperatorId: input.actingOperatorId,
          parameters: { evidenceReference: input.evidenceReference ?? null, reason: input.reason },
        },
      );
      if (commandReceipt?.replayed === true) return contract;
      if (!(ACTIVE_CONTRACT_STATUSES as readonly string[]).includes(contract.status)) {
        throw new CooperationConflictError("Vertrag ist nicht kündbar.");
      }
      if (input.evidenceReference !== undefined) {
        await this.assertContractNonPerformanceEvidence(tx, {
          worldId: input.worldId,
          contract,
          actingOperatorId: actor.operatorId,
          atS: input.atS,
          evidenceReference: input.evidenceReference,
        });
        await this.returnContractRental(tx, contract, input.atS);
        const [updated] = await tx.update(operatorContracts).set({
          status: "non-performance",
          terminationRequestedByOperatorId: actor.operatorId,
          terminationRequestedAtS: input.atS,
          terminatedAtS: input.atS,
          terminationEffectiveAtS: input.atS,
          terminationEvidenceReference: input.evidenceReference,
          terminationRuleVersion: CONTRACT_NON_PERFORMANCE_RULE.schemaVersion,
          endedAtS: input.atS,
          endReason: input.reason,
          revision: contract.revision + 1,
        }).where(and(eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, input.contractId))).returning();
        if (updated === undefined) throw new Error("Vertragsende konnte nicht gespeichert werden.");
        const accusedOperatorId = actor.operatorId === contract.offerorOperatorId
          ? contract.offereeOperatorId
          : contract.offerorOperatorId;
        await appendEvent(tx, input.worldId, "cooperation.contract-non-performance", {
          contractId: contract.id,
          actingOperatorId: actor.operatorId,
          accusedOperatorId,
          evidenceReference: input.evidenceReference,
          ruleVersion: CONTRACT_NON_PERFORMANCE_RULE.schemaVersion,
          reason: input.reason,
          ...commandReceiptPayload(input.idempotencyKey, commandReceipt),
        }, occurredAt);
        await notifyOperators(tx, {
          worldId: input.worldId,
          operatorIds: [contract.offerorOperatorId, contract.offereeOperatorId],
          messageType: "cooperation.contract-non-performance",
          payload: { contractId: contract.id, accusedOperatorId, evidenceReference: input.evidenceReference, reason: input.reason },
          sentAt: occurredAt,
          idempotencyKey: `contract-non-performance:${contract.id}:${contract.revision + 1}`,
        });
        return updated;
      }

      const terminationEffectiveAtS = input.atS + contract.terminationNoticeS;
      safeSimSecond(terminationEffectiveAtS, "Wirksamer Kündigungszeitpunkt");
      if (terminationEffectiveAtS > contract.validUntilS) {
        throw new CooperationConflictError("Kündigungsfrist reicht über das reguläre Vertragsende hinaus.", "notice_window_invalid");
      }
      const immediatelyEffective = terminationEffectiveAtS === input.atS;
      if (immediatelyEffective) await this.returnContractRental(tx, contract, input.atS);
      const status = immediatelyEffective ? "terminated" : "termination-pending";
      const [updated] = await tx.update(operatorContracts).set({
        status,
        terminationRequestedByOperatorId: actor.operatorId,
        terminationRequestedAtS: input.atS,
        terminatedAtS: immediatelyEffective ? input.atS : null,
        terminationEffectiveAtS,
        endedAtS: immediatelyEffective ? terminationEffectiveAtS : null,
        endReason: input.reason,
        revision: contract.revision + 1,
      }).where(and(eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, input.contractId))).returning();
      if (updated === undefined) throw new Error("Vertragsende konnte nicht gespeichert werden.");
      const eventType = immediatelyEffective ? "cooperation.contract-terminated" : "cooperation.contract-termination-scheduled";
      await appendEvent(tx, input.worldId, eventType, {
        contractId: contract.id,
        actingOperatorId: actor.operatorId,
        terminationEffectiveAtS,
        reason: input.reason,
        ...commandReceiptPayload(input.idempotencyKey, commandReceipt),
      }, occurredAt);
      await notifyOperators(tx, {
        worldId: input.worldId,
        operatorIds: [contract.offerorOperatorId, contract.offereeOperatorId],
        messageType: eventType,
        payload: { contractId: contract.id, terminationEffectiveAtS, reason: input.reason },
        sentAt: occurredAt,
        idempotencyKey: `contract-end:${contract.id}:${contract.revision + 1}`,
      });
      return updated;
    });
  }

  async advanceContracts(worldId: string, atS: number): Promise<readonly OperatorContract[]> {
    const occurredAt = await worldSimDate(this.db, worldId, atS);
    return this.db.transaction(async (tx) => {
      const candidates = await tx.select().from(operatorContracts).where(and(
        eq(operatorContracts.worldId, worldId),
        or(eq(operatorContracts.status, "offered"), eq(operatorContracts.status, "accepted"), eq(operatorContracts.status, "active"), eq(operatorContracts.status, "termination-pending")),
      )).orderBy(asc(operatorContracts.id));
      const changed: OperatorContract[] = [];
      for (const contract of candidates) {
        let status: OperatorContract["status"] | undefined;
        if (contract.status === "termination-pending") {
          if (contract.terminationEffectiveAtS === null) {
            throw new CooperationConflictError("Vorgemerkter Kündigung fehlt der serverseitige Wirksamkeitszeitpunkt.", "termination_schedule_invalid");
          }
          if (atS >= contract.terminationEffectiveAtS) status = "terminated";
        }
        else if (contract.status === "offered" && atS > contract.responseDeadlineS) status = "expired";
        else if (contract.status === "accepted" && atS >= contract.validFromS && atS < contract.validUntilS) status = "active";
        else if ((contract.status === "accepted" || contract.status === "active") && atS >= contract.validUntilS) status = "completed";
        if (status === undefined) continue;
        const effectiveAtS = status === "terminated" ? contract.terminationEffectiveAtS! : atS;
        if (status === "completed" || status === "terminated") await this.returnContractRental(tx, contract, effectiveAtS);
        const [updated] = await tx.update(operatorContracts).set({
          status,
          terminatedAtS: status === "terminated" ? contract.terminationEffectiveAtS : undefined,
          endedAtS: status === "terminated" ? contract.terminationEffectiveAtS : status === "completed" || status === "expired" ? atS : undefined,
          endReason: status === "completed" ? "regular-end" : status === "expired" ? "response-deadline" : undefined,
          revision: contract.revision + 1,
        }).where(and(
          eq(operatorContracts.worldId, worldId),
          eq(operatorContracts.id, contract.id),
          eq(operatorContracts.revision, contract.revision),
        )).returning();
        if (updated === undefined) throw new CooperationConflictError("Vertrag wurde parallel geändert.", "revision_conflict");
        changed.push(updated);
        const transitionOccurredAt = status === "terminated" ? await worldSimDate(tx, worldId, effectiveAtS) : occurredAt;
        await appendEvent(tx, worldId, `cooperation.contract-${status}`, { contractId: contract.id, status }, transitionOccurredAt);
        if (status === "terminated") {
          await notifyOperators(tx, {
            worldId,
            operatorIds: [contract.offerorOperatorId, contract.offereeOperatorId],
            messageType: "cooperation.contract-terminated",
            payload: { contractId: contract.id, terminationEffectiveAtS: contract.terminationEffectiveAtS },
            sentAt: transitionOccurredAt,
            idempotencyKey: `contract-termination-effective:${contract.id}:${contract.terminationEffectiveAtS}`,
          });
        }
      }
      return changed;
    });
  }

  listContracts(worldId: string, operatorId: string): Promise<readonly OperatorContract[]> {
    return this.db.select().from(operatorContracts).where(and(
      eq(operatorContracts.worldId, worldId),
      or(eq(operatorContracts.offerorOperatorId, operatorId), eq(operatorContracts.offereeOperatorId, operatorId)),
    )).orderBy(desc(operatorContracts.offeredAtS));
  }

  async pageContracts(worldId: string, operatorId: string, options: CooperationPageOptions = {}): Promise<CooperationPage<OperatorContract>> {
    const limit = pageLimit(options.limit);
    const cursor = pageCursor(options.cursor);
    const deadlineBeforeS = pageDeadline(options.deadlineBeforeS);
    const view = options.view ?? "actionable";
    const visibility = view === "all" ? undefined : view === "actionable"
      ? inArray(operatorContracts.status, ["offered", "accepted", "active", "termination-pending"])
      : inArray(operatorContracts.status, ["rejected", "terminated", "non-performance", "completed", "expired"]);
    const before = cursor === undefined ? undefined : or(
      lt(operatorContracts.offeredAtS, cursor.atS),
      and(eq(operatorContracts.offeredAtS, cursor.atS), lt(operatorContracts.id, cursor.id)),
    );
    const rows = await this.db.select().from(operatorContracts).where(and(
      eq(operatorContracts.worldId, worldId),
      or(eq(operatorContracts.offerorOperatorId, operatorId), eq(operatorContracts.offereeOperatorId, operatorId)),
      visibility,
      deadlineBeforeS === undefined ? undefined : or(
        lte(operatorContracts.responseDeadlineS, deadlineBeforeS),
        lte(operatorContracts.validUntilS, deadlineBeforeS),
      ),
      before,
    )).orderBy(desc(operatorContracts.offeredAtS), desc(operatorContracts.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore ? items.at(-1) : undefined;
    return { items, nextCursor: nextPageCursor(last === undefined ? undefined : { id: last.id, atS: last.offeredAtS }) };
  }

  listOwnedVehicles(worldId: string, operatorId: string): Promise<readonly VehicleAsset[]> {
    return this.db.select().from(vehicleAssets).where(and(
      eq(vehicleAssets.worldId, worldId),
      eq(vehicleAssets.ownerOperatorId, operatorId),
    )).orderBy(asc(vehicleAssets.classDesignation), asc(vehicleAssets.vehicleId));
  }

  async registerVehicle(input: RegisterVehicleInput): Promise<VehicleAsset> {
    nonEmpty(input.vehicleId, "Fahrzeug-ID");
    nonEmpty(input.authorityReleaseId, "Authority-Release");
    nonEmpty(input.classDesignation, "Baureihe");
    nonEmpty(input.valuationSpecId, "Bewertungsspezifikation");
    safeSimSecond(input.acquiredAtS, "Erwerbszeit");
    if (input.odometerMetres < 0n || input.valueCents < 0n) throw new CooperationValidationError("Laufleistung und Wert dürfen nicht negativ sein.");
    if (!Number.isSafeInteger(input.conditionBasisPoints) || input.conditionBasisPoints < 0 || input.conditionBasisPoints > 10_000) {
      throw new CooperationValidationError("Zustand muss in Basispunkten zwischen 0 und 10.000 liegen.");
    }
    const occurredAt = await worldSimDate(this.db, input.worldId, input.acquiredAtS);
    return this.db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: operators.id }).from(operators).where(and(
      eq(operators.worldId, input.worldId), eq(operators.id, input.ownerOperatorId),
    )).limit(1);
    if (owner === undefined) throw new CooperationNotFoundError("Fahrzeugeigentümer existiert nicht in dieser Welt.");
    const initial = {
      ...input,
      holderOperatorId: input.ownerOperatorId,
      lessorOperatorId: null,
      bindings: { formations: [], contracts: [], workshop: [], security: [] },
      revision: 1,
    };
    const historyHash = cooperationHash("vehicle-asset-history/v1", initial);
    let newlyCreated = true;
    let [created] = await tx.insert(vehicleAssets).values({ ...initial, historyHash }).onConflictDoNothing({
      target: [vehicleAssets.worldId, vehicleAssets.vehicleId],
    }).returning();
    if (created === undefined) {
      newlyCreated = false;
      [created] = await tx.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, input.vehicleId),
      )).limit(1);
      if (created === undefined) throw new Error("Fahrzeug konnte nicht registriert werden.");
      if (created.historyHash !== historyHash) throw new CooperationConflictError("Fahrzeugidentität gehört bereits zu anderen Quellfakten.", "vehicle_identity_conflict");
    }
    if (newlyCreated) {
      await this.appendVehicleHistory(tx, {
        worldId: input.worldId, vehicleId: input.vehicleId, eventType: "registered", atS: input.acquiredAtS,
        priorHistoryHash: null, resultingHistoryHash: historyHash, details: discloseVehicle(created),
        idempotencyKey: `vehicle-registered:${input.vehicleId}`,
      });
      await appendEvent(tx, input.worldId, "vehicle.asset-registered", {
        vehicleId: input.vehicleId, ownerOperatorId: input.ownerOperatorId,
        authorityReleaseId: input.authorityReleaseId, historyHash,
      }, occurredAt);
    }
    return created;
    });
  }

  async createListing(input: CreateListingInput & { readonly actingAccountId: string }): Promise<VehicleMarketListing> {
    nonEmpty(input.idempotencyKey, "Idempotenzschlüssel");
    safeSimSecond(input.listedAtS, "Angebotszeit");
    safeSimSecond(input.expiresAtS, "Angebotsende");
    if (input.expiresAtS <= input.listedAtS) throw new CooperationValidationError("Marktangebot braucht ein positives Zeitfenster.");
    if (input.priceCents <= 0n) throw new CooperationValidationError("Marktpreis muss positiv sein.");
    if (input.listingType === "rental") {
      if (input.rentalValidUntilS === undefined || input.rentalValidUntilS <= input.expiresAtS) {
        throw new CooperationValidationError("Vermietung braucht ein Vertragsende nach dem Angebotsende.");
      }
    } else if (input.rentalValidUntilS !== undefined) {
      throw new CooperationValidationError("Verkauf darf kein Mietende tragen.");
    }
    const occurredAt = await worldSimDate(this.db, input.worldId, input.listedAtS);
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.offeringOperatorId, input.actingAccountId);
      await tx.execute(sql`select ${vehicleAssets.vehicleId} from ${vehicleAssets} where ${vehicleAssets.worldId} = ${input.worldId} and ${vehicleAssets.vehicleId} = ${input.vehicleId} for update`);
      const [vehicle] = await tx.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, input.vehicleId),
      )).limit(1);
      if (vehicle === undefined) throw new CooperationNotFoundError("Fahrzeug wurde in dieser Welt nicht gefunden.");
      if (vehicle.ownerOperatorId !== input.offeringOperatorId) throw new CooperationAuthorizationError("Nur der aktuelle Eigentümer darf das Fahrzeug anbieten.");
      const decision = await this.authority.verifyVehicleListing({ worldId: input.worldId, vehicle, listingType: input.listingType, atS: input.listedAtS });
      if (!decision.permitted) throw new CooperationConflictError(decision.explanation, decision.code);
      const disclosure = discloseVehicle(vehicle);
      const disclosureHash = cooperationHash("vehicle-market-disclosure/v1", disclosure);
      let [listing] = await tx.insert(vehicleMarketListings).values({
        ...input,
        disclosure,
        disclosureHash,
        status: "open",
      }).onConflictDoNothing({
        target: [vehicleMarketListings.worldId, vehicleMarketListings.offeringOperatorId, vehicleMarketListings.idempotencyKey],
      }).returning();
      if (listing === undefined) {
        [listing] = await tx.select().from(vehicleMarketListings).where(and(
          eq(vehicleMarketListings.worldId, input.worldId),
          eq(vehicleMarketListings.offeringOperatorId, input.offeringOperatorId),
          eq(vehicleMarketListings.idempotencyKey, input.idempotencyKey),
        )).limit(1);
        if (listing === undefined) throw new Error("Idempotentes Marktangebot konnte nicht gelesen werden.");
        if (
          listing.disclosureHash !== disclosureHash
          || listing.priceCents !== input.priceCents
          || listing.listingType !== input.listingType
          || listing.expiresAtS !== input.expiresAtS
          || listing.rentalValidUntilS !== (input.rentalValidUntilS ?? null)
        ) {
          throw new CooperationConflictError("Idempotenzschlüssel gehört zu einem anderen Marktangebot.", "idempotency_conflict");
        }
        return listing;
      }
      await appendEvent(tx, input.worldId, "vehicle-market.listed", {
        listingId: listing.id,
        vehicleId: listing.vehicleId,
        listingType: listing.listingType,
        offeringOperatorId: listing.offeringOperatorId,
        priceCents: listing.priceCents.toString(),
        disclosureHash,
      }, occurredAt);
      return listing;
    });
  }

  async reserveListing(input: {
    readonly worldId: string;
    readonly listingId: string;
    readonly buyerOperatorId: string;
    readonly actingAccountId: string;
    readonly atS: number;
    readonly expectedRevision: number;
    readonly idempotencyKey?: string;
  }): Promise<VehicleMarketListing> {
    safeSimSecond(input.atS, "Reservierungszeit");
    const maximumReservedUntilS = input.atS + VEHICLE_MARKET_RESERVATION_SECONDS;
    safeSimSecond(maximumReservedUntilS, "Reservierungsende");
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.buyerOperatorId, input.actingAccountId);
      await tx.execute(sql`select ${vehicleMarketListings.id} from ${vehicleMarketListings} where ${vehicleMarketListings.worldId} = ${input.worldId} and ${vehicleMarketListings.id} = ${input.listingId} for update`);
      const [listing] = await tx.select().from(vehicleMarketListings).where(and(
        eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, input.listingId),
      )).limit(1);
      if (listing === undefined) throw new CooperationNotFoundError("Marktangebot wurde nicht gefunden.");
      const commandReceipt = input.idempotencyKey === undefined ? undefined : await claimCooperationCommand(
        tx,
        input.worldId,
        input.idempotencyKey,
        {
          kind: "listing-reserve",
          targetId: input.listingId,
          actingOperatorId: input.buyerOperatorId,
          parameters: { expectedRevision: input.expectedRevision },
        },
      );
      if (commandReceipt?.replayed === true) return listing;
      if (listing.revision !== input.expectedRevision) throw new CooperationConflictError("Marktangebot wurde zwischenzeitlich geändert.", "revision_conflict");
      if (listing.status !== "open" || input.atS >= listing.expiresAtS) throw new CooperationConflictError("Marktangebot ist nicht mehr reservierbar.");
      if (input.buyerOperatorId === listing.offeringOperatorId) throw new CooperationValidationError("Eigenes Angebot kann nicht reserviert werden.");
      // Eine Reservierung blockiert das Angebot fuer andere Spieler und ist
      // deshalb bereits eine wirtschaftliche Kaufhandlung. Gesperrte oder
      // insolvente EVU duerfen diesen knappen Marktstatus nicht belegen.
      await assertEconomyPurchaseAllowed(tx, input.worldId, input.buyerOperatorId);
      const reservedUntilS = Math.min(maximumReservedUntilS, listing.expiresAtS);
      const [updated] = await tx.update(vehicleMarketListings).set({
        status: "reserved",
        reservedByOperatorId: input.buyerOperatorId,
        reservedUntilS,
        revision: listing.revision + 1,
      }).where(and(
        eq(vehicleMarketListings.worldId, input.worldId),
        eq(vehicleMarketListings.id, input.listingId),
        eq(vehicleMarketListings.revision, input.expectedRevision),
      )).returning();
      if (updated === undefined) throw new CooperationConflictError("Reservierung hat ein Parallelrennen verloren.", "reservation_race");
      await appendEvent(tx, input.worldId, "vehicle-market.reserved", {
        listingId: listing.id,
        vehicleId: listing.vehicleId,
        buyerOperatorId: input.buyerOperatorId,
        reservedUntilS,
        ...commandReceiptPayload(input.idempotencyKey, commandReceipt),
      }, occurredAt);
      return updated;
    });
  }

  async transferListing(input: {
    readonly worldId: string;
    readonly listingId: string;
    readonly buyerOperatorId: string;
    readonly actingAccountId: string;
    readonly atS: number;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
  }): Promise<VehicleTransferResult> {
    nonEmpty(input.idempotencyKey, "Idempotenzschlüssel");
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.buyerOperatorId, input.actingAccountId);
      const [existingTransfer] = await tx.select().from(vehicleMarketTransfers).where(and(
        eq(vehicleMarketTransfers.worldId, input.worldId), eq(vehicleMarketTransfers.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existingTransfer !== undefined) {
        if (
          existingTransfer.listingId !== input.listingId
          || existingTransfer.toHolderOperatorId !== input.buyerOperatorId
          || (existingTransfer.transferType !== "sale" && existingTransfer.transferType !== "rental-start")
        ) {
          throw new CooperationConflictError("Idempotenzschlüssel gehört zu einer anderen Fahrzeugübertragung.", "idempotency_conflict");
        }
        const [listing] = await tx.select().from(vehicleMarketListings).where(and(
          eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, existingTransfer.listingId),
        )).limit(1);
        const [vehicle] = await tx.select().from(vehicleAssets).where(and(
          eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, existingTransfer.vehicleId),
        )).limit(1);
        if (listing === undefined || vehicle === undefined) throw new Error("Idempotente Übertragung ist unvollständig.");
        return { listing, vehicle, transferId: existingTransfer.id };
      }
      await tx.execute(sql`select ${vehicleMarketListings.id} from ${vehicleMarketListings} where ${vehicleMarketListings.worldId} = ${input.worldId} and ${vehicleMarketListings.id} = ${input.listingId} for update`);
      const [listing] = await tx.select().from(vehicleMarketListings).where(and(
        eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, input.listingId),
      )).limit(1);
      if (listing === undefined) throw new CooperationNotFoundError("Marktangebot wurde nicht gefunden.");
      if (listing.revision !== input.expectedRevision) throw new CooperationConflictError("Marktangebot wurde zwischenzeitlich geändert.", "revision_conflict");
      if (listing.status !== "reserved" || listing.reservedByOperatorId !== input.buyerOperatorId || listing.reservedUntilS === null || input.atS >= listing.reservedUntilS) {
        throw new CooperationConflictError("Gültige eigene Reservierung fehlt.", "reservation_required");
      }
      await tx.execute(sql`select ${vehicleAssets.vehicleId} from ${vehicleAssets} where ${vehicleAssets.worldId} = ${input.worldId} and ${vehicleAssets.vehicleId} = ${listing.vehicleId} for update`);
      const [vehicle] = await tx.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, listing.vehicleId),
      )).limit(1);
      if (vehicle === undefined) throw new CooperationNotFoundError("Fahrzeug wurde nicht gefunden.");
      const currentDisclosureHash = cooperationHash("vehicle-market-disclosure/v1", discloseVehicle(vehicle));
      if (currentDisclosureHash !== listing.disclosureHash) {
        throw new CooperationConflictError("Entscheidungsrelevante Fahrzeugdaten haben sich seit Veröffentlichung geändert.", "disclosure_changed");
      }
      // Die gesperrte Economy-Zeile ist der gemeinsame Serialisierungspunkt
      // fuer Kaufsperre, Cash-Pruefung, Ledger und Flottenuebergabe. Eine
      // parallele Eskalation linearisiert davor oder danach, nie dazwischen.
      await assertEconomyPurchaseAllowed(tx, input.worldId, input.buyerOperatorId);
      const decision = await this.authority.verifyVehicleTransfer({
        worldId: input.worldId,
        vehicle,
        listing,
        buyerOperatorId: input.buyerOperatorId,
        atS: input.atS,
      });
      if (!decision.permitted) throw new CooperationConflictError(decision.explanation, decision.code);
      const paymentAccounts = await resolveInteroperatorCashAccounts(tx, {
        worldId: input.worldId,
        payerOperatorId: input.buyerOperatorId,
        payeeOperatorId: listing.offeringOperatorId,
      });
      await assertSufficientCashBalance(tx, {
        worldId: input.worldId,
        operatorId: input.buyerOperatorId,
        cashAccountId: paymentAccounts.payerCashAccountId,
        requiredCents: listing.priceCents,
      });

      let contract: OperatorContract | undefined;
      if (listing.listingType === "rental") {
        const validUntilS = listing.rentalValidUntilS;
        if (validUntilS === null || validUntilS <= input.atS) throw new CooperationConflictError("Mietzeitraum ist abgelaufen.");
        const subject = { vehicleIds: [vehicle.vehicleId] };
        const terms = { source: "secondary-market", listingId: listing.id, returnRequired: true };
        const termsHash = cooperationHash("operator-contract/v1", {
          contractType: "vehicle-rental",
          subject,
          terms,
          priceCents: listing.priceCents,
          validFromS: input.atS,
          validUntilS,
          responseDeadlineS: input.atS,
          terminationNoticeS: 0,
        });
        [contract] = await tx.insert(operatorContracts).values({
          worldId: input.worldId,
          offerorOperatorId: listing.offeringOperatorId,
          offereeOperatorId: input.buyerOperatorId,
          contractType: "vehicle-rental",
          subject,
          terms,
          termsHash,
          priceCents: listing.priceCents,
          validFromS: input.atS,
          validUntilS,
          responseDeadlineS: input.atS,
          terminationNoticeS: 0,
          status: "active",
          offeredByAccountId: (await tx.select({ accountId: operators.foundingAccountId }).from(operators).where(and(eq(operators.worldId, input.worldId), eq(operators.id, listing.offeringOperatorId))).limit(1))[0]!.accountId,
          respondedByAccountId: input.actingAccountId,
          offeredAtS: input.atS,
          respondedAtS: input.atS,
          idempotencyKey: `market-rental:${listing.id}`,
        }).returning();
        if (contract === undefined) throw new Error("Mietvertrag konnte nicht angelegt werden.");
      }

      const newOwner = listing.listingType === "sale" ? input.buyerOperatorId : vehicle.ownerOperatorId;
      const newHolder = input.buyerOperatorId;
      const newLessor = listing.listingType === "rental" ? listing.offeringOperatorId : null;
      const afterCore = {
        vehicleId: vehicle.vehicleId,
        previousHistoryHash: vehicle.historyHash,
        ownerOperatorId: newOwner,
        holderOperatorId: newHolder,
        lessorOperatorId: newLessor,
        acquiredAtS: input.atS,
        revision: vehicle.revision + 1,
        listingId: listing.id,
        contractId: contract?.id ?? null,
      };
      const historyHash = cooperationHash("vehicle-asset-history/v1", afterCore);
      const transferReceiptHash = cooperationHash("vehicle-market-transfer-intent/v1", {
        worldId: input.worldId,
        listingId: listing.id,
        vehicleId: vehicle.vehicleId,
        transferType: listing.listingType === "sale" ? "sale" : "rental-start",
        fromOwnerOperatorId: vehicle.ownerOperatorId,
        toOwnerOperatorId: newOwner,
        fromHolderOperatorId: vehicle.holderOperatorId,
        toHolderOperatorId: newHolder,
        contractId: contract?.id ?? null,
        priceCents: listing.priceCents,
        atS: input.atS,
        idempotencyKey: input.idempotencyKey,
      });
      await this.applyFleetTransfer(tx, {
        worldId: input.worldId,
        commandId: `vehicle-market:${input.idempotencyKey}`,
        atS: input.atS,
        vehicleId: vehicle.vehicleId,
        transferType: listing.listingType === "sale" ? "sale" : "rental-start",
        fromOwnerOperatorId: vehicle.ownerOperatorId,
        toOwnerOperatorId: newOwner,
        fromHolderOperatorId: vehicle.holderOperatorId,
        toHolderOperatorId: newHolder,
        lessorOperatorId: newLessor,
        contractId: contract?.id ?? null,
        validUntilS: listing.listingType === "rental" ? listing.rentalValidUntilS : null,
        transferReceiptHash,
      });
      const [updatedVehicle] = await tx.update(vehicleAssets).set({
        ownerOperatorId: newOwner,
        holderOperatorId: newHolder,
        lessorOperatorId: newLessor,
        acquiredAtS: input.atS,
        revision: vehicle.revision + 1,
        historyHash,
      }).where(and(
        eq(vehicleAssets.worldId, input.worldId),
        eq(vehicleAssets.vehicleId, vehicle.vehicleId),
        eq(vehicleAssets.revision, vehicle.revision),
      )).returning();
      if (updatedVehicle === undefined) throw new CooperationConflictError("Fahrzeug wurde parallel geändert.", "vehicle_revision_conflict");
      const [updatedListing] = await tx.update(vehicleMarketListings).set({
        status: "transferred",
        contractId: contract?.id,
        revision: listing.revision + 1,
      }).where(and(
        eq(vehicleMarketListings.worldId, input.worldId),
        eq(vehicleMarketListings.id, listing.id),
        eq(vehicleMarketListings.revision, listing.revision),
      )).returning();
      if (updatedListing === undefined) throw new CooperationConflictError("Marktangebot wurde parallel geändert.", "listing_revision_conflict");
      const [transfer] = await tx.insert(vehicleMarketTransfers).values({
        worldId: input.worldId,
        listingId: listing.id,
        vehicleId: vehicle.vehicleId,
        transferType: listing.listingType === "sale" ? "sale" : "rental-start",
        fromOwnerOperatorId: vehicle.ownerOperatorId,
        toOwnerOperatorId: newOwner,
        fromHolderOperatorId: vehicle.holderOperatorId,
        toHolderOperatorId: newHolder,
        contractId: contract?.id,
        priceCents: listing.priceCents,
        transferredAtS: input.atS,
        assetBeforeHash: vehicle.historyHash,
        assetAfterHash: historyHash,
        idempotencyKey: input.idempotencyKey,
      }).returning();
      if (transfer === undefined) throw new Error("Fahrzeugübertragung konnte nicht protokolliert werden.");
      await this.appendVehicleHistory(tx, {
        worldId: input.worldId, vehicleId: vehicle.vehicleId,
        eventType: listing.listingType === "sale" ? "sale" : "rental-start", atS: input.atS,
        priorHistoryHash: vehicle.historyHash, resultingHistoryHash: historyHash,
        listingId: listing.id, contractId: contract?.id,
        details: {
          transferId: transfer.id, fromOwnerOperatorId: vehicle.ownerOperatorId, toOwnerOperatorId: newOwner,
          fromHolderOperatorId: vehicle.holderOperatorId, toHolderOperatorId: newHolder,
          priceCents: listing.priceCents.toString(), disclosureHash: listing.disclosureHash,
        },
        idempotencyKey: `market-history:${input.idempotencyKey}`,
      });
      await postInteroperatorPayment(tx, {
        worldId: input.worldId,
        payerOperatorId: input.buyerOperatorId,
        payeeOperatorId: listing.offeringOperatorId,
        priceCents: listing.priceCents,
        postedAt: occurredAt,
        reference: `vehicle-transfer:${transfer.id}`,
        description: `${listing.listingType === "sale" ? "Fahrzeugkauf" : "Fahrzeugmiete"} ${vehicle.vehicleId}`,
      }, paymentAccounts);
      await appendEvent(tx, input.worldId, "vehicle-market.transferred", {
        transferId: transfer.id,
        listingId: listing.id,
        vehicleId: vehicle.vehicleId,
        transferType: transfer.transferType,
        fromOperatorId: listing.offeringOperatorId,
        toOperatorId: input.buyerOperatorId,
        contractId: contract?.id ?? null,
        priceCents: listing.priceCents.toString(),
        assetAfterHash: historyHash,
      }, occurredAt);
      await notifyOperators(tx, {
        worldId: input.worldId,
        operatorIds: [listing.offeringOperatorId, input.buyerOperatorId],
        messageType: "vehicle-market.transferred",
        payload: {
          transferId: transfer.id,
          listingId: listing.id,
          vehicleId: vehicle.vehicleId,
          contractId: contract?.id ?? null,
        },
        sentAt: occurredAt,
        idempotencyKey: `vehicle-transfer:${transfer.id}`,
      });
      return { listing: updatedListing, vehicle: updatedVehicle, contract, transferId: transfer.id };
    });
  }

  async cancelListing(input: {
    readonly worldId: string;
    readonly listingId: string;
    readonly offeringOperatorId: string;
    readonly actingAccountId: string;
    readonly atS: number;
    readonly expectedRevision: number;
    readonly idempotencyKey?: string;
  }): Promise<VehicleMarketListing> {
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.offeringOperatorId, input.actingAccountId);
      await tx.execute(sql`select ${vehicleMarketListings.id} from ${vehicleMarketListings} where ${vehicleMarketListings.worldId} = ${input.worldId} and ${vehicleMarketListings.id} = ${input.listingId} for update`);
      const [listing] = await tx.select().from(vehicleMarketListings).where(and(
        eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, input.listingId),
      )).limit(1);
      if (listing === undefined) throw new CooperationNotFoundError("Marktangebot wurde nicht gefunden.");
      if (listing.offeringOperatorId !== input.offeringOperatorId) throw new CooperationAuthorizationError("Nur der Anbieter darf das Angebot zurückziehen.");
      const commandReceipt = input.idempotencyKey === undefined ? undefined : await claimCooperationCommand(
        tx,
        input.worldId,
        input.idempotencyKey,
        {
          kind: "listing-cancel",
          targetId: input.listingId,
          actingOperatorId: input.offeringOperatorId,
          parameters: { expectedRevision: input.expectedRevision },
        },
      );
      if (commandReceipt?.replayed === true) return listing;
      if (listing.revision !== input.expectedRevision) throw new CooperationConflictError("Marktangebot wurde zwischenzeitlich geändert.", "revision_conflict");
      if (listing.status === "reserved") throw new CooperationConflictError("Reserviertes Angebot kann nicht einseitig zurückgezogen werden.", "active_reservation");
      if (listing.status !== "open") throw new CooperationConflictError("Marktangebot ist nicht mehr offen.");
      const [updated] = await tx.update(vehicleMarketListings).set({
        status: "cancelled",
        revision: listing.revision + 1,
      }).where(and(
        eq(vehicleMarketListings.worldId, input.worldId),
        eq(vehicleMarketListings.id, input.listingId),
        eq(vehicleMarketListings.revision, input.expectedRevision),
      )).returning();
      if (updated === undefined) throw new CooperationConflictError("Marktangebot wurde parallel geändert.", "listing_revision_conflict");
      await appendEvent(tx, input.worldId, "vehicle-market.cancelled", {
        listingId: listing.id,
        vehicleId: listing.vehicleId,
        offeringOperatorId: listing.offeringOperatorId,
        ...commandReceiptPayload(input.idempotencyKey, commandReceipt),
      }, occurredAt);
      return updated;
    });
  }

  async reverseTransfer(input: {
    readonly worldId: string;
    readonly listingId: string;
    readonly buyerOperatorId: string;
    readonly actingAccountId: string;
    readonly atS: number;
    readonly reasonCode: string;
    readonly idempotencyKey: string;
  }): Promise<VehicleTransferResult> {
    nonEmpty(input.reasonCode, "Rückabwicklungsgrund");
    nonEmpty(input.idempotencyKey, "Idempotenzschlüssel");
    const occurredAt = await worldSimDate(this.db, input.worldId, input.atS);
    return this.db.transaction(async (tx) => {
      await assertOperatorAccount(tx, input.worldId, input.buyerOperatorId, input.actingAccountId);
      const [existing] = await tx.select().from(vehicleMarketTransfers).where(and(
        eq(vehicleMarketTransfers.worldId, input.worldId), eq(vehicleMarketTransfers.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existing !== undefined) {
        if (
          existing.listingId !== input.listingId
          || existing.transferType !== "reversal"
          || existing.fromHolderOperatorId !== input.buyerOperatorId
        ) {
          throw new CooperationConflictError("Idempotenzschlüssel gehört zu einer anderen Rückabwicklung.", "idempotency_conflict");
        }
        const [listing] = await tx.select().from(vehicleMarketListings).where(and(eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, existing.listingId))).limit(1);
        const [vehicle] = await tx.select().from(vehicleAssets).where(and(eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, existing.vehicleId))).limit(1);
        if (listing === undefined || vehicle === undefined) throw new Error("Idempotente Rückabwicklung ist unvollständig.");
        return { listing, vehicle, transferId: existing.id };
      }
      await tx.execute(sql`select ${vehicleMarketListings.id} from ${vehicleMarketListings} where ${vehicleMarketListings.worldId} = ${input.worldId} and ${vehicleMarketListings.id} = ${input.listingId} for update`);
      const [listing] = await tx.select().from(vehicleMarketListings).where(and(
        eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, input.listingId),
      )).limit(1);
      if (listing === undefined) throw new CooperationNotFoundError("Marktangebot wurde nicht gefunden.");
      if (listing.status !== "transferred" || listing.reservedByOperatorId !== input.buyerOperatorId) {
        throw new CooperationAuthorizationError("Nur der Übernehmer darf diese Übertragung rückabwickeln.");
      }
      const [original] = await tx.select().from(vehicleMarketTransfers).where(and(
        eq(vehicleMarketTransfers.worldId, input.worldId),
        eq(vehicleMarketTransfers.listingId, listing.id),
        or(eq(vehicleMarketTransfers.transferType, "sale"), eq(vehicleMarketTransfers.transferType, "rental-start")),
      )).orderBy(desc(vehicleMarketTransfers.transferredAtS)).limit(1);
      if (original === undefined) throw new CooperationConflictError("Autoritativer Übertragungsbeleg fehlt.", "transfer_receipt_missing");
      if (input.atS > original.transferredAtS + 604_800) throw new CooperationConflictError("Rückabwicklungsfenster von sieben Tagen ist abgelaufen.", "reversal_window_elapsed");
      await tx.execute(sql`select ${vehicleAssets.vehicleId} from ${vehicleAssets} where ${vehicleAssets.worldId} = ${input.worldId} and ${vehicleAssets.vehicleId} = ${listing.vehicleId} for update`);
      const [vehicle] = await tx.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, listing.vehicleId),
      )).limit(1);
      if (vehicle === undefined) throw new CooperationNotFoundError("Fahrzeug wurde nicht gefunden.");
      if (vehicle.historyHash !== original.assetAfterHash) throw new CooperationConflictError("Fahrzeughistorie wurde nach der Übertragung verändert.", "vehicle_history_changed");
      const decision = await this.authority.verifyVehicleReversal({
        worldId: input.worldId,
        vehicle,
        listing,
        originalTransferId: original.id,
        originalTransferredAtS: original.transferredAtS,
        assetBeforeHash: original.assetBeforeHash,
        reasonCode: input.reasonCode,
        atS: input.atS,
      });
      if (!decision.permitted) throw new CooperationConflictError(decision.explanation, decision.code);
      // Eine Rückabwicklung ist eine neue Zahlungsverpflichtung des Verkäufers.
      // Sie teilt daher exakt dieselbe gesperrte Economy-/Cash-Grenze wie ein
      // Kauf; ohne Deckung bleibt der gesamte Transfer unverändert.
      await assertEconomyPurchaseAllowed(tx, input.worldId, listing.offeringOperatorId);
      const reversalPaymentAccounts = await resolveInteroperatorCashAccounts(tx, {
        worldId: input.worldId,
        payerOperatorId: listing.offeringOperatorId,
        payeeOperatorId: input.buyerOperatorId,
      });
      await assertSufficientCashBalance(tx, {
        worldId: input.worldId,
        operatorId: listing.offeringOperatorId,
        cashAccountId: reversalPaymentAccounts.payerCashAccountId,
        requiredCents: original.priceCents,
      });
      const restoredOwner = original.fromOwnerOperatorId;
      const restoredHolder = original.fromHolderOperatorId;
      const historyHash = cooperationHash("vehicle-asset-history/v1", {
        vehicleId: vehicle.vehicleId,
        previousHistoryHash: vehicle.historyHash,
        reversalOfTransferId: original.id,
        ownerOperatorId: restoredOwner,
        holderOperatorId: restoredHolder,
        atS: input.atS,
        reasonCode: input.reasonCode,
      });
      await this.applyFleetTransfer(tx, {
        worldId: input.worldId,
        commandId: `vehicle-market-reversal:${input.idempotencyKey}`,
        atS: input.atS,
        vehicleId: vehicle.vehicleId,
        transferType: "reversal",
        fromOwnerOperatorId: vehicle.ownerOperatorId,
        toOwnerOperatorId: restoredOwner,
        fromHolderOperatorId: vehicle.holderOperatorId,
        toHolderOperatorId: restoredHolder,
        lessorOperatorId: null,
        contractId: null,
        validUntilS: null,
        transferReceiptHash: cooperationHash("vehicle-market-reversal-intent/v1", {
          worldId: input.worldId,
          listingId: listing.id,
          originalTransferId: original.id,
          vehicleId: vehicle.vehicleId,
          reasonCode: input.reasonCode,
          atS: input.atS,
          idempotencyKey: input.idempotencyKey,
        }),
      });
      const [updatedVehicle] = await tx.update(vehicleAssets).set({
        ownerOperatorId: restoredOwner,
        holderOperatorId: restoredHolder,
        lessorOperatorId: null,
        acquiredAtS: input.atS,
        revision: vehicle.revision + 1,
        historyHash,
      }).where(and(eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, vehicle.vehicleId), eq(vehicleAssets.revision, vehicle.revision))).returning();
      if (updatedVehicle === undefined) throw new CooperationConflictError("Fahrzeug wurde parallel geändert.", "vehicle_revision_conflict");
      const [updatedListing] = await tx.update(vehicleMarketListings).set({
        status: "reversed",
        revision: listing.revision + 1,
      }).where(and(eq(vehicleMarketListings.worldId, input.worldId), eq(vehicleMarketListings.id, listing.id), eq(vehicleMarketListings.revision, listing.revision))).returning();
      if (updatedListing === undefined) throw new CooperationConflictError("Marktangebot wurde parallel geändert.", "listing_revision_conflict");
      if (listing.contractId !== null) {
        await tx.update(operatorContracts).set({
          status: "terminated",
          terminatedAtS: input.atS,
          endedAtS: input.atS,
          endReason: `market-reversal:${input.reasonCode}`,
          revision: sql`${operatorContracts.revision} + 1`,
        }).where(and(eq(operatorContracts.worldId, input.worldId), eq(operatorContracts.id, listing.contractId)));
      }
      const [reversal] = await tx.insert(vehicleMarketTransfers).values({
        worldId: input.worldId,
        listingId: listing.id,
        vehicleId: vehicle.vehicleId,
        transferType: "reversal",
        fromOwnerOperatorId: original.toOwnerOperatorId,
        toOwnerOperatorId: original.fromOwnerOperatorId,
        fromHolderOperatorId: original.toHolderOperatorId,
        toHolderOperatorId: original.fromHolderOperatorId,
        contractId: original.contractId,
        priceCents: original.priceCents,
        transferredAtS: input.atS,
        assetBeforeHash: vehicle.historyHash,
        assetAfterHash: historyHash,
        reversalOfTransferId: original.id,
        idempotencyKey: input.idempotencyKey,
      }).returning();
      if (reversal === undefined) throw new Error("Rückabwicklungsbeleg konnte nicht gespeichert werden.");
      await this.appendVehicleHistory(tx, {
        worldId: input.worldId, vehicleId: vehicle.vehicleId, eventType: "reversal", atS: input.atS,
        priorHistoryHash: vehicle.historyHash, resultingHistoryHash: historyHash,
        listingId: listing.id, contractId: original.contractId ?? undefined,
        details: { transferId: reversal.id, reversalOfTransferId: original.id, reasonCode: input.reasonCode },
        idempotencyKey: `market-history:${input.idempotencyKey}`,
      });
      await postInteroperatorPayment(tx, {
        worldId: input.worldId,
        payerOperatorId: listing.offeringOperatorId,
        payeeOperatorId: input.buyerOperatorId,
        priceCents: original.priceCents,
        postedAt: occurredAt,
        reference: `vehicle-reversal:${reversal.id}`,
        description: `Rückabwicklung Fahrzeug ${vehicle.vehicleId}`,
      }, reversalPaymentAccounts);
      await appendEvent(tx, input.worldId, "vehicle-market.reversed", {
        transferId: reversal.id,
        reversalOfTransferId: original.id,
        listingId: listing.id,
        vehicleId: vehicle.vehicleId,
        reasonCode: input.reasonCode,
        assetAfterHash: historyHash,
      }, occurredAt);
      await notifyOperators(tx, {
        worldId: input.worldId,
        operatorIds: [listing.offeringOperatorId, input.buyerOperatorId],
        messageType: "vehicle-market.reversed",
        payload: {
          transferId: reversal.id,
          listingId: listing.id,
          vehicleId: vehicle.vehicleId,
          reasonCode: input.reasonCode,
        },
        sentAt: occurredAt,
        idempotencyKey: `vehicle-reversal:${reversal.id}`,
      });
      return { listing: updatedListing, vehicle: updatedVehicle, transferId: reversal.id };
    });
  }

  listListings(worldId: string): Promise<readonly VehicleMarketListing[]> {
    return this.db.select().from(vehicleMarketListings).where(eq(vehicleMarketListings.worldId, worldId)).orderBy(desc(vehicleMarketListings.listedAtS));
  }

  async pageListings(worldId: string, options: CooperationPageOptions = {}): Promise<CooperationPage<VehicleMarketListing>> {
    const limit = pageLimit(options.limit);
    const cursor = pageCursor(options.cursor);
    const deadlineBeforeS = pageDeadline(options.deadlineBeforeS);
    const view = options.view ?? "actionable";
    const visibility = view === "all" ? undefined : view === "actionable"
      ? inArray(vehicleMarketListings.status, ["open", "reserved"])
      : inArray(vehicleMarketListings.status, ["transferred", "cancelled", "expired", "reversed"]);
    const before = cursor === undefined ? undefined : or(
      lt(vehicleMarketListings.listedAtS, cursor.atS),
      and(eq(vehicleMarketListings.listedAtS, cursor.atS), lt(vehicleMarketListings.id, cursor.id)),
    );
    const rows = await this.db.select().from(vehicleMarketListings).where(and(
      eq(vehicleMarketListings.worldId, worldId), visibility,
      deadlineBeforeS === undefined ? undefined : lte(vehicleMarketListings.expiresAtS, deadlineBeforeS),
      before,
    )).orderBy(desc(vehicleMarketListings.listedAtS), desc(vehicleMarketListings.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore ? items.at(-1) : undefined;
    return { items, nextCursor: nextPageCursor(last === undefined ? undefined : { id: last.id, atS: last.listedAtS }) };
  }

  listVehicleHistory(worldId: string, vehicleId: string) {
    return this.db.select().from(vehicleAssetHistoryEvents).where(and(
      eq(vehicleAssetHistoryEvents.worldId, worldId), eq(vehicleAssetHistoryEvents.vehicleId, vehicleId),
    )).orderBy(asc(vehicleAssetHistoryEvents.atS), asc(vehicleAssetHistoryEvents.id));
  }
}
