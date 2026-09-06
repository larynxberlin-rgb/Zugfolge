/** Liest den committed Atlas. Fehlende Freigaben können ausdrücklich offen bleiben; technische Lücken nie. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArtAtlas, parseArtAtlasManifest } from "../../packages/conductor-art/dist/index.js";
import { RELEASE_DIRECTORY, buildArtManifest, readArtResources } from "./manifest.mjs";

const PENDING_APPROVAL_CODES = new Set(["release_not_approved", "review_not_approved", "reference_rights_unverified"]);

export function checkArtRelease({ allowPending = false, directory = RELEASE_DIRECTORY } = {}) {
  const manifestBytes = readFileSync(resolve(directory, "manifest.json"));
  const manifest = parseArtAtlasManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (JSON.stringify(manifest) !== JSON.stringify(buildArtManifest(directory))) throw new Error("Committed Manifest passt nicht zu Aufbereitung und Prüfbelegen; erneut mit manifest.mjs bauen.");
  const report = inspectArtAtlas(manifestBytes, readArtResources(manifest, directory));
  const blocking = report.issues.filter((issue) => !allowPending || !PENDING_APPROVAL_CODES.has(issue.code));
  if (manifest.status === "rejected") blocking.push({ code: "release_rejected", path: "status" });
  if (manifest.status === "approved" && !report.activationEligible) blocking.push({ code: "approved_release_incomplete", path: "status" });
  return { report, blocking };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, blocking } = checkArtRelease({ allowPending: process.argv.includes("--allow-pending") });
  console.log(JSON.stringify(report, null, 2));
  if (blocking.length > 0) process.exitCode = 1;
}
