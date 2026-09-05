import { describe, expect, it } from "vitest";
import { assertServerWorldInventory, serverWorldScope } from "./server-world-scope.js";

const WORLD = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const TUTORIAL = "33333333-3333-3333-3333-333333333333";

describe("Eine Spielwelt je Server und Subdomain", () => {
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
