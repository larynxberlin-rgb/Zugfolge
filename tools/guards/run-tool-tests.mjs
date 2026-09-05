import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Dieselben Verhaltenstests wie bisher, bewusst nur auf ausdruecklichen Aufruf.
run(process.execPath, ["--test", "*.test.mjs"], fileURLToPath(new URL("../reference-corpus/", import.meta.url)));
for (const paths of [
  ["tools/alpha-ops/*.test.mjs"],
  [
    "tools/audits/germany-2026.4-alpha-world-runtime.real.test.mjs",
    "tools/audits/germany-2026.5-alpha-world-runtime.real.test.mjs",
    "tools/audits/germany-2026.5-real-acceptance-pins.test.mjs",
    "tools/audits/germany-2026.5-signed-game-staging.real.test.mjs",
    "tools/audits/keycloak-public-catalog-selection.test.mjs",
  ],
  ["tools/region-import/*.test.mjs"],
  [
    "tools/tiles/gdal-semantic-pmtiles.test.mjs",
    "tools/tiles/map-build-cache-inventory.test.mjs",
    "tools/tiles/map-delivery-release.test.mjs",
    "tools/tiles/map-package.test.mjs",
    "tools/tiles/map-release-build-evidence.test.mjs",
    "tools/tiles/map-release.test.mjs",
    "tools/tiles/map-source-capture.test.mjs",
    "tools/tiles/offline-basemap-style.test.mjs",
    "tools/tiles/semantic-tiles.test.mjs",
    "tools/tiles/signed-map-package-plan.test.mjs",
    "tools/tiles/static-map-quality.test.mjs",
    "tools/tiles/static-map-release.test.mjs",
    "tools/tiles/static-map-sources.test.mjs",
    "tools/tiles/train-map-projection.test.mjs",
  ],
  ["tools/region-import/germany/*.test.mjs"],
]) {
  run(process.execPath, ["--test", ...paths]);
}
run(process.execPath, ["apps/livemap/node_modules/vitest/vitest.mjs", "run", "tools/tiles/livemap-read-model.test.mjs"]);
const python = process.env["PYTHON"] ?? "python3";
run(python, ["tools/region-import/germany/apn_semantic_extract_test.py"]);
run(python, [
  "-m", "py_compile",
  "tools/region-import/germany/apn_semantic_extract.py",
  "tools/region-import/germany/copernicus_dem_sample.py",
  "tools/region-import/germany/copernicus_dem_sample_test.py",
]);
