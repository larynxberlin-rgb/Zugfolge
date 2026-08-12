#!/usr/bin/env node
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { expandMapPackagePlan, installMapPackage, packMapPackage, verifyMapPackage } from "./map-package.mjs";

function usage() {
  return [
    "Aufruf:",
    "  map-package-cli.mjs expand PLAN.json QUELLWURZEL SPEC.json",
    "  map-package-cli.mjs pack SPEC.json AUSGABEVERZEICHNIS [QUELLWURZEL]",
    "  map-package-cli.mjs pack-plan PLAN.json QUELLWURZEL AUSGABEVERZEICHNIS",
    "  map-package-cli.mjs verify PAKETVERZEICHNIS",
    "  map-package-cli.mjs install PAKETVERZEICHNIS INSTALLATIONSVERZEICHNIS",
  ].join("\n");
}

const [command, firstPath, secondPath, thirdPath, ...extra] = process.argv.slice(2);
if (!command || !firstPath || extra.length > 0) throw new Error(usage());

let result;
if (command === "expand") {
  if (!secondPath || !thirdPath) throw new Error(usage());
  const plan = JSON.parse(await readFile(resolve(firstPath), "utf8"));
  const spec = await expandMapPackagePlan(plan, resolve(secondPath));
  const outputPath = resolve(thirdPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(spec, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  result = { action: "expanded", specPath: outputPath, auxiliaryFiles: spec.auxiliaryFiles.length };
} else if (command === "pack" || command === "pack-plan") {
  if (!secondPath || (command === "pack-plan" && !thirdPath)) throw new Error(usage());
  const specPath = resolve(firstPath);
  const input = JSON.parse(await readFile(specPath, "utf8"));
  const sourceRoot = command === "pack-plan" ? resolve(secondPath) : thirdPath === undefined ? dirname(specPath) : resolve(thirdPath);
  const outputPath = resolve(command === "pack-plan" ? thirdPath : secondPath);
  const spec = command === "pack-plan" ? await expandMapPackagePlan(input, sourceRoot) : input;
  result = await packMapPackage(spec, sourceRoot, outputPath);
  result = {
    action: "packed",
    packageRoot: result.packageRoot,
    packageId: result.manifest.packageId,
    version: result.manifest.version,
    manifestSha256: result.manifestSha256,
    partBytes: result.manifest.partBytes,
    artifacts: result.manifest.artifacts.length,
    auxiliaryFiles: result.manifest.auxiliaryFiles.length,
    parts: [...result.manifest.artifacts, ...result.manifest.auxiliaryFiles].reduce((sum, artifact) => sum + artifact.parts.length, 0),
  };
} else if (command === "verify") {
  if (secondPath || thirdPath) throw new Error(usage());
  const verified = await verifyMapPackage(resolve(firstPath));
  result = {
    action: "verified",
    packageRoot: verified.root,
    packageId: verified.manifest.packageId,
    version: verified.manifest.version,
    manifestSha256: verified.manifestSha256,
    partBytes: verified.manifest.partBytes,
    artifacts: verified.manifest.artifacts.length,
    auxiliaryFiles: verified.manifest.auxiliaryFiles.length,
  };
} else if (command === "install") {
  if (!secondPath || thirdPath) throw new Error(usage());
  const installed = await installMapPackage(resolve(firstPath), resolve(secondPath));
  result = {
    action: installed.status,
    installRoot: installed.installRoot,
    packageId: installed.manifest.packageId,
    version: installed.manifest.version,
    artifacts: installed.manifest.artifacts.length,
    auxiliaryFiles: installed.manifest.auxiliaryFiles.length,
  };
} else {
  throw new Error(usage());
}

process.stdout.write(`${JSON.stringify(result)}\n`);
