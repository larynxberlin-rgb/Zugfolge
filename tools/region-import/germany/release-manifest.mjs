import { canonical, sha256 } from "./quality-model.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateSourceCatalog(catalog) {
  invariant(catalog?.schema === "zugfolge-germany-source-catalog/v1", "Unbekanntes Quellenkatalogschema.");
  invariant(Array.isArray(catalog.sources) && catalog.sources.length > 0, "Quellenkatalog ist leer.");
  const ids = new Set();
  for (const source of catalog.sources) {
    invariant(typeof source.id === "string" && source.id !== "", "Quelle ohne ID.");
    invariant(!ids.has(source.id), `Doppelte Quelle ${source.id}.`);
    ids.add(source.id);
    invariant(typeof source.rightsSourceId === "string" && source.rightsSourceId !== "", `Quelle ${source.id} ohne Rechte-ID.`);
    invariant(typeof source.sourceLicense === "string" && source.sourceLicense !== "", `Quelle ${source.id} ohne Quellenlizenz.`);
    invariant(["release-input", "optional-release-input", "internal-validation"].includes(source.role), `Quelle ${source.id} mit unbekannter Rolle.`);
    invariant(typeof source.shipAttribution === "boolean", `Quelle ${source.id} ohne Auslieferungsregel.`);
    if (source.role === "internal-validation") {
      invariant(source.shipAttribution === false, `Interne Evidenz ${source.id} darf keine Auslieferungsattribution erzeugen.`);
      invariant(source.classAEligible === false, `Interne Evidenz ${source.id} darf nicht allein Klasse A erzeugen.`);
    }
    if (source.shipAttribution) invariant(typeof source.attribution === "string" && source.attribution !== "", `Quelle ${source.id} ohne Attribution.`);
  }
  return catalog;
}

export function validateRightsRegistry(catalog, registry) {
  validateSourceCatalog(catalog);
  invariant(Number.isSafeInteger(registry?.version) && Array.isArray(registry.quellen), "Unbekanntes Rechte-Registerschema.");
  const byId = new Map(registry.quellen.map((source) => [source.id, source]));
  for (const source of catalog.sources) {
    const rights = byId.get(source.rightsSourceId);
    invariant(rights !== undefined, `Rechtequelle ${source.rightsSourceId} für ${source.id} ist nicht registriert.`);
    if (["release-input", "optional-release-input"].includes(source.role)) invariant(rights.status === "freigegeben", `Rechtequelle ${source.rightsSourceId} für ${source.id} ist nicht freigegeben.`);
    if (source.role === "internal-validation") invariant(["entwicklung", "freigegeben"].includes(rights.status), `Interne Evidenzquelle ${source.rightsSourceId} ist nicht zur Entwicklung freigegeben.`);
    invariant(rights.entscheidung?.datum && rights.entscheidung?.pruefer, `Rechtequelle ${source.rightsSourceId} ohne datierte Freigabe.`);
  }
  return registry;
}

export function validateCaptureManifest(capture, catalog) {
  invariant(capture?.schema === "zugfolge-source-capture/v1", "Unbekanntes Capture-Schema.");
  invariant(/^\d{4}-\d{2}-\d{2}T/.test(capture.capturedAt), "Capture ohne UTC-Zeitpunkt.");
  invariant(SHA256.test(capture.internalEvidenceLedgerSha256), "Capture ohne Hash des internen Evidenzledgers.");
  const catalogById = new Map(catalog.sources.map((source) => [source.id, source]));
  invariant(Array.isArray(capture.sources), "Capture ohne Quellen.");
  const capturedIds = new Set();
  for (const source of capture.sources) {
    invariant(catalogById.has(source.id), `Capture nennt unbekannte Quelle ${source.id}.`);
    invariant(!capturedIds.has(source.id), `Capture nennt Quelle ${source.id} doppelt.`);
    capturedIds.add(source.id);
    invariant(typeof source.version === "string" && source.version !== "", `Capture ${source.id} ohne Version.`);
    invariant(typeof source.file === "string" && source.file !== "" && !source.file.includes(".."), `Capture ${source.id} mit ungültigem Dateipfad.`);
    invariant(Number.isSafeInteger(source.bytes) && source.bytes > 0, `Capture ${source.id} ohne Bytezahl.`);
    invariant(SHA256.test(source.sha256), `Capture ${source.id} ohne SHA-256.`);
  }
  for (const source of catalog.sources.filter(({ role }) => role === "release-input")) {
    invariant(capturedIds.has(source.id), `Pflichtquelle ${source.id} fehlt im Capture.`);
  }
  return capture;
}

function publicSource(source, captured) {
  return {
    id: source.id,
    rightsSourceId: source.rightsSourceId,
    version: captured.version,
    sha256: captured.sha256,
    sourceLicense: source.sourceLicense,
    attribution: source.attribution,
    modifications: source.modifications,
  };
}

