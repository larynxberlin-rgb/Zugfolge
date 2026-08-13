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

  it("exponiert die vollstaendige Phase-2-Reise mit Tutorial, Status, Claim, Heatmap und Assistent", async () => {
    const app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db: {} as never,
      authenticate: (async () => undefined) as never,
      services: {
        tutorial: {} as never,
        onboarding: {} as never,
        startPackageSpec: {
          schemaVersion: "zugfolge-start-package/v1", version: "v1", emergencyLotId: "lot-1",
          maximumTrainKmPerPeriod: 1_000, vehicleClass: "Mireo", maximumVehicleValueCents: 1n,
          durationS: 86_400, pathWindowId: "path-1", personnelPoolId: "pool-1", operatingProgramTemplateId: "balanced",
        },
        abuse: {} as never,
        pseudonymSecret: "a".repeat(32),
      },
    });
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/tutorial" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/tutorial/reset" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/onboarding/start-package" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/onboarding/start-package" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/capacity-heatmap" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/onboarding/assistant" })).toBe(true);

    await app.close();
  });

  it("koppelt Heatmap und Tutorial-Assistent nicht an die Startpaket-Spezifikation", async () => {
    const app = Fastify({ logger: false });
    registerAlphaRoutes(app, {
      db: {} as never,
      authenticate: (async () => undefined) as never,
      services: {
        onboarding: {} as never,
        abuse: {} as never,
        pseudonymSecret: "a".repeat(32),
      },
    });
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/onboarding/start-package" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/worlds/:worldId/onboarding/start-package" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/capacity-heatmap" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/worlds/:worldId/onboarding/assistant" })).toBe(true);

    await app.close();
  });
});
