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
      code: "check_failed",
    });
    expect(report.checks.find((c) => c.name === "bricht")).not.toHaveProperty("detail");
    expect(report.checks.find((c) => c.name === "laeuft")).toMatchObject({ status: "ok" });
  });

  it("veröffentlicht auch eine nicht-Error-Ablehnung nicht als Detail", async () => {
    const report = await runHealthChecks([
      check("wirft-string", async () => {
        throw "kaputt";
      }),
    ]);
    expect(report.checks[0]).toMatchObject({ status: "down", code: "check_failed" });
    expect(report.checks[0]).not.toHaveProperty("detail");
  });

  it("begrenzt eine nie auflösende Prüfung und signalisiert den Abbruch", async () => {
    let aborted = false;
    const started = Date.now();
    const report = await runHealthChecks(
      [
        check("haengt", (signal) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise(() => undefined);
        }),
      ],
      { timeoutMs: 20 },
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(report.checks[0]).toMatchObject({ status: "down", code: "timeout" });
  });

  it("leitet die vollständige Ursache nur an den internen Fehlerkanal", async () => {
    const errors: unknown[] = [];
    const secret = new Error("postgres://user:secret@internal/db");
    const report = await runHealthChecks(
      [check("db", async () => Promise.reject(secret))],
      { onError: (_name, error) => errors.push(error) },
    );
    expect(errors).toEqual([secret]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
