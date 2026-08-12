import { PGlite } from "@electric-sql/pglite";
import { OnboardingService } from "@zugfolge/alpha";
import {
  alphaWorldProfiles,
  domainEvents,
  fleetWorldCheckpoints,
  MIGRATIONS_FOLDER,
  onboardingGrants,
  operatingProgramVersions,
  operators,
  worldAccesses,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  buildEconomyRelease,
  createFleetMobilizationEnvelope,
  loadEconomyWorldState,
  persistEconomyTransition,
  persistFleetMobilizationSnapshot,
  startEconomyWorld,
  type FleetMobilizationSnapshot,
} from "@zugfolge/economy";
import type { KeycloakAdminClient } from "@zugfolge/identity";
import type { OperatingRuntime, OperatingRuntimeEvent } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAlphaInvitationAdminHandlers } from "./alpha-invitation-admin.js";
import { AuthoritativeOnboardingPort } from "./alpha-journey-adapters.js";
import { GameAlphaJourneyCommandWriter } from "./alpha-journey-writer.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000081";
const TUTORIAL_WORLD_ID = "00000000-0000-4000-8000-000000000083";
const OPERATOR_ID = "00000000-0000-4000-8000-000000000082";
const SUBJECT = "kc-odoo-invited-external";
const SPEC = {
  schemaVersion: "zugfolge-start-package/v1" as const,
  version: "alpha-2026-08",
  emergencyLotId: "starter-lot-1",
  maximumTrainKmPerPeriod: 1_000,
  vehicleClass: "Mireo",
  maximumVehicleValueCents: 900_000_000n,
  durationS: 86_400,
  pathWindowId: "starter-path-1",
  personnelPoolId: "starter-pool-1",
  operatingProgramTemplateId: "balanced",
};

function economyRelease() {
  return buildEconomyRelease({
    version: "alpha-2026-08",
    rates: {
      trackPerTrainKmCents: 100n, stationPerStopCents: 20n, facilityPerHourCents: 50n,
      energyPerKwhCents: 30n, personnelPerHourCents: 4_000n, administrationPerPeriodCents: 10_000n,
      vehiclePerPeriodCents: 100_000n, overnightStablingPerPeriodCents: 20_000n,
      protectionEquipmentPerPeriodCents: 5_000n, lateInterestBasisPoints: 500,
    },
    rules: {
      qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 10,
      pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 100,
      requirementFocusMaximumPoints: 1_000, contractBonusCentsPerPeriod: 100_000n,
      penaltyRates: { punctuality: 1n, cancellation: 1_000n, seats: 10n, connections: 100n },
      penaltyFocusMultiplierBasisPoints: 20_000, publicOperationSurchargeBasisPoints: 2_000,
      failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400,
    },
    tenderProfiles: [
      { id: "price", weights: { price: 7_000, quality: 3_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 500 },
      { id: "quality", weights: { price: 3_000, quality: 7_000 }, requirementFocus: "comfort", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 500 },
    ],
  });
}

function fleetSnapshot(): FleetMobilizationSnapshot {
  return {
    schema: "zugfolge-fleet-mobilization/v1", worldId: WORLD_ID, revision: 0, producedAt: 0,
    formations: [{
      id: "starter-formation-1", operatorId: OPERATOR_ID, vehicleIds: ["starter-vehicle-1"], serviceLineIds: ["S1"],
      availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: 1_000_000,
      characteristics: {
        seats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2,
        equipment: ["passenger-information"], vehicleAgeYears: 1, maximumSpeedKph: 160,
        operatingCostCentsPerTrainKm: 700, homologatedLineIds: ["S1"], maintenanceValidUntil: 1_000_000,
        traction: "electric", replacementPlan: true,
      },
    }],
    personnelDuties: [{ id: "starter-duty-1", operatorId: OPERATOR_ID, formationIds: ["starter-formation-1"], status: "ready", validFrom: 0, validUntil: 1_000_000 }],
    pathReservations: [{ id: "starter-path-1", operatorId: OPERATOR_ID, serviceLineIds: ["S1"], status: "confirmed", validFrom: 0, validUntil: 1_000_000 }],
  };
}

function runtime(): OperatingRuntime {
  return {
    verifyFleetMobilizationSnapshot: () => ({ schemaVersion: "zugfolge-fleet-mobilization-verification/v1", worldId: WORLD_ID, fleetRevision: 0, snapshotHash: "f".repeat(64) }),
    initialize: () => ({ schemaVersion: "zugfolge-operating-world-initialized/v1", state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: WORLD_ID, revision: 0 }, stateHash: "1".repeat(64) }),
    applyTransition: (_state, command) => ({
      schemaVersion: "zugfolge-operating-transition-result/v1",
      state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: WORLD_ID, revision: 1 },
      stateHash: "2".repeat(64), idempotentReplay: false,
      outcome: { lotId: SPEC.emergencyLotId, previousOperatorId: "public", operatorId: OPERATOR_ID, kind: "operator-change", seamless: false, penaltyRequired: false, trainRunIds: ["starter-run-1"], livemapMarker: null },
      events: [
        { eventId: `${command.commandId}:completed`, worldId: WORLD_ID, eventType: "operating-transition-completed", atS: command.atS, payload: { operatorId: OPERATOR_ID, lotId: SPEC.emergencyLotId } },
        { eventId: `${command.commandId}:assigned`, worldId: WORLD_ID, eventType: "train-operation-assigned", atS: command.atS, payload: { operatorId: OPERATOR_ID, trainRunId: "starter-run-1" } },
        { eventId: `${command.commandId}:clear`, worldId: WORLD_ID, eventType: "livemap-operation-cleared", atS: command.atS, payload: { operatorId: OPERATOR_ID, lotId: SPEC.emergencyLotId } },
      ],
    }),
  };
}

