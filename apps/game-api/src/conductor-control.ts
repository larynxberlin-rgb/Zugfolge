import { createHash } from "node:crypto";
import { conductorControlStates } from "@zugfolge/db";
import { ensureLedgerAccount, loadConfirmedFareContractRevenues, loadEconomyWorldState, lockEconomyCashWriter,
  postLedgerTransaction } from "@zugfolge/economy";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { ConductorSessionControlReceiptV1, ConductorSessionEffectV1, ConductorTrainStateV1 } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { ConductorAccessError, type ConductorCommittedContext } from "./conductor-context.js";
import type { ConductorControlDeployment } from "./conductor-control-configuration.js";
import { controlJson, controlRecord, controlText, type ConductorPoliceAdapter, type ControlCase, type ControlLedgerEvent,
  type ControlOperationalHoldReceipt, type ControlRecord, type FareControlRuntime, type FareControlState, type FareDayReportV1 } from "./conductor-control-runtime.js";
import type { ConductorControlIntegration } from "./conductor-session-service.js";

export interface ConductorControlService extends ConductorControlIntegration {
  /** Autoritativer Weltcommit; läuft auch ohne verbundene Schaffnersitzung. */
  advanceWorld(tx: IdentityDatabase, worldId: string, nowMs: number): Promise<void>;
  publicHistory(tx: IdentityDatabase, scope: { readonly worldId: string; readonly operatorId: string; readonly trainRunId: string }): Promise<ConductorControlStatusV1>;
  publicStatus(tx: IdentityDatabase, context: ConductorCommittedContext): Promise<ConductorControlStatusV1>;
}
export interface ConductorControlStatusV1 {
  readonly schemaVersion: "conductor-control-status/v1";
  readonly cases: readonly ControlRecord[];
  readonly days: readonly FareDayReportV1[];
  readonly hold: { readonly holdId: string; readonly targetStopId: string; readonly status: "requested" | "active" | "released";
    readonly deadlineMs: number | null; readonly outcome: ControlOperationalHoldReceipt["hold"]["outcome"] } | null;
}
function reject(): never { throw new ConductorAccessError(503, "conductor_control_unavailable", "Die bestätigten Kontrollbelege sind momentan nicht verfügbar."); }
function requireFact(value: unknown): asserts value { if (!value) reject(); }
const id = (...parts: unknown[]): string => createHash("sha256").update(controlJson(parts)).digest("hex");
const accountNames: Readonly<Record<string, string>> = Object.freeze({ receivable: "Kontrolle:Forderungen", claim_accrual: "Kontrolle:Forderungsanlage",
  cash: "Economy:Kasse", claim_reduction: "Kontrolle:Reduzierung", handling_cost: "Kontrolle:Bearbeitung",
  write_off: "Kontrolle:Abschreibung", premium: "Kontrolle:Prämie", cap_adjustment: "Kontrolle:Tagesdeckel" });

