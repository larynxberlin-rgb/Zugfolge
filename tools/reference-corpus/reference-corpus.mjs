import { createHash, createPublicKey, KeyObject, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CORPUS_SCHEMA = "zugfolge-reference-corpus/v2";
export const MODEL_RESULTS_SCHEMA = "zugfolge-model-results/v2";
export const REPORT_SCHEMA = "zugfolge-reference-report/v2";
export const BUNDLE_SCHEMA = "zugfolge-pilot-release-bundle/v2";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function integer(value, name, minimum = 0) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} muss eine ganze Zahl >= ${minimum} sein.`);
}

function nonEmpty(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function sha256Hex(value, name) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), `${name} muss ein SHA-256-Hash sein.`);
}

function quantileNearestRank(sorted, ratio) {
  invariant(sorted.length > 0, "Quantil einer leeren Stichprobe ist nicht definiert.");
  const index = Math.ceil(ratio * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function observationGroupKey(observation) {
  return [
    observation.routeId,
    observation.fromEva,
    observation.toEva,
    observation.direction,
    observation.stopPattern,
    observation.characteristicsId,
    observation.trainCategory,
  ].join("|");
}

export function validateObservation(observation, index) {
  const prefix = `Beobachtung ${index}`;
  for (const field of [
    "sourceId",
    "tripId",
    "serviceDate",
    "routeId",
    "fromEva",
    "toEva",
    "direction",
    "stopPattern",
    "characteristicsId",
    "trainCategory",
    "trainNumber",
  ]) {
    nonEmpty(observation[field], `${prefix}.${field}`);
  }
  integer(observation.plannedDepartureEpochSeconds, `${prefix}.plannedDepartureEpochSeconds`);
  integer(observation.plannedArrivalEpochSeconds, `${prefix}.plannedArrivalEpochSeconds`);
  integer(observation.scheduledDwellSeconds ?? 0, `${prefix}.scheduledDwellSeconds`);
  invariant(
    observation.plannedArrivalEpochSeconds > observation.plannedDepartureEpochSeconds,
    `${prefix}: Ankunft muss nach Abfahrt liegen.`,
  );
  invariant(
    (observation.scheduledDwellSeconds ?? 0) <=
      observation.plannedArrivalEpochSeconds - observation.plannedDepartureEpochSeconds,
    `${prefix}: Haltezeit darf die Gesamtfahrzeit nicht überschreiten.`,
  );
  if (observation.changedDepartureEpochSeconds !== undefined) {
    integer(observation.changedDepartureEpochSeconds, `${prefix}.changedDepartureEpochSeconds`);
  }
  if (observation.changedArrivalEpochSeconds !== undefined) {
    integer(observation.changedArrivalEpochSeconds, `${prefix}.changedArrivalEpochSeconds`);
  }
  return Object.freeze({ ...observation, scheduledDwellSeconds: observation.scheduledDwellSeconds ?? 0 });
}

export function buildReferenceCorpus(input) {
  invariant(Array.isArray(input.observations), "observations muss eine Liste sein.");
  integer(input.minimumSamples ?? 5, "minimumSamples", 2);
  const observations = input.observations.map(validateObservation);
  const byGroup = new Map();
  for (const observation of observations) {
    const key = observationGroupKey(observation);
    const group = byGroup.get(key) ?? [];
    group.push(observation);
    byGroup.set(key, group);
  }

  const groups = [];
  for (const [key, values] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    invariant(
      values.length >= (input.minimumSamples ?? 5),
      `${key}: nur ${values.length} statt mindestens ${input.minimumSamples ?? 5} vergleichbare Läufe.`,
    );
    const scheduledDurations = values
      .map((value) => value.plannedArrivalEpochSeconds - value.plannedDepartureEpochSeconds)
      .sort((a, b) => a - b);
    const scheduledDwells = values.map((value) => value.scheduledDwellSeconds).sort((a, b) => a - b);
    const scheduledRunning = values
      .map(
        (value) =>
          value.plannedArrivalEpochSeconds -
          value.plannedDepartureEpochSeconds -
          value.scheduledDwellSeconds,
      )
      .sort((a, b) => a - b);
    const changed = values
      .filter(
        (value) =>
          value.changedDepartureEpochSeconds !== undefined &&
          value.changedArrivalEpochSeconds !== undefined &&
          value.changedArrivalEpochSeconds > value.changedDepartureEpochSeconds,
      )
      .map((value) => value.changedArrivalEpochSeconds - value.changedDepartureEpochSeconds)
      .sort((a, b) => a - b);
    const first = values[0];
    groups.push(
      Object.freeze({
        id: sha256(key).slice(0, 16),
        routeId: first.routeId,
        fromEva: first.fromEva,
        toEva: first.toEva,
        direction: first.direction,
        stopPattern: first.stopPattern,
        characteristicsId: first.characteristicsId,
        trainCategory: first.trainCategory,
        sampleCount: values.length,
        scheduledDurationP20Seconds: quantileNearestRank(scheduledDurations, 0.2),
        scheduledDurationMedianSeconds: median(scheduledDurations),
        scheduledDurationMeanSeconds: Math.round(
          scheduledDurations.reduce((sum, value) => sum + value, 0) / scheduledDurations.length,
        ),
        scheduledRunningP20Seconds: quantileNearestRank(scheduledRunning, 0.2),
        scheduledDwellP20Seconds: quantileNearestRank(scheduledDwells, 0.2),
        observedDurationMedianSeconds: changed.length >= 3 ? median(changed) : null,
        observedSampleCount: changed.length,
        minimumScheduledDurationSeconds: scheduledDurations[0],
        maximumScheduledDurationSeconds: scheduledDurations.at(-1),
        observationIds: values.map((value) => value.tripId).sort(),
      }),
    );
  }

  return Object.freeze({
    schema: CORPUS_SCHEMA,
    region: input.region,
    schedulePeriod: input.schedulePeriod,
    generatedAt: input.generatedAt,
    source: input.source,
    methodology: Object.freeze({
      timetableReference:
        "P20, Median und arithmetisches Mittel der Sollfahrzeiten bei identischer Linie, Strecke, Richtung, Haltefolge und Zugcharakteristik",
      scheduledRunning:
        "Sollfahrzeit abzüglich der in GTFS ausgewiesenen Zwischenhalte; enthält weiterhin Fahrplanreserven und ist keine technische Fahrzeitreferenz",
      technicalReference:
        "Muss aus einer unabhängigen Infrastruktur-/Fahrdynamikquelle stammen; GTFS-Sollzeiten werden dafür ausdrücklich nicht verwendet",
      observedReference: "Median vorhandener Istfahrzeiten; nur informativ und erst ab drei Beobachtungen",
    }),
    groups: Object.freeze(groups),
    observationsSha256: sha256(canonicalJson(observations)),
  });
}

export function compareWithModel(corpus, modelResults, tolerance = { absoluteSeconds: 30, relativeBasisPoints: 500 }) {
  invariant(corpus.schema === CORPUS_SCHEMA, "Unbekanntes Korpus-Schema.");
  invariant(modelResults?.schema === MODEL_RESULTS_SCHEMA, "Unbekanntes Modellergebnis-Schema.");
  sha256Hex(modelResults.releaseChecksum, "modelResults.releaseChecksum");
  sha256Hex(modelResults.modelInputSha256, "modelResults.modelInputSha256");
  invariant(
    modelResults.qualification === "calibration-only" || modelResults.qualification === "validation",
    "modelResults.qualification muss 'calibration-only' oder 'validation' sein.",
  );
  nonEmpty(modelResults.technicalReference?.sourceId, "modelResults.technicalReference.sourceId");
  sha256Hex(
    modelResults.technicalReference?.artifactSha256,
    "modelResults.technicalReference.artifactSha256",
  );
  integer(modelResults.technicalReference?.runningSeconds, "modelResults.technicalReference.runningSeconds", 1);
  invariant(Array.isArray(modelResults.results), "modelResults.results muss eine Liste sein.");
  integer(tolerance.absoluteSeconds, "absoluteSeconds", 0);
  integer(tolerance.relativeBasisPoints, "relativeBasisPoints", 0);
  const corpusById = new Map(corpus.groups.map((group) => [group.id, group]));
  const seen = new Set();
  for (const result of modelResults.results) {
    nonEmpty(result.groupId, "modelResults.results[].groupId");
  }
  const comparisons = modelResults.results.map((result) => {
    invariant(!seen.has(result.groupId), `Modellergebnis für Gruppe ${result.groupId} ist doppelt.`);
    seen.add(result.groupId);
    const group = corpusById.get(result.groupId);
    invariant(group, `Referenzgruppe ${result.groupId} fehlt im Fahrplankorpus.`);
    invariant(result.characteristicsId === group.characteristicsId, `${group.id}: Zugcharakteristik stimmt nicht überein.`);
    nonEmpty(result.calibrationMethod, `${group.id}.calibrationMethod`);
    integer(result.rawRunningSeconds, `${group.id}.rawRunningSeconds`, 1);
    integer(result.runningSeconds, `${group.id}.runningSeconds`, 1);
    integer(result.dwellSeconds, `${group.id}.dwellSeconds`);
    integer(result.modeledTimetableSeconds, `${group.id}.modeledTimetableSeconds`, 1);
    integer(result.technicalReferenceSeconds, `${group.id}.technicalReferenceSeconds`, 1);
    invariant(
      result.technicalReferenceSeconds === modelResults.technicalReference.runningSeconds,
      `${group.id}: technische Referenz stimmt nicht mit dem gebundenen Artefakt überein.`,
    );
    const allowance = Math.max(
      tolerance.absoluteSeconds,
      Math.ceil((result.technicalReferenceSeconds * tolerance.relativeBasisPoints) / 10_000),
    );
    const deviation = result.runningSeconds - result.technicalReferenceSeconds;
    const modeledTimetableSeconds = result.runningSeconds + result.dwellSeconds;
    invariant(
      result.modeledTimetableSeconds === modeledTimetableSeconds,
      `${group.id}: modellierte Fahrplanzeit stimmt nicht mit Lauf- plus Haltezeit überein.`,
    );
    return Object.freeze({
      groupId: group.id,
      characteristicsId: group.characteristicsId,
      trainCategory: group.trainCategory,
      calibrationMethod: result.calibrationMethod,
      rawRunningSeconds: result.rawRunningSeconds,
      calculatedTechnicalSeconds: result.runningSeconds,
      technicalReferenceSeconds: result.technicalReferenceSeconds,
      technicalDeviationSeconds: deviation,
      toleranceSeconds: allowance,
      technicalWithinTolerance: Math.abs(deviation) <= allowance,
      scheduledDurationP20Seconds: group.scheduledDurationP20Seconds,
      scheduledRunningP20Seconds: group.scheduledRunningP20Seconds,
      scheduledDwellP20Seconds: group.scheduledDwellP20Seconds,
      modeledTimetableSeconds,
      scheduledAllowanceSeconds: group.scheduledDurationP20Seconds - modeledTimetableSeconds,
      sampleCount: group.sampleCount,
    });
  });
  for (const group of corpus.groups) {
    invariant(seen.has(group.id), `Modellergebnis für Gruppe ${group.id} fehlt.`);
  }
  const passed = comparisons.length > 0 && comparisons.every((comparison) => comparison.technicalWithinTolerance);
  return Object.freeze({
    schema: REPORT_SCHEMA,
    corpusSha256: sha256(canonicalJson(corpus)),
    releaseChecksum: modelResults.releaseChecksum,
    modelInputSha256: modelResults.modelInputSha256,
    technicalReference: modelResults.technicalReference,
    qualification: modelResults.qualification,
    tolerance,
    passed,
    releaseQualified: passed && modelResults.qualification === "validation",
    comparisons: Object.freeze(comparisons),
  });
}

export function verifyRegisteredSource(registry, source) {
  const entry = registry.quellen?.find((candidate) => candidate.id === source.id);
  invariant(entry, `Quelle '${source.id}' fehlt im Quellenregister.`);
  invariant(entry.status === "freigegeben", `Quelle '${source.id}' ist nicht für Import freigegeben.`);
  invariant(entry.lizenz === source.sourceLicense, `Lizenz von '${source.id}' weicht vom Quellenregister ab.`);
  nonEmpty(source.attribution, "source.attribution");
  nonEmpty(source.retrievedAt, "source.retrievedAt");
  nonEmpty(source.apiVersion, "source.apiVersion");
  return entry;
}

export function createUnsignedBundle(input) {
  invariant(input.corpus.schema === CORPUS_SCHEMA, "Korpus-Schema ist nicht signierbar.");
  invariant(
    input.report.schema === REPORT_SCHEMA && input.report.passed && input.report.releaseQualified,
    "Nur ein bestandener, unabhängiger Validierungsreport darf signiert werden.",
  );
  invariant(input.report.corpusSha256 === sha256(canonicalJson(input.corpus)), "Report gehört nicht zu diesem Korpus.");
  nonEmpty(input.report.releaseChecksum, "report.releaseChecksum");
  nonEmpty(input.report.modelInputSha256, "report.modelInputSha256");
  nonEmpty(input.releasePath, "releasePath");
  nonEmpty(input.releaseSha256, "releaseSha256");
  return Object.freeze({
    schema: BUNDLE_SCHEMA,
    region: input.corpus.region,
    schedulePeriod: input.corpus.schedulePeriod,
    corpusSha256: sha256(canonicalJson(input.corpus)),
    reportSha256: sha256(canonicalJson(input.report)),
    releasePath: input.releasePath,
    releaseSha256: input.releaseSha256,
    releaseChecksum: input.report.releaseChecksum,
    modelInputSha256: input.report.modelInputSha256,
    source: input.corpus.source,
    createdAt: input.createdAt,
  });
}

export function signBundle(bundle, privateKeyPem) {
  invariant(bundle.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  const publicKey = createPublicKey(privateKeyPem);
  const payload = Buffer.from(canonicalJson(bundle));
  return Object.freeze({
    bundle,
    signature: Object.freeze({
      algorithm: "Ed25519",
      publicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      valueBase64: cryptoSign(null, payload, privateKeyPem).toString("base64"),
    }),
  });
}

export function verifySignedBundle(signedBundle, publicKeyPem) {
  invariant(signedBundle.bundle?.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  invariant(signedBundle.signature?.algorithm === "Ed25519", "Nur Ed25519-Signaturen sind zulässig.");
  const publicKey = publicKeyPem instanceof KeyObject && publicKeyPem.type === "public"
    ? publicKeyPem
    : createPublicKey(publicKeyPem);
  invariant(
    signedBundle.signature.publicKeySha256 === sha256(publicKey.export({ type: "spki", format: "der" })),
    "Signatur wurde nicht mit dem erwarteten Release-Schlüssel erstellt.",
  );
  invariant(
    cryptoVerify(
      null,
      Buffer.from(canonicalJson(signedBundle.bundle)),
      publicKey,
      Buffer.from(signedBundle.signature.valueBase64, "base64"),
    ),
    "Signatur des Pilot-Releases ist ungültig.",
  );
  return signedBundle.bundle;
}

export async function verifyBundleFiles(signedBundle, publicKeyPem, rootDirectory) {
  const bundle = verifySignedBundle(signedBundle, publicKeyPem);
  const releasePath = path.resolve(rootDirectory, bundle.releasePath);
  invariant(
    releasePath.startsWith(`${path.resolve(rootDirectory)}${path.sep}`),
    "releasePath darf den Artefaktordner nicht verlassen.",
  );
  const release = await readFile(releasePath);
  invariant(sha256(release) === bundle.releaseSha256, "InfraRelease-Artefakt stimmt nicht mit dem signierten Hash überein.");
  return bundle;
}
