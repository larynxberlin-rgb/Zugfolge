import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, operators, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { applyFleetProducerCommand, loadFleetProducerCheckpoint } from "@zugfolge/economy";
import { requestWorldAccess, type IdentityDatabase } from "@zugfolge/identity";
import { FLEET_ASSET_TRANSFER_COMMAND_SCHEMA, FLEET_FORMATION_COMMAND_SCHEMA, type InteriorLayoutV1 } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticator } from "./auth.js";
import { buildApp } from "./app.js";
import { committedInteriorTime, loadConductorInteriorDeployment } from "./conductor-interior-configuration.js";
import { ConductorInteriorService, registerConductorInteriorRoutes } from "./conductor-interior.js";
import { createInteriorNativeFixture, hasInteriorNativeFixture, initializeInteriorFixtureDatabase, interiorFixtureAccess,
  INTERIOR_FIXTURE_OPERATOR as OPERATOR, INTERIOR_FIXTURE_OTHER_OPERATOR as OTHER_OPERATOR,
  INTERIOR_FIXTURE_PERIOD as PERIOD, INTERIOR_FIXTURE_SUBJECT as SUBJECT, INTERIOR_FIXTURE_WORLD as WORLD } from "./conductor-interior.native-fixture.js";

const FOREIGN = "22222222-2222-4222-8222-222222222222";
function httpApp(service?: ConductorInteriorService, log?: string[], db?: IdentityDatabase) {
  const logger = log === undefined ? false : { stream: new Writable({ write(chunk, _encoding, callback) { log.push(String(chunk)); callback(); } }) };
  const verifyToken = async (token: string) => {
    if (token !== SUBJECT && token !== "interior-fixture-other") throw new Error("Ungültiges Prüftoken");
    return { keycloakSubject: token, displayName: "Explizite Prüfanmeldung" };
  };
  if (db !== undefined) return buildApp({ db, conductorInterior: service, verifyToken, logger });
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } }, logger });
  app.decorateRequest("identity", null);
  registerConductorInteriorRoutes(app, { conductorInterior: service, authenticate: createAuthenticator(verifyToken) });
  return app;
}
const url = (hash: string, formation = 1) => `/worlds/${WORLD}/operators/${OPERATOR}/fleet/formations/fixture-interior-formation-${formation}/interior?expectedFleetStateHash=${hash}&periodId=${PERIOD}`;

