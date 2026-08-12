import { readFile, writeFile } from "node:fs/promises";
import { buildIndependentValidationSet } from "./validation-set.mjs";

const [operationalPath, pbfPath, gtfsPath, outputPath] = process.argv.slice(2);
if (!operationalPath || !pbfPath || !gtfsPath || !outputPath) {
  throw new Error("Aufruf: node build-validation-set.mjs OPERATIONAL.json PBF-REPORT.json GTFS.json OUTPUT.json");
}

const operationalNetwork = JSON.parse(await readFile(operationalPath, "utf8"));
const pbfReport = JSON.parse(await readFile(pbfPath, "utf8"));
const gtfsSnapshot = JSON.parse(await readFile(gtfsPath, "utf8"));
const validation = buildIndependentValidationSet({ operationalNetwork, pbfReport, gtfsSnapshot });
await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`);
console.log(JSON.stringify({ ...validation.artifact.metrics, result: validation.artifact.result, validationHash: validation.validationHash }));
if (validation.artifact.result !== "passed") process.exitCode = 1;
