import { generateKeyPairSync, sign } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATIONS_FOLDER,
  alphaWorldProfiles,
  gameAdminRequests,
  infraReleaseChanges,
  odooCommandQueue,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import {
  InfraUpdateService,
  type InfraActivationSafety,
  type QualifiedInfraPackageCandidate,
} from "@zugfolge/alpha";
import {
  GameAdminCommandTerminalError,
  processNextOdooCommand,
  type AdminCommandPayload,
  type GameAdminCommandContext,
} from "@zugfolge/commerce";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInfraReleaseAdoptionAdminHandler,
  infraReleaseAdoptionCapability,
  type InfraPackageActivationStore,
} from "./odoo-admin-handlers.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const ADMIN_REQUEST = "71000000-0000-4000-8000-000000000001";
const COMMAND = "72000000-0000-4000-8000-000000000001";
const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const NEXT_PERIOD_START = "2026-01-01T08:24:00.000Z";
const PREDECESSOR_HASH = "a".repeat(64);
const INFRA_RELEASE_HASH = "b".repeat(64);
const PACKAGE_MANIFEST_SHA256 = "c".repeat(64);
const DELIVERY_RELEASE_HASH = "d".repeat(64);
const DELIVERY_KEY_ID = "delivery-2027";
const DELIVERY_KEYS = generateKeyPairSync("ed25519");
const DELIVERY_PUBLIC_KEY = DELIVERY_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const TRUSTED_DELIVERY_KEYS = { [DELIVERY_KEY_ID]: DELIVERY_PUBLIC_KEY };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const candidate: QualifiedInfraPackageCandidate = Object.freeze({
  releaseId: "infra-deutschland-2027.1",
  releaseHash: INFRA_RELEASE_HASH,
  timetableYear: 2027,
  packageManifestSha256: PACKAGE_MANIFEST_SHA256,
  signatureProof: Object.freeze({
    schema: "zugfolge-infra-package-activation-proof/v1",
    deliveryReleaseId: "infra-deutschland-2027.1",
    timetableYear: 2027,
    packageManifestSha256: PACKAGE_MANIFEST_SHA256,
    deliveryReleaseHash: DELIVERY_RELEASE_HASH,
    infraReleaseHash: INFRA_RELEASE_HASH,
    deliveryReleaseBase64: "e30K",
    algorithm: "Ed25519",
    keyId: DELIVERY_KEY_ID,
    valueBase64: sign(null, Buffer.from(DELIVERY_RELEASE_HASH, "hex"), DELIVERY_KEYS.privateKey).toString("base64"),
    signatureStatus: "verified",
    nativeOperationalValidationStatus: "verified",
    operationalStateHash: "e".repeat(64),
  }),
  coverageReport: Object.freeze({
    classASections: 0,
    classBSections: 1,
    classCSections: 0,
    orderableClassCSections: 0,
  }),
  rightsReport: Object.freeze({ approved: true, sourceIds: Object.freeze(["db-infrago", "gtfs-de"]) }),
  deviationReport: Object.freeze({ unresolvedRequired: 0 }),
  impactPreview: Object.freeze({ operationalStateHash: "e".repeat(64) }),
  operationalInfrastructure: Object.freeze({
    schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
    infraReleaseId: "infra-deutschland-2027.1",
    file: "operational-infrastructure-v2.json",
    bytes: 8_192,
    sha256: "f".repeat(64),
    stateHash: "e".repeat(64),
  }),
});

function payload(overrides: Partial<AdminCommandPayload> = {}): AdminCommandPayload {
  return {
    kind: "admin.infra_release_adoption",
    worldId: WORLD,
    actionType: "infra_release_adoption",
    riskClass: "high",
    requesterReference: "odoo-importer",
    approverReference: "odoo-approver",
    reason: "Signierten Jahresrelease zum Periodenwechsel uebernehmen",
    effectPreview: {
      kind: "infra-release",
      importId: "import-2027-1",
      deliveryReleaseId: candidate.releaseId,
      manifestSha256: PACKAGE_MANIFEST_SHA256,
      infraReleaseHash: INFRA_RELEASE_HASH,
    },
    releaseHash: INFRA_RELEASE_HASH,
    requestedPeriodStart: NEXT_PERIOD_START,
    ...overrides,
  };
}

