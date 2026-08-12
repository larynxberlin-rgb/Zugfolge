import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { classifyMapFeature } from "./map-layers.mjs";

const [inputPath, includedPath, contextPath] = process.argv.slice(2);
if (!inputPath || !includedPath || !contextPath) throw new Error("usage: node build-map-layers.mjs INPUT.geojsonseq INCLUDED.geojsonseq CONTEXT.geojsonseq");

const included = createWriteStream(includedPath, { encoding: "utf8" });
const context = createWriteStream(contextPath, { encoding: "utf8" });
const counts = { rail: 0, context: 0, ignored: 0, A: 0, B: 0, C: 0 };
for await (const raw of createInterface({ input: createReadStream(inputPath, "utf8"), crlfDelay: Infinity })) {
  const line = raw.replace(/^\x1e/, "").trim();
  if (line === "") continue;
  const result = classifyMapFeature(JSON.parse(line));
  if (result === null) {
    counts.ignored += 1;
    continue;
  }
  counts[result.layer] += 1;
  counts[result.feature.properties.qualityClass] += 1;
  const target = result.layer === "rail" ? included : context;
  if (!target.write(`\x1e${JSON.stringify(result.feature)}\n`)) await once(target, "drain");
}
included.end();
context.end();
await Promise.all([once(included, "finish"), once(context, "finish")]);
process.stdout.write(`${JSON.stringify(counts)}\n`);

