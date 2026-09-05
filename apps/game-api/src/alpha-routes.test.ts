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
    registerServerWorldScope(app, serverWorldScope(worldId, "https://elbe.zugfolge.test"));
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
});
