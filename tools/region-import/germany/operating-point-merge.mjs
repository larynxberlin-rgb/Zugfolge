import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readSequence(path) {
  const values = [];
  for await (const raw of createInterface({ input: createReadStream(resolve(path), "utf8"), crlfDelay: Infinity })) {
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line !== "") values.push(JSON.parse(line));
  }
  return values;
}

function sequence(values) {
  return values.map((value) => `\x1e${JSON.stringify(value)}\n`).join("");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function groundDistanceMm(left, right) {
  const latitudeRadians = ((left[1] + right[1]) / 2) * Math.PI / 180;
  const latitudeM = (left[1] - right[1]) * 111_132;
  const longitudeM = (left[0] - right[0]) * 111_320 * Math.cos(latitudeRadians);
  return Math.round(Math.hypot(latitudeM, longitudeM) * 1_000);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
}

function tfOnlyFeature(point) {
  return {
    type: "Feature",
    properties: {
      feature_id: `operating-point:rl100:${encodeURIComponent(point.rl100)}`,
      feature_type: "operating-point",
      quality_class: "B",
      model_state: "observed_annual_operating_point_without_official_open_data_match",
      orderable: false,
      source_id: "trassenfinder-infrastruktur-api",
      rl100: point.rl100,
      name: point.name,
      electrified: point.electrified,
      station: point.station,
      primary_location_code: point.primaryLocationCode,
    },
    geometry: {
      type: "Point",
      coordinates: [point.coordinateE7.longitude / 10_000_000, point.coordinateE7.latitude / 10_000_000],
    },
  };
}

function officialCoordinateCandidates(feature) {
  const raw = feature.properties.official_coordinate_candidates_json;
  if (typeof raw !== "string") return [feature.geometry.coordinates];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Betriebspunkt ${feature.properties.rl100} besitzt ungültige amtliche Koordinatenkandidaten.`);
  }
  invariant(Array.isArray(parsed) && parsed.length > 0, `Betriebspunkt ${feature.properties.rl100} besitzt keine amtlichen Koordinatenkandidaten.`);
  return parsed.map((candidate) => {
    invariant(Number.isSafeInteger(candidate?.longitude) && Number.isSafeInteger(candidate?.latitude), `Betriebspunkt ${feature.properties.rl100} besitzt einen ungültigen Koordinatenkandidaten.`);
    return [candidate.longitude / 10_000_000, candidate.latitude / 10_000_000];
  });
}

export function mergeOperatingPointFeatures(officialFeatures, trassenfinderPoints) {
  const officialByRl100 = new Map();
  for (const feature of officialFeatures) {
    invariant(feature?.type === "Feature" && feature.geometry?.type === "Point", "Amtlicher Betriebsstellenlayer enthält kein Punktfeature.");
    const code = feature.properties?.rl100;
    invariant(typeof code === "string" && code !== "", "Amtlicher Betriebspunkt ohne RL100.");
    invariant(!officialByRl100.has(code), `Amtlicher Betriebspunkt ${code} ist doppelt.`);
    officialByRl100.set(code, feature);
  }
  const tfByRl100 = new Map();
  for (const point of trassenfinderPoints) {
    invariant(point?.schema === "zugfolge-trassenfinder-operating-point/v1", "Unbekannter jährlicher Betriebsstellenbeleg.");
    invariant(!tfByRl100.has(point.rl100), `Jährlicher Betriebspunkt ${point.rl100} ist doppelt.`);
    tfByRl100.set(point.rl100, point);
  }
  const distances = [];
  const conflicts = [];
  const merged = [];
  for (const [code, feature] of officialByRl100) {
    const corroboration = tfByRl100.get(code);
    if (corroboration?.coordinateE7 === null || corroboration === undefined) {
      merged.push(feature);
      continue;
    }
    const tfCoordinate = [corroboration.coordinateE7.longitude / 10_000_000, corroboration.coordinateE7.latitude / 10_000_000];
    const candidates = officialCoordinateCandidates(feature)
      .map((coordinate) => ({ coordinate, distanceMm: groundDistanceMm(coordinate, tfCoordinate) }))
      .sort((left, right) => left.distanceMm - right.distanceMm || left.coordinate[0] - right.coordinate[0] || left.coordinate[1] - right.coordinate[1]);
    const selected = candidates[0];
    const distanceMm = selected.distanceMm;
    distances.push(distanceMm);
    if (distanceMm > 250_000) conflicts.push({ rl100: code, coordinateDistanceMm: distanceMm });
    merged.push({
      ...feature,
      geometry: { ...feature.geometry, coordinates: selected.coordinate },
      properties: {
        ...feature.properties,
        quality_class: distanceMm <= 250_000 ? feature.properties.quality_class : "C",
        model_state: distanceMm <= 250_000
          ? "observed_official_operating_place_corroborated_annual_network"
          : "observed_official_operating_place_with_coordinate_conflict",
        tf_coordinate_distance_mm: distanceMm,
        tf_electrified: corroboration.electrified,
        tf_station: corroboration.station,
        tf_primary_location_code: corroboration.primaryLocationCode,
        official_coordinate_candidate_count: candidates.length,
      },
    });
  }
  let tfOnlyWithoutCoordinate = 0;
  for (const [code, point] of tfByRl100) {
    if (officialByRl100.has(code)) continue;
    if (point.coordinateE7 === null) {
      tfOnlyWithoutCoordinate += 1;
      continue;
    }
    merged.push(tfOnlyFeature(point));
  }
  merged.sort((left, right) => compareText(left.properties.feature_id, right.properties.feature_id));
  const sortedDistances = distances.sort((left, right) => left - right);
  return {
    features: merged,
    report: {
      schema: "zugfolge-operating-point-merge-report/v1",
      official: officialFeatures.length,
      annualNetwork: trassenfinderPoints.length,
      corroborated: distances.length,
      coordinateConflictsOver250m: conflicts.length,
      tfOnlyWithCoordinate: merged.length - officialFeatures.length,
      tfOnlyWithoutCoordinate,
      outputFeatures: merged.length,
      distanceMm: {
        median: percentile(sortedDistances, 0.5),
        p95: percentile(sortedDistances, 0.95),
        maximum: sortedDistances.at(-1) ?? null,
      },
      conflicts: conflicts.sort((left, right) => compareText(left.rl100, right.rl100)),
    },
  };
}

export async function writeMergedOperatingPoints(officialPath, trassenfinderPath, outputRoot) {
  const [official, trassenfinder] = await Promise.all([readSequence(officialPath), readSequence(trassenfinderPath)]);
  const { features, report } = mergeOperatingPointFeatures(official, trassenfinder);
  const content = sequence(features);
  const output = {
    ...report,
    artifact: { file: "operating-points.geojsonseq", bytes: Buffer.byteLength(content), sha256: sha256(content) },
  };
  await mkdir(resolve(outputRoot), { recursive: true });
  await Promise.all([
    writeFile(resolve(outputRoot, "operating-points.geojsonseq"), content, "utf8"),
    writeFile(resolve(outputRoot, "operating-point-merge-report.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8"),
  ]);
  return output;
}