function qualitySummary(qualityReport, config) {
  if (qualityReport?.schema === "zugfolge-infrastructure-quality-report/v2") {
    invariant(Number.isSafeInteger(qualityReport.totalLengthMm) && qualityReport.totalLengthMm > 0, "Qualitätsbericht ohne positive Gesamtlänge.");
    invariant(["A", "B", "C"].every((qualityClass) => Number.isSafeInteger(qualityReport.byClassLengthMm?.[qualityClass]) && qualityReport.byClassLengthMm[qualityClass] >= 0), "Qualitätsbericht ohne vollständige Klassenlängen.");
    return {
      totalLengthMm: qualityReport.totalLengthMm,
      byClassLengthMm: qualityReport.byClassLengthMm,
    };
  }
  invariant(qualityReport?.schema === "zugfolge-final-infrastructure-quality-report/v1", "Unbekannter Qualitätsbericht.");
  invariant(qualityReport.releaseId === config.release.releaseId, "Qualitätsbericht und InfraRelease nennen verschiedene Release-IDs.");
  invariant(qualityReport.timetableYear === config.release.timetableYear, "Qualitätsbericht und InfraRelease nennen verschiedene Fahrplanjahre.");
  invariant(qualityReport.deterministic === true && qualityReport.policy?.classAFromSingleSourceOrAutomatedInference === false, "Deutschland-Qualitätsbericht besitzt keinen konservativen Nachweisvertrag.");
  invariant(Number.isSafeInteger(qualityReport.summary?.visibleFeatures) && qualityReport.summary.visibleFeatures > 0, "Deutschland-Qualitätsbericht ohne sichtbaren Korpus.");
  invariant(["A", "B", "C"].every((qualityClass) => Number.isSafeInteger(qualityReport.summary.qualityClassFeatureCount?.[qualityClass]) && qualityReport.summary.qualityClassFeatureCount[qualityClass] >= 0), "Deutschland-Qualitätsbericht ohne vollständige Objektklassen.");
  const tracks = qualityReport.layers?.find(({ name }) => name === "tracks");
  invariant(tracks !== undefined && Number.isSafeInteger(tracks.totalLengthMm) && tracks.totalLengthMm > 0, "Deutschland-Qualitätsbericht ohne Gleislänge.");
  invariant(["A", "B", "C"].every((qualityClass) => Number.isSafeInteger(tracks.qualityClassLengthMm?.[qualityClass]) && tracks.qualityClassLengthMm[qualityClass] >= 0), "Deutschland-Qualitätsbericht ohne Gleislängen je Klasse.");
  invariant(["A", "B", "C"].reduce((sum, qualityClass) => sum + tracks.qualityClassLengthMm[qualityClass], 0) === tracks.totalLengthMm, "Gleislängen des Deutschland-Qualitätsberichts sind nicht vollständig.");
  return {
    totalLengthMm: tracks.totalLengthMm,
    byClassLengthMm: tracks.qualityClassLengthMm,
    visibleFeatures: qualityReport.summary.visibleFeatures,
    byClassFeatureCount: qualityReport.summary.qualityClassFeatureCount,
    visibleLayers: qualityReport.summary.visibleLayers,
  };
}

