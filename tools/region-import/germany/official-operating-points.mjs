import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

export const OFFICIAL_OPERATING_POINTS_SPEC_SCHEMA =
  "zugfolge-official-operating-points/v1";
export const OFFICIAL_OPERATING_POINTS_REPORT_SCHEMA =
  "zugfolge-official-operating-points-report/v1";

const OUTPUT_FILE = "operating-points.geojsonseq";
const REPORT_FILE = "official-operating-points-report.json";
const OPERATING_PLACE_SCHEMA = "zugfolge-infrago-operating-place/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  const normalized = value.replaceAll("\\", "/");
  invariant(normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"), `${label} verlaesst die Repositorywurzel.`);
  return normalized;
}

export function validateOfficialOperatingPointsSpecification(specification) {
  exactKeys(specification, ["schema", "releaseId", "sourceFile", "outputDirectory", "allowedSourceId", "forbiddenSourceIds"], "Official-Operating-Points-Vertrag");
  invariant(specification.schema === OFFICIAL_OPERATING_POINTS_SPEC_SCHEMA, "Official-Operating-Points-Vertrag besitzt ein unbekanntes Schema.");
  invariant(typeof specification.releaseId === "string" && specification.releaseId !== "", "Official-Operating-Points-Vertrag besitzt keine Release-ID.");
  specification.sourceFile = portablePath(specification.sourceFile, "sourceFile");
  specification.outputDirectory = portablePath(specification.outputDirectory, "outputDirectory");
  invariant(specification.sourceFile !== specification.outputDirectory, "Official-Operating-Points-Eingabe und -Ausgabe kollidieren.");
  invariant(specification.allowedSourceId === "db-infrago-infrastructure-open-data", "Nur DB-InfraGO-Open-Data darf den freien Betriebspunktlayer speisen.");
  invariant(Array.isArray(specification.forbiddenSourceIds), "forbiddenSourceIds muss eine Liste sein.");
  const sorted = [...specification.forbiddenSourceIds].sort((left, right) => left.localeCompare(right, "en"));
  invariant(JSON.stringify(sorted) === JSON.stringify(specification.forbiddenSourceIds) && new Set(sorted).size === sorted.length, "forbiddenSourceIds muss stabil sortiert und eindeutig sein.");
  for (const id of ["annual-infrastructure-master", "trassenfinder-infrastruktur-api"]) {
    invariant(specification.forbiddenSourceIds.includes(id), `Official-Operating-Points-Vertrag muss ${id} explizit ausschliessen.`);
  }
  return specification;
}

function e7Coordinate(value, label) {
  exactKeys(value, ["longitude", "latitude"], label);
  invariant(Number.isSafeInteger(value.longitude) && value.longitude >= -1_800_000_000 && value.longitude <= 1_800_000_000, `${label}.longitude ist ungueltig.`);
  invariant(Number.isSafeInteger(value.latitude) && value.latitude >= -900_000_000 && value.latitude <= 900_000_000, `${label}.latitude ist ungueltig.`);
  return value;
}

function validateOperatingPlace(place, index, specification, ids) {
  exactKeys(place, ["schema", "operatingPlaceId", "rl100", "name", "names", "coordinateE7", "coordinateCandidatesE7", "types", "operatingStates", "routeBindings", "sourceRecordIds"], `InfraGO-Betriebsstelle ${index}`);
  invariant(place.schema === OPERATING_PLACE_SCHEMA, `InfraGO-Betriebsstelle ${index} besitzt ein unbekanntes Schema.`);
  invariant(
    typeof place.rl100 === "string"
      && place.rl100.length <= 10
      && /^[A-Z0-9]+(?: [A-Z0-9]+)*$/u.test(place.rl100),
    `InfraGO-Betriebsstelle ${index} besitzt kein gueltiges RL100-Kuerzel.`,
  );
  invariant(place.operatingPlaceId === `db-infrago:rl100:${encodeURIComponent(place.rl100)}`, `InfraGO-Betriebsstelle ${place.rl100} besitzt keine stabile offizielle ID.`);
  invariant(!ids.has(place.operatingPlaceId), `InfraGO-Betriebsstelle ${place.operatingPlaceId} ist doppelt.`);
  ids.add(place.operatingPlaceId);
  invariant(typeof place.name === "string" && place.name.trim() !== "", `InfraGO-Betriebsstelle ${place.rl100} besitzt keinen Namen.`);
  e7Coordinate(place.coordinateE7, `InfraGO-Betriebsstelle ${place.rl100}.coordinateE7`);
  invariant(Array.isArray(place.coordinateCandidatesE7) && place.coordinateCandidatesE7.length > 0, `InfraGO-Betriebsstelle ${place.rl100} besitzt keine offiziellen Koordinatenkandidaten.`);
  place.coordinateCandidatesE7.forEach((value, candidateIndex) => e7Coordinate(value, `InfraGO-Betriebsstelle ${place.rl100}.coordinateCandidatesE7[${candidateIndex}]`));
  invariant(Array.isArray(place.types) && Array.isArray(place.operatingStates) && Array.isArray(place.routeBindings), `InfraGO-Betriebsstelle ${place.rl100} besitzt unvollstaendige offizielle Attribute.`);
  const routeNumbers = [...new Set(place.routeBindings.map(({ routeNumber }) => {
    invariant(Number.isSafeInteger(routeNumber) && routeNumber >= 1000 && routeNumber <= 9999, `InfraGO-Betriebsstelle ${place.rl100} besitzt eine ungueltige Streckennummer.`);
    return routeNumber;
  }))].sort((left, right) => left - right);
  const featureId = `operating-point:rl100:${place.rl100}`;
  const properties = {
    feature_id: featureId,
    feature_type: "operating-point",
    quality_class: "B",
    model_state: "observed_official_operating_place",
    orderable: false,
    source_id: specification.allowedSourceId,
    official_evidence_id: place.operatingPlaceId,
    rl100: place.rl100,
    name: place.name,
    types_json: JSON.stringify(place.types),
    operating_states_json: JSON.stringify(place.operatingStates),
    route_numbers_json: JSON.stringify(routeNumbers),
    official_coordinate_candidates_json: JSON.stringify(place.coordinateCandidatesE7),
    official_coordinate_candidate_count: place.coordinateCandidatesE7.length,
  };
  invariant(!Object.keys(properties).some((key) => key.startsWith("tf_")), `InfraGO-Betriebsstelle ${place.rl100} traegt Trassenfinder-Felder.`);
  invariant(!specification.forbiddenSourceIds.includes(properties.source_id), `InfraGO-Betriebsstelle ${place.rl100} stammt aus einer verbotenen Direktquelle.`);
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Point",
      coordinates: [place.coordinateE7.longitude / 10_000_000, place.coordinateE7.latitude / 10_000_000],
    },
  };
}

