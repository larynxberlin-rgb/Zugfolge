#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAXIMUM_WAIT_MS = 7_200_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LIVENESS_GRACE_MS = 30_000;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} muss eine positive Ganzzahl sein.`);
  }
  return parsed;
}

function metricValue(metrics, name) {
  const match = metrics.match(new RegExp(`^${name}\\s+([0-9]+(?:\\.[0-9]+)?)$`, "mu"));
  return match === null ? undefined : Number(match[1]);
}

function downChecks(report) {
  return Array.isArray(report?.checks)
    ? report.checks.filter((check) => check?.status === "down")
    : [];
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Wartet nach erfolgreicher Container-Liveness auf fachliche Readiness. Ein
 * langer erster Catch-up ist nur erlaubt, solange der Scheduler nachweislich
 * laeuft und sein letzter Fortschritt nicht aelter als der Health-Stallvertrag
 * ist. Damit ist `compose up --wait` allein noch kein Aktivierungserfolg.
 */
export async function waitForGameReadiness({
  baseUrl,
  maximumWaitMs = DEFAULT_MAXIMUM_WAIT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  livenessGraceMs = DEFAULT_LIVENESS_GRACE_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
  onProgress = () => undefined,
}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch fuer den Readiness-Gate fehlt.");
  const maximum = positiveInteger(maximumWaitMs, "Maximale Readiness-Wartezeit");
  const poll = positiveInteger(pollIntervalMs, "Readiness-Pollintervall");
  const livenessGrace = positiveInteger(livenessGraceMs, "Liveness-Anlaufzeit");
  const origin = new URL(baseUrl);
  const metricsOrigin = new URL(origin);
  metricsOrigin.port = "9464";
  const startedAtMs = now();
  let firstLivenessFailureAtMs;

  while (true) {
    const atMs = now();
    if (atMs - startedAtMs > maximum) {
      throw new Error(`Game-Readiness wurde trotz Schedulerfortschritt nicht innerhalb von ${maximum} ms erreicht.`);
    }

    let liveness;
    try {
      liveness = await fetchImpl(new URL("/health", origin));
    } catch {
      liveness = undefined;
    }
    const livenessBody = liveness === undefined ? undefined : await responseJson(liveness);
    if (liveness?.ok !== true || livenessBody?.status !== "ok") {
      firstLivenessFailureAtMs ??= atMs;
      if (atMs - firstLivenessFailureAtMs > livenessGrace) {
        throw new Error("Game-Prozess-Liveness blieb waehrend des Readiness-Gates unerreichbar.");
      }
      await sleep(poll);
      continue;
    }
    firstLivenessFailureAtMs = undefined;

    const readiness = await fetchImpl(new URL("/health/ready", origin));
    const report = await responseJson(readiness);
    if (readiness.ok && report?.status !== "down") return report;

    const blockers = downChecks(report);
    const scheduler = blockers.find((check) => check?.name === "regional-simulation-scheduler");
    const unrelatedBlocker = blockers.find((check) => check !== scheduler);
    if (
      unrelatedBlocker !== undefined
      || scheduler === undefined
      || !["scheduler_starting", "scheduler_catching_up"].includes(scheduler.code)
    ) {
      const codes = blockers.map((check) => check?.code ?? check?.name ?? "unknown").join(", ");
      throw new Error(`Game-Readiness ist fachlich blockiert: ${codes || readiness.status}.`);
    }

    if (scheduler.code === "scheduler_catching_up") {
      const metricsResponse = await fetchImpl(new URL("/metrics", metricsOrigin));
      const metrics = metricsResponse.ok ? await metricsResponse.text() : "";
      const running = metricValue(metrics, "zugfolge_regional_simulation_scheduler_running");
      const progressAgeSeconds = metricValue(
        metrics,
        "zugfolge_regional_simulation_scheduler_progress_age_seconds",
      );
      if (running !== 1 || progressAgeSeconds === undefined || progressAgeSeconds > 120) {
        throw new Error("Game-Cold-Catch-up meldet keinen aktuellen Schedulerfortschritt.");
      }
      onProgress({ elapsedMs: atMs - startedAtMs, progressAgeSeconds });
    }

    await sleep(poll);
  }
}

async function main() {
  const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
  const maximumWaitMs = process.argv[3] === undefined
    ? DEFAULT_MAXIMUM_WAIT_MS
    : positiveInteger(process.argv[3], "Maximale Readiness-Wartezeit");
  await waitForGameReadiness({
    baseUrl,
    maximumWaitMs,
    onProgress: ({ elapsedMs, progressAgeSeconds }) => {
      process.stdout.write(
        `Game-Cold-Catch-up aktiv: ${Math.floor(elapsedMs / 1_000)} s, letzter Fortschritt ${progressAgeSeconds} s alt.\n`,
      );
    },
  });
  process.stdout.write("Game-Readiness erreicht.\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