describe("M15.4: gesperrte Plattformgrenzen ohne nativen Fachersatz", () => {
  it("verlangt vollständig bestätigte weltisolierte Regionalzeit ohne Uhr- oder Nullersatz", () => {
    const expected = [{ worldId: WORLD, regionId: "a" }, { worldId: WORLD, regionId: "b" }];
    const ready = expected.map((region) => ({ ...region, nowMs: 110_000 }));
    expect(committedInteriorTime(WORLD, expected, ready)).toBe(110_000);
    expect(committedInteriorTime(WORLD, [], ready)).toBeUndefined();
    expect(committedInteriorTime(WORLD, expected, ready.slice(1))).toBeUndefined();
    expect(committedInteriorTime(WORLD, expected, [{ ...ready[0]!, worldId: FOREIGN }, ready[1]!])).toBeUndefined();
    expect(committedInteriorTime(WORLD, expected, [ready[0]!, { ...ready[1]!, nowMs: 109_999 }])).toBeUndefined();
    expect(committedInteriorTime(WORLD, expected, ready.map((row) => ({ ...row, nowMs: NaN })))).toBeUndefined();
  });

  it("weist Zugang, fremdes EVU und Archiv vor Flotten- und Geometriezugriff ab", async () => {
    const client = new PGlite(), db = drizzle(client, { schema });
    const verify = vi.fn((): never => { throw new Error("Flottenkern darf nicht laufen"); });
    const build = vi.fn((): never => { throw new Error("Innenraumkern darf nicht laufen"); });
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await initializeInteriorFixtureDatabase(db);
      await db.insert(worlds).values({ id: FOREIGN, name: "Andere Testwelt", schedulePeriodWeeks: 3, epoch: new Date(0) });
      await requestWorldAccess(db, { worldId: FOREIGN, keycloakSubject: SUBJECT, displayName: "Anderer Weltzugang" });
      const service = new ConductorInteriorService({ db, fleetRuntime: { verifyFleetWorldState: verify }, interiorRuntime: { build },
        deployment: { period: () => undefined }, committedTimeForWorld: () => undefined });
      const access = { worldId: WORLD, operatorId: OPERATOR, keycloakSubject: SUBJECT, formationId: "fixture-interior-formation-1", periodId: PERIOD, expectedFleetStateHash: "a".repeat(64) };
      await expect(service.layout({ ...access, keycloakSubject: "no-access" })).rejects.toMatchObject({ statusCode: 403, telemetry: undefined });
      await expect(service.layout({ ...access, keycloakSubject: "interior-fixture-other" })).rejects.toMatchObject({ statusCode: 403, telemetry: undefined });
      await expect(service.layout({ ...access, worldId: FOREIGN })).rejects.toMatchObject({ statusCode: 403 });
      await db.update(operators).set({ lifecycle: "exited" }).where(and(eq(operators.worldId, WORLD), eq(operators.id, OPERATOR)));
      await expect(service.layout(access)).rejects.toMatchObject({ statusCode: 403 });
      await db.update(worlds).set({ lifecycleStatus: "archived" }).where(eq(worlds.id, WORLD));
      await expect(service.layout(access)).rejects.toMatchObject({ statusCode: 409 });
      expect(verify).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
    } finally { await client.close(); }
  }, 30_000);

  it("meldet fehlende Einrichtung sichtbar und entfernt private Datenbankfehler", async () => {
    const app = httpApp();
    try {
      expect((await app.inject({ url: url("a".repeat(64)) })).statusCode).toBe(401);
      const disabled = await app.inject({ url: url("a".repeat(64)), headers: { authorization: `Bearer ${SUBJECT}` } });
      expect(disabled.statusCode).toBe(503); expect(disabled.json().code).toBe("interior_disabled");
      const invalid = await app.inject({ url: `${url("a".repeat(64))}&geometryPolicy=private-marker`, headers: { authorization: `Bearer ${SUBJECT}` } });
      expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain("private-marker");
      const marker = "private-account private-formation secret-db-parameter";
      const db = { transaction: () => { throw Object.assign(new Error(marker), { params: [marker], cause: new Error(marker) }); } } as unknown as IdentityDatabase;
      const service = new ConductorInteriorService({ db, fleetRuntime: { verifyFleetWorldState: () => { throw new Error(marker); } },
        interiorRuntime: { build: () => { throw new Error(marker); } }, deployment: { period: () => undefined }, committedTimeForWorld: () => undefined });
      const error = await service.layout({ worldId: WORLD, operatorId: OPERATOR, keycloakSubject: SUBJECT, formationId: "formation", periodId: PERIOD,
        expectedFleetStateHash: "a".repeat(64) }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ statusCode: 503, code: "interior_unavailable" });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("private-");
      expect(error).not.toHaveProperty("cause"); expect(error).not.toHaveProperty("params");
    } finally { await app.close(); }
  });
});