describe("eingeladener externer Spieler durchlaeuft das produktive Onboarding", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: WORLD_ID, name: "Alpha", schedulePeriodWeeks: 3, epoch: new Date(0), worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" });
    await db.insert(worlds).values({ id: TUTORIAL_WORLD_ID, name: "Tutorial", schedulePeriodWeeks: 3, epoch: new Date(0), worldKind: "private", rankingStatus: "unranked", lifecycleStatus: "active" });
    await db.insert(alphaWorldProfiles).values({
      worldId: WORLD_ID, profileKind: "public", regionId: "lhe", regionVariant: "B", worldSeed: 9n, accelerationFactor: 1,
      infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64), blueprint: {}, blueprintHash: "e".repeat(64), state: "running",
    });
    await db.insert(alphaWorldProfiles).values({
      worldId: TUTORIAL_WORLD_ID, profileKind: "tutorial", regionId: "lhe", regionVariant: "B", worldSeed: 10n, accelerationFactor: 60,
      infraReleaseHash: "a".repeat(64), timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64),
      economyReleaseHash: "d".repeat(64), blueprint: {}, blueprintHash: "f".repeat(64), state: "running",
    });
    const started = startEconomyWorld({
      worldId: WORLD_ID, seed: 9n, durationMonths: 6, release: economyRelease(),
      lots: Array.from({ length: 8 }, (_, index) => ({ id: index === 0 ? SPEC.emergencyLotId : `public-lot-${index}`, size: 10 - index, attractiveness: index })), authorityBudgets: [], accounts: [],
      publicVehiclePoolByLot: { [SPEC.emergencyLotId]: ["public-reserve-1"] },
    });
    await persistEconomyTransition(db, { expectedRevision: null, ...started, committedAt: new Date(0) });
    const envelope = createFleetMobilizationEnvelope(fleetSnapshot());
    await persistFleetMobilizationSnapshot(db, WORLD_ID, envelope, new Date(0));
    await db.insert(fleetWorldCheckpoints).values({
      worldId: WORLD_ID, revision: 0, stateSchema: "zugfolge-fleet-world-state/v2",
      state: {
        schemaVersion: "zugfolge-fleet-world-state/v2", worldId: WORLD_ID, revision: 0, producedAt: 0,
        authorityReleaseHash: "c".repeat(64),
        authorityRelease: {
          schemaVersion: "zugfolge-fleet-authority-release/v1", releaseId: "fleet-alpha", referenceYear: 2026,
          assets: [{
            id: "starter-vehicle-1", numericId: 1, operatorId: OPERATOR_ID, vehicleTypeId: 1, classDesignation: "Mireo",
            tradeName: "Alpha-Mireo", buildYear: 2025, acquisitionYear: 2026, procurementChannel: "leasing",
            approvedLineIds: ["S1"], maintenanceDeadlines: [{ kind: "inspection", dueAt: 1_000_000 }], installedProtection: ["pzb"],
            technical: { lengthMm: 70_000, massKg: 120_000, maximumSpeedKph: 160, traction: "electric", electricSystems: ["ac15kv"], role: "powered-unit" },
            passenger: { seats: 120, firstClassSeats: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, equipment: ["passenger-information"], operatingCostCentsPerTrainKm: 700, replacementPlan: true },
            deliveredAt: 0, retiredAt: 1_000_000,
          }],
          personnelPools: [{ id: SPEC.personnelPoolId, numericId: 1, operatorId: OPERATOR_ID, capacitySeconds: 100_000, minimumRestSeconds: 1_000, classDesignations: ["Mireo"], pathReceiptIds: ["receipt-1"], qualificationHash: "3".repeat(64) }],
          pathReceipts: [{ id: "receipt-1", numericRouteId: 1, operatorId: OPERATOR_ID, serviceLineIds: ["S1"], decision: "confirmed", validFrom: 0, validUntil: 1_000_000, platformLengthsMm: [150_000], electrifications: ["overhead-ac15kv"], requiredProtection: ["pzb"], approvedClasses: ["Mireo"], plannerStateHash: "4".repeat(64), conflictCheckHash: "5".repeat(64) }],
        },
        formations: { "starter-formation-1": { id: "starter-formation-1", vehicleIds: ["starter-vehicle-1"], pathReceiptId: "receipt-1" } },
        personnelDuties: { "starter-duty-1": { id: "starter-duty-1", personnelPoolId: SPEC.personnelPoolId, formationIds: ["starter-formation-1"], pathReceiptId: "receipt-1", validFrom: 0, validUntil: 1_000_000 } },
        pathReservations: { "starter-path-1": { id: "starter-path-1", pathReceiptId: "receipt-1" } },
      },
      stateHash: "6".repeat(64), snapshotHash: envelope.snapshotHash, commandId: null, commandSchema: null,
      commandJson: null, commandHash: null, producedAt: new Date(0), ingestedAt: new Date(0),
    });
  });

  afterEach(async () => client.close());

  it("bindet Odoo-Request, Keycloak-Subject, Weltkonto und alle autoritativen Projektionen", async () => {
    const keycloak: KeycloakAdminClient = {
      invite: vi.fn(async () => SUBJECT), resend: vi.fn(async () => undefined), disable: vi.fn(async () => undefined),
    };
    const invitations = createAlphaInvitationAdminHandlers({ db, keycloak, redirectUri: "https://game.test/", tutorialWorldId: TUTORIAL_WORLD_ID });
    const invited = await invitations.alpha_invitation_create({
      adminRequestId: "odoo-request-1", commandId: "odoo-command-1", eventId: "odoo-event-1", correlationId: "odoo-correlation-1",
      receivedAt: new Date(0), now: new Date(0),
      payload: {
        kind: "admin.alpha_invitation_create", worldId: WORLD_ID, actionType: "alpha_invitation_create", riskClass: "standard",
        requesterReference: "odoo-admin", reason: "Geschlossene Alpha", effectPreview: {},
        invitation: { requestReference: "INV-1", email: "external@example.test", displayName: "Externer Spieler", role: "player", startPackage: SPEC.version },
      },
    });
    const accountId = invited.result?.["gameAccountReference"];
    expect(typeof accountId).toBe("string");
    expect(typeof invited.result?.["tutorialAccountReference"]).toBe("string");

    const publishRuntimeEvents = vi.fn(async (runtimeEvents: readonly OperatingRuntimeEvent[]) => {
      expect(await db.select().from(onboardingGrants)).toHaveLength(1);
      expect(runtimeEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining([
        "operating-transition-completed", "train-operation-assigned", "livemap-operation-cleared",
      ]));
    });
    const writer = new GameAlphaJourneyCommandWriter(db, runtime(), {
      tutorialOperatorNamePrefix: "Tutorialbahn",
      startPackageSlots: [{
        worldId: WORLD_ID, operatorId: OPERATOR_ID, operatorName: "Alpha Startbahn 1", vehicleId: "starter-vehicle-1",
        formationId: "starter-formation-1", personnelDutyId: "starter-duty-1", pathReservationId: "starter-path-1",
        vehicleLeaseReceiptId: "starter-lease-1", trainRunIds: ["starter-run-1"],
      }],
    }, publishRuntimeEvents);
    const onboarding = new OnboardingService(db, new AuthoritativeOnboardingPort(writer));
    const first = await onboarding.claim(WORLD_ID, SUBJECT, 100, SPEC);
    const replay = await onboarding.claim(WORLD_ID, SUBJECT, 100, SPEC);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(publishRuntimeEvents).toHaveBeenCalledTimes(2);
    expect(first.grant).toMatchObject({ accountId, operatorId: OPERATOR_ID, emergencyLotId: SPEC.emergencyLotId, vehicleId: "starter-vehicle-1" });
    const [economy, storedOperators, grants, programs, events] = await Promise.all([
      loadEconomyWorldState(db, WORLD_ID), db.select().from(operators), db.select().from(onboardingGrants),
      db.select().from(operatingProgramVersions), db.select().from(domainEvents),
    ]);
    expect(economy?.contracts.get(`start-package:${WORLD_ID}:${accountId}:${SPEC.version}:contract`)).toMatchObject({ operatorId: OPERATOR_ID, lotId: SPEC.emergencyLotId });
    expect(economy?.publicOperations.has(SPEC.emergencyLotId)).toBe(false);
    expect(storedOperators).toEqual([expect.objectContaining({ id: OPERATOR_ID, foundingAccountId: accountId })]);
    expect(grants).toHaveLength(1);
    expect(programs).toEqual([expect.objectContaining({ operatorId: OPERATOR_ID, status: "active" })]);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "operating-transition-completed", "train-operation-assigned", "livemap-operation-cleared",
      "alpha.start-package-authority-committed", "alpha.start-package-granted",
    ]));

    await invitations.alpha_invitation_revoke({
      adminRequestId: "odoo-request-2", commandId: "odoo-command-2", eventId: "odoo-event-2", correlationId: "odoo-correlation-2",
      receivedAt: new Date(1_000), now: new Date(1_000),
      payload: {
        kind: "admin.alpha_invitation_revoke", worldId: WORLD_ID, actionType: "alpha_invitation_revoke", riskClass: "standard",
        requesterReference: "odoo-admin", reason: "Alpha-Zugang entziehen", effectPreview: {},
        invitation: { requestReference: "INV-1", email: "external@example.test", displayName: "Externer Spieler", role: "player", keycloakSubject: SUBJECT },
      },
    });
    const accesses = await db.select().from(worldAccesses).where(eq(worldAccesses.keycloakSubject, SUBJECT));
    expect(accesses).toHaveLength(2);
    expect(accesses.every((access) => access.status === "revoked")).toBe(true);
    expect(keycloak.disable).toHaveBeenCalledWith(SUBJECT);
  });
});
