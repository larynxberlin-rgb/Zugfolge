#!/usr/bin/env node
import { spawn as spawnChild } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runMapReleaseDeploymentPreflight } from "./map-release-deployment-preflight.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function mapReleaseStartPreflightMode(environment) {
  const mode = environment.MAP_RELEASE_START_PREFLIGHT_MODE;
  invariant(mode === "active-candidate" || mode === "pre-activation", "MAP_RELEASE_START_PREFLIGHT_MODE muss explizit active-candidate oder pre-activation sein.");
  return mode;
}

export async function startAfterMapReleasePreflight({
  command,
  environment = process.env,
  preflight = runMapReleaseDeploymentPreflight,
  spawn = spawnChild,
  signalSource = process,
} = {}) {
  invariant(Array.isArray(command) && command.length > 0, "Aufruf: start-after-map-release-preflight.mjs PROGRAMM [ARGUMENTE...]");
  invariant(command.every((argument) => typeof argument === "string" && argument.length > 0 && !argument.includes("\0")), "Startkommando enthält ein ungültiges Argument.");

  await preflight({ mode: mapReleaseStartPreflightMode(environment), environment });

  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = new Map(forwardedSignals.map((signal) => [signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }]));
  for (const [signal, handler] of handlers) signalSource.on(signal, handler);
  try {
    return await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== null) accept(code);
        else accept(128 + (osConstants.signals[signal] ?? 0));
      });
    });
  } finally {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const exitCode = await startAfterMapReleasePreflight({ command: process.argv.slice(2) });
  process.exitCode = exitCode;
}
