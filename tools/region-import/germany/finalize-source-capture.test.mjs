import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeGermanySourceCapture } from "./finalize-source-capture.mjs";

test("bindet DEM-Kachelsatz und internes Ledger, ohne die interne Quelle öffentlich zu benennen", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-capture-"));
  const ledger = join(root, "review.json");
  await writeFile(ledger, "interne-pruefung\n");
  const capture = await finalizeGermanySourceCapture({
    baseCapture: {
      schema: "zugfolge-source-capture/v1",
      capturedAt: "2026-08-12T13:05:00.000Z",
      sources: [{ id: "geofabrik-germany-pbf", version: "2026", file: "germany.pbf", bytes: 10, sha256: "a".repeat(64) }],
    },
    demCapture: {
      schema: "zugfolge-copernicus-dem-capture/v1",
      source: { sourceId: "copernicus-dem-germany", product: "COP-DEM-GLO-30-DGED", release: "2021" },
      aggregateTileSha256: "b".repeat(64),
      tiles: [
        { bytes: 20, sha256: "c".repeat(64) },
        { bytes: 30, sha256: "d".repeat(64) },
      ],
    },
    internalEvidenceLedgerPath: ledger,
  });
  assert.equal(capture.sources[0].id, "copernicus-dem-germany");
  assert.equal(capture.sources[0].bytes, 50);
  assert.equal(capture.internalEvidenceLedgerSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(capture.sources), /station-plan|apn/i);
});
