import {
  AlphaConflictError,
  alphaHash,
  type AlphaDatabase,
  type CapacityCell,
  type StartPackageProof,
  type StartPackageSpec,
} from "@zugfolge/alpha";
import {
  accounts,
  alphaWorldProfiles,
  domainEvents,
  onboardingGrants,
  operatingProgramVersions,
  operatorContracts,
  operators,
  vehicleAssets,
  worlds,
} from "@zugfolge/db";
import { canonicalizeProgram, operatingProgramTemplates } from "@zugfolge/dispatch";
import {
  encodeEconomyValue,
  grantEmergencyStartPackage,
  loadEconomyWorldState,
  loadFleetProducerCheckpoint,
  persistEconomyTransition,
  seedTutorialAccount,
  type EconomyDatabase,
  type MobilizationProof,
} from "@zugfolge/economy";
import { parsePlanningProjection } from "@zugfolge/planning-projection";
import {
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  type NativeFleetMobilizationSnapshot,
  type OperatingRuntime,
  type OperatingRuntimeEvent,
} from "@zugfolge/runtime-native";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import {
  ALPHA_START_PACKAGE_COMMAND_SCHEMA,
  ALPHA_TUTORIAL_RESET_COMMAND_SCHEMA,
  type AlphaJourneyCommandWriter,
  type StartPackageCommand,
  type TutorialResetCommand,
} from "./alpha-journey-adapters.js";

export interface StartPackageAuthoritySlot {
  readonly worldId: string;
  readonly operatorId: string;
  readonly operatorName: string;
  readonly vehicleId: string;
  readonly formationId: string;
  readonly personnelDutyId: string;
  readonly pathReservationId: string;
  readonly vehicleLeaseReceiptId: string;
  readonly trainRunIds: readonly string[];
}

export interface AlphaJourneyAuthorityConfiguration {
  readonly startPackageSlots: readonly StartPackageAuthoritySlot[];
  readonly tutorialOperatorNamePrefix: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} ist kein Objekt.`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} fehlt.`);
  return value;
}

