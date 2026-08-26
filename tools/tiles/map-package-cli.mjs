#!/usr/bin/env node
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createOperationalInfrastructureV2ExecutableVerifier,
  expandMapPackagePlan,
  installMapPackage,
  OPERATIONAL_INFRASTRUCTURE_V2_VALIDATOR_ENV,
  packMapPackage,
  verifyMapPackage,
} from "./map-package.mjs";

function usage() {
  return [
    "Aufruf:",
    "  map-package-cli.mjs expand PLAN.json QUELLWURZEL SPEC.json",
    "  map-package-cli.mjs pack SPEC.json AUSGABEVERZEICHNIS [QUELLWURZEL]",
    "  map-package-cli.mjs pack-plan PLAN.json QUELLWURZEL AUSGABEVERZEICHNIS",
    "  map-package-cli.mjs expand-overlay PLAN.json SPEC.json QUELLWURZEL [QUELLWURZEL...]",
    "  map-package-cli.mjs pack-overlay SPEC.json AUSGABEVERZEICHNIS QUELLWURZEL [QUELLWURZEL...]",
    "  map-package-cli.mjs pack-plan-overlay PLAN.json AUSGABEVERZEICHNIS QUELLWURZEL [QUELLWURZEL...]",
    "  map-package-cli.mjs verify PAKETVERZEICHNIS",
    "  map-package-cli.mjs install PAKETVERZEICHNIS INSTALLATIONSVERZEICHNIS",
    `  Operational-v2: ${OPERATIONAL_INFRASTRUCTURE_V2_VALIDATOR_ENV}=PFAD/ZU/zugfolge-infra-release`,
  ].join("\n");
}

const configuredNativeValidator = process.env[OPERATIONAL_INFRASTRUCTURE_V2_VALIDATOR_ENV]?.trim();
const operationalValidation = configuredNativeValidator === undefined || configuredNativeValidator === ""
  ? {}
  : { validateOperationalInfrastructure: createOperationalInfrastructureV2ExecutableVerifier(configuredNativeValidator) };

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error(usage());

let result;
if (command === "expand") {
  if (args.length !== 3) throw new Error(usage());
  const [firstPath, secondPath, thirdPath] = args;
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
} else if (command === "expand-overlay") {
  if (args.length < 3) throw new Error(usage());
  const [firstPath, secondPath, ...sourceRoots] = args;
  const plan = JSON.parse(await readFile(resolve(firstPath), "utf8"));
  const spec = await expandMapPackagePlan(plan, sourceRoots.map((root) => resolve(root)));
  const outputPath = resolve(secondPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(spec, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  result = { action: "expanded", specPath: outputPath, sourceRoots: sourceRoots.length, auxiliaryFiles: spec.auxiliaryFiles.length };
} else if (["pack", "pack-plan", "pack-overlay", "pack-plan-overlay"].includes(command)) {
  const overlay = command.endsWith("-overlay");
  const planCommand = command.startsWith("pack-plan");
  if ((!overlay && (planCommand ? args.length !== 3 : ![2, 3].includes(args.length))) || (overlay && args.length < 3)) throw new Error(usage());
  const [firstPath, secondPath, thirdPath] = args;
  const specPath = resolve(firstPath);
  const input = JSON.parse(await readFile(specPath, "utf8"));
  const sourceRoot = overlay
    ? args.slice(2).map((root) => resolve(root))
    : planCommand ? resolve(secondPath) : thirdPath === undefined ? dirname(specPath) : resolve(thirdPath);
  const outputPath = resolve(planCommand && !overlay ? thirdPath : secondPath);
  const spec = planCommand ? await expandMapPackagePlan(input, sourceRoot) : input;
  result = await packMapPackage(spec, sourceRoot, outputPath, operationalValidation);
  result = {
    action: "packed",
    packageRoot: result.packageRoot,
    packageId: result.manifest.packageId,
    version: result.manifest.version,
    schema: result.manifest.schema,
    ...(result.manifest.releaseId === undefined ? {} : { releaseId: result.manifest.releaseId, claims: result.manifest.claims, cutover: result.manifest.cutover }),
    manifestSha256: result.manifestSha256,
    partBytes: result.manifest.partBytes,
    artifacts: result.manifest.artifacts.length,
    auxiliaryFiles: result.manifest.auxiliaryFiles.length,
    parts: [...result.manifest.artifacts, ...result.manifest.auxiliaryFiles].reduce((sum, artifact) => sum + artifact.parts.length, 0),
  };
} else if (command === "verify") {
  if (args.length !== 1) throw new Error(usage());
  const verified = await verifyMapPackage(resolve(args[0]), operationalValidation);
  result = {
    action: "verified",
    packageRoot: verified.root,
    packageId: verified.manifest.packageId,
    version: verified.manifest.version,
    schema: verified.manifest.schema,
    ...(verified.manifest.releaseId === undefined ? {} : { releaseId: verified.manifest.releaseId, claims: verified.manifest.claims, cutover: verified.manifest.cutover }),
    manifestSha256: verified.manifestSha256,
    partBytes: verified.manifest.partBytes,
    artifacts: verified.manifest.artifacts.length,
    auxiliaryFiles: verified.manifest.auxiliaryFiles.length,
  };
} else if (command === "install") {
  if (args.length !== 2) throw new Error(usage());
  const installed = await installMapPackage(resolve(args[0]), resolve(args[1]), operationalValidation);
  result = {
    action: installed.status,
    installRoot: installed.installRoot,
    packageId: installed.manifest.packageId,
    version: installed.manifest.version,
    schema: installed.manifest.schema,
    ...(installed.manifest.releaseId === undefined ? {} : { releaseId: installed.manifest.releaseId, claims: installed.manifest.claims, cutover: installed.manifest.cutover }),
    artifacts: installed.manifest.artifacts.length,
    auxiliaryFiles: installed.manifest.auxiliaryFiles.length,
  };
} else {
  throw new Error(usage());
}

process.stdout.write(`${JSON.stringify(result)}\n`);