/** Ausschließlich innerhalb des vorhandenen Weltwriters verwenden. Keine Fachregel wird in TypeScript nachgerechnet. */
export function createConductorControlIntegration(deps: {
  readonly runtime: FareControlRuntime; readonly releases: ConductorControlDeployment; readonly police: ConductorPoliceAdapter;
}): ConductorControlService {
  async function load(tx: IdentityDatabase, worldId: string, operatorId: string): Promise<FareControlState | undefined> {
    const [row] = await tx.select().from(conductorControlStates).where(and(eq(conductorControlStates.worldId, worldId), eq(conductorControlStates.operatorId, operatorId)));
    if (row === undefined) return undefined;
    const state = deps.runtime.restore(row.state as FareControlState, row.stateHash);
    requireFact(state.worldId === worldId && state.operatorId === operatorId && state.revision === row.revision && state.nowMs === row.atMs); return state;
  }
  async function save(tx: IdentityDatabase, state: FareControlState): Promise<void> {
    await tx.insert(conductorControlStates).values({ worldId: state.worldId, operatorId: state.operatorId, state, stateHash: state.stateHash,
      revision: state.revision, atMs: state.nowMs }).onConflictDoUpdate({ target: [conductorControlStates.worldId, conductorControlStates.operatorId],
      set: { state, stateHash: state.stateHash, revision: state.revision, atMs: state.nowMs } });
  }
  async function journal(tx: IdentityDatabase, event: ControlLedgerEvent): Promise<void> {
    const entries = [];
    for (const posting of event.postings) {
      const name = accountNames[posting.role]; requireFact(name !== undefined && /^-?(?:0|[1-9][0-9]*)$/u.test(posting.amountCents));
      const account = await ensureLedgerAccount(tx, { worldId: event.worldId, operatorId: event.operatorId, name });
      entries.push({ ledgerAccountId: account.id, amountCents: BigInt(posting.amountCents) });
    }
    await postLedgerTransaction(tx, { worldId: event.worldId, operatorId: event.operatorId, idempotencyKey: `fare-control:${event.eventId}`,
      postedAt: new Date(event.atMs), description: `Fahrkartenkontrolle: ${event.kind}`, entries });
  }
  async function command(tx: IdentityDatabase, state: FareControlState, commandId: string, nowMs: number, action: ControlRecord): Promise<FareControlState> {
    const result = deps.runtime.apply(state, { worldId: state.worldId, operatorId: state.operatorId, commandId, expectedRevision: state.revision, nowMs, action });
    for (const event of result.ledgerEvents) { requireFact(event.worldId === state.worldId && event.operatorId === state.operatorId); await journal(tx, event); }
    return result.state;
  }
  function ownCase(state: FareControlState, train: ConductorTrainStateV1, encounterId: string): ControlCase | undefined {
    return Object.values(state.cases).find((row) => row.pin.trainRunId === train.trainRunId && row.pin.encounterId === encounterId);
  }
  function operationalEvidence(receipt: ControlOperationalHoldReceipt): ControlRecord {
    const hold = receipt.hold;
    return { worldId: hold.worldId, trainRunId: hold.trainRunId, holdId: hold.holdId, targetStopId: hold.targetStopId,
      modelHash: hold.modelHash, operationalStateHash: receipt.operationalStateHash, activatedAtMs: hold.activatedAtMs,
      deadlineMs: hold.deadlineMs, releasedAtMs: hold.releasedAtMs, targetUnavailable: hold.outcome === "target_unavailable",
      outcome: hold.outcome === "timeout" ? "timed_out" : hold.outcome ?? "pending" };
  }
  async function policeProgress(tx: IdentityDatabase, state: FareControlState, nowMs: number): Promise<FareControlState> {
    for (const plan of Object.values(state.policePlans).filter((row) => row.resolution === "pending")) {
      let receipt = await deps.police.read(tx, { worldId: state.worldId, operatorId: state.operatorId, trainRunId: plan.trainRunId });
      requireFact(receipt !== undefined && receipt.hold.holdId === plan.holdId && receipt.hold.worldId === state.worldId && receipt.nowMs <= nowMs);
      const outcome = deps.runtime.policeDue(plan, operationalEvidence(receipt), receipt.nowMs);
      if (outcome !== null) receipt = await deps.police.resolve(tx, { worldId: state.worldId, operatorId: state.operatorId, trainRunId: plan.trainRunId,
        holdId: plan.holdId, expectedRevision: receipt.hold.revision, modelHash: receipt.hold.modelHash, outcome, causalityId: `fare-police:${id(plan.holdId, outcome)}` });
      if (receipt.hold.releasedAtMs !== null) {
        requireFact(receipt.nowMs <= nowMs);
        state = await command(tx, state, `police-result:${id(plan.holdId, receipt.hold.revision)}`, nowMs,
          { type: "resolve_police", evidence: operationalEvidence(receipt) });
      }
    }
    return state;
  }
  async function initializeCases(tx: IdentityDatabase, context: ConductorCommittedContext, train: ConductorTrainStateV1,
    current: FareControlState): Promise<FareControlState> {
    let state = current;
    for (const [encounterId, encounter] of Object.entries(train.encounters)) {
      if (ownCase(state, train, encounterId) !== undefined) continue;
      const dialogue = controlRecord(encounter["dialogue"]);
      if (dialogue["status"] !== "active") continue;
      const periodId = controlText(dialogue["periodId"]), release = deps.releases.resolve(state.worldId, periodId, context.nowMs);
      requireFact(release !== undefined && periodId === context.projectionInput.binding.periodId);
      const economy = await loadEconomyWorldState(tx, state.worldId);
      requireFact(economy !== undefined && economy.worldId === state.worldId && economy.releasePin.worldId === state.worldId
        && economy.releasePin.releaseChecksum === release.economyReleaseHash && economy.release.checksum === release.economyReleaseHash);
      const manifests = context.projectionInput.evaluation["manifests"]; requireFact(Array.isArray(manifests) && train.passengers !== null);
      const manifest = manifests.map(controlRecord).find((row) => row["trainRunId"] === train.trainRunId && row["segmentId"] === train.passengers!.segmentId);
      requireFact(manifest !== undefined && Array.isArray(manifest["passengers"]));
      const passengerKey = controlText(encounter["passengerKey"]);
      const passenger = manifest["passengers"].map(controlRecord).find((row) => row["passengerKey"] === passengerKey);
      requireFact(passenger !== undefined && dialogue["worldId"] === state.worldId && dialogue["trainRunId"] === train.trainRunId
        && dialogue["passengerKey"] === passengerKey && dialogue["fareFact"] === passenger["fareFact"]);
      const journey = release.journeys.find((row) => row["trainRunId"] === train.trainRunId
        && row["boardingStopId"] === passenger["boardingStopId"] && row["alightingStopId"] === passenger["alightingStopId"]);
      const binding = context.projectionInput.binding, caseId = id(state.worldId, state.operatorId, train.trainRunId, passengerKey);
      state = await command(tx, state, `case-open:${caseId}`, context.nowMs, { type: "open_case", caseId, pin: {
        worldId: state.worldId, operatorId: state.operatorId, periodId, trainRunId: train.trainRunId, encounterId,
        manifestRevision: binding.manifestRevision, demandStateHash: binding.demandStateHash, segmentId: train.passengers.segmentId,
        passenger, dialogueReleaseHash: dialogue["releaseHash"], inspectedAtMs: context.nowMs, seedHash: binding.seedHash,
        inspectionPolicy: release.inspectionPolicy, journeyEvidence: journey ?? null,
        economyRelease: JSON.parse(controlJson(economy.release)), expectedEconomyReleaseHash: release.economyReleaseHash } });
    }
    return state;
  }
  async function executeEffect(tx: IdentityDatabase, context: ConductorCommittedContext, train: ConductorTrainStateV1,
    current: FareControlState, effect: ConductorSessionEffectV1): Promise<FareControlState> {
    requireFact(effect.worldId === current.worldId && effect.trainRunId === train.trainRunId && effect.atMs <= context.nowMs);
    const row = ownCase(current, train, effect.encounterId); requireFact(row !== undefined && controlRecord(row.pin["passenger"])["passengerKey"] === effect.passengerKey);
    let action: ControlRecord;
    if (effect.kind === "request_police") {
      const oldReceipt = current.receipts[effect.effectId]; if (oldReceipt !== undefined) return current;
      const release = deps.releases.resolve(current.worldId, controlText(row.pin["periodId"]), row.pin.inspectedAtMs); requireFact(release !== undefined);
      const reason = row.evidence.identityStatus === "refused" ? "identity_refusal" : row.evidence.concreteDanger ? "concrete_danger" : undefined;
      requireFact(reason !== undefined);
      const receipt = await deps.police.request(tx, context, { caseId: row.caseId, reason, causalityId: effect.effectId });
      requireFact(receipt.hold.worldId === current.worldId && receipt.hold.trainRunId === train.trainRunId
        && receipt.hold.caseIds.includes(row.caseId) && receipt.hold.modelHash === release.policeResponseModel["contentHash"] && receipt.nowMs === context.nowMs);
      action = { type: "plan_police", holdId: receipt.hold.holdId, trainRunId: train.trainRunId, targetStopId: receipt.hold.targetStopId,
        caseIds: [row.caseId], model: release.policeResponseModel };
    } else if (effect.kind === "request_document_check") action = { type: "inspect_document", caseId: row.caseId };
    else if (effect.kind === "close_without_action") action = { type: "close_case", caseId: row.caseId };
    else action = { type: "create_claim", caseId: row.caseId, kind: effect.kind === "request_regular_claim" ? "regular" : "provisional" };
    return command(tx, current, effect.effectId, effect.atMs, action);
  }
  async function guarded<T>(run: () => Promise<T>): Promise<T> { try { return await run(); } catch { return reject(); } }
  async function publicHistory(tx: IdentityDatabase, binding: { readonly worldId: string; readonly operatorId: string; readonly trainRunId: string }): Promise<ConductorControlStatusV1> {
      return guarded(async () => {
        const state = await load(tx, binding.worldId, binding.operatorId);
        if (state === undefined) return { schemaVersion: "conductor-control-status/v1", cases: [], days: [], hold: null };
        const report = deps.runtime.report(state), days = report.days;
        const cases = report.cases.filter((row) => row["trainRunId"] === binding.trainRunId);
        if (!Object.values(state.policePlans).some((plan) => plan.trainRunId === binding.trainRunId)) {
          return { schemaVersion: "conductor-control-status/v1", cases, days, hold: null };
        }
        const receipt = await deps.police.read(tx, { worldId: binding.worldId, operatorId: binding.operatorId, trainRunId: binding.trainRunId });
        if (receipt === undefined) return { schemaVersion: "conductor-control-status/v1", cases, days, hold: null };
        const value = receipt.hold; requireFact(value.worldId === binding.worldId && value.trainRunId === binding.trainRunId);
        return { schemaVersion: "conductor-control-status/v1", cases, days, hold: { holdId: value.holdId, targetStopId: value.targetStopId,
          status: value.releasedAtMs !== null ? "released" : value.activatedAtMs !== null ? "active" : "requested",
          deadlineMs: value.deadlineMs, outcome: value.outcome } };
      });
  }
  return Object.freeze({
    publicHistory,
    publicStatus(tx: IdentityDatabase, context: ConductorCommittedContext): Promise<ConductorControlStatusV1> {
      return publicHistory(tx, context.projectionInput.binding);
    },
    async apply(tx: IdentityDatabase, context: ConductorCommittedContext, train: ConductorTrainStateV1, effects: readonly ConductorSessionEffectV1[]) {
      return guarded(async () => {
        const operatorId = train.session?.operatorId; requireFact(operatorId !== undefined && context.projectionInput.binding.worldId === train.worldId
          && context.projectionInput.binding.operatorId === operatorId && context.projectionInput.binding.trainRunId === train.trainRunId);
        await lockEconomyCashWriter(tx, { worldId: train.worldId, operatorId });
        let state = await load(tx, train.worldId, operatorId) ?? deps.runtime.initialize(train.worldId, operatorId, context.nowMs);
        state = await initializeCases(tx, context, train, state);
        for (const effect of effects) state = await executeEffect(tx, context, train, state, effect);
        state = await policeProgress(tx, state, context.nowMs); await save(tx, state);
      });
    },
    async evidence(tx: IdentityDatabase, context: ConductorCommittedContext, train: ConductorTrainStateV1) {
      return guarded(async () => {
        const operatorId = train.session?.operatorId ?? context.projectionInput.binding.operatorId;
        requireFact(train.worldId === context.projectionInput.binding.worldId && operatorId === context.projectionInput.binding.operatorId);
        const state = await load(tx, train.worldId, operatorId);
        if (state === undefined) return { encounterEvidence: [], controlReceipts: [] };
        const cases = Object.values(state.cases).filter((row) => row.pin.trainRunId === train.trainRunId && train.encounters[row.pin.encounterId] !== undefined);
        const controlReceipts: ConductorSessionControlReceiptV1[] = [];
        for (const [effectId, receipt] of Object.entries(state.receipts)) {
          if (receipt["binding"] === null) continue; const binding = controlRecord(receipt["binding"]);
          const caseIds = binding["kind"] === "claim" ? [binding["caseId"]] : binding["caseIds"];
          requireFact(Array.isArray(caseIds));
          for (const row of cases.filter((candidate) => caseIds.includes(candidate.caseId))) {
            const kind = binding["kind"]; requireFact(kind === "claim" || kind === "hold");
            controlReceipts.push({ worldId: train.worldId, trainRunId: train.trainRunId, encounterId: row.pin.encounterId, effectId,
              kind, domainReceiptId: controlText(receipt["commandId"]), domainStateHash: controlText(receipt["domainStateHash"]) });
          }
        }
        return { encounterEvidence: cases.map((row) => ({ encounterId: row.pin.encounterId, evidence: row.evidence })), controlReceipts };
      });
    },
    async closeSession(tx: IdentityDatabase, train: ConductorTrainStateV1, effects: readonly ConductorSessionEffectV1[]) {
      return guarded(async () => {
        const operatorId = train.session?.operatorId; requireFact(operatorId !== undefined);
        await lockEconomyCashWriter(tx, { worldId: train.worldId, operatorId });
        let state = await load(tx, train.worldId, operatorId); if (state === undefined) return;
        for (const effect of effects) {
          requireFact(effect.kind === "close_without_action" && effect.worldId === train.worldId && effect.trainRunId === train.trainRunId);
          const row = ownCase(state, train, effect.encounterId); if (row === undefined || row.status !== "open" || row.policeHoldId !== null) continue;
          state = await command(tx, state, effect.effectId, effect.atMs, { type: "close_case", caseId: row.caseId });
        }
        await save(tx, state);
      });
    },
    async advanceWorld(tx: IdentityDatabase, worldId: string, nowMs: number) {
      return guarded(async () => {
        requireFact(Number.isSafeInteger(nowMs) && nowMs >= 0);
        const rows = await tx.select({ operatorId: conductorControlStates.operatorId }).from(conductorControlStates).where(eq(conductorControlStates.worldId, worldId));
        for (const row of rows) {
          await lockEconomyCashWriter(tx, { worldId, operatorId: row.operatorId });
          let state = await load(tx, worldId, row.operatorId); requireFact(state !== undefined); if (nowMs < state.nowMs) continue;
          const originalHash = state.stateHash, wakeup = deps.runtime.nextWakeup(state);
          if (wakeup !== null && wakeup <= nowMs) state = await command(tx, state, `advance:${nowMs}`, nowMs, { type: "advance_time" });
          state = await policeProgress(tx, state, nowMs);
          const evidence = await loadConfirmedFareContractRevenues(tx, { worldId, operatorId: row.operatorId, nowMs });
          const days = new Map<number, ControlRecord>();
          for (const event of Object.values(state.ledgerEvents)) {
            if (event.caseId === null) continue;
            const release = state.cases[event.caseId]!.pin.economyRelease, rules = controlRecord(release["fareInspection"]);
            const length = rules["dayLengthMs"]; requireFact(typeof length === "number");
            if (event.dayStartMs + length <= nowMs) {
              const existing = days.get(event.dayStartMs); requireFact(existing === undefined || existing["checksum"] === release["checksum"]);
              days.set(event.dayStartMs, release);
            }
          }
          for (const [dayStartMs, economyRelease] of [...days].sort(([a], [b]) => a - b)) {
            const commandId = `day:${id(dayStartMs, evidence, Object.values(state.ledgerEvents).filter((event) => event.caseId !== null).map((event) => event.eventId).sort())}`;
            if (state.receipts[commandId] !== undefined) continue;
            state = await command(tx, state, commandId, nowMs, { type: "settle_day", dayStartMs, contractRevenueEvidence: evidence, economyRelease });
          }
          if (state.stateHash !== originalHash) await save(tx, state);
        }
      });
    },
  });
}