async function containedRegularFile(repositoryRoot, relativeFile, label) {
  const requested = resolve(repositoryRoot, portablePath(relativeFile, label));
  const remainder = relative(repositoryRoot, requested);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst die Repositorywurzel.`);
  const metadata = await lstat(requested);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine regulaere nichtleere Datei.`);
  const actual = await realpath(requested);
  const actualRemainder = relative(repositoryRoot, actual);
  invariant(actualRemainder !== "" && !actualRemainder.startsWith("..") && !isAbsolute(actualRemainder), `${label} verlaesst die Repositorywurzel ueber einen Link.`);
  return actual;
}

async function readValidatedFeatures(sourcePath, specification) {
  const features = [];
  const ids = new Set();
  for await (const raw of createInterface({ input: createReadStream(sourcePath, "utf8"), crlfDelay: Infinity })) {
    const line = raw.replace(/^\x1e/u, "").trim();
    if (line === "") continue;
    let place;
    try {
      place = JSON.parse(line);
    } catch (error) {
      throw new Error(`Betriebspunktzeile ${features.length + 1} ist kein JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    features.push(validateOperatingPlace(place, features.length + 1, specification, ids));
  }
  invariant(features.length > 0, "DB-InfraGO-Operating-Points-Eingabe ist leer.");
  features.sort((left, right) => left.properties.feature_id.localeCompare(right.properties.feature_id, "en"));
  return features;
}

async function writeSequence(path, features) {
  const handle = await open(path, "wx");
  const stream = createWriteStream(path, { fd: handle.fd, autoClose: false, encoding: "utf8" });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (const feature of features) {
      const line = `\x1e${JSON.stringify(feature)}\n`;
      hash.update(line);
      bytes += Buffer.byteLength(line);
      if (!stream.write(line)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    await handle.sync();
    await handle.close();
  } catch (error) {
    stream.destroy();
    if (handle.fd !== -1) await handle.close().catch(() => undefined);
    throw error;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function writeOfficialOperatingPoints({ specification, repositoryRoot = "." }) {
  const checked = validateOfficialOperatingPointsSpecification(specification);
  const repository = await realpath(resolve(repositoryRoot));
  const source = await containedRegularFile(repository, checked.sourceFile, "sourceFile");
  const output = resolve(repository, checked.outputDirectory);
  const outputRemainder = relative(repository, output);
  invariant(outputRemainder !== "" && !outputRemainder.startsWith("..") && !isAbsolute(outputRemainder), "outputDirectory verlaesst die Repositorywurzel.");
  try {
    await lstat(output);
    throw new Error(`Official-Operating-Points-Ausgabe existiert bereits: ${output}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const features = await readValidatedFeatures(source, checked);
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.building-${process.pid}-${randomUUID()}`;
  await mkdir(staging, { recursive: false });
  let complete = false;
  try {
    const artifact = await writeSequence(resolve(staging, OUTPUT_FILE), features);
    const report = {
      schema: OFFICIAL_OPERATING_POINTS_REPORT_SCHEMA,
      releaseId: checked.releaseId,
      sourceId: checked.allowedSourceId,
      inputFile: checked.sourceFile,
      outputFile: OUTPUT_FILE,
      features: features.length,
      forbiddenFallbackFeatures: 0,
      artifact,
    };
    const reportHandle = await open(resolve(staging, REPORT_FILE), "wx");
    try {
      await reportHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      await reportHandle.sync();
    } finally {
      await reportHandle.close();
    }
    await rename(staging, output);
    complete = true;
    return { outputDirectory: output, report };
  } finally {
    if (!complete) await rm(staging, { recursive: true, force: true });
  }
}

export const OFFICIAL_OPERATING_POINTS_OUTPUT_FILE = OUTPUT_FILE;
export const OFFICIAL_OPERATING_POINTS_REPORT_FILE = REPORT_FILE;
