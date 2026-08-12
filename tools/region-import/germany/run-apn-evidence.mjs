#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_APN_BASE_URL,
  analyzeCapturedApnEvidence,
  captureApnEvidence,
  parseNormalizedOperatingPointCatalog,
} from "./apn-evidence.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function usage() {
  return [
    "Aufruf:",
    "  run-apn-evidence.mjs capture --catalog FILE --evidence-root ABSOLUT [Optionen]",
    "  run-apn-evidence.mjs analyze --evidence-root ABSOLUT",
    "  run-apn-evidence.mjs run --catalog FILE --evidence-root ABSOLUT [Optionen]",
    "",
    "Optionen für capture/run:",
    `  --base-url URL              Standard: ${DEFAULT_APN_BASE_URL}`,
    "  --concurrency 1|2           Standard: 1",
    "  --delay-ms N                Standard: 1000; bei externen Zielen mindestens 250",
    "  --max-attempts N            Standard: 3",
    "  --initial-backoff-ms N      Standard: 1000",
    "  --maximum-backoff-ms N      Standard: 15000",
    "  --request-timeout-ms N      Standard: 30000",
    "  --max-bytes N               Standard: 67108864",
    "  --user-agent TEXT           Identifizierender, kontaktfähiger User-Agent",
    "  --retry-unavailable         Auch dauerhaft fehlende Einträge erneut prüfen",
  ].join("\n");
}

function parseArguments(values) {
  const [command, ...rest] = values;
  if (!["capture", "analyze", "run"].includes(command)) throw new Error(usage());
  const captureOptions = new Set([
    "catalog",
    "evidence-root",
    "base-url",
    "concurrency",
    "delay-ms",
    "max-attempts",
    "initial-backoff-ms",
    "maximum-backoff-ms",
    "request-timeout-ms",
    "max-bytes",
    "user-agent",
    "retry-unavailable",
  ]);
  const allowed = command === "analyze" ? new Set(["evidence-root"]) : captureOptions;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--retry-unavailable") {
      if (!allowed.has("retry-unavailable")) throw new Error(`Unbekannte Option ${token}.\n${usage()}`);
      options.retryUnavailable = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unerwartetes Argument ${token}.\n${usage()}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unbekannte Option ${token}.\n${usage()}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Wert für ${token} fehlt.`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function integerOption(options, name) {
  if (options[name] === undefined) return undefined;
  if (!/^\d+$/.test(options[name])) throw new Error(`--${name} erwartet eine nichtnegative Ganzzahl.`);
  return Number.parseInt(options[name], 10);
}

function isLoopback(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function capturePolicy(options) {
  const pairs = [
    ["concurrency", "concurrency"],
    ["delay-ms", "delayMs"],
    ["max-attempts", "maxAttempts"],
    ["initial-backoff-ms", "initialBackoffMs"],
    ["maximum-backoff-ms", "maximumBackoffMs"],
    ["request-timeout-ms", "requestTimeoutMs"],
    ["max-bytes", "maxBytes"],
  ];
  const result = {};
  for (const [argument, property] of pairs) {
    const value = integerOption(options, argument);
    if (value !== undefined) result[property] = value;
  }
  if (options["user-agent"] !== undefined) result.userAgent = options["user-agent"];
  return result;
}

async function catalog(path) {
  if (typeof path !== "string" || path === "") throw new Error("--catalog fehlt.");
  return parseNormalizedOperatingPointCatalog(await readFile(resolve(path), "utf8"));
}

function evidenceRoot(options) {
  if (typeof options["evidence-root"] !== "string" || options["evidence-root"] === "") throw new Error("--evidence-root fehlt.");
  return options["evidence-root"];
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const root = evidenceRoot(options);
  if (command === "analyze") {
    const result = await analyzeCapturedApnEvidence({ evidenceRoot: root, repositoryRoot: REPOSITORY_ROOT });
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
    return;
  }

  const baseUrl = options["base-url"] ?? DEFAULT_APN_BASE_URL;
  const policy = capturePolicy(options);
  const effectiveDelay = policy.delayMs ?? 1_000;
  if (!isLoopback(baseUrl) && effectiveDelay < 250) throw new Error("Externe APN-Abrufe benötigen mindestens 250 ms Abstand.");
  const captured = await captureApnEvidence({
    catalog: await catalog(options.catalog),
    evidenceRoot: root,
    repositoryRoot: REPOSITORY_ROOT,
    baseUrl,
    policy,
    retryUnavailable: options.retryUnavailable === true,
  });
  if (command === "capture") {
    process.stdout.write(`${JSON.stringify(captured.summary)}\n`);
    return;
  }
  const analyzed = await analyzeCapturedApnEvidence({ evidenceRoot: root, repositoryRoot: REPOSITORY_ROOT });
  process.stdout.write(`${JSON.stringify({ capture: captured.summary, analysis: analyzed.summary })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
