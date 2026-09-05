import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { alphaMonitoringApiUrl, registerAlphaRoutes } from "./alpha-routes.js";
import { createAuthenticator } from "./auth.js";
import { registerServerWorldScope, serverWorldScope } from "./server-world-scope.js";

describe("produktive Alpha-Teilpfade", () => {
  it("bindet den kopierbaren Monitoringbeleg an oeffentliche Origin und API-Praefix, ohne Tokenfreigabe", async () => {
    const worldId = "11111111-1111-4111-8111-111111111111";
    const url = alphaMonitoringApiUrl("https://elbe.zugfolge.test/", worldId);
    expect(url).toBe(`https://elbe.zugfolge.test/api/worlds/${worldId}/alpha-monitoring`);
    const app = Fastify({ logger: false });
    let snapshots = 0;
    registerServerWorldScope(app, {} as never, serverWorldScope(worldId, "https://elbe.zugfolge.test"));
    registerAlphaRoutes(app, {
      db: {} as never,
      authenticate: createAuthenticator(async () => { throw new Error("Ohne Token kein Verifier-Aufruf."); }),
      services: {
        monitoring: { snapshot: async () => { snapshots += 1; return {}; } } as never,
        authorizeMonitoring: async () => undefined,
        abuse: {} as never, pseudonymSecret: "a".repeat(32),
      },
    });
    try {
      // Der oeffentliche Proxy entfernt genau /api; Authentifizierung bleibt am Fachendpunkt.
      const response = await app.inject({ method: "GET", url: new URL(url).pathname.slice(4), headers: { host: new URL(url).host } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "Kein Zugriffstoken übermittelt." });
      expect(snapshots).toBe(0);
    } finally { await app.close(); }
  });
  it("exponiert Teilpfade nur bei vollstaendig gelieferten Services", async () => {
    const app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db: {} as never,
      authenticate: (async () => undefined) as never,
      services: {
        feedback: {} as never,
        monitoring: {} as never,
        worldEnd: {} as never,
        abuse: {} as never,
        pseudonymSecret: "a".repeat(32),
        authorizeMonitoring: async () => undefined,
      },
    });
    await app.ready();

    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/alpha-feedback" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/alpha-monitoring" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/replay-export" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/tutorial" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/onboarding/start-package" })).toBe(false);

    await app.close();
  });

  it("exponiert den vollstaendigen spielergebundenen Tutorial-Sessionvertrag", async () => {
    const app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db: {} as never,
      authenticate: (async () => undefined) as never,
      services: {
        tutorialSessions: {} as never,
        abuse: {} as never,
        pseudonymSecret: "a".repeat(32),
      },
    });
    await app.ready();

    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial-sessions" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/tutorial-sessions/active" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/tutorial-session" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial-session/actions" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial-session/restart" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial-session/summary/confirm" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial/reset" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/onboarding/start-package" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/onboarding/start-package" })).toBe(false);

    await app.close();
  });

});
