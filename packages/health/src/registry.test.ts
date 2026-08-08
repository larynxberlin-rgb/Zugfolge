import { describe, expect, it } from "vitest";

import { runHealthChecks } from "./registry.js";
import type { HealthCheck } from "./types.js";

function check(name: string, run: HealthCheck["check"]): HealthCheck {
  return { name, check: run };
}

describe("runHealthChecks", () => {
  it("meldet 'ok' bei einer leeren Liste", async () => {
    const report = await runHealthChecks([]);
    expect(report).toEqual({ status: "ok", checks: [] });
  });

  it("übernimmt den einzigen Status einer einzelnen Prüfung", async () => {
    const report = await runHealthChecks([check("db", async () => ({ status: "ok" }))]);
    expect(report.status).toBe("ok");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: "db", status: "ok" });
    expect(report.checks[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("aggregiert zum ungünstigsten Status: down schlägt degraded schlägt ok", async () => {
    const report = await runHealthChecks([
      check("a", async () => ({ status: "ok" })),
      check("b", async () => ({ status: "degraded", detail: "langsam" })),
      check("c", async () => ({ status: "ok" })),
    ]);
    expect(report.status).toBe("degraded");

    const mitAusfall = await runHealthChecks([
      check("a", async () => ({ status: "ok" })),
      check("b", async () => ({ status: "degraded" })),
      check("c", async () => ({ status: "down", detail: "nicht erreichbar" })),
    ]);
    expect(mitAusfall.status).toBe("down");
  });

  it("fängt eine werfende Prüfung als 'down' auf, ohne die anderen zu stören", async () => {
    const report = await runHealthChecks([
      check("bricht", async () => {
        throw new Error("Verbindung verweigert");
      }),
      check("laeuft", async () => ({ status: "ok" })),
    ]);
    expect(report.status).toBe("down");
    expect(report.checks.find((c) => c.name === "bricht")).toMatchObject({
      status: "down",
      detail: "Verbindung verweigert",
    });
    expect(report.checks.find((c) => c.name === "laeuft")).toMatchObject({ status: "ok" });
  });

  it("übernimmt den Freitext einer nicht-Error-Ablehnung als Detail", async () => {
    const report = await runHealthChecks([
      check("wirft-string", async () => {
        throw "kaputt";
      }),
    ]);
    expect(report.checks[0]).toMatchObject({ status: "down", detail: "kaputt" });
  });
});
