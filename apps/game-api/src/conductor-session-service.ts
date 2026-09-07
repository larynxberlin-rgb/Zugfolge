import { randomUUID } from "node:crypto";
import { accounts, conductorCommandReceipts, conductorLeases, conductorOwners, conductorSnapshots, conductorTrainStates, operators, regionalSimulationStates, worldAccesses, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { ConductorCommandReceiptV1, ConductorCommandV1, ConductorSessionAccessV1, ConductorSessionControlReceiptV1,
  ConductorSessionEffectV1, ConductorSessionPolicyV1, ConductorSessionRuntime, ConductorSessionSnapshotV1, ConductorSessionSourceV1,
  ConductorSessionTransitionV1, ConductorTrainStateV1, DialogueEvidenceV1, InteriorLayoutV1, InteriorPointV1, ConductorSceneRuntime, SceneProjectionV1, OperationalSimulationState } from "@zugfolge/runtime-native";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { ConductorAccessError, conductorHoldsVehicles, loadConductorFleet, loadConductorContext, requireConductorAccount, resolveConductorRegion, type ConductorAccess, type ConductorCommittedContext, type ConductorContextDependencies } from "./conductor-context.js";
import { demandHash, demandRecord, demandText } from "./demand-store.js";
import type { ConductorSceneDeployment } from "./conductor-scene-configuration.js";
import type { ConductorControlStatusV1 } from "./conductor-control.js";

export interface ConductorSessionReleaseCatalog {
  resolve(worldId: string, periodId: string, nowMs: number): {
    readonly policy: ConductorSessionPolicyV1; readonly currentDialogueReleaseHash: string;
    readonly dialogueReleases: readonly Readonly<Record<string, unknown>>[];
  } | undefined;
}
export interface ConductorControlIntegration {
  evidence(tx: IdentityDatabase, context: ConductorCommittedContext, state: ConductorTrainStateV1): Promise<{
    encounterEvidence: readonly { readonly encounterId: string; readonly evidence: DialogueEvidenceV1 }[];
    controlReceipts: readonly ConductorSessionControlReceiptV1[];
  }>;
  apply(tx: IdentityDatabase, context: ConductorCommittedContext, state: ConductorTrainStateV1,
    effects: readonly ConductorSessionEffectV1[]): Promise<void>;
  closeSession?(tx: IdentityDatabase, state: ConductorTrainStateV1, effects: readonly ConductorSessionEffectV1[]): Promise<void>;
  publicStatus?(tx: IdentityDatabase, context: ConductorCommittedContext): Promise<ConductorControlStatusV1>;
  publicHistory?(tx: IdentityDatabase, scope: { worldId: string; operatorId: string; trainRunId: string }): Promise<ConductorControlStatusV1>;
}
export interface ConductorSessionResponse {
  readonly schemaVersion: "conductor-session-response/v1"; readonly receipt: ConductorCommandReceiptV1 | null;
  readonly snapshot: ConductorSessionSnapshotV1; readonly layout: InteriorLayoutV1;
  readonly scene: SceneProjectionV1 | null;
  readonly control: ConductorControlStatusV1 | null;
}
export interface ConductorSessionServiceDependencies extends ConductorContextDependencies {
  readonly db: IdentityDatabase; readonly sessionRuntime: ConductorSessionRuntime;
  readonly sessionReleases: ConductorSessionReleaseCatalog; readonly control: ConductorControlIntegration;
  readonly scenes?: { readonly runtime: ConductorSceneRuntime; readonly deployment: ConductorSceneDeployment };
}
function reject(status: number, code: string, message: string): never { throw new ConductorAccessError(status, code, message); }

/** Ein Weltwriter committed Sitzung, private Quittung und nachgelagerte Effekte gemeinsam. */
export class ConductorSessionService {
  constructor(private readonly deps: ConductorSessionServiceDependencies) {}

  private async underWorld<T>(access: ConductorAccess, run: (tx: IdentityDatabase, context: ConductorCommittedContext) => Promise<T>,
    onEnded?: (response: ConductorSessionResponse) => T): Promise<T> {
    // Maintenance has its own commit: rejecting the browser afterwards must
    // not roll back an independently required revocation or lease expiry.
    await this.sweepWorld(access.worldId, access.trainRunId);
    return this.deps.db.transaction(async (tx) => {
      const [world] = await tx.select({ status: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, access.worldId)).for("update");
      if (world?.status !== "active") reject(409, "conductor_world_inactive", "Die Spielwelt ist nicht aktiv.");
      if (onEnded !== undefined) {
        const response = await this.endedResponse(tx, access);
        if (response !== undefined) return onEnded(response);
      }
      const context = await loadConductorContext(tx, access, this.deps);
      return run(tx, context);
    });
  }

  private async endedResponse(tx: IdentityDatabase, access: ConductorAccess): Promise<ConductorSessionResponse | undefined> {
    const accountId = await requireConductorAccount(tx, access);
    const [stored] = await tx.select().from(conductorTrainStates).where(and(eq(conductorTrainStates.worldId, access.worldId), eq(conductorTrainStates.trainRunId, access.trainRunId)));
    const raw = stored?.state as ConductorTrainStateV1 | undefined;
    if (stored === undefined || raw?.session?.status !== "ended") return undefined;
    const [owner] = await tx.select().from(conductorOwners).where(and(eq(conductorOwners.worldId, access.worldId), eq(conductorOwners.accountId, accountId)));
    if (owner === undefined || owner.ownerRef !== raw.session.ownerRef || raw.session.operatorId !== access.operatorId)
      reject(403, "conductor_access_denied", "Diese abgeschlossene Sitzung gehört nicht zu deinem Unternehmen.");
    const policy = raw.session["policy"] as ConductorSessionPolicyV1;
    const releases = this.deps.sessionReleases.resolve(access.worldId, policy.periodId, Number(raw.session["startedAtMs"]));
    if (releases === undefined) reject(503, "conductor_release_unavailable", "Der aufbewahrte Regelstand der Sitzung fehlt.");
    const state = this.deps.sessionRuntime.restore(raw, stored.stateHash, releases.dialogueReleases);
    if (state.worldId !== access.worldId || state.trainRunId !== access.trainRunId || state.revision !== stored.revision || state.nowMs !== stored.atMs)
      reject(503, "conductor_state_invalid", "Der gespeicherte Sitzungsabschluss konnte nicht bestätigt werden.");
    const binding = this.deps.regionBindings(access.worldId).find((row) => row.regionId === stored.regionId);
    const [head] = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, access.worldId), eq(regionalSimulationStates.regionId, stored.regionId)));
    if (binding === undefined || head === undefined || head.initializationHash !== binding.initializationHash)
      reject(503, "conductor_source_unavailable", "Der bestätigte regionale Betriebsstand fehlt.");
    const restored = this.deps.operationalRuntime.restore(head.state as OperationalSimulationState, binding.initializationHash);
    if (restored.stateHash !== head.stateHash || restored.state.revision !== head.revision || restored.state.publisherSequence !== head.publisherSequence
      || restored.state.world.worldId !== access.worldId || restored.state.world.regionId !== stored.regionId)
      reject(503, "conductor_source_unavailable", "Der regionale Betriebsstand ist nicht bestätigt.");
    const snapshot = this.deps.sessionRuntime.project(state, { worldId: access.worldId, operatorId: access.operatorId,
      ownerRef: owner.ownerRef, worldAccessActive: true, operatorActive: true, trainUseAuthorized: true, otherActiveSessionId: null },
    { operationalWorld: restored.state.world, expectedOperationalWorldHash: this.deps.sessionRuntime.operationalWorldHash(restored.state.world),
      interior: null, projection: null, sessionPolicy: policy, currentDialogueReleaseHash: releases.currentDialogueReleaseHash,
      dialogueReleases: releases.dialogueReleases, encounterEvidence: [], controlReceipts: [] });
    if (snapshot === null || state.layout === null) reject(503, "conductor_state_invalid", "Der Sitzungsabschluss konnte nicht dargestellt werden.");
    return { schemaVersion: "conductor-session-response/v1", receipt: null, snapshot, layout: state.layout, scene: null,
      control: await this.deps.control.publicHistory?.(tx, access) ?? null };
  }

  async report(access: ConductorAccess) {
    return this.deps.db.transaction(async (tx) => {
      await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, access.worldId)).for("update");
      await requireConductorAccount(tx, access);
      if (this.deps.control.publicHistory === undefined) reject(503, "conductor_control_unavailable", "Der Kontrollbericht ist noch nicht verfügbar.");
      return { schemaVersion: "conductor-report/v1" as const, worldId: access.worldId, operatorId: access.operatorId, trainRunId: access.trainRunId,
        control: await this.deps.control.publicHistory(tx, access) };
    });
  }

  private scene(context: ConductorCommittedContext, snapshot: ConductorSessionSnapshotV1): SceneProjectionV1 | null {
    if (this.deps.scenes === undefined || snapshot.status === "ended") return null;
    const { runtime, deployment } = this.deps.scenes;
    const pin = deployment.period(snapshot.worldId, context.period.periodId, context.regionId, context.nowMs,
      context.operationalProjection.infraReleaseId, context.operationalInfraReleaseHash);
    if (pin === undefined || pin.artReleaseId !== context.period.artPin.releaseId || pin.artManifestHash !== context.period.artPin.manifestSha256)
      reject(503, "conductor_scene_unavailable", "Für diese Fahrt ist keine freigegebene Umgebung verfügbar.");
    return runtime.project({ schemaVersion: "conductor-scene-input/v1", sceneRelease: pin.sceneRelease, operational: context.operationalProjection,
      sampleAtMs: context.nowMs, binding: { worldId: snapshot.worldId, periodId: pin.periodId, operatorId: snapshot.operatorId,
        trainRunId: snapshot.trainRunId, regionId: context.regionId, infraReleaseId: pin.infraReleaseId, infraReleaseHash: pin.infraReleaseHash,
        sceneReleaseHash: pin.sceneReleaseHash, artReleaseId: pin.artReleaseId, artManifestHash: pin.artManifestHash,
        operationalStateHash: context.operationalStateHash, commitSequence: context.operationalProjection.commitSequence,
        validFromMs: pin.validFromMs, validUntilMs: pin.validUntilMs } });
  }

  /** Trusted lifecycle maintenance, never an authorization of the requesting browser. */
  private async sweep(tx: IdentityDatabase, worldId: string, trainRunId?: string): Promise<void> {
    const rows = await tx.select().from(conductorTrainStates).where(and(eq(conductorTrainStates.worldId, worldId),
      trainRunId === undefined ? undefined : eq(conductorTrainStates.trainRunId, trainRunId)));
    for (const stored of rows) {
      const raw = stored.state as ConductorTrainStateV1;
      if (raw.session === null || raw.session.status === "ended") continue;
      const policy = raw.session["policy"] as ConductorSessionPolicyV1;
      const releases = this.deps.sessionReleases.resolve(worldId, policy.periodId, Number(raw.session["startedAtMs"]));
      if (releases === undefined) reject(503, "conductor_release_unavailable", "Eine bestehende Sitzung benötigt ihren aufbewahrten Regelstand.");
      const state = this.deps.sessionRuntime.restore(raw, stored.stateHash, releases.dialogueReleases), session = state.session!;
      if (state.worldId !== worldId || state.trainRunId !== stored.trainRunId || state.revision !== stored.revision || state.nowMs !== stored.atMs)
        reject(503, "conductor_state_invalid", "Der gespeicherte Sitzungsstand konnte nicht bestätigt werden.");
      let region: Awaited<ReturnType<typeof resolveConductorRegion>>;
      try { region = await resolveConductorRegion(tx, worldId, state.trainRunId, this.deps,
        { regionId: stored.regionId, atMs: state.nowMs }); }
      catch (error) {
        // Eine gesperrte Übergabe darf die unabhängige Bereinigung anderer
        // Züge nicht verhindern. Der konkrete Benutzerabruf bleibt gesperrt.
        if (trainRunId === undefined && error instanceof ConductorAccessError && error.code === "conductor_handover_pending") continue;
        throw error;
      }
      const { head, restored } = region;
      if (head.regionId !== stored.regionId)
        await tx.update(conductorTrainStates).set({ regionId: head.regionId }).where(and(eq(conductorTrainStates.worldId, worldId), eq(conductorTrainStates.trainRunId, state.trainRunId)));
      const world = restored.state.world, train = demandRecord(world["trains"])[state.trainRunId] as Record<string, unknown> | undefined;
      const [owner] = await tx.select({ accountId: accounts.id, subject: accounts.keycloakSubject, access: worldAccesses.status }).from(conductorOwners)
        .innerJoin(accounts, and(eq(accounts.worldId, conductorOwners.worldId), eq(accounts.id, conductorOwners.accountId), isNull(accounts.erasedAt)))
        .leftJoin(worldAccesses, and(eq(worldAccesses.worldId, accounts.worldId), eq(worldAccesses.keycloakSubject, accounts.keycloakSubject)))
        .where(and(eq(conductorOwners.worldId, worldId), eq(conductorOwners.ownerRef, session.ownerRef)));
      const [operator] = await tx.select().from(operators).where(and(eq(operators.worldId, worldId), eq(operators.id, session.operatorId)));
      const worldAccessActive = owner?.access === "active", operatorActive = operator?.lifecycle === "active" && operator.foundingAccountId === owner?.accountId;
      const pins = session["pins"] as { vehicleIds: readonly string[] };
      // Rights come from M5, while missing/cancelled trains are classified by the native lifecycle.
      const trainUseAuthorized = !worldAccessActive || !operatorActive || world.nowMs >= session.leaseUntilMs || train === undefined ? true : conductorHoldsVehicles(
        await loadConductorFleet(tx, worldId, world.nowMs, this.deps.fleetRuntime), session.operatorId, pins.vehicleIds, world.nowMs);
      const eligible = train !== undefined && train["operatorId"] === session.operatorId && train["movementKind"] === "train" && train["publicPassengerStop"] === true;
      const receipts = train?.["passengerStops"] === undefined || train["passengerStops"] === null ? [] : demandRecord(train["passengerStops"])["receipts"] as Record<string, unknown>[];
      const cancelled = train?.["passengerStops"] !== undefined && train["passengerStops"] !== null && demandRecord(train["passengerStops"])["cancellation"] != null;
      const terminal = receipts.at(-1)?.["actualArrivalMs"] !== null && receipts.at(-1)?.["actualArrivalMs"] !== undefined;
      const formation = train === undefined ? undefined : demandRecord(world["formations"])[demandText(train["formationVersionId"])] as { vehicleIds: readonly string[] } | undefined;
      const changed = formation !== undefined && JSON.stringify(formation.vehicleIds) !== JSON.stringify(pins.vehicleIds);
      if (worldAccessActive && operatorActive && trainUseAuthorized && eligible && !cancelled && !terminal && !changed && world.nowMs < session.leaseUntilMs) continue;
      const result = this.deps.sessionRuntime.synchronize({ schemaVersion: "conductor-session-synchronize-input/v1", state,
        expectedStateHash: state.stateHash, causalityId: `lifecycle:${head.stateHash}`, access: { worldId, operatorId: session.operatorId,
          ownerRef: session.ownerRef, worldAccessActive, operatorActive, trainUseAuthorized, otherActiveSessionId: null },
        source: { operationalWorld: world, expectedOperationalWorldHash: this.deps.sessionRuntime.operationalWorldHash(world), interior: null, projection: null,
          sessionPolicy: policy, currentDialogueReleaseHash: releases.currentDialogueReleaseHash, dialogueReleases: releases.dialogueReleases,
          encounterEvidence: [], controlReceipts: [] } });
      if (result.effects.length > 0) {
        if (this.deps.control.closeSession === undefined) reject(503, "conductor_control_unavailable", "Die laufende Kontrolle kann noch nicht abgeschlossen werden.");
        await this.deps.control.closeSession(tx, result.state, result.effects);
      }
      await tx.update(conductorTrainStates).set({ state: result.state, stateHash: result.stateHash, revision: result.state.revision, atMs: result.state.nowMs })
        .where(and(eq(conductorTrainStates.worldId, worldId), eq(conductorTrainStates.trainRunId, state.trainRunId)));
      await tx.delete(conductorLeases).where(and(eq(conductorLeases.worldId, worldId), eq(conductorLeases.trainRunId, state.trainRunId)));
      if (result.snapshot !== null && owner !== undefined) await tx.insert(conductorSnapshots).values({ worldId, trainRunId: state.trainRunId,
        ownerRef: session.ownerRef, sessionId: session.sessionId, sequence: result.snapshot.sequence, snapshot: result.snapshot }).onConflictDoNothing();
    }
  }

  async sweepWorld(worldId: string, trainRunId?: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const [world] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).for("update");
      if (world?.lifecycleStatus === "active") await this.sweep(tx, worldId, trainRunId);
    });
  }

  private async source(tx: IdentityDatabase, context: ConductorCommittedContext, state: ConductorTrainStateV1): Promise<ConductorSessionSourceV1> {
    const releases = this.deps.sessionReleases.resolve(state.worldId, context.period.periodId, context.nowMs);
    if (releases === undefined) reject(503, "conductor_release_unavailable", "Für diese Periode fehlen freigegebene Schaffnerregeln oder Dialoge.");
    const facts = await this.deps.control.evidence(tx, context, state);
    return { operationalWorld: context.operationalWorld, expectedOperationalWorldHash: this.deps.sessionRuntime.operationalWorldHash(context.operationalWorld),
      interior: context.interiorInput, projection: context.projectionInput, sessionPolicy: releases.policy,
      currentDialogueReleaseHash: releases.currentDialogueReleaseHash, dialogueReleases: releases.dialogueReleases, ...facts };
  }

  private async state(tx: IdentityDatabase, access: ConductorAccess, context: ConductorCommittedContext): Promise<ConductorTrainStateV1> {
    const [stored] = await tx.select().from(conductorTrainStates).where(and(eq(conductorTrainStates.worldId, access.worldId), eq(conductorTrainStates.trainRunId, access.trainRunId)));
    if (stored === undefined) return this.deps.sessionRuntime.initialize(access.worldId, access.trainRunId, context.nowMs);
    const releases = this.deps.sessionReleases.resolve(access.worldId, context.period.periodId, context.nowMs);
    if (releases === undefined) reject(503, "conductor_release_unavailable", "Die gepinnten Schaffnerregeln sind nicht verfügbar.");
    const state = this.deps.sessionRuntime.restore(stored.state as ConductorTrainStateV1, stored.stateHash, releases.dialogueReleases);
    if (state.worldId !== access.worldId || state.trainRunId !== access.trainRunId || state.revision !== stored.revision || state.nowMs !== stored.atMs)
      reject(503, "conductor_state_invalid", "Der gespeicherte Sitzungsstand konnte nicht bestätigt werden.");
    return state;
  }

  private async access(tx: IdentityDatabase, access: ConductorAccess, context: ConductorCommittedContext, create: boolean): Promise<ConductorSessionAccessV1> {
    let [owner] = await tx.select().from(conductorOwners).where(and(eq(conductorOwners.worldId, access.worldId), eq(conductorOwners.accountId, context.accountId)));
    if (owner === undefined && create) {
      [owner] = await tx.insert(conductorOwners).values({ worldId: access.worldId, accountId: context.accountId, ownerRef: randomUUID() }).returning();
    }
    if (owner === undefined) reject(404, "conductor_session_missing", "Du hast noch keine Schaffnersitzung in dieser Welt.");
    const other = await this.accountLease(tx, access, context.accountId);
    return { worldId: access.worldId, operatorId: access.operatorId, ownerRef: owner.ownerRef,
      worldAccessActive: true, operatorActive: true, trainUseAuthorized: true,
      otherActiveSessionId: other !== undefined && other.trainRunId !== access.trainRunId ? other.sessionId : null };
  }

  private async accountLease(tx: IdentityDatabase, access: ConductorAccess, accountId: string) {
    const read = () => tx.select().from(conductorLeases).where(and(eq(conductorLeases.worldId, access.worldId), eq(conductorLeases.accountId, accountId)));
    const [lease] = await read();
    if (lease === undefined || lease.trainRunId === access.trainRunId) return lease;
    // Only the other train's actual native lifecycle can release its lease.
    await this.sweep(tx, access.worldId, lease.trainRunId);
    const [current] = await read(); return current;
  }

  private async persist(tx: IdentityDatabase, context: ConductorCommittedContext, transition: ConductorSessionTransitionV1): Promise<void> {
    const { state, stateHash, snapshot } = transition;
    if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) reject(503, "conductor_state_capacity", "Der private Sitzungsstand überschreitet die freigegebene Speichergrenze.");
    await tx.insert(conductorTrainStates).values({ worldId: state.worldId, trainRunId: state.trainRunId, regionId: context.regionId,
      state, stateHash, revision: state.revision, atMs: state.nowMs }).onConflictDoUpdate({
      target: [conductorTrainStates.worldId, conductorTrainStates.trainRunId], set: { state, stateHash, regionId: context.regionId, revision: state.revision, atMs: state.nowMs } });
    if (state.session !== null && state.session.status !== "ended") {
      await tx.insert(conductorLeases).values({ worldId: state.worldId, accountId: context.accountId, ownerRef: state.session.ownerRef,
        trainRunId: state.trainRunId, sessionId: state.session.sessionId, leaseUntilMs: state.session.leaseUntilMs })
        .onConflictDoUpdate({ target: [conductorLeases.worldId, conductorLeases.accountId], set: {
          ownerRef: state.session.ownerRef, trainRunId: state.trainRunId, sessionId: state.session.sessionId, leaseUntilMs: state.session.leaseUntilMs } });
    } else {
      await tx.delete(conductorLeases).where(and(eq(conductorLeases.worldId, state.worldId), eq(conductorLeases.trainRunId, state.trainRunId)));
    }
    if (snapshot !== null && state.session !== null) {
      await tx.insert(conductorSnapshots).values({ worldId: state.worldId, trainRunId: state.trainRunId, sessionId: snapshot.sessionId,
        ownerRef: state.session.ownerRef, sequence: snapshot.sequence, snapshot }).onConflictDoNothing();
      // Der begrenzte Ring erzeugt bei zu alter SSE-Kennung einen Vollsnapshot.
      await tx.delete(conductorSnapshots).where(and(eq(conductorSnapshots.worldId, state.worldId), eq(conductorSnapshots.trainRunId, state.trainRunId),
        lt(conductorSnapshots.sequence, Math.max(0, snapshot.sequence - 128))));
    }
  }

  async command(access: ConductorAccess, command: ConductorCommandV1): Promise<ConductorSessionResponse> {
    if (command.worldId !== access.worldId || command.trainRunId !== access.trainRunId)
      reject(400, "conductor_command_binding", "Der Befehl gehört zu einer anderen Fahrt.");
    return this.underWorld(access, async (tx, context) => {
      const authorization = await this.access(tx, access, context, command.action.type === "start_session");
      const state = await this.state(tx, access, context);
      const source = await this.source(tx, context, state);
      const requestHash = demandHash(command);
      const [prior] = await tx.select().from(conductorCommandReceipts).where(and(eq(conductorCommandReceipts.worldId, access.worldId),
        eq(conductorCommandReceipts.trainRunId, access.trainRunId), eq(conductorCommandReceipts.commandId, command.idempotencyKey)));
      if (prior !== undefined) {
        if (prior.ownerRef !== authorization.ownerRef) reject(403, "conductor_access_denied", "Diese Quittung gehört zu einer anderen Sitzung.");
        if (prior.requestHash !== requestHash) reject(409, "conductor_idempotency_conflict", "Die Befehlskennung wurde bereits für eine andere Handlung verwendet.");
        if ((prior.receipt as ConductorCommandReceiptV1).sessionId !== state.session?.sessionId)
          reject(409, "conductor_session_ended", "Die frühere Quittung gehört zu einer bereits abgeschlossenen Sitzung.");
        const snapshot = this.deps.sessionRuntime.project(state, authorization, source);
        if (snapshot === null || state.layout === null) reject(409, "conductor_session_ended", "Die Sitzung ist nicht mehr verfügbar.");
        return { schemaVersion: "conductor-session-response/v1", receipt: prior.receipt as ConductorCommandReceiptV1, snapshot, layout: state.layout,
          scene: this.scene(context, snapshot), control: await this.deps.control.publicStatus?.(tx, context) ?? null };
      }
      let result = this.deps.sessionRuntime.apply({ schemaVersion: "conductor-session-apply-input/v1", state, expectedStateHash: state.stateHash,
        command, access: authorization, source });
      // Alle Effekte werden entweder im selben Commit angenommen oder der
      // gesamte Befehl wird zurückgerollt; ein Client bestätigt keine Folge.
      {
        await this.deps.control.apply(tx, context, result.state, result.effects);
        context = await loadConductorContext(tx, access, this.deps);
        const nextSource = await this.source(tx, context, result.state);
        const originalReceipt = result.receipt;
        result = this.deps.sessionRuntime.synchronize({ schemaVersion: "conductor-session-synchronize-input/v1", state: result.state,
          expectedStateHash: result.stateHash, access: authorization, source: nextSource, causalityId: `${command.idempotencyKey}:effects` });
        result = { ...result, receipt: originalReceipt };
      }
      if (result.snapshot === null || result.state.layout === null || result.receipt === null)
        reject(409, "conductor_session_unavailable", "Die Sitzung konnte für diesen Befehl nicht fortgesetzt werden.");
      await this.persist(tx, context, result);
      await tx.insert(conductorCommandReceipts).values({ worldId: access.worldId, trainRunId: access.trainRunId, commandId: command.idempotencyKey,
        ownerRef: authorization.ownerRef, requestHash, receipt: result.receipt });
      return { schemaVersion: "conductor-session-response/v1", receipt: result.receipt, snapshot: result.snapshot, layout: result.state.layout,
        scene: this.scene(context, result.snapshot), control: await this.deps.control.publicStatus?.(tx, context) ?? null };
    });
  }

  private async synchronizedSnapshot(tx: IdentityDatabase, context: ConductorCommittedContext, access: ConductorAccess): Promise<ConductorSessionResponse> {
    const authorization = await this.access(tx, access, context, false), state = await this.state(tx, access, context);
    const source = await this.source(tx, context, state);
    const result = this.deps.sessionRuntime.synchronize({ schemaVersion: "conductor-session-synchronize-input/v1", state,
      expectedStateHash: state.stateHash, access: authorization, source, causalityId: `sync:${context.operationalStateHash}` });
    if (result.snapshot === null || result.state.layout === null) reject(404, "conductor_session_missing", "Für dich ist keine Sitzung in diesem Zug geöffnet.");
    if (result.effects.length > 0) await this.deps.control.apply(tx, context, result.state, result.effects);
    if (result.stateHash !== state.stateHash) await this.persist(tx, context, result);
    return { schemaVersion: "conductor-session-response/v1", receipt: null, snapshot: result.snapshot, layout: result.state.layout,
      scene: this.scene(context, result.snapshot), control: await this.deps.control.publicStatus?.(tx, context) ?? null };
  }

  async snapshot(access: ConductorAccess): Promise<ConductorSessionResponse> {
    return this.underWorld(access, (tx, context) => this.synchronizedSnapshot(tx, context, access), (response) => response);
  }

  async changes(access: ConductorAccess, afterSequence: number): Promise<{ reset: boolean; response: ConductorSessionResponse; snapshots: readonly ConductorSessionSnapshotV1[] }> {
    return this.underWorld(access, async (tx, context) => {
      const response = await this.synchronizedSnapshot(tx, context, access);
      const authorization = await this.access(tx, access, context, false);
      const rows = await tx.select().from(conductorSnapshots).where(and(eq(conductorSnapshots.worldId, access.worldId),
        eq(conductorSnapshots.trainRunId, access.trainRunId), eq(conductorSnapshots.ownerRef, authorization.ownerRef),
        eq(conductorSnapshots.sessionId, response.snapshot.sessionId), gt(conductorSnapshots.sequence, afterSequence)))
        .orderBy(asc(conductorSnapshots.sequence)).limit(129);
      const gap = afterSequence > response.snapshot.sequence || response.snapshot.sequence > afterSequence
        && (rows.length === 0 || rows.some((row, index) => row.sequence !== afterSequence + index + 1)
          || rows.at(-1)?.sequence !== response.snapshot.sequence);
      return { reset: gap, response, snapshots: gap ? [response.snapshot] : rows.map((row) => row.snapshot as ConductorSessionSnapshotV1) };
    }, (response) => ({ reset: true, response, snapshots: [response.snapshot] }));
  }

  async availability(access: ConductorAccess): Promise<{ available: true; revision: number; manifestRevision: number; sessionId: string | null }> {
    return this.underWorld(access, async (tx, context) => {
      const state = await this.state(tx, access, context);
      const [owner] = await tx.select().from(conductorOwners).where(and(eq(conductorOwners.worldId, access.worldId), eq(conductorOwners.accountId, context.accountId)));
      const active = state.session !== null && state.session.status !== "ended" && state.session.leaseUntilMs > context.nowMs;
      if (active && state.session!.ownerRef !== owner?.ownerRef) reject(409, "conductor_train_reserved", "In diesem Zug ist bereits eine Schaffnersitzung geöffnet.");
      const other = await this.accountLease(tx, access, context.accountId);
      if (other !== undefined && other.trainRunId !== access.trainRunId) reject(409, "conductor_account_reserved", "Beende zuerst deine Schaffnersitzung im anderen Zug.");
      return { available: true, revision: active ? state.session!.revision : 0, manifestRevision: context.projectionInput.binding.manifestRevision, sessionId: active ? state.session!.sessionId : null };
    });
  }

  async art(access: ConductorAccess) {
    return this.underWorld(access, async (tx, context) => {
      await this.synchronizedSnapshot(tx, context, access);
      return context.period.atlas.renderView(access.worldId);
    });
  }

  async path(access: ConductorAccess, targetNodeId: string) {
    return this.underWorld(access, async (tx, context) => {
      const { snapshot, layout } = await this.synchronizedSnapshot(tx, context, access);
      if (snapshot.status !== "active") reject(409, "conductor_session_inactive", "Die Sitzung ist nicht aktiv.");
      const from = snapshot.position;
      const candidates = layout.nodes.filter(({ point }) => point.vehicleId === from.vehicleId && point.bodyId === from.bodyId && point.deckId === from.deckId)
        .map((node) => ({ node, distance: Math.abs(node.point.xMm - from.xMm) + Math.abs(node.point.yMm - from.yMm) }))
        .sort((a, b) => a.distance - b.distance || a.node.nodeId.localeCompare(b.node.nodeId));
      const start = candidates.find(({ node }) => this.deps.interiorRuntime.movement({ schemaVersion: "conductor-interior-movement-input/v1", layout,
        expectedLayoutHash: layout.layoutHash, from, to: node.point, transitionEdgeId: null, wheelchair: false }).allowed)?.node;
      if (start === undefined) reject(409, "conductor_path_unavailable", "Von deiner Position ist kein begehbarer Weg erreichbar.");
      const path = this.deps.interiorRuntime.path({ schemaVersion: "conductor-interior-path-input/v1", layout,
        expectedLayoutHash: layout.layoutHash, fromNodeId: start.nodeId, toNodeId: targetNodeId, wheelchair: false });
      const points: { to: InteriorPointV1; transitionEdgeId: string | null }[] = [{ to: start.point, transitionEdgeId: null }];
      for (let index = 1; index < path.nodeIds.length; index++) {
        const edge = layout.edges.find((row) => row.edgeId === path.edgeIds[index - 1])!;
        points.push({ to: layout.nodes.find((node) => node.nodeId === path.nodeIds[index])!.point,
          transitionEdgeId: edge.kind === "walk" ? null : edge.edgeId });
      }
      return { schemaVersion: "conductor-walking-path/v1" as const, layoutHash: layout.layoutHash, from, points };
    });
  }

  async atlasFile(access: ConductorAccess, fileId: string): Promise<Uint8Array> {
    return this.underWorld(access, async (tx, context) => {
      await this.synchronizedSnapshot(tx, context, access);
      if (!context.period.atlas.renderView(access.worldId).files.some((file) => file.id === fileId))
        reject(404, "conductor_atlas_missing", "Die Grafikdatei gehört nicht zum freigegebenen Atlas.");
      return context.period.atlas.file(access.worldId, fileId);
    });
  }
}
