import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";

describe("produktive Alpha-Teilpfade", () => {
  it("exponiert Monitoring, Feedback und Replay ohne unfertige Tutorial- oder Startpaketrouten", async () => {
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
});
