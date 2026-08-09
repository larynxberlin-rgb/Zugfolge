import type { AuthorityBudget, MobilizationProof, PerformanceEvidence, PublicOperation, ServiceContract } from "./contracts.js";
import { commitAuthorityBudget, performOperatingTransition, settleContract, startPublicOperation } from "./contracts.js";
import type { ClassifiedPosting, InsolvencyDecision, InsolvencySignals, Prequalification, ProfitAndLoss } from "./finance.js";
import { assertPrequalified, calculateProfitAndLoss, evaluateInsolvency, updatePrequalification } from "./finance.js";
import type { EconomyRelease, WorldEconomyPin } from "./release.js";
import { assertPinnedRelease, pinEconomyRelease } from "./release.js";
import type { Bid, Tender } from "./tender.js";
import { awardTender, createTender, scoreBid } from "./tender.js";
import type { Lot, TenderCalendarEntry, WorldProfile } from "./world.js";
import { createTenderCalendar, deriveWorldProfile, deterministicProfileOrder } from "./world.js";

export interface EconomyNotice {
  readonly worldId: string;
  readonly recipientAccountId: string;
  readonly type: string;
  readonly at: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EconomyJournalEntry {
  readonly worldId: string;
  readonly operatorId: string;
  readonly idempotencyKey: string;
  readonly at: number;
  readonly description: string;
  readonly postings: readonly ClassifiedPosting[];
  readonly revenueCents: bigint;
}

export interface EconomyEffects {
  readonly notices: readonly EconomyNotice[];
  readonly journal: readonly EconomyJournalEntry[];
}

export type TenderLifecycle =
  | { readonly phase: "announced"; readonly tender: Tender; readonly bids: readonly Bid[] }
  | { readonly phase: "open"; readonly tender: Tender; readonly bids: readonly Bid[] }
  | { readonly phase: "awarded"; readonly tender: Tender; readonly bids: readonly Bid[]; readonly winningBid: Bid }
  | { readonly phase: "failed"; readonly tender: Tender; readonly bids: readonly Bid[]; readonly publicOperation: PublicOperation };

export interface Mobilization {
  readonly tenderId: string;
  readonly winnerOperatorId: string;
  readonly deadline: number;
  readonly proof?: MobilizationProof;
  readonly completed: boolean;
}

export interface EconomyWorldState {
  readonly worldId: string;
  readonly seed: bigint;
  readonly profile: WorldProfile;
  readonly releasePin: WorldEconomyPin;
  readonly release: EconomyRelease;
  readonly lots: readonly Lot[];
  readonly calendar: readonly TenderCalendarEntry[];
  readonly tenders: ReadonlyMap<string, TenderLifecycle>;
  readonly contracts: ReadonlyMap<string, ServiceContract>;
  readonly mobilizations: ReadonlyMap<string, Mobilization>;
  readonly publicOperations: ReadonlyMap<string, PublicOperation>;
  readonly budgets: ReadonlyMap<string, AuthorityBudget>;
  readonly prequalifications: ReadonlyMap<string, Prequalification>;
  readonly insolventOperators: ReadonlySet<string>;
  readonly processedCommands: ReadonlySet<string>;
  readonly revision: number;
}

function mutableMap<K, V>(map: ReadonlyMap<K, V>): Map<K, V> { return new Map(map); }
function withCommand(state: EconomyWorldState, commandId: string, changes: Partial<EconomyWorldState>): EconomyWorldState {
  const processedCommands = new Set(state.processedCommands);
  processedCommands.add(commandId);
  return Object.freeze({ ...state, ...changes, processedCommands, revision: state.revision + 1 });
}
function requireNewCommand(state: EconomyWorldState, commandId: string): boolean { return !state.processedCommands.has(commandId); }
function lifecycle(state: EconomyWorldState, tenderId: string): TenderLifecycle {
  const found = state.tenders.get(tenderId);
  if (found === undefined) throw new Error(`Ausschreibung '${tenderId}' existiert in Welt '${state.worldId}' nicht.`);
  return found;
}

export function startEconomyWorld(input: {
  readonly worldId: string;
  readonly seed: bigint;
  readonly durationMonths: WorldProfile["durationMonths"];
  readonly release: EconomyRelease;
  readonly lots: readonly Lot[];
  readonly authorityBudgets: readonly AuthorityBudget[];
  readonly accounts: readonly string[];
}): { readonly state: EconomyWorldState; readonly effects: EconomyEffects } {
  if (input.worldId.trim() === "" || new Set(input.lots.map((lot) => lot.id)).size !== input.lots.length) throw new Error("Welt und Lose müssen eindeutig sein.");
  const profile = deriveWorldProfile(input.durationMonths);
  const calendar = createTenderCalendar(profile, input.lots, input.seed);
  const budgets = new Map<string, AuthorityBudget>(input.authorityBudgets.map((budget) => [`${budget.authorityId}:${budget.period}`, budget]));
  const prequalifications = new Map<string, Prequalification>(input.accounts.map((accountId) => [accountId, { worldId: input.worldId, accountId, score: 5_000, creditScore: 5_000, bankruptcies: 0 }]));
  const publicOperations = new Map<string, PublicOperation>(input.lots.map((lot) => [lot.id, startPublicOperation(lot.id, [])]));
  const notices = input.accounts.map((recipientAccountId) => ({ worldId: input.worldId, recipientAccountId, type: "tender-calendar-published", at: 0, payload: { calendar } }));
  return {
    state: Object.freeze({ worldId: input.worldId, seed: input.seed, profile, releasePin: pinEconomyRelease(input.worldId, input.release), release: input.release, lots: Object.freeze([...input.lots]), calendar, tenders: new Map<string, TenderLifecycle>(), contracts: new Map<string, ServiceContract>(), mobilizations: new Map<string, Mobilization>(), publicOperations, budgets, prequalifications, insolventOperators: new Set<string>(), processedCommands: new Set<string>(), revision: 0 }),
    effects: { notices, journal: [] },
  };
}

export function announceTender(state: EconomyWorldState, input: {
  readonly commandId: string;
  readonly release: EconomyRelease;
  readonly tender: Omit<Tender, "profile" | "viabilityThresholdCentsPerTrainKm" | "status"> & { readonly smallLot: boolean };
  readonly recipients: readonly string[];
}): { readonly state: EconomyWorldState; readonly effects: EconomyEffects } {
  if (!requireNewCommand(state, input.commandId)) return { state, effects: { notices: [], journal: [] } };
  assertPinnedRelease(state.releasePin, input.release);
  if (input.tender.worldId !== state.worldId || state.tenders.has(input.tender.id)) throw new Error("Ausschreibung verletzt Weltisolation oder Eindeutigkeit.");
  const calendar = state.calendar.find((entry) => entry.lotId === input.tender.lotId);
  if (calendar === undefined) throw new Error("Los steht nicht im veröffentlichten Vergabekalender.");
  const profiles = deterministicProfileOrder(input.release.tenderProfiles, state.seed);
  const lotIndex = state.calendar.findIndex((entry) => entry.lotId === input.tender.lotId);
  const profile = profiles[lotIndex % profiles.length]!;
  const tender = createTender({ ...input.tender, profile, release: input.release });
  const tenders = mutableMap(state.tenders);
  tenders.set(tender.id, { phase: "announced", tender, bids: [] });
  const notices = input.recipients.map((recipientAccountId) => ({ worldId: state.worldId, recipientAccountId, type: "tender-announced", at: tender.announcedAt, payload: { tenderId: tender.id, lotId: tender.lotId, profile, viabilityThresholdCentsPerTrainKm: tender.viabilityThresholdCentsPerTrainKm.toString() } }));
  return { state: withCommand(state, input.commandId, { tenders }), effects: { notices, journal: [] } };
}

export function openTender(state: EconomyWorldState, commandId: string, tenderId: string, at: number): EconomyWorldState {
  if (!requireNewCommand(state, commandId)) return state;
  const current = lifecycle(state, tenderId);
  if (current.phase !== "announced" || at !== current.tender.opensAt) throw new Error("Ausschreibung öffnet ausschließlich zum veröffentlichten Zeitpunkt.");
  const tenders = mutableMap(state.tenders);
  tenders.set(tenderId, { ...current, phase: "open" });
  return withCommand(state, commandId, { tenders });
}

export function submitBid(state: EconomyWorldState, commandId: string, tenderId: string, bid: Bid, qualification: { readonly accountId: string; readonly period: number; readonly smallLot: boolean; readonly minimumScore: number }): EconomyWorldState {
  if (!requireNewCommand(state, commandId)) return state;
  const current = lifecycle(state, tenderId);
  if (current.phase !== "open" || bid.submittedAt < current.tender.opensAt || bid.submittedAt > current.tender.closesAt) throw new Error("Angebot liegt außerhalb des offenen Fensters.");
  if (state.insolventOperators.has(bid.operatorId) || current.bids.some((item) => item.operatorId === bid.operatorId)) throw new Error("EVU darf für diese Ausschreibung kein weiteres Angebot abgeben.");
  const prequalification = state.prequalifications.get(qualification.accountId);
  if (prequalification === undefined) throw new Error("Spieler besitzt keine Präqualifikation in dieser Welt.");
  assertPrequalified(prequalification, state.worldId, qualification.period, qualification.smallLot, qualification.minimumScore);
  scoreBid(current.tender, bid);
  const tenders = mutableMap(state.tenders);
  tenders.set(tenderId, { ...current, bids: Object.freeze([...current.bids, bid]) });
  return withCommand(state, commandId, { tenders });
}

export function closeTender(state: EconomyWorldState, input: { readonly commandId: string; readonly tenderId: string; readonly at: number; readonly authorityId: string; readonly budgetPeriod: number; readonly vehiclePool: readonly string[]; readonly recipientByOperator: Readonly<Record<string, string>> }): { readonly state: EconomyWorldState; readonly effects: EconomyEffects } {
  if (!requireNewCommand(state, input.commandId)) return { state, effects: { notices: [], journal: [] } };
  const current = lifecycle(state, input.tenderId);
  if (current.phase !== "open" || input.at !== current.tender.closesAt) throw new Error("Zuschlag erfolgt exakt am Fristende.");
  const award = awardTender(current.tender, current.bids, input.at);
  const tenders = mutableMap(state.tenders);
  const publicOperations = mutableMap(state.publicOperations);
  const mobilizations = mutableMap(state.mobilizations);
  const notices: EconomyNotice[] = [];
  if (award.winner === undefined) {
    const operation = startPublicOperation(current.tender.lotId, input.vehiclePool);
    const budgetKey = `${input.authorityId}:${input.budgetPeriod}`;
    const budget = state.budgets.get(budgetKey);
    if (budget === undefined) throw new Error("Aufgabenträger-Budget fehlt.");
    const budgets = mutableMap(state.budgets);
    const base = current.tender.viabilityThresholdCentsPerTrainKm * current.tender.specification.trainKmPerPeriod * 2n;
    const publicCost = base + base * BigInt(state.release.rules.publicOperationSurchargeBasisPoints) / 10_000n;
    budgets.set(budgetKey, commitAuthorityBudget(budget, publicCost));
    publicOperations.set(current.tender.lotId, operation);
    tenders.set(input.tenderId, { ...current, phase: "failed", publicOperation: operation });
    return { state: withCommand(state, input.commandId, { tenders, publicOperations, mobilizations, budgets }), effects: { notices, journal: [] } };
  } else {
    const expectedCost = award.winner.orderingFeeCentsPerTrainKm * current.tender.specification.trainKmPerPeriod * BigInt(current.tender.contractPeriods);
    const budgetKey = `${input.authorityId}:${input.budgetPeriod}`;
    const budget = state.budgets.get(budgetKey);
    if (budget === undefined) throw new Error("Aufgabenträger-Budget fehlt.");
    const budgets = mutableMap(state.budgets);
    budgets.set(budgetKey, commitAuthorityBudget(budget, expectedCost));
    tenders.set(input.tenderId, { ...current, phase: "awarded", winningBid: award.winner });
    mobilizations.set(input.tenderId, { tenderId: input.tenderId, winnerOperatorId: award.winner.operatorId, deadline: current.tender.operatingFrom, completed: false });
    const account = input.recipientByOperator[award.winner.operatorId];
    if (account !== undefined) notices.push({ worldId: state.worldId, recipientAccountId: account, type: "tender-awarded", at: input.at, payload: { tenderId: input.tenderId, mobilizationDeadline: current.tender.operatingFrom } });
    return { state: withCommand(state, input.commandId, { tenders, publicOperations, mobilizations, budgets }), effects: { notices, journal: [] } };
  }
}

export function completeMobilization(state: EconomyWorldState, input: { readonly commandId: string; readonly tenderId: string; readonly at: number; readonly proof: MobilizationProof; readonly failurePenaltyCents: bigint; readonly recipientAccountId: string }): { readonly state: EconomyWorldState; readonly effects: EconomyEffects } {
  if (!requireNewCommand(state, input.commandId)) return { state, effects: { notices: [], journal: [] } };
  const current = lifecycle(state, input.tenderId);
  const mobilization = state.mobilizations.get(input.tenderId);
  if (current.phase !== "awarded" || mobilization === undefined || mobilization.completed || input.at !== current.tender.operatingFrom) throw new Error("Mobilisierung kann nur einmal am Fahrplanstichtag abgeschlossen werden.");
  const transition = performOperatingTransition({ incumbentOperatorId: current.tender.incumbentOperatorId, winnerOperatorId: current.winningBid.operatorId, proof: input.proof, at: input.at, timetableBoundary: current.tender.operatingFrom, failurePenaltyCents: input.failurePenaltyCents });
  const mobilizations = mutableMap(state.mobilizations);
  mobilizations.set(input.tenderId, { ...mobilization, proof: input.proof, completed: true });
  const contracts = mutableMap(state.contracts);
  const publicOperations = mutableMap(state.publicOperations);
  const prequalifications = mutableMap(state.prequalifications);
  const notices: EconomyNotice[] = [];
  const journal: EconomyJournalEntry[] = [];
  if (transition.operatorId === "public") {
    publicOperations.set(current.tender.lotId, startPublicOperation(current.tender.lotId, []));
    const accountRecord = [...prequalifications.values()].find((record) => record.accountId === input.recipientAccountId);
    if (accountRecord !== undefined) prequalifications.set(accountRecord.accountId, updatePrequalification(accountRecord, { mobilizationFailed: true }));
    notices.push({ worldId: state.worldId, recipientAccountId: input.recipientAccountId, type: "mobilization-failed", at: input.at, payload: { tenderId: input.tenderId, penaltyCents: transition.penaltyCents.toString() } });
    journal.push({ worldId: state.worldId, operatorId: current.winningBid.operatorId, idempotencyKey: `${input.commandId}:penalty`, at: input.at, description: "Vertragsstrafe wegen gescheiterter Mobilisierung", revenueCents: 0n, postings: [{ amountCents: transition.penaltyCents, costType: "penalty", costCentreId: current.tender.lotId, reference: input.tenderId }] });
  } else {
    publicOperations.delete(current.tender.lotId);
    const basePenalties = { ...current.tender.rules.penaltyRates };
    basePenalties[current.tender.profile.penaltyFocus] = basePenalties[current.tender.profile.penaltyFocus] * BigInt(current.tender.rules.penaltyFocusMultiplierBasisPoints) / 10_000n;
    contracts.set(input.tenderId, { id: input.tenderId, worldId: state.worldId, lotId: current.tender.lotId, operatorId: transition.operatorId, startsAt: input.at, endsAt: input.at + current.tender.contractPeriods * current.tender.periodDurationSeconds, orderingFeeCentsPerTrainKm: current.winningBid.orderingFeeCentsPerTrainKm, bonusCentsPerPeriod: current.tender.rules.contractBonusCentsPerPeriod, penaltyRates: basePenalties, evidenceRequired: ["vehicles", "personnel", "paths"] });
  }
  return { state: withCommand(state, input.commandId, { mobilizations, contracts, publicOperations, prequalifications }), effects: { notices, journal } };
}

export function settleContractPeriod(state: EconomyWorldState, input: { readonly commandId: string; readonly contractId: string; readonly period: number; readonly at: number; readonly performance: PerformanceEvidence; readonly costs: readonly ClassifiedPosting[] }): { readonly state: EconomyWorldState; readonly effects: EconomyEffects; readonly result: ProfitAndLoss } {
  if (!requireNewCommand(state, input.commandId)) throw new Error("Abrechnungsbefehl wurde bereits verarbeitet.");
  const contract = state.contracts.get(input.contractId);
  if (contract === undefined || contract.worldId !== state.worldId || input.at < contract.startsAt || input.at > contract.endsAt) throw new Error("Vertrag ist in dieser Welt und Periode nicht abrechenbar.");
  const settlement = settleContract(contract, input.performance);
  const result = calculateProfitAndLoss(settlement.netCents, input.costs);
  const journal: EconomyJournalEntry = { worldId: state.worldId, operatorId: contract.operatorId, idempotencyKey: `${input.commandId}:settlement`, at: input.at, description: `Vertragsabrechnung Periode ${input.period}`, postings: input.costs, revenueCents: settlement.netCents };
  return { state: withCommand(state, input.commandId, {}), effects: { notices: [], journal: [journal] }, result };
}

export function escalateOperator(state: EconomyWorldState, input: { readonly commandId: string; readonly operatorId: string; readonly accountId: string; readonly period: number; readonly at: number; readonly signals: InsolvencySignals }): { readonly state: EconomyWorldState; readonly effects: EconomyEffects; readonly decision: InsolvencyDecision } {
  if (!requireNewCommand(state, input.commandId)) throw new Error("Eskalation wurde bereits verarbeitet.");
  const decision = evaluateInsolvency(input.signals);
  const notices = decision.messages.map((message) => ({ worldId: state.worldId, recipientAccountId: input.accountId, type: message.messageType, at: input.at, payload: { stage: message.stage, actions: message.actions, channel: message.channel } }));
  const insolventOperators = new Set(state.insolventOperators);
  const prequalifications = mutableMap(state.prequalifications);
  const contracts = mutableMap(state.contracts);
  const publicOperations = mutableMap(state.publicOperations);
  if (decision.stage === 5) {
    insolventOperators.add(input.operatorId);
    const record = prequalifications.get(input.accountId);
    if (record !== undefined) prequalifications.set(input.accountId, updatePrequalification(record, { insolvencyAtPeriod: input.period }));
    for (const [id, contract] of contracts) if (contract.operatorId === input.operatorId) { contracts.delete(id); publicOperations.set(contract.lotId, startPublicOperation(contract.lotId, [])); }
  }
  return { state: withCommand(state, input.commandId, { insolventOperators, prequalifications, contracts, publicOperations }), effects: { notices, journal: [] }, decision };
}

/** Führt Effekte erst nach erfolgreichem Zustands-Commit aus; Adapter müssen Idempotenzschlüssel beachten. */
export async function dispatchEconomyEffects(effects: EconomyEffects, adapters: { readonly sendNotice: (notice: EconomyNotice) => Promise<void>; readonly postJournal: (entry: EconomyJournalEntry) => Promise<void> }): Promise<void> {
  for (const entry of effects.journal) await adapters.postJournal(entry);
  for (const notice of effects.notices) await adapters.sendNotice(notice);
}

/** Reguläres Weltende: Verträge und Welt-Präqualifikation enden ohne Insolvenzfolge. */
export function closeEconomyWorld(state: EconomyWorldState, commandId: string): EconomyWorldState {
  if (!requireNewCommand(state, commandId)) return state;
  return withCommand(state, commandId, { contracts: new Map(), mobilizations: new Map(), prequalifications: new Map(), publicOperations: new Map() });
}
