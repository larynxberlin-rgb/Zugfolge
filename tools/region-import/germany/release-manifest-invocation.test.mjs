import assert from "node:assert/strict";
import test from "node:test";

import {
  GERMANY_RELEASE_MANIFEST_USAGE,
  germanyReleaseManifestCompilerArgs,
} from "./release-manifest-invocation.mjs";

test("Manifestaufruf reicht statische und operative Qualitaet getrennt an Rust weiter", () => {
  const paths = [
    "config.json",
    "catalog.json",
    "rights.json",
    "capture.json",
    "artifacts.json",
    "static-map-quality-v2.json",
    "operational-infrastructure-quality.json",
    "release.json",
  ];

  assert.deepEqual(
    germanyReleaseManifestCompilerArgs(paths, (path) => `resolved/${path}`),
    ["manifest", ...paths.map((path) => `resolved/${path}`)],
  );
});

test("der alte Ein-Quality-Aufruf und zusaetzliche untypisierte Pfade scheitern", () => {
  const oldSingleQualityArgs = [
    "config.json",
    "catalog.json",
    "rights.json",
    "capture.json",
    "artifacts.json",
    "quality.json",
    "release.json",
  ];

  assert.throws(
    () => germanyReleaseManifestCompilerArgs(oldSingleQualityArgs),
    (error) => error instanceof Error && error.message === GERMANY_RELEASE_MANIFEST_USAGE,
  );
  assert.throws(
    () => germanyReleaseManifestCompilerArgs([...oldSingleQualityArgs, "operational.json", "extra.json"]),
    (error) => error instanceof Error && error.message === GERMANY_RELEASE_MANIFEST_USAGE,
  );
});
