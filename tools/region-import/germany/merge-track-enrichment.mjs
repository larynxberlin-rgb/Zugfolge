import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function * lines(path) {
  const input = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const raw of input) {
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line !== "") yield JSON.parse(line);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function featureId(feature, file) {
  const id = feature?.properties?.feature_id;
  invariant(typeof id === "string" && id !== "", `${basename(file)} enth\u00e4lt ein Feature ohne feature_id.`);
  return id;
}

function enrichmentProperties(properties) {
  invariant(properties.schema === "zugfolge-copernicus-dem-track-enrichment/v1", "Unbekanntes DEM-Anreicherungsschema.");
  const result = {
    gradient_status: properties.gradient_status,
    gradient_dimension_state: properties.gradient_dimension_state,
    gradient_source_id: properties.source_id,
    gradient_source_product: properties.source_product,
    gradient_source_release: properties.source_release,
    gradient_confidence: properties.confidence,
    gradient_surface_model: properties.surface_model,
    gradient_class_a_eligible: properties.class_a_eligible,
    gradient_quality_class_cap: properties.quality_class_cap,
    elevation_start_mm: properties.elevation_start_mm ?? null,
    elevation_end_mm: properties.elevation_end_mm ?? null,
    gradient_vertical_accuracy_assumption_mm: properties.vertical_accuracy_assumption_mm,
  };
  for (const key of [
    "representative_gradient_permille",
    "minimum_gradient_permille",
    "maximum_gradient_permille",
    "uncertainty_permille",
    "analysis_baseline_mm",
    "sample_count",
    "maximum_residual_mm",
    "uncertainty_model",
    "unresolved_reason",
  ]) if (properties[key] !== undefined) result[key] = properties[key];
  return result;
}

function assertNoPropertyCollision(trackProperties, additions, featureId) {
  for (const key of Object.keys(additions)) {
    invariant(!Object.hasOwn(trackProperties, key), `DEM-Anreicherung w\u00fcrde die vorhandene Eigenschaft ${key} von ${featureId} \u00fcberschreiben.`);
  }
}

export async function mergeTrackEnrichment({ tracksPath, enrichmentPath, outputPath }) {
  const tracks = resolve(tracksPath);
  const enrichments = resolve(enrichmentPath);
  const output = resolve(outputPath);
  const report = `${output}.report.json`;
  const temporary = `${output}.building`;
  const reportTemporary = `${report}.building`;
  for (const path of [output, report, temporary, reportTemporary]) {
    try {
      await stat(path);
      throw new Error(`Ausgabe existiert bereits: ${path}.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const target = await open(temporary, "wx");
  let count = 0;
  let derivedCount = 0;
  let unresolvedCount = 0;
  let outputBytes = 0;
  const outputHash = createHash("sha256");
  try {
    const trackIterator = lines(tracks)[Symbol.asyncIterator]();
    const enrichmentIterator = lines(enrichments)[Symbol.asyncIterator]();
    while (true) {
      const [trackItem, enrichmentItem] = await Promise.all([trackIterator.next(), enrichmentIterator.next()]);
      invariant(trackItem.done === enrichmentItem.done, "Gleis- und DEM-Layer besitzen unterschiedliche Featurezahlen.");
      if (trackItem.done) break;
      const track = trackItem.value;
      const enrichment = enrichmentItem.value;
      const trackId = featureId(track, tracks);
      const enrichmentId = featureId(enrichment, enrichments);
      invariant(trackId === enrichmentId, `DEM-Anreicherung ${enrichmentId} passt nicht zu Gleis ${trackId}.`);
      invariant(JSON.stringify(track.geometry) === JSON.stringify(enrichment.geometry), `DEM-Anreicherung ver\u00e4ndert die Geometrie von ${trackId}.`);
      const properties = enrichmentProperties(enrichment.properties);
      if (properties.gradient_status === "derived_with_uncertainty") derivedCount += 1;
      else if (properties.gradient_status === "unresolved") unresolvedCount += 1;
      else throw new Error(`DEM-Anreicherung ${trackId} besitzt unbekannten Status ${properties.gradient_status}.`);
      assertNoPropertyCollision(track.properties, properties, trackId);
      const merged = { ...track, properties: { ...track.properties, ...properties } };
      const line = `\x1e${JSON.stringify(merged)}\n`;
      await target.write(line);
      outputHash.update(line);
      outputBytes += Buffer.byteLength(line);
      count += 1;
    }
    await target.sync();
  } catch (error) {
    await target.close();
    try {
      await unlink(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    throw error;
  } finally {
    if (target.fd !== -1) await target.close();
  }
  const outputSha256 = outputHash.digest("hex");
  const [tracksStat, enrichmentStat, tracksSha256, enrichmentSha256] = await Promise.all([
    stat(tracks), stat(enrichments), sha256File(tracks), sha256File(enrichments),
  ]);
  const reportValue = {
    schema: "zugfolge-track-enrichment-merge-report/v1",
    inputs: {
      tracks: { file: basename(tracks), bytes: tracksStat.size, sha256: tracksSha256 },
      copernicusDem: { file: basename(enrichments), bytes: enrichmentStat.size, sha256: enrichmentSha256 },
    },
    output: { file: basename(output), bytes: outputBytes, sha256: outputSha256 },
    counts: { featureCount: count, derivedCount, unresolvedCount },
    contract: {
      joinKey: "properties.feature_id",
      geometryMustMatch: true,
      existingPropertiesPreserved: true,
      gradientClassAEligible: false,
      unresolvedExplicit: true,
    },
  };
  await writeFile(reportTemporary, `${JSON.stringify(reportValue, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, output);
  await rename(reportTemporary, report);
  return { ...reportValue.counts, output, outputBytes, outputSha256, report };
}