function context(commandPayload: AdminCommandPayload, markEffectApplied?: () => void): GameAdminCommandContext {
  return {
    adminRequestId: ADMIN_REQUEST,
    effectIdempotencyKey: ADMIN_REQUEST,
    commandId: COMMAND,
    eventId: "infra-release-adoption-test",
    correlationId: "infra-release-adoption-correlation",
    receivedAt: EPOCH,
    now: EPOCH,
    payload: commandPayload,
    ...(markEffectApplied === undefined ? {} : { markEffectApplied }),
  };
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Infra-Brueckenwelt", schedulePeriodWeeks: 3, epoch: EPOCH });
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD,
    profileKind: "test",
    regionId: "deutschland-ebo-operational-v2",
    regionVariant: "B",
    worldSeed: 42n,
    accelerationFactor: 60,
    infraReleaseHash: PREDECESSOR_HASH,
    timetableReleaseHash: "1".repeat(64),
    fleetReleaseHash: "2".repeat(64),
    economyReleaseHash: "3".repeat(64),
    blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v1" },
    blueprintHash: "4".repeat(64),
    currentPeriod: 0,
    state: "running",
    startedAtS: 0,
  });
  await db.insert(odooCommandQueue).values({
    id: COMMAND,
    eventId: "infra-release-adoption-test",
    worldId: WORLD,
    commandType: "admin.infra_release_adoption",
    actorReference: "odoo-admin",
    payload: {},
    correlationId: "infra-release-adoption-correlation",
    status: "accepted",
    receivedAt: EPOCH,
  });
  await db.insert(gameAdminRequests).values({
    id: ADMIN_REQUEST,
    worldId: WORLD,
    commandId: COMMAND,
    actionType: "infra_release_adoption",
    riskClass: "high",
    requesterReference: "odoo-importer",
    approverReference: "odoo-approver",
    reason: "Signierten Jahresrelease uebernehmen",
    effectPreview: {},
    state: "dispatched",
    correlationId: "infra-release-adoption-correlation",
  });
});

afterEach(async () => client.close());

