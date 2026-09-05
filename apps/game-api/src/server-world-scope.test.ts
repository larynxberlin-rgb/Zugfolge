import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { assertServerWorldDeployment, assertServerWorldInventory, registerServerWorldScope, serverWorldScope } from "./server-world-scope.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const TUTORIAL = "33333333-3333-3333-3333-333333333333";

describe("Eine Spielwelt je Server und Subdomain", () => {
  it("verhindert Tutorial-Enkelwelten vor Handler oder Datenbankzugriff", async () => {
    const app = Fastify();
    let starts = 0;
    registerServerWorldScope(app, { select() { throw new Error("unerwarteter DB-Zugriff"); } } as never, serverWorldScope(WORLD, "https://elbe.zugfolge.test"));
    app.post("/worlds/:worldId/tutorial-sessions", async () => { starts += 1; return { started: true }; });
    try {
      for (const parent of [TUTORIAL, OTHER]) {
        const response = await app.inject({ method: "POST", url: `/worlds/${parent}/tutorial-sessions`, headers: { host: "elbe.zugfolge.test" } });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: "tutorial_parent_world_invalid" });
      }
      expect(starts).toBe(0);
      expect((await app.inject({ method: "POST", url: `/worlds/${WORLD}/tutorial-sessions`, headers: { host: "elbe.zugfolge.test" } })).statusCode).toBe(200);
      expect(starts).toBe(1);
    } finally { await app.close(); }
  });
  it("wendet denselben Hauptweltvertrag auf signierte initiale und spaetere Deployments an", () => {
    const scope = serverWorldScope(WORLD, "https://elbe.zugfolge.test");
    for (const profileKind of ["public", "private", "test"]) {
      expect(() => assertServerWorldDeployment(scope, { worldId: WORLD, blueprint: { profileKind } })).not.toThrow();
      expect(() => assertServerWorldDeployment(scope, { worldId: OTHER, blueprint: { profileKind } })).toThrow("Serverhauptweltbindung");
    }
    expect(() => assertServerWorldDeployment(scope, { worldId: WORLD, blueprint: { profileKind: "tutorial" } })).toThrow("Serverhauptweltbindung");
  });
  it("pinnt eine feste Origin und lehnt Pfad-, Wildcard- und Credential-Routing ab", () => {
    expect(serverWorldScope(WORLD, "https://elbe.zugfolge.test/")).toEqual({ worldId: WORLD, publicOrigin: "https://elbe.zugfolge.test" });
    expect(serverWorldScope(WORLD, "http://localhost:3000").publicOrigin).toBe("http://localhost:3000");
    for (const url of ["http://elbe.zugfolge.test", "https://*.zugfolge.test", "https://elbe.zugfolge.test/worlds/a", "https://user:pass@elbe.zugfolge.test", "https://elbe.zugfolge.test?world=b"]) {
      expect(() => serverWorldScope(WORLD, url)).toThrow();
    }
    expect(() => serverWorldScope("weltname", "https://elbe.zugfolge.test")).toThrow("UUID");
  });
  it("erlaubt nur die Hauptwelt und deren belegte Tutorialinstanzen, auch beim Wiederanlauf", () => {
    const scope = serverWorldScope(WORLD, "https://elbe.zugfolge.test");
    const primary = { worldId: WORLD, lifecycleStatus: "active", profileKind: "public", publicWorldId: null };
    const tutorial = { worldId: TUTORIAL, lifecycleStatus: "active", profileKind: "tutorial", publicWorldId: WORLD };
    expect(() => assertServerWorldInventory(scope, [primary, tutorial])).not.toThrow();
    expect(() => assertServerWorldInventory(scope, [])).not.toThrow(); // vor dem ersten signierten Deployment
    for (const invalid of [
      { worldId: OTHER, lifecycleStatus: "active", profileKind: "public", publicWorldId: null },
      { worldId: OTHER, lifecycleStatus: "active", profileKind: "private", publicWorldId: null },
      { ...tutorial, publicWorldId: OTHER },
      { ...tutorial, publicWorldId: null },
      { ...primary, profileKind: "tutorial" },
    ]) expect(() => assertServerWorldInventory(scope, [primary, invalid])).toThrow("Serverbindung");
    expect(() => assertServerWorldInventory(scope, [primary, { ...primary, worldId: OTHER, lifecycleStatus: "archived" }])).not.toThrow();
  });
});
