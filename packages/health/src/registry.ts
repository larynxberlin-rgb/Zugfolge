import type {
  HealthCheck,
  HealthCheckResult,
  HealthCheckRunOptions,
  HealthReport,
  HealthStatus,
} from "./types.js";

/** Rangfolge im ungünstigsten Sinn: `down` schlägt `degraded` schlägt `ok`. */
const SEVERITY: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

class HealthCheckTimeoutError extends Error {
  constructor(checkName: string) {
    super(`Health-Check '${checkName}' hat sein Zeitbudget überschritten.`);
    this.name = "HealthCheckTimeoutError";
  }
}

async function runOne(
  check: HealthCheck,
  timeoutMs: number,
  onError?: HealthCheckRunOptions["onError"],
): Promise<HealthCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HealthCheckTimeoutError(check.name));
      }, timeoutMs);
    });
    const outcome = await Promise.race([check.check(controller.signal), timeout]);
    return { name: check.name, ...outcome, durationMs: Date.now() - start };
  } catch (error) {
    onError?.(check.name, error);
    const timedOut = error instanceof HealthCheckTimeoutError;
    return {
      name: check.name,
      status: "down",
      code: timedOut ? "timeout" : "check_failed",
      ...(timedOut ? { detail: "Zeitlimit überschritten." } : {}),
      durationMs: Date.now() - start,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Führt alle Prüfungen nebenläufig aus und fasst sie zu einem Bericht
 * zusammen. Eine werfende Prüfung reißt die anderen nicht mit — jede meldet
 * für sich, ob sie durchgeführt werden konnte.
 */
export async function runHealthChecks(
  checks: readonly HealthCheck[],
  options: HealthCheckRunOptions = {},
): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Health-Check-Zeitbudget muss eine positive Ganzzahl sein.");
  }
  const results = await Promise.all(
    checks.map((check) => runOne(check, timeoutMs, options.onError)),
  );
  const status = results.reduce<HealthStatus>((acc, result) => worse(acc, result.status), "ok");
  return { status, checks: results };
}