// Linux nutzt das produktive NAPI-Addon; Windows führt dieselben Rust-Funktionen per JSON-Beispiel aus.
describe.skipIf(!hasInteriorNativeFixture)("M15.4: echter Compiler → native M5-Kommandos → DB → autorisierter Innenraum", () => {
  it("liefert drei vollständige Konfigurationen über HTTP, bindet den Grafikbeweis und restauriert identische Layouts", async () => {
    const fixture = await createInteriorNativeFixture(), log: string[] = [], app = httpApp(fixture.service, log, fixture.db);
    let restoredClient: PGlite | undefined;
    try {
      expect(fixture.checkpoint.state.revision).toBe(3);
      const layouts: InteriorLayoutV1[] = [];
      for (let number = 1; number <= 3; number++) {
        const response = await app.inject({ url: url(fixture.checkpoint.stateHash, number), headers: { authorization: `Bearer ${SUBJECT}` } });
        expect(response.statusCode, response.body).toBe(200);
        const layout = response.json<InteriorLayoutV1>(), asset = fixture.compiled.authority.assets[number - 1]!;
        expect(layout.vehicles[0]?.configuration).toEqual(asset.vehicleConfiguration);
        expect(layout.passengerPlaces.filter((place) => place.kind === "seat")).toHaveLength(asset.passenger.seats);
        expect(layout.seats).toHaveLength(asset.passenger.seats);
        expect(new Set(layout.seats.map((seat) => seat.placeId)).size).toBe(asset.passenger.seats);
        expect(layout.seats.every((seat) => layout.obstacles.some((obstacle) => obstacle.obstacleId === seat.obstacleId && obstacle.kind === "seat"))).toBe(true);
        expect(layout.passengerPlaces.filter((place) => place.kind === "standing")).toHaveLength(asset.vehicleConfiguration!.interior.multipurpose.standing);
        expect(layout.binding).toMatchObject({ worldId: WORLD, operatorId: OPERATOR, formationRevision: 3,
          fleetStateHash: fixture.checkpoint.stateHash, fleetAuthorityReleaseHash: fixture.checkpoint.state.authorityReleaseHash,
          mobilizationSnapshotHash: fixture.checkpoint.snapshotHash, artManifestHash: fixture.signed.document.periods[0]!.artPin.manifestSha256 });
        expect(new Set(layout.passengerPlaces.map((place) => place.placeId)).size).toBe(layout.passengerPlaces.length);
        expect(layout.doors).toHaveLength(asset.vehicleConfiguration!.structural.doorCountPerSide * 2);
        layouts.push(layout);
      }
      expect(layouts[0]!.vehicles[0]!.bodies.every((body) => body.deckIds.length === 1)).toBe(true);
      expect(layouts[1]!.vehicles[0]!.bodies.every((body) => body.deckIds.length === 2)).toBe(true);
      expect(layouts[1]!.edges.some((edge) => edge.kind === "stair")).toBe(true);
      expect(layouts.every((layout) => layout.edges.some((edge) => edge.kind === "gangway"))).toBe(true);
      const unauthorized = await app.inject({ url: url(fixture.checkpoint.stateHash), headers: { authorization: "Bearer interior-fixture-other" } });
      expect(unauthorized.statusCode).toBe(403); expect(unauthorized.body).not.toContain("fixture-interior-vehicle");
      const injected = await app.inject({ url: `${url(fixture.checkpoint.stateHash)}&nowMs=0&geometryPolicy=private-marker`, headers: { authorization: `Bearer ${SUBJECT}` } });
      expect(injected.statusCode).toBe(400); expect(injected.body).not.toContain("private-marker");
      const access = interiorFixtureAccess(fixture.checkpoint);
      await expect(fixture.service.layout({ ...access, expectedFleetStateHash: "a".repeat(64) })).rejects.toMatchObject({ code: "interior_fleet_stale" });
      await expect(fixture.service.layout({ ...access, periodId: "previous-period" })).rejects.toMatchObject({ code: "interior_period_stale" });
      fixture.clock.nowMs = 400_000;
      await expect(fixture.service.layout(access)).rejects.toMatchObject({ code: "interior_period_stale" });
      fixture.clock.nowMs = 110_000;
      const noCommittedTime = new ConductorInteriorService({ ...fixture.dependencies, committedTimeForWorld: () => undefined });
      await expect(noCommittedTime.layout(access)).rejects.toMatchObject({ code: "interior_unavailable" });

      const image = await fixture.client.dumpDataDir();
      restoredClient = new PGlite({ loadDataDir: image });
      const restoredDb = drizzle(restoredClient, { schema });
      expect(await loadFleetProducerCheckpoint(restoredDb, WORLD)).toEqual(fixture.checkpoint);
      const restored = new ConductorInteriorService({ ...fixture.dependencies, db: restoredDb });
      for (let number = 1; number <= 3; number++) expect(await restored.layout(interiorFixtureAccess(fixture.checkpoint, number))).toEqual(layouts[number - 1]);
      await restoredDb.update(operators).set({ lifecycle: "exited" }).where(and(eq(operators.worldId, WORLD), eq(operators.id, OPERATOR)));
      await expect(restored.layout(access)).rejects.toMatchObject({ statusCode: 403 });

      const events = log.flatMap((chunk) => chunk.trim().split("\n").map((line) => JSON.parse(line))).filter((event) => event.event === "conductor_interior_result");
      expect(events.filter((event) => event.outcome === "built")).toHaveLength(3);
      expect(events.find((event) => event.code === "interior_built")).toMatchObject({ worldId: WORLD, periodId: PERIOD, formationRevision: 3 });
      expect(events.find((event) => event.code === "interior_access_denied")).not.toHaveProperty("worldId");
      expect(JSON.stringify(events)).not.toContain("private-marker");
      expect(JSON.stringify(events)).not.toContain(SUBJECT);

      // Geänderte Datei-/Welt-/Schlüsselbelege dürfen keinen Atlaszugriff erzeugen.
      const input = fixture.signed.input, original = readFileSync(input.path);
      writeFileSync(input.path, Buffer.concat([original, Buffer.from(" ")]));
      await expect(loadConductorInteriorDeployment(input)).rejects.toThrow("Innenraumdeployment");
      writeFileSync(input.path, original);
      await expect(loadConductorInteriorDeployment({ ...input, worldId: FOREIGN })).rejects.toThrow("Innenraumdeployment");
      const document = structuredClone(fixture.signed.document);
      document.periods[0]!.artSignature.keyId = "untrusted-test-key";
      writeFileSync(input.path, JSON.stringify(document));
      await expect(loadConductorInteriorDeployment({ ...input, expectedSha256: createHash("sha256").update(readFileSync(input.path)).digest("hex") })).rejects.toThrow("Innenraumdeployment");
      document.periods[0]!.artSignature = fixture.signed.document.periods[0]!.artSignature;
      document.periods[0]!.geometryPolicyHash = "a".repeat(64);
      writeFileSync(input.path, JSON.stringify(document));
      const wrongGeometry = await loadConductorInteriorDeployment({ ...input, expectedSha256: createHash("sha256").update(readFileSync(input.path)).digest("hex") });
      await expect(new ConductorInteriorService({ ...fixture.dependencies, deployment: wrongGeometry }).layout(access)).rejects.toMatchObject({ statusCode: 409, code: "interior_policy_hash_mismatch" });
    } finally { await app.close(); await restoredClient?.close(); await fixture.client.close(); }
  }, 60_000);

  it("meldet ein konkret fehlendes eigenes M5-Asset und bestätigt dennoch dessen vorhandenen Flottenzustand", async () => {
    const fixture = await createInteriorNativeFixture({ missingConfigurationVehicleId: "fixture-interior-vehicle-1" });
    try {
      expect(fixture.runtimes.fleet.verifyFleetWorldState(fixture.checkpoint.state, fixture.checkpoint.stateHash).stateHash).toBe(fixture.checkpoint.stateHash);
      await expect(fixture.service.layout(interiorFixtureAccess(fixture.checkpoint))).rejects.toMatchObject({ statusCode: 409,
        code: "interior_configuration_missing", vehicleId: "fixture-interior-vehicle-1" });
      await expect(fixture.service.layout({ ...interiorFixtureAccess(fixture.checkpoint), keycloakSubject: "interior-fixture-other" })).rejects.toMatchObject({ statusCode: 403, vehicleId: undefined });
      expect((await fixture.service.layout(interiorFixtureAccess(fixture.checkpoint, 2))).capacity.standardSeats).toBe(184);
    } finally { await fixture.client.close(); }
  }, 60_000);

  it("bindet einen echten Halterwechsel an den neuen Eigentümer und verweigert historische Autoritätsrechte", async () => {
    const fixture = await createInteriorNativeFixture({ form: false });
    try {
      const transfer = await applyFleetProducerCommand({ db: fixture.db, runtime: fixture.runtimes.fleet, ingestedAt: new Date(101_000), command: {
        schemaVersion: FLEET_ASSET_TRANSFER_COMMAND_SCHEMA, worldId: WORLD, commandId: "interior-fixture-transfer",
        expectedStateHash: fixture.checkpoint.stateHash, expectedRevision: 0, atS: 101, vehicleId: "fixture-interior-vehicle-1", transferType: "sale",
        fromOwnerOperatorId: OPERATOR, toOwnerOperatorId: OTHER_OPERATOR, fromHolderOperatorId: OPERATOR, toHolderOperatorId: OTHER_OPERATOR,
        lessorOperatorId: null, contractId: null, validUntilS: null, transferReceiptHash: "9".repeat(64) } });
      const formed = await applyFleetProducerCommand({ db: fixture.db, runtime: fixture.runtimes.fleet, ingestedAt: new Date(102_000), command: {
        schemaVersion: FLEET_FORMATION_COMMAND_SCHEMA, worldId: WORLD, commandId: "interior-fixture-new-holder-formation",
        expectedStateHash: transfer.stateHash, expectedRevision: 1, atS: 102, formationId: "fixture-interior-formation-1",
        vehicleIds: ["fixture-interior-vehicle-1"], pathReceiptId: "fixture-path-other" } });
      expect(formed.state.authorityRelease.assets[0]!.operatorId).toBe(OPERATOR);
      expect(formed.state.assetHoldings?.["fixture-interior-vehicle-1"]?.holderOperatorId).toBe(OTHER_OPERATOR);
      const checkpoint = (await loadFleetProducerCheckpoint(fixture.db, WORLD))!;
      const access = interiorFixtureAccess(checkpoint);
      await expect(fixture.service.layout(interiorFixtureAccess(fixture.checkpoint))).rejects.toMatchObject({ code: "interior_fleet_stale" });
      await expect(fixture.service.layout(access)).rejects.toMatchObject({ statusCode: 404, code: "interior_formation_missing" });
      const current = await fixture.service.layout({ ...access, operatorId: OTHER_OPERATOR, keycloakSubject: "interior-fixture-other" });
      expect(current.binding.operatorId).toBe(OTHER_OPERATOR);
      expect(current.vehicles[0]!.vehicleId).toBe("fixture-interior-vehicle-1");
    } finally { await fixture.client.close(); }
  }, 60_000);
});