export function buildPublicInfraRelease({ config, catalog, rightsRegistry, capture, artifacts, qualityReport }) {
  validateSourceCatalog(catalog);
  validateRightsRegistry(catalog, rightsRegistry);
  validateCaptureManifest(capture, catalog);
  invariant(config?.schema === "zugfolge-germany-release-config/v1", "Unbekannte Deutschland-Konfiguration.");
  const quality = qualitySummary(qualityReport, config);
  invariant(Array.isArray(artifacts) && artifacts.length > 0, "InfraRelease ohne Artefakte.");
  for (const artifact of artifacts) {
    invariant(typeof artifact.id === "string" && artifact.id !== "", "Artefakt ohne ID.");
    invariant(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, `Artefakt ${artifact.id} ohne Bytezahl.`);
    invariant(SHA256.test(artifact.sha256), `Artefakt ${artifact.id} ohne SHA-256.`);
  }
  const capturedById = new Map(capture.sources.map((source) => [source.id, source]));
  const sources = catalog.sources
    .filter((source) => ["release-input", "optional-release-input"].includes(source.role) && source.shipAttribution && capturedById.has(source.id))
    .map((source) => publicSource(source, capturedById.get(source.id)))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const publicCapture = {
    schema: "zugfolge-public-source-capture/v1",
    capturedAt: capture.capturedAt,
    sources: sources.map(({ id, version, sha256: sourceSha256 }) => ({ id, version, sha256: sourceSha256 })),
  };
  const internalEvidence = catalog.sources.filter((source) => source.role === "internal-validation");
  const release = {
    schema: "zugfolge-infra-release/v2",
    releaseId: config.release.releaseId,
    timetableYear: config.release.timetableYear,
    corpus: {
      id: "deutschland-ebo",
      loadedOnServer: "complete",
      visibleScope: "complete-germany",
      modelledScope: "quality-a-and-b",
      playableScope: "separate-world-mask",
    },
    sources,
    artifacts: [...artifacts].sort((left, right) => left.id.localeCompare(right.id, "en")),
    quality: {
      reportSha256: sha256(qualityReport),
      totalLengthMm: quality.totalLengthMm,
      byClassLengthMm: quality.byClassLengthMm,
      ...(quality.visibleFeatures === undefined ? {} : {
        visibleFeatures: quality.visibleFeatures,
        byClassFeatureCount: quality.byClassFeatureCount,
        visibleLayers: quality.visibleLayers,
      }),
      classCPlayable: false,
    },
    validation: {
      additionalInternalValidationApplied: internalEvidence.length > 0,
      rawValidationMaterialShipped: false,
    },
    annualBuild: {
      pipelineVersion: config.pipeline.version,
      configSha256: sha256(config),
      publicCaptureSha256: sha256(publicCapture),
    },
  };
  const serialized = canonical(release).toLowerCase();
  for (const source of internalEvidence) {
    invariant(!serialized.includes(source.id.toLowerCase()), `Interne Evidenzquelle ${source.id} ist in den auszuliefernden Release gelangt.`);
    for (const forbidden of source.forbiddenShippingTokens ?? []) {
      invariant(!serialized.includes(forbidden.toLowerCase()), `Interne Evidenzkennung ${forbidden} ist in den auszuliefernden Release gelangt.`);
    }
  }
  return { release, releaseHash: sha256(release) };
}

