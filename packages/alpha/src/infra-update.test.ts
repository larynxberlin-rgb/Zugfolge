import { generateKeyPairSync, sign } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, alphaWorldProfiles, domainEvents, gameAdminRequests, infraReleaseChanges, odooCommandQueue, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { alphaHash } from "./hash.js";
import { InfraUpdateService, type InfraActivationSafety } from "./infra-update.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const VALID_FROM = new Date("2026-01-22T00:00:00.000Z");
const OLD = "a".repeat(64);

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(worlds).values({ id: WORLD, name: "Infra-Testwelt", schedulePeriodWeeks: 3, epoch: EPOCH });
  await db.insert(alphaWorldProfiles).values({
    worldId: WORLD, profileKind: "test", regionId: "mitteldeutschland-b", regionVariant: "B",
    worldSeed: 42n, accelerationFactor: 60, infraReleaseHash: OLD,
    timetableReleaseHash: "b".repeat(64), fleetReleaseHash: "c".repeat(64), economyReleaseHash: "d".repeat(64),
    blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v1" }, blueprintHash: "e".repeat(64),
    currentPeriod: 0, state: "running", startedAtS: 0,
  });
});

afterEach(async () => client.close());

async function approvedRequest(releaseHash: string) {
  const [queue] = await db.insert(odooCommandQueue).values({
    eventId: `infra-${releaseHash.slice(0, 12)}`, worldId: WORLD, commandType: "admin.infra_release_adoption",
    actorReference: "odoo-admin", payload: {}, correlationId: `corr-${releaseHash.slice(0, 12)}`,
    status: "accepted", receivedAt: EPOCH,
  }).returning();
  const [request] = await db.insert(gameAdminRequests).values({
    worldId: WORLD, commandId: queue!.id, actionType: "infra_release_adoption", riskClass: "high",
    requesterReference: "one", approverReference: "two", reason: "Jaehrlicher Fahrplanwechsel",
    effectPreview: { releaseHash }, state: "approved", correlationId: queue!.correlationId,
  }).returning();
  return request!;
}

describe("M9.10 InfraRelease-Uebernahme", () => {
  it("trennt signierte Kandidatenstufe von Odoo-Freigabe und aktiviert exakt am naechsten Periodenwechsel", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest = { schema: "zugfolge-infra-release-manifest/v1", region: "mitteldeutschland-b", year: 2027, blocks: 1200 };
    const releaseHash = alphaHash("zugfolge-infra-release-manifest/v1", manifest);
    const safety: InfraActivationSafety = { verify: async () => ({
      safe: true, conflictCount: 0, invalidPathCount: 0, invalidCirculationCount: 0, invalidContractCount: 0,
      invariantOneProofHash: "f".repeat(64), explanation: "Konfliktfrei gegen aktiven Bindungsstand.",
    }) };
    const service = new InfraUpdateService(db, { "release-owner-2027": publicPem }, safety);
    const candidate = await service.stageCandidate({
      worldId: WORLD, releaseId: "infra-md-b-2027", predecessorHash: OLD, timetableYear: 2027,
      validFrom: VALID_FROM, validUntil: new Date("2027-12-31T23:59:59.000Z"), manifest,
      coverageReport: { classASections: 900, classBSections: 250, classCSections: 50, orderableClassCSections: 0 },
      rightsReport: { approved: true, sourceIds: ["osm-geofabrik-2026-08", "e22-infra-master-2027"] },
      deviationReport: { unresolved: 0 }, impactPreview: { paths: 200, circulations: 25, contracts: 4 },
      signature: { algorithm: "ed25519", keyId: "release-owner-2027", signedHash: releaseHash, valueBase64: sign(null, Buffer.from(releaseHash, "utf8"), keys.privateKey).toString("base64") },
      activateAtPeriod: 1,
    });
    expect(candidate).toMatchObject({ status: "validated", requestedByAdminRequestId: null, releaseHash });
    const request = await approvedRequest(releaseHash);
    const scheduled = await service.approveStagedAt(WORLD, releaseHash, request.id, VALID_FROM);
    expect(scheduled).toMatchObject({ status: "scheduled", requestedByAdminRequestId: request.id, activateAtPeriod: 1 });
    const activated = await service.activateAtPeriodBoundary(WORLD, 1, 3 * 7 * 86_400);
    expect(activated).toMatchObject({ status: "activated", releaseHash });
    const [profile] = await db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, WORLD));
    expect(profile).toMatchObject({ currentPeriod: 1, infraReleaseHash: releaseHash });
    const [event] = await db.select().from(domainEvents).where(eq(domainEvents.eventType, "infrastructure.release-activated"));
    expect(event?.payload).toMatchObject({ releaseHash, predecessorHash: OLD, invariantOneProofHash: "f".repeat(64), adminRequestId: request.id });
  });

  it("weist Klasse C als bestellbar bereits vor Signatur- und Odoo-Wirkung ab", async () => {
    const keys = generateKeyPairSync("ed25519");
    const service = new InfraUpdateService(db, { owner: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, { verify: async () => { throw new Error("darf nicht laufen"); } });
    const manifest = { region: "mitteldeutschland-b" };
    const releaseHash = alphaHash("zugfolge-infra-release-manifest/v1", manifest);
    await expect(service.stageCandidate({
      worldId: WORLD, releaseId: "bad", predecessorHash: OLD, timetableYear: 2027,
      validFrom: VALID_FROM, validUntil: new Date("2027-12-31T23:59:59.000Z"), manifest,
      coverageReport: { classASections: 1, classBSections: 1, classCSections: 1, orderableClassCSections: 1 },
      rightsReport: { approved: true, sourceIds: ["source"] }, deviationReport: {}, impactPreview: {},
      signature: { algorithm: "ed25519", keyId: "owner", signedHash: releaseHash, valueBase64: sign(null, Buffer.from(releaseHash), keys.privateKey).toString("base64") }, activateAtPeriod: 1,
    })).rejects.toThrow(/Klasse C|Qualitaetsklasse C/);
    expect(await db.select().from(infraReleaseChanges)).toHaveLength(0);
  });
});