describe("Odoo InfraRelease-Paketbruecke", () => {
  it("projiziert die Faehigkeit ohne konfiguriertes Paketstaging als nicht verfuegbar", () => {
    expect(infraReleaseAdoptionCapability(false)).toMatchObject({
      actionType: "infra_release_adoption",
      availability: "unavailable",
    });
    expect(infraReleaseAdoptionCapability(true)).toMatchObject({
      actionType: "infra_release_adoption",
      availability: "available",
    });
  });

  it("laesst den echten Queue-Dispatch durch das exakte dispatched-Gate und lehnt erst am Full-Deployment-Gate ab", async () => {
    await db.delete(gameAdminRequests).where(eq(gameAdminRequests.id, ADMIN_REQUEST));
    await db.update(odooCommandQueue).set({
      payload: payload(),
      status: "pending",
    }).where(eq(odooCommandQueue.id, COMMAND));
    const activationCandidate = vi.fn(async () => candidate);
    const safety: InfraActivationSafety = { verify: vi.fn(async () => ({
      safe: true,
      conflictCount: 0,
      invalidPathCount: 0,
      invalidCirculationCount: 0,
      invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64),
      explanation: "Konfliktfrei.",
    })) };
    const handler = createInfraReleaseAdoptionAdminHandler(
      new InfraUpdateService(db, TRUSTED_DELIVERY_KEYS, safety),
      { activationCandidate },
    );

    await expect(processNextOdooCommand(db, EPOCH, {
      adminHandlers: { infra_release_adoption: handler },
    })).resolves.toEqual({
      id: COMMAND,
      outcome: "rejected",
      code: "infra_hot_activation_requires_full_deployment",
    });

    expect(activationCandidate).toHaveBeenCalledOnce();
    const [request] = await db.select().from(gameAdminRequests).where(eq(gameAdminRequests.commandId, COMMAND));
    expect(request).toMatchObject({
      actionType: "infra_release_adoption",
      state: "failed",
    });
    expect(await db.select().from(infraReleaseChanges).where(eq(infraReleaseChanges.worldId, WORLD)))
      .toHaveLength(0);
    const [queue] = await db.select().from(odooCommandQueue).where(eq(odooCommandQueue.id, COMMAND));
    expect(queue).toMatchObject({
      status: "rejected",
      failureCode: "infra_hot_activation_requires_full_deployment",
    });
  });

  it("bindet Import, Paketmanifest und InfraRelease getrennt, mutiert vor dem Full-Deployment-Cutover aber nichts", async () => {
    const activationCandidate = vi.fn(async () => candidate);
    const packages: InfraPackageActivationStore = { activationCandidate };
    const safety: InfraActivationSafety = { verify: vi.fn(async () => ({
      safe: true,
      conflictCount: 0,
      invalidPathCount: 0,
      invalidCirculationCount: 0,
      invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64),
      explanation: "Konfliktfrei.",
    })) };
    const handler = createInfraReleaseAdoptionAdminHandler(new InfraUpdateService(db, TRUSTED_DELIVERY_KEYS, safety), packages);
    const markEffectApplied = vi.fn();

    await expect(handler(context(payload(), markEffectApplied)))
      .rejects.toMatchObject<GameAdminCommandTerminalError>({
        name: "GameAdminCommandTerminalError",
        code: "infra_hot_activation_requires_full_deployment",
      });
    await expect(handler(context(payload())))
      .rejects.toMatchObject<GameAdminCommandTerminalError>({
        name: "GameAdminCommandTerminalError",
        code: "infra_hot_activation_requires_full_deployment",
      });

    expect(markEffectApplied).not.toHaveBeenCalled();
    expect(activationCandidate).toHaveBeenNthCalledWith(1, "import-2027-1");
    expect(await db.select().from(infraReleaseChanges).where(eq(infraReleaseChanges.worldId, WORLD)))
      .toHaveLength(0);
  });

  it("weist Hashvertauschung vor persistierter Kandidatenanlage terminal ab", async () => {
    const activationCandidate = vi.fn(async () => candidate);
    const handler = createInfraReleaseAdoptionAdminHandler(
      new InfraUpdateService(db, TRUSTED_DELIVERY_KEYS, { verify: async () => { throw new Error("darf nicht laufen"); } }),
      { activationCandidate },
    );
    const command = payload({
      effectPreview: {
        ...payload().effectPreview,
        manifestSha256: INFRA_RELEASE_HASH,
      },
    });

    await expect(handler(context(command))).rejects.toMatchObject<GameAdminCommandTerminalError>({
      name: "GameAdminCommandTerminalError",
      code: "infra_package_binding_invalid",
    });
    expect(activationCandidate).toHaveBeenCalledOnce();
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });

  it("schreibt auch bei einem abweichenden Periodenwunsch vor dem Full-Deployment-Gate keinen Kandidaten", async () => {
    const handler = createInfraReleaseAdoptionAdminHandler(
      new InfraUpdateService(db, TRUSTED_DELIVERY_KEYS, { verify: async () => { throw new Error("darf nicht laufen"); } }),
      { activationCandidate: async () => candidate },
    );

    await expect(handler(context(payload({
      requestedPeriodStart: "2026-01-01T08:24:01.000Z",
    })))).rejects.toMatchObject<GameAdminCommandTerminalError>({
      name: "GameAdminCommandTerminalError",
      code: "infra_hot_activation_requires_full_deployment",
    });
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });
});
