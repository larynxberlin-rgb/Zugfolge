import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { assertServerWorldDeployment, assertServerWorldInventory, registerServerWorldScope, serverWorldScope } from "./server-world-scope.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("Eine Spielwelt je Server und Subdomain", () => {
  it("weist fremde Welt- und Hostangaben vor jeder Handlerwirkung ab", async () => {
    const app = Fastify();
    let calls = 0;
    registerServerWorldScope(app, serverWorldScope(WORLD, "https://elbe.zugfolge.test"));
    app.post("/worlds/:worldId/action", async () => { calls += 1; return { accepted: true }; });
    app.get("/health", async () => ({ healthy: true }));
    try {
      const headers = { host: "elbe.zugfolge.test" };
      expect((await app.inject({ method: "POST", url: `/worlds/${OTHER}/action`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/worlds/${WORLD}/action`, headers: { host: "spree.zugfolge.test", "x-forwarded-host": headers.host } })).statusCode).toBe(421);
      expect(calls).toBe(0);
      expect((await app.inject({ method: "POST", url: `/worlds/${WORLD}/action`, headers })).statusCode).toBe(200);
      expect(calls).toBe(1);
      expect((await app.inject({ url: "/health", headers: { host: "localhost" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it("bindet jedes signierte Deployment an die konfigurierte Welt", () => {
    const scope = serverWorldScope(WORLD, "https://elbe.zugfolge.test");
    for (const profileKind of ["public", "private", "test"]) {
      expect(() => assertServerWorldDeployment(scope, { worldId: WORLD, blueprint: { profileKind } })).not.toThrow();
      expect(() => assertServerWorldDeployment(scope, { worldId: OTHER, blueprint: { profileKind } })).toThrow("Serverhauptweltbindung");
    }
    expect(() => assertServerWorldDeployment(scope, { worldId: WORLD, blueprint: { profileKind: "unknown" } })).toThrow();
  });
  it("pinnt eine feste Origin und lehnt Pfad-, Wildcard- und Credential-Routing ab", () => {
    expect(serverWorldScope(WORLD, "https://elbe.zugfolge.test/")).toEqual({ worldId: WORLD, publicOrigin: "https://elbe.zugfolge.test" });
    expect(serverWorldScope(WORLD, "http://localhost:3000").publicOrigin).toBe("http://localhost:3000");
    for (const url of ["http://elbe.zugfolge.test", "https://*.zugfolge.test", "https://elbe.zugfolge.test/worlds/a", "https://user:pass@elbe.zugfolge.test", "https://elbe.zugfolge.test?world=b"]) {
      expect(() => serverWorldScope(WORLD, url)).toThrow();
    }
    expect(() => serverWorldScope("weltname", "https://elbe.zugfolge.test")).toThrow("UUID");
  });
  it("startet nur mit einer aktiven Welt und erhaelt versiegelte Vorgeschichte", () => {
    const scope = serverWorldScope(WORLD, "https://elbe.zugfolge.test");
    const active = { worldId: WORLD, lifecycleStatus: "active" };
    expect(() => assertServerWorldInventory(scope, [])).not.toThrow();
    expect(() => assertServerWorldInventory(scope, [active])).not.toThrow();
    expect(() => assertServerWorldInventory(scope, [active, { worldId: OTHER, lifecycleStatus: "archived" }])).not.toThrow();
    for (const lifecycleStatus of ["active", "provisioning"]) {
      expect(() => assertServerWorldInventory(scope, [active, { worldId: OTHER, lifecycleStatus }])).toThrow("Serverbindung");
    }
  });
});
