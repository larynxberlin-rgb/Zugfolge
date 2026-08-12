import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("usage: node classify-osm-sections.mjs INPUT.geojsonseq OUTPUT.json");

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function quality(properties) {
  const missing = [];
  if (text(properties.maxspeed) === null) missing.push("maxspeed");
  if (text(properties.electrified) === null) missing.push("electrified");
  if (text(properties.usage) === null && text(properties.service) === null) missing.push("usage-or-service");
  if (text(properties.gauge) !== null && properties.gauge !== "1435") missing.push("ebo-standard-gauge");
  if (properties["zugfolge:validated"] === "yes" && missing.length === 0) return { class: "A", missing };
  if (missing.length === 0) return { class: "B", missing: ["manual-route-and-block-validation"] };
  return { class: "C", missing };
}

const sections = [];
const lines = createInterface({ input: createReadStream(inputPath, "utf8"), crlfDelay: Infinity });
for await (const raw of lines) {
  const line = raw.replace(/^\x1e/, "").trim();
  if (line === "") continue;
  const feature = JSON.parse(line);
  if (feature.type !== "Feature" || feature.geometry?.type !== "LineString" || feature.properties?.railway !== "rail") continue;
  const sourceId = typeof feature.id === "string" ? feature.id : `way/${feature.properties?.id ?? "unknown"}`;
  const result = quality(feature.properties);
  sections.push({
    sectionId: `osm-${sourceId.replaceAll("/", "-")}`,
    sourceId,
    qualityClass: result.class,
    orderable: result.class !== "C",
    missingEvidence: result.missing,
    tags: {
      maxspeed: text(feature.properties.maxspeed),
      electrified: text(feature.properties.electrified),
      gauge: text(feature.properties.gauge),
      usage: text(feature.properties.usage),
      service: text(feature.properties.service),
      railway: "rail",
    },
  });
}
sections.sort((left, right) => left.sectionId.localeCompare(right.sectionId));
const counts = { A: 0, B: 0, C: 0 };
for (const section of sections) counts[section.qualityClass] += 1;
const report = {
  schema: "zugfolge-infrastructure-quality-report/v1",
  regionId: "mitteldeutschland-b",
  rulesVersion: "ebo-osm-e22-2026.1",
  policy: {
    A: "vollstaendige Pflichtattribute und explizite fachliche Validierung",
    B: "vollstaendige Pflichtattribute, manuelle Fahrstrassen-/Blockvalidierung noch konservativ",
    C: "mindestens ein Pflichtnachweis fehlt; sichtbar, aber nicht bestellbar",
  },
  counts,
  sections,
};
const canonical = JSON.stringify(report);
const envelope = { report, reportHash: createHash("sha256").update(canonical).digest("hex") };
writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...counts, total: sections.length, reportHash: envelope.reportHash })}\n`);
