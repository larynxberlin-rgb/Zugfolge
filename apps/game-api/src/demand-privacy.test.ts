import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, operators, worldAccesses, worlds } from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { requestWorldAccess } from "@zugfolge/identity";
import type { LivemapReadModel } from "@zugfolge/livemap-stream";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify, { type InjectOptions } from "fastify";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerDemandRoutes, type DemandReadService } from "./demand-routes.js";
import { DemandService, type DemandDeployment } from "./demand-service.js";

const WORLD = "61111111-1111-4111-8111-111111111111";
const OTHER = "62222222-2222-4222-8222-222222222222";
const OPERATOR = "6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIVATE_MARKERS = ["fareFact", "valid_unpresentable", "private-world-seed-789", "passenger-private-0001", "SELECT_private_manifest"];

function databaseFailure(statusCode?: number): Error {
  const parameters = { fareFact: "valid_unpresentable", seed: "private-world-seed-789", passengerKey: "passenger-private-0001" };
  const cause = Object.assign(new Error(`SELECT_private_manifest parameters ${JSON.stringify(parameters)}`), { parameters });
  return Object.assign(new Error(`Failed query SELECT_private_manifest; params ${JSON.stringify(parameters)}`, { cause }), {
    name: "DrizzleQueryError", query: "SELECT_private_manifest", params: [parameters],
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function expectNoPrivateData(serialized: string): void {
  for (const marker of PRIVATE_MARKERS) expect(serialized).not.toContain(marker);
}

describe("Nachfrage: private Fehlerdaten verlassen weder API noch Fehlerprotokoll", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values([
      { id: WORLD, name: "Datenschutzprüfung", schedulePeriodWeeks: 3, epoch: new Date(0) },
      { id: OTHER, name: "Andere Welt", schedulePeriodWeeks: 3, epoch: new Date(0) },
    ]);
    const owner = await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "privacy-owner", displayName: "Owner" });
    await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "privacy-visitor", displayName: "Visitor" });
    await requestWorldAccess(db, { worldId: WORLD, keycloakSubject: "privacy-revoked", displayName: "Revoked" });
    await db.update(worldAccesses).set({ status: "revoked" }).where(eq(worldAccesses.keycloakSubject, "privacy-revoked"));
    await db.insert(operators).values({ id: OPERATOR, worldId: WORLD, foundingAccountId: owner.id, name: "Prüfbahn", color: "#123456" });
  });

  afterAll(async () => { await client.close(); });

  function routes(error: Error, service?: DemandReadService) {
    const messages: string[] = [];
    const destination = new Writable({ write(chunk, _encoding, callback) { messages.push(String(chunk)); callback(); } });
    const app = Fastify({ logger: { level: "info", stream: destination } });
    app.decorateRequest("identity", null);
    const fail = vi.fn(async () => { throw error; });
    registerDemandRoutes(app, { db,
      async authenticate(request, reply) {
        const subject = request.headers["x-test-subject"];
        if (typeof subject !== "string") { await reply.code(401).send({ error: "Bitte melde dich an." }); return; }
        request.identity = { keycloakSubject: subject, displayName: subject };
      },
      demand: service ?? { overview: fail, train: fail, manifest: fail },
      spfv: { catalog: fail, preview: fail, confirm: fail },
    });
    return { app, messages, fail };
  }

  const requests: readonly InjectOptions[] = [
    { url: `/worlds/${WORLD}/demand/overview` },
    { url: `/worlds/${WORLD}/demand/trains/train` },
    { url: `/worlds/${WORLD}/operators/${OPERATOR}/demand/trains/train/manifest` },
    { url: `/worlds/${WORLD}/operators/${OPERATOR}/spfv/catalog` },
    { method: "POST", url: `/worlds/${WORLD}/operators/${OPERATOR}/spfv/preview`, payload: {
      name: "Prüflinie", stopIds: ["station-a", "station-b"], headwayS: 600,
      fareCents: "100", formationId: "formation", validFromS: 0, validUntilS: 600,
    } },
    { method: "POST", url: `/worlds/${WORLD}/operators/${OPERATOR}/spfv/confirm`, payload: { previewId: "preview", commandId: "command" } },
  ];

  it.each([
    ["gewöhnlichem Datenbankfehler", undefined],
    ["Datenbankfehler mit nachgelagertem HTTP-Status", 409],
  ] as const)("redigiert Nachricht, Ursache und SQL-Parameter bei %s auf allen Nachfragewegen", async (_label, statusCode) => {
    const { app, messages, fail } = routes(databaseFailure(statusCode));
    try {
      for (const request of requests) {
        const response = await app.inject({ ...request, headers: { "x-test-subject": "privacy-owner" } });
        if (statusCode === undefined) expect(response.statusCode).toBe(503);
        else expect([409, 503]).toContain(response.statusCode);
        expectNoPrivateData(response.body);
      }
      expect(fail).toHaveBeenCalledTimes(requests.length);
      const logs = messages.join("");
      expectNoPrivateData(logs);
      if (statusCode === undefined) expect(logs).toContain("demand_request_failed");
    } finally { await app.close(); }
  });

  it("prüft aktiven Weltzugang und Eigentum vor jedem privaten Dienstaufruf", async () => {
    const { app, messages, fail } = routes(databaseFailure());
    const manifest = `/worlds/${WORLD}/operators/${OPERATOR}/demand/trains/train/manifest`;
    try {
      expect((await app.inject({ url: manifest })).statusCode).toBe(401);
      for (const subject of ["privacy-visitor", "privacy-revoked"]) {
        const response = await app.inject({ url: manifest, headers: { "x-test-subject": subject } });
        expect(response.statusCode).toBe(403);
        expectNoPrivateData(response.body);
      }
      const otherWorld = await app.inject({ url: `/worlds/${OTHER}/demand/overview`, headers: { "x-test-subject": "privacy-owner" } });
      expect(otherWorld.statusCode).toBe(403);
      expect(fail).not.toHaveBeenCalled();
      expectNoPrivateData(messages.join(""));
    } finally { await app.close(); }
  });

  it("übernimmt nach einem fehlgeschlagenen Hintergrundlauf keine SQL-Fehlertexte in spätere Antworten", async () => {
    const error = databaseFailure();
    const deployment: DemandDeployment = { schemaVersion: "zugfolge-demand-deployment/v1", worldId: WORLD,
      infrastructureReleaseId: "infra", windows: [{ schemaVersion: "zugfolge-demand-evaluation/v1", worldId: WORLD,
        periodId: "period", seed: "42", release: { id: "test" }, windowStartMs: 0, windowEndMs: 1000,
        daySliceId: "test", services: [], alternatives: [] }] };
    const runtime: DemandRuntime = { evaluate: vi.fn(() => { throw new Error("Der Kern darf vor der Infrastrukturprüfung nicht laufen."); }) };
    const readModel = { async getConfig() { throw error; } } as unknown as LivemapReadModel;
    const service = new DemandService({ db, runtime, deployment, deploymentHash: "pin", readModel, infrastructure: [] });
    await expect(service.refresh(100, new Date(100))).rejects.toBe(error);
    expect(runtime.evaluate).not.toHaveBeenCalled();
    const { app, messages } = routes(error, service);
    try {
      for (const request of requests.slice(0, 3)) {
        const response = await app.inject({ ...request, headers: { "x-test-subject": "privacy-owner" } });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: "Nachfrage ist nicht verfügbar." });
        expectNoPrivateData(response.body);
      }
      expectNoPrivateData(messages.join(""));
    } finally { await app.close(); }
  });
});
