import { readFileSync, writeFileSync } from "node:fs";

import { buildOperationalNetwork } from "./operational-network.mjs";

const [masterPath, gtfsPath, boundaryPath, outputPath] = process.argv.slice(2);
if (!masterPath || !gtfsPath || !boundaryPath || !outputPath) {
  throw new Error("usage: node build-operational-network.mjs MASTER_JSON GTFS_SNAPSHOT_JSON REGION_GEOJSON OUTPUT_JSON");
}

const masterData = JSON.parse(readFileSync(masterPath, "utf8"));
const gtfsEnvelope = JSON.parse(readFileSync(gtfsPath, "utf8"));
const regionBoundary = JSON.parse(readFileSync(boundaryPath, "utf8"));
const envelope = buildOperationalNetwork({ masterData, gtfsSnapshot: gtfsEnvelope.snapshot, regionBoundary });
writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...envelope.network.metrics, networkHash: envelope.networkHash })}\n`);