export function buildAnnualPlan(config, catalog, rightsRegistry) {
  validateSourceCatalog(catalog);
  validateRightsRegistry(catalog, rightsRegistry);
  invariant(config?.schema === "zugfolge-germany-release-config/v1", "Unbekannte Deutschland-Konfiguration.");
  const infraGoAdapter = config.pipeline?.officialAdapters?.dbInfraGoGeoPackage;
  invariant(infraGoAdapter?.sourceId === "db-infrago-infrastructure-open-data", "Offizieller DB-InfraGO-GeoPackage-Adapter fehlt in der Deutschland-Konfiguration.");
  invariant(typeof infraGoAdapter.entrypoint === "string" && infraGoAdapter.entrypoint !== "", "DB-InfraGO-GeoPackage-Adapter ohne Einstiegspunkt.");
  invariant(Array.isArray(infraGoAdapter.outputs) && infraGoAdapter.outputs.length === 3, "DB-InfraGO-GeoPackage-Adapter ohne vollständigen Ausgabevertrag.");
  invariant(catalog.sources.some(({ id }) => id === infraGoAdapter.sourceId), `Adapterquelle ${infraGoAdapter.sourceId} fehlt im Quellenkatalog.`);
  const openStationAdapter = config.pipeline?.officialAdapters?.openStationNetex;
  invariant(openStationAdapter?.sourceId === "openstation-enrichment", "OpenStation-NeTEx-Adapter fehlt in der Deutschland-Konfiguration.");
  invariant(typeof openStationAdapter.entrypoint === "string" && openStationAdapter.entrypoint !== "", "OpenStation-NeTEx-Adapter ohne Einstiegspunkt.");
  invariant(Array.isArray(openStationAdapter.outputs) && openStationAdapter.outputs.length === 4, "OpenStation-NeTEx-Adapter ohne vollständigen Ausgabevertrag.");
  invariant(catalog.sources.some(({ id }) => id === openStationAdapter.sourceId), `Adapterquelle ${openStationAdapter.sourceId} fehlt im Quellenkatalog.`);
  const demAdapter = config.pipeline?.officialAdapters?.copernicusDemGlo30;
  invariant(demAdapter?.sourceId === "copernicus-dem-germany" && demAdapter?.rightsSourceId === "dem-hoehenmodell", "Copernicus-GLO-30-Adapter fehlt in der Deutschland-Konfiguration.");
  invariant(typeof demAdapter.entrypoint === "string" && demAdapter.entrypoint !== "", "Copernicus-GLO-30-Adapter ohne Einstiegspunkt.");
  invariant(Number.isSafeInteger(demAdapter.samplingPolicy?.intervalMm) && demAdapter.samplingPolicy.intervalMm > 0, "Copernicus-GLO-30-Adapter ohne Stichprobenabstand.");
  invariant(Number.isSafeInteger(demAdapter.samplingPolicy?.minimumBaselineMm) && demAdapter.samplingPolicy.minimumBaselineMm >= 200_000, "Copernicus-GLO-30-Adapter unterschreitet die 200-m-Mindeststuetzweite.");
  invariant(demAdapter.samplingPolicy?.analysisWindowMm >= demAdapter.samplingPolicy.minimumBaselineMm, "Copernicus-GLO-30-Analysefenster ist kuerzer als die Mindeststuetzweite.");
  invariant(Number.isSafeInteger(demAdapter.samplingPolicy?.maximumAbsoluteGradientPermille) && demAdapter.samplingPolicy.maximumAbsoluteGradientPermille > 0, "Copernicus-GLO-30-Adapter ohne Neigungsplausibilitaetsgrenze.");
  invariant(Number.isSafeInteger(demAdapter.samplingPolicy?.maximumUncertaintyPermille) && demAdapter.samplingPolicy.maximumUncertaintyPermille > 0, "Copernicus-GLO-30-Adapter ohne Unsicherheitsgrenze.");
  invariant(demAdapter.samplingPolicy?.classAEligible === false, "Copernicus DEM darf allein keine Klasse-A-Evidenz sein.");
  invariant(Array.isArray(demAdapter.outputs) && demAdapter.outputs.length === 3, "Copernicus-GLO-30-Adapter ohne vollstaendigen Ausgabevertrag.");
  invariant(catalog.sources.some(({ id, rightsSourceId }) => id === demAdapter.sourceId && rightsSourceId === demAdapter.rightsSourceId), `Adapterquelle ${demAdapter.sourceId} fehlt im Quellenkatalog.`);
  const gradientMerge = config.pipeline?.postProcessors?.mergeTrackGradient;
  invariant(typeof gradientMerge?.entrypoint === "string" && gradientMerge.entrypoint !== "", "DEM-Gleis-Join ohne Einstiegspunkt.");
  invariant(gradientMerge.joinKey === "properties.feature_id" && gradientMerge.geometryMustMatch === true && gradientMerge.existingPropertiesPreserved === true, "DEM-Gleis-Join ist nicht streng an Kennung, Geometrie und Bestandseigenschaften gebunden.");
  invariant(typeof gradientMerge.output === "string" && gradientMerge.output.endsWith("/tracks.geojsonseq"), "DEM-Gleis-Join ohne finalen Tracklayer.");
  invariant(typeof gradientMerge.report === "string" && gradientMerge.report.endsWith(".report.json"), "DEM-Gleis-Join ohne Hashreport.");
  return {
    schema: "zugfolge-annual-infra-plan/v1",
    releaseId: config.release.releaseId,
    stages: [
      { id: "rights-gate", mutatesRelease: false, proof: "all-source-rights-approved" },
      { id: "capture", mutatesRelease: false, proof: "version-size-sha256-for-every-input" },
      {
        id: "official-infrago-normalization",
        mutatesRelease: true,
        sourceId: infraGoAdapter.sourceId,
        entrypoint: infraGoAdapter.entrypoint,
        outputs: [...infraGoAdapter.outputs],
        proof: "strict-schema-report-and-deterministic-jsonseq-hashes",
      },
      {
        id: "openstation-normalization",
        mutatesRelease: true,
        sourceId: openStationAdapter.sourceId,
        entrypoint: openStationAdapter.entrypoint,
        outputs: [...openStationAdapter.outputs],
        proof: "streamed-netex-report-and-deterministic-station-layer-hashes",
      },
      { id: "ebo-filter", mutatesRelease: true, proof: "filter-report" },
      {
        id: "copernicus-dem-gradient",
        mutatesRelease: true,
        sourceId: demAdapter.sourceId,
        entrypoint: demAdapter.entrypoint,
        outputs: [...demAdapter.outputs],
        proof: "pinned-cog-hashes-complete-sampling-and-uncertainty-report",
      },
      {
        id: "copernicus-dem-track-merge",
        mutatesRelease: true,
        entrypoint: gradientMerge.entrypoint,
        output: gradientMerge.output,
        report: gradientMerge.report,
        proof: "strict-feature-id-geometry-count-and-sha256-report",
      },
      { id: "topology-and-conservative-model", mutatesRelease: true, proof: "deterministic-corpus-hash" },
      { id: "internal-validation", mutatesRelease: true, proof: "accepted-evidence-receipts" },
      { id: "quality-report", mutatesRelease: false, proof: "dimension-cause-length-report" },
      { id: "tiles", mutatesRelease: true, proof: "self-hosted-pmtiles-hashes" },
      { id: "independent-validation", mutatesRelease: false, proof: "holdout-pass" },
      { id: "signature", mutatesRelease: false, proof: "release-responsible-signature" },
    ],
  };
}