function stringList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${name} ist keine nichtleere Zeichenliste.`);
  }
  return Object.freeze([...value] as string[]);
}

export function parseAlphaJourneyAuthorityConfiguration(value: string): AlphaJourneyAuthorityConfiguration {
  const parsed = record(JSON.parse(value), "Alpha-Journey-Konfiguration");
  if (!Array.isArray(parsed["startPackageSlots"]) || parsed["startPackageSlots"].length === 0) {
    throw new Error("Alpha-Journey-Konfiguration braucht mindestens einen vorbereiteten Startpaket-Slot.");
  }
  const slots = parsed["startPackageSlots"].map((candidate, index): StartPackageAuthoritySlot => {
    const slot = record(candidate, `Startpaket-Slot ${index + 1}`);
    return Object.freeze({
      worldId: nonEmpty(slot["worldId"], "Slot-Welt"),
      operatorId: nonEmpty(slot["operatorId"], "Slot-EVU"),
      operatorName: nonEmpty(slot["operatorName"], "Slot-EVU-Name"),
      vehicleId: nonEmpty(slot["vehicleId"], "Slot-Fahrzeug"),
      formationId: nonEmpty(slot["formationId"], "Slot-Formation"),
      personnelDutyId: nonEmpty(slot["personnelDutyId"], "Slot-Personaldienst"),
      pathReservationId: nonEmpty(slot["pathReservationId"], "Slot-Trassenreservierung"),
      vehicleLeaseReceiptId: nonEmpty(slot["vehicleLeaseReceiptId"], "Slot-Leasingbeleg"),
      trainRunIds: stringList(slot["trainRunIds"], "Slot-Zugfahrten"),
    });
  });
  const keys = new Set(slots.map((slot) => `${slot.worldId}:${slot.operatorId}`));
  if (keys.size !== slots.length) throw new Error("Startpaket-Slots sind nicht weltweit eindeutig.");
  return Object.freeze({
    startPackageSlots: Object.freeze(slots),
    tutorialOperatorNamePrefix: nonEmpty(parsed["tutorialOperatorNamePrefix"], "Tutorial-EVU-Praefix"),
  });
}

export function parseStartPackageSpec(value: string): StartPackageSpec {
  const parsed = record(JSON.parse(value), "Startpaket-Spezifikation");
  const maximumVehicleValueCents = nonEmpty(parsed["maximumVehicleValueCents"], "Startpaket-Fahrzeugwert");
  if (!/^[1-9][0-9]*$/.test(maximumVehicleValueCents)) throw new Error("Startpaket-Fahrzeugwert ist keine positive Cent-Ganzzahl.");
  const integer = (name: string): number => {
    const candidate = parsed[name];
    if (!Number.isSafeInteger(candidate)) throw new Error(`Startpaket-${name} ist keine sichere Ganzzahl.`);
    return candidate as number;
  };
  if (parsed["schemaVersion"] !== "zugfolge-start-package/v1") throw new Error("Startpaket-Schema ist unbekannt.");
  return Object.freeze({
    schemaVersion: "zugfolge-start-package/v1",
    version: nonEmpty(parsed["version"], "Startpaket-Version"),
    emergencyLotId: nonEmpty(parsed["emergencyLotId"], "Startpaket-Los"),
    maximumTrainKmPerPeriod: integer("maximumTrainKmPerPeriod"),
    vehicleClass: nonEmpty(parsed["vehicleClass"], "Startpaket-Fahrzeugklasse"),
    maximumVehicleValueCents: BigInt(maximumVehicleValueCents),
    durationS: integer("durationS"),
    pathWindowId: nonEmpty(parsed["pathWindowId"], "Startpaket-Trassenfenster"),
    personnelPoolId: nonEmpty(parsed["personnelPoolId"], "Startpaket-Personalpool"),
    operatingProgramTemplateId: nonEmpty(parsed["operatingProgramTemplateId"], "Startpaket-Betriebsprogrammvorlage"),
  });
}

function payloadCommandId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)["commandId"];
  return typeof value === "string" ? value : undefined;
}

function payloadProof(payload: unknown): StartPackageProof | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const proof = (payload as Record<string, unknown>)["proof"];
  return typeof proof === "object" && proof !== null && !Array.isArray(proof)
    ? proof as unknown as StartPackageProof
    : undefined;
}

function fleetProof(
  snapshot: NativeFleetMobilizationSnapshot,
  slot: StartPackageAuthoritySlot,
  spec: StartPackageSpec,
): MobilizationProof {
  const formation = snapshot.formations.find((entry) => entry.id === slot.formationId);
  const duty = snapshot.personnelDuties.find((entry) => entry.id === slot.personnelDutyId);
  const path = snapshot.pathReservations.find((entry) => entry.id === slot.pathReservationId);
  if (
    formation?.operatorId !== slot.operatorId
    || !formation.vehicleIds.includes(slot.vehicleId)
    || formation.availability !== "available"
    || formation.procurement !== "delivered"
    || formation.characteristics.maintenanceValidUntil < spec.durationS
    || duty?.operatorId !== slot.operatorId
    || duty.status !== "ready"
    || !duty.formationIds.includes(slot.formationId)
    || path?.operatorId !== slot.operatorId
    || path.status !== "confirmed"
  ) throw new AlphaConflictError("Vorbereiteter Startpaket-Slot besitzt keinen vollstaendigen M5-Nachweis.", "start_package_slot_unavailable");
  return Object.freeze({
    source: "m5-release",
    verifiedBy: "zugfolge-fleet-mobilization/v1",
    fleetRevision: snapshot.revision,
    snapshotHash: "",
    formationIds: Object.freeze([slot.formationId]),
    personnelDutyIds: Object.freeze([slot.personnelDutyId]),
    pathReservationIds: Object.freeze([slot.pathReservationId]),
  });
}

function template(spec: StartPackageSpec, worldId: string, operatorId: string) {
  const indexById: Readonly<Record<string, number>> = { resilience: 0, balanced: 0, connections: 1, lean: 2 };
  const index = indexById[spec.operatingProgramTemplateId];
  if (index === undefined) throw new Error(`Unbekannte Betriebsprogrammvorlage '${spec.operatingProgramTemplateId}'.`);
  return operatingProgramTemplates(worldId, operatorId, 1)[index]!;
}

function overlapSeconds(intervals: readonly { readonly start: number; readonly end: number }[]): number {
  const sorted = [...intervals].filter((interval) => interval.end > interval.start).sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start = -1;
  let end = -1;
  for (const interval of sorted) {
    if (start < 0) {
      ({ start, end } = interval);
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      ({ start, end } = interval);
    }
  }
  return total + (start < 0 ? 0 : end - start);
}

export class GameAlphaJourneyCommandWriter implements AlphaJourneyCommandWriter {
  constructor(
    private readonly db: AlphaDatabase,
    private readonly operatingRuntime: OperatingRuntime,
    private readonly configuration: AlphaJourneyAuthorityConfiguration,
    private readonly publishRuntimeEvents?: (events: readonly OperatingRuntimeEvent[]) => Promise<void> | void,
  ) {}

  private async startPackageSlotForAccount(
    db: AlphaDatabase,
    worldId: string,
    accountId: string,
  ): Promise<{ readonly slot: StartPackageAuthoritySlot; readonly operatorExists: boolean }> {
    const slots = this.configuration.startPackageSlots.filter((candidate) => candidate.worldId === worldId);
    if (slots.length === 0) {
      throw new AlphaConflictError("Kein autoritativ vorbereitetes Startpaket ist fuer diese Welt konfiguriert.", "start_package_capacity_exhausted");
    }
    const [grant, accountOperators] = await Promise.all([
      db.select({ operatorId: onboardingGrants.operatorId }).from(onboardingGrants).where(and(
        eq(onboardingGrants.worldId, worldId),
        eq(onboardingGrants.accountId, accountId),
        eq(onboardingGrants.revoked, false),
      )).limit(1),
      db.select({ id: operators.id }).from(operators).where(and(
        eq(operators.worldId, worldId),
        eq(operators.foundingAccountId, accountId),
      )),
    ]);
    const accountOperatorIds = new Set(accountOperators.map((operator) => operator.id));
    if (grant[0] !== undefined) {
      const grantedSlot = slots.find((candidate) => candidate.operatorId === grant[0]!.operatorId);
      if (grantedSlot === undefined || !accountOperatorIds.has(grantedSlot.operatorId)) {
        throw new AlphaConflictError("Persistiertes Tutorial-Startpaket stimmt nicht mit den vorbereiteten Slots ueberein.", "start_package_release_mismatch");
      }
      return { slot: grantedSlot, operatorExists: true };
    }
    const assignedSlot = slots.find((candidate) => accountOperatorIds.has(candidate.operatorId));
    if (assignedSlot !== undefined) return { slot: assignedSlot, operatorExists: true };

    const usedOperatorIds = new Set((await db.select({ id: operators.id }).from(operators)
      .where(eq(operators.worldId, worldId))).map((operator) => operator.id));
    const freeSlot = slots.find((candidate) => !usedOperatorIds.has(candidate.operatorId));
    if (freeSlot === undefined) {
      throw new AlphaConflictError("Kein autoritativ vorbereitetes Startpaket ist mehr frei.", "start_package_capacity_exhausted");
    }
    return { slot: freeSlot, operatorExists: false };
  }

  async resetTutorial(command: TutorialResetCommand): Promise<void> {
    if (
      command.schemaVersion !== ALPHA_TUTORIAL_RESET_COMMAND_SCHEMA
      || !Number.isSafeInteger(command.resetNumber)
      || command.resetNumber < 0
      || !Number.isSafeInteger(command.atS)
      || command.atS < 0
    ) {
      throw new Error("Tutorialreset-Kommando ist ungueltig.");
    }
    const write = async (tx: AlphaDatabase): Promise<void> => {
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${command.worldId} for update`);
      const [profile, account] = await Promise.all([
        tx.select({
          profileKind: alphaWorldProfiles.profileKind,
          profileState: alphaWorldProfiles.state,
          accelerationFactor: alphaWorldProfiles.accelerationFactor,
          worldKind: worlds.worldKind,
          rankingStatus: worlds.rankingStatus,
          lifecycleStatus: worlds.lifecycleStatus,
        }).from(alphaWorldProfiles)
          .innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId))
          .where(eq(alphaWorldProfiles.worldId, command.worldId))
          .limit(1),
        tx.select().from(accounts).where(and(eq(accounts.worldId, command.worldId), eq(accounts.id, command.accountId))).limit(1),
      ]);
      if (
        profile[0]?.profileKind !== "tutorial"
        || profile[0].profileState !== "running"
        || profile[0].accelerationFactor <= 1
        || profile[0].worldKind !== "private"
        || profile[0].rankingStatus !== "unranked"
        || profile[0].lifecycleStatus !== "active"
        || account[0] === undefined
        || account[0].erasedAt !== null
      ) {
        throw new AlphaConflictError("Tutorialreset ist nur fuer ein aktives Konto in einer beschleunigten Tutorial-Welt erlaubt.", "not_tutorial_world");
      }
      const priorEvents = await tx.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
        eq(domainEvents.worldId, command.worldId),
        eq(domainEvents.eventType, "alpha.tutorial-session-seeded"),
      ));
      if (priorEvents.some((event) => payloadCommandId(event.payload) === command.commandId)) return;
      const assignment = await this.startPackageSlotForAccount(tx as unknown as AlphaDatabase, command.worldId, command.accountId);
      if (!assignment.operatorExists) {
        await tx.insert(operators).values({
          id: assignment.slot.operatorId,
          worldId: command.worldId,
          foundingAccountId: command.accountId,
          name: assignment.slot.operatorName,
        });
      }
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, command.worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const [world] = await tx.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, command.worldId)).limit(1);
      if (world === undefined) throw new Error("Tutorial-Welt fehlt.");
      const economy = await loadEconomyWorldState(tx as unknown as EconomyDatabase, command.worldId);
      if (economy === undefined) throw new AlphaConflictError("Tutorial-Wirtschaftswelt ist nicht gestartet.", "tutorial_economy_unavailable");
      const [rentalContracts, heldVehicles, activePrograms, fleetCheckpoint] = await Promise.all([
        tx.select({ id: operatorContracts.id }).from(operatorContracts).where(and(
          eq(operatorContracts.worldId, command.worldId),
          eq(operatorContracts.contractType, "vehicle-rental"),
          or(eq(operatorContracts.offerorOperatorId, assignment.slot.operatorId), eq(operatorContracts.offereeOperatorId, assignment.slot.operatorId)),
          inArray(operatorContracts.status, ["accepted", "active", "completed"]),
        )),
        tx.select({ id: vehicleAssets.vehicleId }).from(vehicleAssets).where(and(
          eq(vehicleAssets.worldId, command.worldId), eq(vehicleAssets.holderOperatorId, assignment.slot.operatorId),
        )),
        tx.select({ id: operatingProgramVersions.id }).from(operatingProgramVersions).where(and(
          eq(operatingProgramVersions.worldId, command.worldId),
          eq(operatingProgramVersions.operatorId, assignment.slot.operatorId),
          eq(operatingProgramVersions.status, "active"),
        )),
        loadFleetProducerCheckpoint(tx as unknown as EconomyDatabase, command.worldId),
      ]);
      const evidenceBoundary = Object.freeze({
        schemaVersion: "zugfolge-tutorial-evidence-boundary/v1" as const,
        bidIds: Object.freeze([...economy.tenders.values()].flatMap((entry) => entry.bids)
          .filter((bid) => bid.operatorId === assignment.slot.operatorId).map((bid) => bid.id).sort()),
        rentalContractIds: Object.freeze(rentalContracts.map(({ id }) => id).sort()),
        heldVehicleIds: Object.freeze(heldVehicles.map(({ id }) => id).sort()),
        confirmedPathIds: Object.freeze((fleetCheckpoint?.snapshot.pathReservations ?? [])
          .filter((path) => path.operatorId === assignment.slot.operatorId && path.status === "confirmed")
          .map((path) => path.id).sort()),
        activeProgramIds: Object.freeze(activePrograms.map(({ id }) => id).sort()),
      });
      const seeded = seedTutorialAccount(economy, { commandId: command.commandId, accountId: command.accountId });
      await persistEconomyTransition(tx as unknown as EconomyDatabase, {
        expectedRevision: economy.revision,
        state: seeded,
        effects: { notices: [], journal: [] },
        committedAt: world.epoch,
      });
      await tx.insert(domainEvents).values({
        worldId: command.worldId,
        sequence: (head?.sequence ?? 0) + 1,
        eventType: "alpha.tutorial-session-seeded",
        payload: { commandId: command.commandId, accountId: command.accountId, operatorId: assignment.slot.operatorId, resetNumber: command.resetNumber, startedAtS: command.atS, evidenceBoundary },
        occurredAt: new Date(world.epoch.getTime() + command.atS * 1_000),
      });
    };
    if (command.tx !== undefined) {
      await write(command.tx);
    } else {
      await this.db.transaction((tx) => write(tx as unknown as AlphaDatabase));
    }
  }

  async grantStartPackage(command: StartPackageCommand): Promise<StartPackageProof> {
    if (command.schemaVersion !== ALPHA_START_PACKAGE_COMMAND_SCHEMA) throw new Error("Startpaket-Kommando ist ungueltig.");
    const tx = command.tx;
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${command.worldId} for update`);
    const [startPackageWorld] = await tx.select({
      profileKind: alphaWorldProfiles.profileKind,
      profileState: alphaWorldProfiles.state,
      accelerationFactor: alphaWorldProfiles.accelerationFactor,
      worldKind: worlds.worldKind,
      rankingStatus: worlds.rankingStatus,
      lifecycleStatus: worlds.lifecycleStatus,
    }).from(alphaWorldProfiles)
      .innerJoin(worlds, eq(worlds.id, alphaWorldProfiles.worldId))
      .where(eq(alphaWorldProfiles.worldId, command.worldId))
      .limit(1);
    if (
      startPackageWorld?.profileKind !== "tutorial"
      || startPackageWorld.profileState !== "running"
      || startPackageWorld.accelerationFactor <= 1
      || startPackageWorld.worldKind !== "private"
      || startPackageWorld.rankingStatus !== "unranked"
      || startPackageWorld.lifecycleStatus !== "active"
    ) {
      throw new AlphaConflictError(
        "Startpaket ist ausschliesslich in einer laufenden, beschleunigten Tutorial-Welt verfuegbar.",
        "start_package_tutorial_only",
      );
    }
    const priorEvents = await tx.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, command.worldId),
      eq(domainEvents.eventType, "alpha.start-package-authority-committed"),
    ));
    const replay = priorEvents.find((event) => payloadCommandId(event.payload) === command.commandId);
    const replayProof = replay === undefined ? undefined : payloadProof(replay.payload);
    if (replayProof !== undefined) return replayProof;

    const assignment = await this.startPackageSlotForAccount(tx, command.worldId, command.accountId);
    const slot = assignment.slot;
    const [account] = await tx.select().from(accounts).where(and(
      eq(accounts.worldId, command.worldId),
      eq(accounts.id, command.accountId),
      eq(accounts.keycloakSubject, command.keycloakSubject),
    )).limit(1);
    if (account === undefined || account.erasedAt !== null) throw new Error("Startpaketkonto stimmt nicht mit der Keycloak-Identitaet ueberein.");
    if (!assignment.operatorExists) {
      await tx.insert(operators).values({ id: slot.operatorId, worldId: command.worldId, foundingAccountId: command.accountId, name: slot.operatorName });
    }

    const checkpoint = await loadFleetProducerCheckpoint(tx as unknown as EconomyDatabase, command.worldId);
    if (checkpoint === undefined) throw new AlphaConflictError("M5-Flottenwelt ist nicht gestartet.", "start_package_fleet_unavailable");
    const formationIntent = checkpoint.state.formations[slot.formationId];
    const dutyIntent = checkpoint.state.personnelDuties[slot.personnelDutyId];
    const pathIntent = checkpoint.state.pathReservations[slot.pathReservationId];
    const asset = checkpoint.state.authorityRelease.assets.find((candidate) => candidate.id === slot.vehicleId);
    const personnelPool = checkpoint.state.authorityRelease.personnelPools.find((candidate) => candidate.id === command.spec.personnelPoolId);
    const pathReceiptId = pathIntent?.pathReceiptId;
    const pathReceipt = checkpoint.state.authorityRelease.pathReceipts.find((candidate) => candidate.id === pathReceiptId);
    if (
      command.spec.pathWindowId !== slot.pathReservationId
      || formationIntent?.id !== slot.formationId
      || !formationIntent.vehicleIds.includes(slot.vehicleId)
      || dutyIntent?.personnelPoolId !== command.spec.personnelPoolId
      || !dutyIntent.formationIds.includes(slot.formationId)
      || pathIntent?.id !== slot.pathReservationId
      || asset?.operatorId !== slot.operatorId
      || asset.classDesignation !== command.spec.vehicleClass
      || asset.procurementChannel !== "leasing"
      || personnelPool?.operatorId !== slot.operatorId
      || pathReceipt?.operatorId !== slot.operatorId
      || pathReceipt.decision !== "confirmed"
    ) throw new AlphaConflictError("Startpaket-Spezifikation stimmt nicht mit dem gepinnten M5-Release ueberein.", "start_package_release_mismatch");
    const proof = fleetProof(checkpoint.snapshot, slot, command.spec);
    const boundProof: MobilizationProof = Object.freeze({ ...proof, snapshotHash: checkpoint.snapshotHash });
    const economy = await loadEconomyWorldState(tx as unknown as EconomyDatabase, command.worldId);
    if (economy === undefined) throw new AlphaConflictError("Wirtschaftswelt ist nicht gestartet.", "start_package_economy_unavailable");
    const initialized = economy.operatingRuntimeByLot.get(command.spec.emergencyLotId)
      ?? this.operatingRuntime.initialize({
        schemaVersion: OPERATING_INITIALIZE_SCHEMA,
        worldId: command.worldId,
        lots: [{
          lotId: command.spec.emergencyLotId,
          incumbentOperatorId: "public",
          timetableBoundaryS: command.atS,
          trainRuns: slot.trainRunIds.map((trainRunId) => ({ trainRunId, formationId: slot.formationId })),
        }],
      });
    const transition = this.operatingRuntime.applyTransition(initialized.state, {
      schemaVersion: OPERATING_TRANSITION_SCHEMA,
      worldId: command.worldId,
      commandId: `${command.commandId}:operating`,
      expectedStateHash: initialized.stateHash,
      expectedRevision: initialized.state.revision,
      lotId: command.spec.emergencyLotId,
      atS: command.atS,
      winnerOperatorId: slot.operatorId,
      mobilizationProof: boundProof,
      publicVehiclePool: [],
    });
    const granted = grantEmergencyStartPackage(economy, {
      commandId: command.commandId,
      contractId: `${command.commandId}:contract`,
      operatorId: slot.operatorId,
      accountId: command.accountId,
      lotId: command.spec.emergencyLotId,
      at: command.atS,
      until: command.atS + command.spec.durationS,
      maximumTrainKmPerPeriod: command.spec.maximumTrainKmPerPeriod,
      proof: boundProof,
      operatingTransition: transition,
    });
    await persistEconomyTransition(tx as unknown as EconomyDatabase, {
      expectedRevision: economy.revision,
      ...granted,
      committedAt: new Date(command.atS * 1_000),
    });

    const canonical = canonicalizeProgram(template(command.spec, command.worldId, slot.operatorId), {
      worldId: command.worldId,
      operatorId: slot.operatorId,
    });
    let [program] = await tx.select({ id: operatingProgramVersions.id }).from(operatingProgramVersions).where(and(
      eq(operatingProgramVersions.worldId, command.worldId),
      eq(operatingProgramVersions.operatorId, slot.operatorId),
      eq(operatingProgramVersions.version, 1),
    )).limit(1);
    if (program === undefined) {
      [program] = await tx.insert(operatingProgramVersions).values({
        worldId: command.worldId,
        operatorId: slot.operatorId,
        version: 1,
        schema: canonical.program.schema,
        enabled: canonical.program.enabled,
        canonicalProgram: canonical.program,
        checksum: canonical.checksum,
        status: "active",
        createdByAccountId: command.accountId,
        createdAt: new Date(command.atS * 1_000),
        activatedAt: new Date(command.atS * 1_000),
      }).returning({ id: operatingProgramVersions.id });
    }
    if (program === undefined) throw new Error("Start-Betriebsprogramm konnte nicht aktiviert werden.");
    const result: StartPackageProof = Object.freeze({
      operatorId: slot.operatorId,
      lotId: command.spec.emergencyLotId,
      vehicleId: slot.vehicleId,
      vehicleLeaseContractId: slot.vehicleLeaseReceiptId,
      pathReceiptId: slot.pathReservationId,
      personnelPoolId: command.spec.personnelPoolId,
      operatingProgramId: program.id,
      operatingProgramActive: true,
      fleetStateHash: checkpoint.stateHash,
      economyStateHash: alphaHash("zugfolge-economy-state/v1", encodeEconomyValue(granted.state)),
    });
    const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
      .where(eq(domainEvents.worldId, command.worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
    const [world] = await tx.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, command.worldId)).limit(1);
    if (world === undefined) throw new Error("Startpaket-Welt fehlt.");
    await tx.insert(domainEvents).values({
      worldId: command.worldId,
      sequence: (head?.sequence ?? 0) + 1,
      eventType: "alpha.start-package-authority-committed",
      payload: { commandId: command.commandId, accountId: command.accountId, proof: result, runtimeEventIds: transition.events.map((event) => event.eventId) },
      occurredAt: new Date(world.epoch.getTime() + command.atS * 1_000),
    });
    return result;
  }

  async projectCommittedGrant(worldId: string, commandId: string): Promise<void> {
    if (this.publishRuntimeEvents === undefined) return;
    const events = await this.db.select({ eventType: domainEvents.eventType, payload: domainEvents.payload, occurredAt: domainEvents.occurredAt }).from(domainEvents)
      .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence));
    const authority = events.find((event) => event.eventType === "alpha.start-package-authority-committed" && payloadCommandId(event.payload) === commandId);
    if (authority === undefined || typeof authority.payload !== "object" || authority.payload === null || Array.isArray(authority.payload)) return;
    const ids = new Set(stringList((authority.payload as Record<string, unknown>)["runtimeEventIds"], "Startpaket-Runtimeereignisse"));
    const runtimeEvents = events.flatMap((event): OperatingRuntimeEvent[] => {
      if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return [];
      const payload = event.payload as Record<string, unknown>;
      const eventId = payload["runtimeEventId"];
      if (typeof eventId !== "string" || !ids.has(eventId)) return [];
      return [{
        eventId,
        worldId,
        eventType: event.eventType,
        atS: Math.floor(event.occurredAt.getTime() / 1_000),
        payload,
      }];
    });
    await this.publishRuntimeEvents(runtimeEvents.reverse());
  }

  async capacityCells(worldId: string, fromS: number, untilS: number): Promise<readonly CapacityCell[]> {
    const events = await this.db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, worldId),
      eq(domainEvents.eventType, "planning.diagram"),
    )).orderBy(desc(domainEvents.sequence)).limit(1);
    if (events[0] === undefined) return [];
    const projection = parsePlanningProjection(events[0].payload);
    const resources = new Map<string, { readonly qualityClass: "A" | "B" | "C"; intervals: { start: number; end: number }[] }>();
    for (const occupation of projection.occupations) {
      const start = Math.max(fromS, occupation.startS);
      const end = Math.min(untilS, occupation.endS);
      if (end <= start) continue;
      const current = resources.get(occupation.resource.id) ?? { qualityClass: "A" as const, intervals: [] };
      current.intervals.push({ start, end });
      resources.set(occupation.resource.id, current);
    }
    return [...resources.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([resourceId, value]) => ({
      resourceId,
      intervalStartS: fromS,
      intervalEndS: untilS,
      usedSeconds: overlapSeconds(value.intervals),
      capacitySeconds: untilS - fromS,
      qualityClass: value.qualityClass,
      orderable: true,
    }));
  }
}
