import Fastify from "fastify";
import { expect, it } from "vitest";
import type { ConductorCommandV1 } from "@zugfolge/runtime-native";
import { conductorCommandReceipts, conductorLeases, conductorSnapshots, conductorTrainStates, domainEvents, worldAccesses } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import { createConductorSessionNativeFixture, hasSessionNativeFixture } from "./conductor-session.native-fixture.js";
import { registerConductorSessionRoutes } from "./conductor-session-routes.js";
import { ConductorSessionService } from "./conductor-session-service.js";
import { advanceConductorControlWorld } from "./conductor-session-scheduler.js";

const nativeIt = hasSessionNativeFixture ? it : it.skip;
nativeIt("führt echte M5- und M10-Fakten durch persistente Sitzung, HTTP, Restore, Atlas und Wiederholung", async () => {
  // Dieser Test übt Sitzungsaktionen aus; Geld/Polizei müssen ihren eigenen
  // echten Integrationsadapter erhalten und dürfen hier nicht als Erfolg gelten.
  const fixture = await createConductorSessionNativeFixture({ async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
    async apply(_tx, _context, _state, effects) { if (effects.length) throw new Error("Dieser Sitzungsbeleg erzeugt keine Kontrolleffekte."); } });
  const app = Fastify();
  let subject = fixture.access.keycloakSubject;
  try {
    const clockInputs: number[] = [];
    const scheduler = { db: fixture.db, worldId: fixture.access.worldId, regions: fixture.dependencies.regionBindings(fixture.access.worldId),
      runtime: fixture.dependencies.operationalRuntime, control: { async advanceWorld(_tx: unknown, _worldId: string, nowMs: number) { clockInputs.push(nowMs); } } };
    expect(await advanceConductorControlWorld(scheduler)).toBe(true);
    expect(clockInputs).toEqual([fixture.clock.nowMs]);
    expect(await advanceConductorControlWorld({ ...scheduler, regions: [...scheduler.regions, { regionId: "uncommitted-region", initializationHash: "a".repeat(64) }] })).toBe(false);
    await expect(advanceConductorControlWorld({ ...scheduler, regions: scheduler.regions.map((row) => ({ ...row, initializationHash: "f".repeat(64) })) })).rejects.toThrow("conductor_control_region_pin_mismatch");
    expect(clockInputs).toHaveLength(1); // No invented clock when a region or independent pin is missing.
    app.decorateRequest("identity", null);
    registerConductorSessionRoutes(app, { conductorSessions: fixture.sessions, async authenticate(request) {
      request.identity = { keycloakSubject: subject, displayName: "Integrationstest" };
    } });
    const url = `/worlds/${fixture.access.worldId}/operators/${fixture.access.operatorId}/trains/${fixture.access.trainRunId}/conductor-sessions`;
    const available = await app.inject({ method: "GET", url });
    expect(available.statusCode, available.body).toBe(200);
    const command: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: fixture.access.worldId, trainRunId: fixture.access.trainRunId,
      sessionId: "fixture-session-http", expectedRevision: 0, expectedManifestRevision: null,
      idempotencyKey: "fixture:start-session", action: { type: "start_session" } };
    const started = await app.inject({ method: "POST", url, payload: command });
    expect(started.statusCode, started.body).toBe(200);
    const initial = started.json();
    expect(initial.snapshot.passengers.passengers.length).toBeGreaterThan(0);
    expect(initial.layout.capacity).toMatchObject({ standardSeats: 104, premiumSeats: 16, standardStanding: 40 });
    expect(started.body).not.toMatch(/fareFact|ownerRef|keycloakSubject|dialogueReleases|journeyChainId/u);
    const events = await fixture.db.select().from(domainEvents).where(eq(domainEvents.worldId, fixture.access.worldId));
    expect(events.some((event) => event.eventType === "operations.passenger-stop-departure")).toBe(true);
    const replay = await app.inject({ method: "POST", url, payload: command });
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().receipt).toEqual(initial.receipt);
    expect(await fixture.db.select().from(conductorCommandReceipts)).toHaveLength(1);
    const extraField = await app.inject({ method: "POST", url, payload: { ...command, action: { type: "start_session", fareFact: "invalid" } } });
    expect(extraField.statusCode).toBe(400); expect(await fixture.db.select().from(conductorCommandReceipts)).toHaveLength(1);
    const futureSequence = await fixture.sessions.changes(fixture.access, initial.snapshot.sequence + 1);
    expect(futureSequence.reset).toBe(true); expect(futureSequence.snapshots).toEqual([futureSequence.response.snapshot]);
    expect(await fixture.db.select().from(conductorTrainStates)).toHaveLength(1);
    expect((await fixture.db.select().from(conductorSnapshots)).length).toBeGreaterThan(0);
    const restored = new ConductorSessionService(fixture.dependencies);
    expect((await restored.snapshot(fixture.access)).snapshot.snapshotHash).toBe(initial.snapshot.snapshotHash);
    const art = await app.inject({ method: "GET", url: `${url}/art` });
    expect(art.statusCode, art.body).toBe(200);
    expect(art.json().appearanceVariants).toHaveLength(256); expect(art.body).not.toMatch(/prompt|evidenceId|"path"|reviewer/u);
    const atlas = await app.inject({ method: "GET", url: `${url}/atlas/${art.json().files[0].id}` });
    expect(atlas.statusCode).toBe(200); expect(atlas.headers["content-type"]).toContain("image/png");
    subject = "interior-fixture-other";
    for (const path of ["", "/snapshot", "/art", `/atlas/${art.json().files[0].id}`])
      expect((await app.inject({ method: "GET", url: `${url}${path}` })).statusCode).toBe(403);
    subject = fixture.access.keycloakSubject;
    const changed = await app.inject({ method: "POST", url, payload: { ...command, action: { type: "end_session" } } });
    expect(changed.statusCode).toBe(409);
    const ended = await app.inject({ method: "POST", url, payload: { ...command, idempotencyKey: "fixture:end-session",
      expectedRevision: initial.snapshot.revision, action: { type: "end_session" } } });
    expect(ended.statusCode, ended.body).toBe(200); expect(ended.json().snapshot.status).toBe("ended");
    const second = await app.inject({ method: "POST", url, payload: { ...command, sessionId: "fixture-session-second", idempotencyKey: "fixture:second" } });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().snapshot.revision).toBe(1); // train revision continues; session revision restarts.
    expect((await app.inject({ method: "POST", url, payload: command })).statusCode).toBe(409);
    const current = second.json().snapshot;
    const moves = await Promise.all(["a", "b"].map((id) => app.inject({ method: "POST", url, payload: { ...command,
      sessionId: current.sessionId, idempotencyKey: `fixture:concurrent-${id}`, expectedRevision: current.revision,
      expectedManifestRevision: current.pins.manifestRevision, action: { type: "move", to: current.position, transitionEdgeId: null } } })));
    expect(moves.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    fixture.clock.nowMs = current.leaseUntilMs;
    await fixture.apply("fixture:lease-expiry", { type: "advance-to", atMs: fixture.clock.nowMs }); await fixture.refresh();
    await fixture.sessions.sweepWorld(fixture.access.worldId);
    const [expired] = await fixture.db.select().from(conductorTrainStates);
    expect((expired!.state as { session: { status: string; endReason: string } }).session).toMatchObject({ status: "ended", endReason: "lease_expired" });
    expect(await fixture.db.select().from(conductorLeases)).toHaveLength(0);
    const third = await app.inject({ method: "POST", url, payload: { ...command, sessionId: "fixture-session-third", idempotencyKey: "fixture:third" } });
    expect(third.statusCode, third.body).toBe(200);
    await fixture.db.update(worldAccesses).set({ status: "revoked" }).where(and(eq(worldAccesses.worldId, fixture.access.worldId), eq(worldAccesses.keycloakSubject, subject)));
    expect((await app.inject({ method: "GET", url: `${url}/snapshot` })).statusCode).toBe(403);
    const [revoked] = await fixture.db.select().from(conductorTrainStates);
    expect((revoked!.state as { session: { status: string; endReason: string } }).session).toMatchObject({ status: "ended", endReason: "access_revoked" });
    expect(await fixture.db.select().from(conductorLeases)).toHaveLength(0);
  } finally { await app.close(); await fixture.dispose(); }
}, 120_000);
