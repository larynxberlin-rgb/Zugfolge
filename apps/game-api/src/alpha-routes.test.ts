import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";

describe("produktive Alpha-Teilpfade", () => {
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
