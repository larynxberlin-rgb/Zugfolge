import type { HealthCheck, HealthCheckResult, HealthReport, HealthStatus } from "./types.js";

/** Rangfolge im ungünstigsten Sinn: `down` schlägt `degraded` schlägt `ok`. */
const SEVERITY: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOne(check: HealthCheck): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const outcome = await check.check();
    return { name: check.name, ...outcome, durationMs: Date.now() - start };
  } catch (error) {
    return { name: check.name, status: "down", detail: errorDetail(error), durationMs: Date.now() - start };
  }
}

/**
 * Führt alle Prüfungen nebenläufig aus und fasst sie zu einem Bericht
 * zusammen. Eine werfende Prüfung reißt die anderen nicht mit — jede meldet
 * für sich, ob sie durchgeführt werden konnte.
 */
export async function runHealthChecks(checks: readonly HealthCheck[]): Promise<HealthReport> {
  const results = await Promise.all(checks.map(runOne));
  const status = results.reduce<HealthStatus>((acc, result) => worse(acc, result.status), "ok");
  return { status, checks: results };
}
