import assert from "node:assert/strict";
import test from "node:test";

import { buildAnnualPlan, buildPublicInfraRelease, validateCaptureManifest, validateRightsRegistry } from "./release-manifest.mjs";

const hash = (character) => character.repeat(64);
const config = {
  schema: "zugfolge-germany-release-config/v1",
  release: { releaseId: "infra-deutschland-2027.1", timetableYear: 2027 },
  pipeline: {
    version: "test/1",
    officialAdapters: {
      dbInfraGoGeoPackage: {
        sourceId: "db-infrago-infrastructure-open-data",
        entrypoint: "tools/region-import/germany/run-infrago-gpkg-adapter.mjs",
        outputs: ["tracks.jsonseq", "places.jsonseq", "report.json"],
      },
      openStationNetex: {
        sourceId: "openstation-enrichment",
        entrypoint: "tools/region-import/germany/run-openstation-netex-adapter.mjs",
        outputs: ["stations.jsonseq", "places.geojsonseq", "platforms.geojsonseq", "report.json"],
      },
      copernicusDemGlo30: {
        sourceId: "copernicus-dem-germany",
        rightsSourceId: "dem-hoehenmodell",
        entrypoint: "tools/region-import/germany/run-copernicus-dem.mjs",
        samplingPolicy: { intervalMm: 30_000, minimumBaselineMm: 200_000, analysisWindowMm: 400_000, maximumAbsoluteGradientPermille: 70, maximumUncertaintyPermille: 50, classAEligible: false },
        outputs: ["gradient.jsonseq", "quality.json", "evidence.json"],
      },
    },
    postProcessors: {
      mergeTrackGradient: {
        entrypoint: "tools/region-import/germany/run-merge-track-enrichment.mjs",
        joinKey: "properties.feature_id",
        geometryMustMatch: true,
        existingPropertiesPreserved: true,
        output: "official-enriched-dem/tracks.geojsonseq",
        report: "official-enriched-dem/tracks.geojsonseq.report.json",
      },
    },
  },
};
const catalog = {
  schema: "zugfolge-germany-source-catalog/v1",
  sources: [
    {
      id: "osm-de", rightsSourceId: "osm-pbf-deutschland", role: "release-input", shipAttribution: true,
      sourceLicense: "ODbL-1.0", attribution: "© OpenStreetMap-Mitwirkende", modifications: "EBO-Filter",
    },
    {
      id: "db-infrago-infrastructure-open-data", rightsSourceId: "db-infrago-infrastrukturdaten-open-data", role: "release-input", shipAttribution: true,
      sourceLicense: "CC-BY-4.0", attribution: "DB InfraGO, CC BY 4.0", modifications: "Normalisiert",
    },
    {
      id: "copernicus-dem-germany", rightsSourceId: "dem-hoehenmodell", role: "release-input", shipAttribution: true,
      sourceLicense: "Copernicus DEM Data Access and Use Terms", attribution: "Copernicus DEM", modifications: "Entlang der Gleise abgetastet",
    },
    {
      id: "openstation-enrichment", rightsSourceId: "openstation", role: "release-input", shipAttribution: true,
      sourceLicense: "CC0-1.0", attribution: "OpenStation, CC0", modifications: "Normalisiert",
    },
    {
      id: "internal-station-plan-evidence", rightsSourceId: "apn-validierung", role: "internal-validation", shipAttribution: false,
      sourceLicense: "interne Projektfreigabe", classAEligible: false, forbiddenShippingTokens: ["apn", "trassenfinder.de/apn"],
    },
  ],
};
const capture = {
  schema: "zugfolge-source-capture/v1",
  capturedAt: "2026-12-01T10:00:00Z",
  internalEvidenceLedgerSha256: hash("e"),
  sources: [
    { id: "osm-de", version: "2026-12-01", file: "sources/germany.osm.pbf", bytes: 100, sha256: hash("a") },
    { id: "db-infrago-infrastructure-open-data", version: "2026-12-01", file: "sources/infrago.gpkg", bytes: 200, sha256: hash("d") },
    { id: "copernicus-dem-germany", version: "2021", file: "sources/copernicus-dem.json", bytes: 300, sha256: hash("f") },
    { id: "openstation-enrichment", version: "2026-12-01", file: "sources/openstation.xml", bytes: 400, sha256: hash("9") },
    { id: "internal-station-plan-evidence", version: "2026-12-01", file: "internal/apn.zip", bytes: 50, sha256: hash("b") },
  ],
};
const rightsRegistry = {
  version: 1,
  quellen: [
    { id: "osm-pbf-deutschland", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
    { id: "db-infrago-infrastrukturdaten-open-data", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
    { id: "dem-hoehenmodell", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
    { id: "openstation", status: "freigegeben", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
    { id: "apn-validierung", status: "entwicklung", entscheidung: { datum: "2026-08-12", pruefer: "Test" } },
  ],
};
const artifacts = [{ id: "infracorpus", file: "infra/de.jsonseq", bytes: 123, sha256: hash("c") }];
const qualityReport = {
  schema: "zugfolge-infrastructure-quality-report/v2",
  totalLengthMm: 999,
  byClassLengthMm: { A: 100, B: 899, C: 0 },
};

test("öffentlicher InfraRelease enthält Attributionen, aber keine interne APN-Kennung", () => {
  const result = buildPublicInfraRelease({ config, catalog, rightsRegistry, capture, artifacts, qualityReport });
  assert.deepEqual(result.release.sources.map(({ id }) => id), ["copernicus-dem-germany", "db-infrago-infrastructure-open-data", "openstation-enrichment", "osm-de"]);
  assert.equal(result.release.corpus.loadedOnServer, "complete");
  assert.equal(result.release.corpus.playableScope, "separate-world-mask");
  assert.equal(result.release.validation.additionalInternalValidationApplied, true);
  assert.equal(result.release.validation.rawValidationMaterialShipped, false);
  assert.equal("internalEvidenceLedgerSha256" in result.release.validation, false);
  const shipped = JSON.stringify(result).toLowerCase();
  assert.equal(shipped.includes("apn"), false);
  assert.equal(shipped.includes("internal-station-plan-evidence"), false);
  assert.equal("captureSha256" in result.release.annualBuild, false);
  const changedInternalLedger = buildPublicInfraRelease({
    config,
    catalog,
    rightsRegistry,
    capture: { ...capture, internalEvidenceLedgerSha256: hash("f") },
    artifacts,
    qualityReport,
  });
  assert.equal(changedInternalLedger.release.annualBuild.publicCaptureSha256, result.release.annualBuild.publicCaptureSha256);
});

test("öffentlicher InfraRelease bindet den finalen deutschlandweiten 10-Layer-Qualitätsbericht", () => {
  const finalQualityReport = {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: config.release.releaseId,
    timetableYear: config.release.timetableYear,
    deterministic: true,
    policy: { classAFromSingleSourceOrAutomatedInference: false },
    summary: {
      visibleLayers: 10,
      visibleFeatures: 1_600_662,
      qualityClassFeatureCount: { A: 0, B: 1_489_960, C: 110_702 },
    },
    layers: [{
      name: "tracks",
      totalLengthMm: 83_491_261_974,
      qualityClassLengthMm: { A: 0, B: 83_491_089_540, C: 172_434 },
    }],
  };
  const result = buildPublicInfraRelease({ config, catalog, rightsRegistry, capture, artifacts, qualityReport: finalQualityReport });
  assert.deepEqual(result.release.quality, {
    reportSha256: result.release.quality.reportSha256,
    totalLengthMm: 83_491_261_974,
    byClassLengthMm: { A: 0, B: 83_491_089_540, C: 172_434 },
    visibleFeatures: 1_600_662,
    byClassFeatureCount: { A: 0, B: 1_489_960, C: 110_702 },
    visibleLayers: 10,
    classCPlayable: false,
  });
});

test("Capture ohne vollständigen internen Evidenzhash fällt vor dem Build auf", () => {
  assert.throws(() => validateCaptureManifest({ ...capture, internalEvidenceLedgerSha256: "" }, catalog), /Evidenzledgers/);
});

test("Jahresplan endet erst nach Holdout und Signatur", () => {
  const plan = buildAnnualPlan(config, catalog, rightsRegistry);
  assert.equal(plan.stages.some(({ id, proof, sourceId }) => id === "official-infrago-normalization" && proof === "strict-schema-report-and-deterministic-jsonseq-hashes" && sourceId === "db-infrago-infrastructure-open-data"), true);
  assert.equal(plan.stages.some(({ id, proof, sourceId }) => id === "openstation-normalization" && proof === "streamed-netex-report-and-deterministic-station-layer-hashes" && sourceId === "openstation-enrichment"), true);
  assert.equal(plan.stages.some(({ id, proof, sourceId }) => id === "copernicus-dem-gradient" && proof === "pinned-cog-hashes-complete-sampling-and-uncertainty-report" && sourceId === "copernicus-dem-germany"), true);
  assert.equal(plan.stages.some(({ id, proof, output }) => id === "copernicus-dem-track-merge" && proof === "strict-feature-id-geometry-count-and-sha256-report" && output === "official-enriched-dem/tracks.geojsonseq"), true);
  assert.deepEqual(plan.stages.slice(-2).map(({ id }) => id), ["independent-validation", "signature"]);
});

test("fehlende zentrale Rechte-ID blockiert bereits den Jahresplan", () => {
  assert.throws(() => validateRightsRegistry(catalog, { version: 1, quellen: rightsRegistry.quellen.filter(({ id }) => id !== "apn-validierung") }), /apn-validierung/);
});
