//! Reproduzierbarer M1.13-Modelllauf aus einer versionierten Pilotkonfiguration.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::error::Error;
use std::fs;
use std::io;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_infra::{
    Acceleration, BandProfile, Confidence, Coordinate, ElectricSystems, Electrification, Gradient,
    InfraRelease, Length, Mass, OperatingGraphBuilder, OperatingPoint, OperatingPointCode,
    OperatingPointId, OperatingPointKind, PowerSystem, ProtectionSystem, Provenance, ReleaseSource,
    ReleaseVersion, RunPath, SourceId, Speed, SpeedCategory, SpeedLimit, Track, TrackDirection,
    TrackEdge, TrackEdgeId, TrackId, TrackKind, TrackOwner, TractionType, TrainCharacteristics,
    TrainCharacteristicsId, TrainProtection, TravelDirection, derive_running_time_table_with_exit,
};

const CONFIG_SCHEMA: &str = "zugfolge-pilot-model/v2";
const RESULTS_SCHEMA: &str = "zugfolge-model-results/v2";
const RELEASE_SCHEMA: &str = "zugfolge-infra-release-manifest/v1";

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelConfig {
    schema: String,
    group_id: String,
    release: ReleaseConfig,
    characteristics: CharacteristicsConfig,
    operating_points: Vec<OperatingPointConfig>,
    segments: Vec<SegmentConfig>,
    intermediate_dwells: Vec<DwellConfig>,
    calibration: CalibrationConfig,
    comparison_basis: ComparisonBasis,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseConfig {
    version: VersionConfig,
    region: String,
    operating_point_source: SourceConfig,
    infrastructure_source: SourceConfig,
    station_track_length_metres: i64,
    station_track_speed_kph: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionConfig {
    major: u32,
    minor: u32,
    patch: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceConfig {
    id: String,
    source_license: String,
    attribution: String,
    confidence: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CharacteristicsConfig {
    id: String,
    numeric_id: u32,
    name: String,
    mass_tonnes: i64,
    length_metres: i64,
    maximum_speed_kph: i64,
    acceleration_millimetres_per_second_squared: i64,
    deceleration_millimetres_per_second_squared: i64,
    protection: Vec<String>,
    evidence: CharacteristicsEvidence,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CharacteristicsEvidence {
    confirmed: Vec<String>,
    assumptions: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperatingPointConfig {
    id: String,
    code: String,
    name: String,
    kind: String,
    latitude_e7: i32,
    longitude_e7: i32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SegmentConfig {
    id: String,
    from_operating_point_id: String,
    to_operating_point_id: String,
    distance_metres: i64,
    maximum_speed_kph: i64,
    gradient_per_mille_tenths: i32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DwellConfig {
    operating_point_id: String,
    seconds: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalibrationConfig {
    method: String,
    minimum_effective_speed_kph: i64,
    step_kph: i64,
    maximum_section_deviation_seconds: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComparisonBasis {
    timetable_corpus_path: String,
    corpus_group_id: String,
    source_archive_sha256: String,
    technical_reference: TechnicalReference,
    dwell_method: String,
    schedule_allowance_method: String,
    limitation: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TechnicalReference {
    source_id: String,
    artifact_path: String,
    artifact_sha256: String,
    retrieved_at: String,
    running_seconds: i64,
    sections: Vec<SectionReference>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SectionReference {
    segment_id: String,
    running_seconds: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualTechnicalReferenceArtifact {
    schema: String,
    result: ManualTechnicalReferenceResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualTechnicalReferenceResult {
    technical_running_seconds: i64,
    sections: Vec<ManualTechnicalReferenceSection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualTechnicalReferenceSection {
    technical_running_seconds: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelResults<'a> {
    schema: &'static str,
    qualification: &'static str,
    release_checksum: &'a str,
    model_input_sha256: &'a str,
    technical_reference: TechnicalReferenceSummary<'a>,
    results: Vec<ModelResult<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TechnicalReferenceSummary<'a> {
    source_id: &'a str,
    artifact_sha256: &'a str,
    running_seconds: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelResult<'a> {
    group_id: &'a str,
    characteristics_id: &'a str,
    calibration_method: &'a str,
    raw_running_seconds: i64,
    running_seconds: i64,
    dwell_seconds: i64,
    modeled_timetable_seconds: i64,
    technical_reference_seconds: i64,
    sections: Vec<SectionResult<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionResult<'a> {
    segment_id: &'a str,
    raw_running_seconds: i64,
    running_seconds: i64,
    effective_speed_kph: i64,
    dwell_after_seconds: i64,
    technical_reference_seconds: i64,
    technical_deviation_seconds: i64,
}

#[derive(Debug, Clone, Copy)]
struct CalibratedSection {
    raw_running_seconds: i64,
    running_seconds: i64,
    effective_speed_kph: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest<'a> {
    schema: &'static str,
    release_checksum: &'a str,
    model_input_sha256: &'a str,
    confidence: &'static str,
    limitation: &'a str,
    model_config: &'a ModelConfig,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn require(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(invalid(message).into())
    }
}

fn sha256_hex(input: &[u8]) -> String {
    Sha256::digest(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verify_technical_reference_artifact(config: &ModelConfig, input: &[u8]) -> Result<()> {
    let expected = &config.comparison_basis.technical_reference;
    require(
        sha256_hex(input) == expected.artifact_sha256,
        "Hash des technischen Referenzartefakts stimmt nicht",
    )?;
    let artifact: ManualTechnicalReferenceArtifact = serde_json::from_slice(input)?;
    require(
        artifact.schema == "zugfolge-manual-technical-reference/v1",
        "unbekanntes Schema des technischen Referenzartefakts",
    )?;
    require(
        artifact.result.technical_running_seconds == expected.running_seconds,
        "Gesamtlaufzeit des technischen Referenzartefakts stimmt nicht",
    )?;
    require(
        artifact.result.sections.len() == expected.sections.len()
            && artifact
                .result
                .sections
                .iter()
                .zip(&expected.sections)
                .all(|(actual, configured)| {
                    actual.technical_running_seconds == configured.running_seconds
                }),
        "Abschnittslaufzeiten des technischen Referenzartefakts stimmen nicht",
    )?;
    Ok(())
}

fn parse_confidence(value: &str) -> Result<Confidence> {
    match value {
        "assumed" => Ok(Confidence::Assumed),
        "derived" => Ok(Confidence::Derived),
        "surveyed" => Ok(Confidence::Surveyed),
        _ => Err(invalid(format!("unbekannte Confidence '{value}'")).into()),
    }
}

fn parse_kind(value: &str) -> Result<OperatingPointKind> {
    match value {
        "station" => Ok(OperatingPointKind::Station),
        "halt" => Ok(OperatingPointKind::Halt),
        _ => Err(invalid(format!("unbekannte Betriebsstellenart '{value}'")).into()),
    }
}

fn parse_protection(values: &[String]) -> Result<TrainProtection> {
    let mut systems = BTreeSet::new();
    for value in values {
        let system = match value.as_str() {
            "pzb" => ProtectionSystem::Pzb,
            "lzb" => ProtectionSystem::Lzb,
            "etcs-l1" => ProtectionSystem::EtcsLevel1,
            "etcs-l2" => ProtectionSystem::EtcsLevel2,
            _ => return Err(invalid(format!("unbekannte Zugsicherung '{value}'")).into()),
        };
        systems.insert(system);
    }
    require(
        !systems.is_empty(),
        "mindestens eine Zugsicherung ist erforderlich",
    )?;
    Ok(TrainProtection::from_systems(systems))
}

fn provenance(source: &SourceConfig) -> Result<Provenance> {
    Ok(Provenance::new(
        SourceId::new(&source.id)?,
        parse_confidence(&source.confidence)?,
    ))
}

#[allow(clippy::too_many_arguments)]
fn track(
    id: TrackId,
    owner: TrackOwner,
    designation: &str,
    length_metres: i64,
    speed_kph: i64,
    gradient_per_mille_tenths: i32,
    protection: &TrainProtection,
    provenance: &Provenance,
) -> Result<Track> {
    let length = Length::from_metres(length_metres);
    Ok(Track::builder(id, owner, designation, length)
        .kind(TrackKind::ThroughMainTrack)
        .direction(TrackDirection::Bidirectional)
        .speed(BandProfile::uniform(
            "vmax",
            length,
            SpeedLimit::uniform(Speed::from_km_h(speed_kph))?,
            provenance.clone(),
        )?)
        .gradient(BandProfile::uniform(
            "neigung",
            length,
            Gradient::from_per_mille_tenths(gradient_per_mille_tenths),
            provenance.clone(),
        )?)
        .electrification(BandProfile::uniform(
            "elektrifizierung",
            length,
            Electrification::Overhead(PowerSystem::Ac15kV),
            provenance.clone(),
        )?)
        .protection(BandProfile::uniform(
            "zugsicherung",
            length,
            protection.clone(),
            provenance.clone(),
        )?)
        .build()?)
}

fn validate(config: &ModelConfig) -> Result<()> {
    require(
        config.schema == CONFIG_SCHEMA,
        "unbekanntes Modellkonfigurations-Schema",
    )?;
    require(!config.group_id.trim().is_empty(), "groupId fehlt")?;
    require(
        config.group_id == config.comparison_basis.corpus_group_id,
        "groupId und comparisonBasis.corpusGroupId stimmen nicht überein",
    )?;
    require(
        config.operating_points.len() >= 2,
        "mindestens zwei Betriebsstellen sind erforderlich",
    )?;
    require(
        config.segments.len() + 1 == config.operating_points.len(),
        "die Pilotstrecke muss als durchgehende Segmentkette vorliegen",
    )?;
    require(
        config.intermediate_dwells.len() == config.operating_points.len().saturating_sub(2),
        "für jede Zwischenbetriebsstelle ist genau eine Haltezeit erforderlich",
    )?;
    require(
        config.comparison_basis.technical_reference.sections.len() == config.segments.len(),
        "für jedes Segment ist genau eine technische Abschnittsreferenz erforderlich",
    )?;
    require(
        config.calibration.method == "per-section-effective-speed-grid-search-v1",
        "unbekannte Kalibrierungsmethode",
    )?;
    require(
        config.calibration.minimum_effective_speed_kph > 0
            && config.calibration.step_kph > 0
            && config.calibration.maximum_section_deviation_seconds >= 0,
        "Kalibrierungsgrenzen sind ungültig",
    )?;
    require(
        !config.comparison_basis.timetable_corpus_path.trim().is_empty()
            && !config.comparison_basis.source_archive_sha256.trim().is_empty(),
        "Fahrplankorpus oder GTFS-Archivhash fehlt",
    )?;
    let technical_reference = &config.comparison_basis.technical_reference;
    require(
        !technical_reference.source_id.trim().is_empty()
            && !technical_reference.artifact_path.trim().is_empty()
            && technical_reference.artifact_sha256.len() == 64
            && !technical_reference.retrieved_at.trim().is_empty(),
        "technische Referenz ist nicht vollständig gebunden",
    )?;
    require(
        technical_reference.source_id == config.release.infrastructure_source.id,
        "technische Referenz und abgeleitete Infrastruktur müssen dieselbe Quelle nennen",
    )?;

    let point_ids: BTreeSet<_> = config
        .operating_points
        .iter()
        .map(|point| &point.id)
        .collect();
    require(
        point_ids.len() == config.operating_points.len(),
        "Betriebsstellenkennungen sind nicht eindeutig",
    )?;
    let segment_ids: BTreeSet<_> = config.segments.iter().map(|segment| &segment.id).collect();
    require(
        segment_ids.len() == config.segments.len(),
        "Segmentkennungen sind nicht eindeutig",
    )?;
    for (index, segment) in config.segments.iter().enumerate() {
        require(
            segment.from_operating_point_id == config.operating_points[index].id
                && segment.to_operating_point_id == config.operating_points[index + 1].id,
            format!(
                "Segment '{}' unterbricht die geordnete Pilotstrecke",
                segment.id
            ),
        )?;
        require(
            segment.distance_metres > 0,
            format!("Segment '{}' hat keine positive Länge", segment.id),
        )?;
        require(
            segment.maximum_speed_kph > 0,
            format!("Segment '{}' hat keine positive Vmax", segment.id),
        )?;
        require(
            config.calibration.minimum_effective_speed_kph <= segment.maximum_speed_kph,
            format!("Segment '{}' liegt unter der minimalen Kalibriergeschwindigkeit", segment.id),
        )?;
        let reference = &technical_reference.sections[index];
        require(
            reference.segment_id == segment.id,
            format!(
                "Abschnittsreferenz für '{}' fehlt an der richtigen Stelle",
                segment.id
            ),
        )?;
        require(
            reference.running_seconds > 0,
            format!("Abschnittsreferenz für '{}' ist ungültig", segment.id),
        )?;
    }
    let expected_dwells: BTreeSet<_> = config.operating_points
        [1..config.operating_points.len() - 1]
        .iter()
        .map(|point| &point.id)
        .collect();
    let actual_dwells: BTreeSet<_> = config
        .intermediate_dwells
        .iter()
        .map(|dwell| &dwell.operating_point_id)
        .collect();
    require(
        expected_dwells == actual_dwells,
        "Haltezeiten gehören nicht exakt zu den Zwischenhalten",
    )?;
    require(
        config
            .intermediate_dwells
            .iter()
            .all(|dwell| dwell.seconds >= 0),
        "Haltezeiten dürfen nicht negativ sein",
    )?;
    require(
        !config.characteristics.evidence.assumptions.is_empty(),
        "nicht extern belegte Fahrzeugwerte müssen als Annahmen ausgewiesen werden",
    )?;
    let component_total = config
        .comparison_basis
        .technical_reference
        .sections
        .iter()
        .map(|reference| reference.running_seconds)
        .sum::<i64>();
    require(
        component_total == technical_reference.running_seconds,
        "Abschnittsreferenzen ergeben nicht die technische Gesamtreferenz",
    )?;
    require(
        config.release.infrastructure_source.confidence == "derived",
        "die kalibrierte Pilotinfrastruktur muss Confidence 'derived' tragen",
    )?;
    Ok(())
}

fn build_release(
    config: &ModelConfig,
    calibrated_sections: &[CalibratedSection],
) -> Result<(InfraRelease, Vec<TrackId>)> {
    require(
        calibrated_sections.len() == config.segments.len(),
        "Kalibrierung und Segmentliste passen nicht zusammen",
    )?;
    let operating_point_source = provenance(&config.release.operating_point_source)?;
    let infrastructure_source = provenance(&config.release.infrastructure_source)?;
    let protection = parse_protection(&config.characteristics.protection)?;
    let mut builder = OperatingGraphBuilder::new();
    let mut point_ids = BTreeMap::new();

    for (index, point) in config.operating_points.iter().enumerate() {
        let numeric_id = u32::try_from(index + 1)?;
        let id = OperatingPointId::new(numeric_id);
        point_ids.insert(point.id.as_str(), id);
        builder = builder
            .operating_point(OperatingPoint::new(
                id,
                OperatingPointCode::new(&point.code)?,
                &point.name,
                parse_kind(&point.kind)?,
                Coordinate::new(point.latitude_e7, point.longitude_e7)?,
                operating_point_source.clone(),
            )?)
            .track(track(
                TrackId::new(1_000 + numeric_id),
                TrackOwner::OperatingPoint(id),
                "Pilot-Bahnsteiggleis",
                config.release.station_track_length_metres,
                config.release.station_track_speed_kph,
                0,
                &protection,
                &infrastructure_source,
            )?);
    }

    let mut path_tracks = Vec::with_capacity(config.segments.len());
    for (index, (segment, calibrated)) in config
        .segments
        .iter()
        .zip(calibrated_sections)
        .enumerate()
    {
        let numeric_id = u32::try_from(index + 1)?;
        let edge_id = TrackEdgeId::new(numeric_id);
        let track_id = TrackId::new(2_000 + numeric_id);
        let from = *point_ids
            .get(segment.from_operating_point_id.as_str())
            .ok_or_else(|| {
                invalid(format!(
                    "unbekannter Segmentanfang '{}'",
                    segment.from_operating_point_id
                ))
            })?;
        let to = *point_ids
            .get(segment.to_operating_point_id.as_str())
            .ok_or_else(|| {
                invalid(format!(
                    "unbekanntes Segmentende '{}'",
                    segment.to_operating_point_id
                ))
            })?;
        builder = builder
            .edge(TrackEdge::new(
                edge_id,
                from,
                to,
                &segment.id,
                Length::from_metres(segment.distance_metres),
                infrastructure_source.clone(),
            )?)
            .track(track(
                track_id,
                TrackOwner::Edge(edge_id),
                "Pilot-Streckengleis",
                segment.distance_metres,
                calibrated.effective_speed_kph,
                segment.gradient_per_mille_tenths,
                &protection,
                &infrastructure_source,
            )?);
        path_tracks.push(track_id);
    }

    let graph = builder.build()?;
    let version = &config.release.version;
    let release = InfraRelease::builder(
        ReleaseVersion::new(version.major, version.minor, version.patch),
        &config.release.region,
        graph,
    )
    .source(ReleaseSource::new(
        SourceId::new(&config.release.operating_point_source.id)?,
        &config.release.operating_point_source.source_license,
        &config.release.operating_point_source.attribution,
    )?)
    .source(ReleaseSource::new(
        SourceId::new(&config.release.infrastructure_source.id)?,
        &config.release.infrastructure_source.source_license,
        &config.release.infrastructure_source.attribution,
    )?)
    .build()?;
    Ok((release, path_tracks))
}

fn train(config: &CharacteristicsConfig) -> Result<TrainCharacteristics> {
    Ok(TrainCharacteristics::new(
        TrainCharacteristicsId::new(config.numeric_id),
        &config.name,
        Mass::from_tonnes(config.mass_tonnes),
        Length::from_metres(config.length_metres),
        Speed::from_km_h(config.maximum_speed_kph),
        SpeedCategory::Standard,
        Acceleration::from_millimetres_per_second_squared(
            config.acceleration_millimetres_per_second_squared,
        ),
        Acceleration::from_millimetres_per_second_squared(
            config.deceleration_millimetres_per_second_squared,
        ),
        TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
        parse_protection(&config.protection)?,
    )?)
}

fn section_running_seconds(
    segment: &SegmentConfig,
    speed_kph: i64,
    train: &TrainCharacteristics,
    protection: &TrainProtection,
    source: &Provenance,
    numeric_id: u32,
) -> Result<i64> {
    let test_track = track(
        TrackId::new(20_000 + numeric_id),
        TrackOwner::Edge(TrackEdgeId::new(10_000 + numeric_id)),
        "Kalibriersegment",
        segment.distance_metres,
        speed_kph,
        segment.gradient_per_mille_tenths,
        protection,
        source,
    )?;
    let mut path = RunPath::new();
    path.push_track_range(
        train,
        &test_track,
        TravelDirection::WithChainage,
        Length::ZERO,
        test_track.length(),
    )?;
    Ok(
        derive_running_time_table_with_exit(&path, train, Speed::ZERO, Speed::ZERO)?
            .total()
            .seconds(),
    )
}

fn calibrate(config: &ModelConfig) -> Result<Vec<CalibratedSection>> {
    let train = train(&config.characteristics)?;
    let protection = parse_protection(&config.characteristics.protection)?;
    let source = provenance(&config.release.infrastructure_source)?;
    let mut calibrated = Vec::with_capacity(config.segments.len());

    for (index, (segment, reference)) in config
        .segments
        .iter()
        .zip(&config.comparison_basis.technical_reference.sections)
        .enumerate()
    {
        let numeric_id = u32::try_from(index + 1)?;
        let raw_running_seconds = section_running_seconds(
            segment,
            segment.maximum_speed_kph,
            &train,
            &protection,
            &source,
            numeric_id,
        )?;
        let mut best: Option<(i64, i64, i64)> = None;
        let mut speed_kph = config.calibration.minimum_effective_speed_kph;
        loop {
            let running_seconds = section_running_seconds(
                segment,
                speed_kph,
                &train,
                &protection,
                &source,
                numeric_id,
            )?;
            let deviation = running_seconds
                .saturating_sub(reference.running_seconds)
                .abs();
            if best.is_none_or(|(best_deviation, best_speed, _)| {
                deviation < best_deviation
                    || (deviation == best_deviation && speed_kph > best_speed)
            }) {
                best = Some((deviation, speed_kph, running_seconds));
            }
            if speed_kph == segment.maximum_speed_kph {
                break;
            }
            speed_kph = speed_kph
                .saturating_add(config.calibration.step_kph)
                .min(segment.maximum_speed_kph);
        }
        let (deviation, effective_speed_kph, running_seconds) =
            best.ok_or_else(|| invalid("Kalibrierung lieferte keinen Kandidaten"))?;
        require(
            deviation <= config.calibration.maximum_section_deviation_seconds,
            format!(
                "Segment '{}' verfehlt die Kalibriergrenze um {} Sekunden",
                segment.id, deviation
            ),
        )?;
        calibrated.push(CalibratedSection {
            raw_running_seconds,
            running_seconds,
            effective_speed_kph,
        });
    }
    Ok(calibrated)
}

fn run<'a>(
    config: &'a ModelConfig,
    release: &InfraRelease,
    path_tracks: &[TrackId],
    calibrated_sections: &[CalibratedSection],
) -> Result<ModelResult<'a>> {
    let train = train(&config.characteristics)?;
    let dwells: BTreeMap<_, _> = config
        .intermediate_dwells
        .iter()
        .map(|dwell| (dwell.operating_point_id.as_str(), dwell.seconds))
        .collect();
    let mut sections = Vec::with_capacity(config.segments.len());
    let mut raw_running_seconds = 0_i64;
    let mut running_seconds = 0_i64;
    let mut dwell_seconds = 0_i64;

    for (((segment, reference), calibrated), track_id) in config
        .segments
        .iter()
        .zip(&config.comparison_basis.technical_reference.sections)
        .zip(calibrated_sections)
        .zip(path_tracks)
    {
        let track = release
            .graph()
            .track(*track_id)
            .ok_or_else(|| invalid(format!("Gleis {track_id} fehlt im gebauten Release")))?;
        let mut path = RunPath::new();
        path.push_track_range(
            &train,
            track,
            TravelDirection::WithChainage,
            Length::ZERO,
            track.length(),
        )?;
        let section_running =
            derive_running_time_table_with_exit(&path, &train, Speed::ZERO, Speed::ZERO)?
                .total()
                .seconds();
        require(
            section_running == calibrated.running_seconds,
            format!("Kalibrierlauf für '{}' ist nicht reproduzierbar", segment.id),
        )?;
        let dwell_after = dwells
            .get(segment.to_operating_point_id.as_str())
            .copied()
            .unwrap_or(0);
        raw_running_seconds = raw_running_seconds.saturating_add(calibrated.raw_running_seconds);
        running_seconds = running_seconds.saturating_add(section_running);
        dwell_seconds = dwell_seconds.saturating_add(dwell_after);
        sections.push(SectionResult {
            segment_id: &segment.id,
            raw_running_seconds: calibrated.raw_running_seconds,
            running_seconds: section_running,
            effective_speed_kph: calibrated.effective_speed_kph,
            dwell_after_seconds: dwell_after,
            technical_reference_seconds: reference.running_seconds,
            technical_deviation_seconds: section_running.saturating_sub(reference.running_seconds),
        });
    }

    Ok(ModelResult {
        group_id: &config.group_id,
        characteristics_id: &config.characteristics.id,
        calibration_method: &config.calibration.method,
        raw_running_seconds,
        running_seconds,
        dwell_seconds,
        modeled_timetable_seconds: running_seconds.saturating_add(dwell_seconds),
        technical_reference_seconds: config.comparison_basis.technical_reference.running_seconds,
        sections,
    })
}

fn write_json(path: &str, value: &impl Serialize) -> Result<()> {
    let mut json = serde_json::to_string_pretty(value)?;
    json.push('\n');
    fs::write(path, json)?;
    Ok(())
}

fn main() -> Result<()> {
    let arguments: Vec<_> = env::args().collect();
    require(
        arguments.len() == 4,
        "Aufruf: zugfolge-reference-model CONFIG MODEL_RESULTS RELEASE_MANIFEST",
    )?;
    let input = fs::read(&arguments[1])?;
    let config: ModelConfig = serde_json::from_slice(&input)?;
    validate(&config)?;
    let technical_reference_input =
        fs::read(&config.comparison_basis.technical_reference.artifact_path)?;
    verify_technical_reference_artifact(&config, &technical_reference_input)?;
    let model_input_sha256 = sha256_hex(&input);
    let calibrated_sections = calibrate(&config)?;
    let (release, path_tracks) = build_release(&config, &calibrated_sections)?;
    let release_checksum = release.checksum().to_hex();
    let result = run(&config, &release, &path_tracks, &calibrated_sections)?;

    write_json(
        &arguments[2],
        &ModelResults {
            schema: RESULTS_SCHEMA,
            qualification: "calibration-only",
            release_checksum: &release_checksum,
            model_input_sha256: &model_input_sha256,
            technical_reference: TechnicalReferenceSummary {
                source_id: &config.comparison_basis.technical_reference.source_id,
                artifact_sha256: &config
                    .comparison_basis
                    .technical_reference
                    .artifact_sha256,
                running_seconds: config.comparison_basis.technical_reference.running_seconds,
            },
            results: vec![result],
        },
    )?;
    write_json(
        &arguments[3],
        &ReleaseManifest {
            schema: RELEASE_SCHEMA,
            release_checksum: &release_checksum,
            model_input_sha256: &model_input_sha256,
            confidence: "derived",
            limitation: &config.comparison_basis.limitation,
            model_config: &config,
        },
    )?;
    println!("InfraRelease {release_checksum} reproduziert und Modelllauf geschrieben.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ModelConfig, build_release, calibrate, run, sha256_hex, validate,
        verify_technical_reference_artifact,
    };

    const PILOT_CONFIG: &[u8] =
        include_bytes!("../../reference-corpus/pilot/2026-08/model-config.json");
    const TECHNICAL_REFERENCE: &[u8] =
        include_bytes!("../../reference-corpus/pilot/2026-08/trassenfinder-reference.json");

    #[test]
    fn pilot_kalibrierung_bleibt_reproduzierbar_und_als_solche_gekennzeichnet() {
        let config: ModelConfig =
            serde_json::from_slice(PILOT_CONFIG).expect("versionierte Pilotkonfiguration");
        validate(&config).expect("Pilotkonfiguration ist vollständig");
        verify_technical_reference_artifact(&config, TECHNICAL_REFERENCE)
            .expect("technisches Referenzartefakt ist vollständig gebunden");
        let calibrated = calibrate(&config).expect("deterministische Kalibrierung");
        let (release, tracks) =
            build_release(&config, &calibrated).expect("Pilot-InfraRelease");
        let result = run(&config, &release, &tracks, &calibrated).expect("Pilot-Modelllauf");
        let input_sha256 = sha256_hex(PILOT_CONFIG);

        assert_eq!(
            release.checksum().to_hex(),
            "994ff2a6cc06bc9ce324f3691d30645765d574f44f09ea4f102e44c1ccd536d3"
        );
        assert_eq!(
            input_sha256,
            "dbbb347c62f4cae0e0c6ad44b58bcae0fa1ae09bffa6990a41bab4509627ab4f"
        );
        assert!(result.raw_running_seconds < result.running_seconds);
        assert_eq!(result.raw_running_seconds, 967);
        assert_eq!(result.running_seconds, 1_263);
        assert_eq!(result.dwell_seconds, 60);
        assert_eq!(result.modeled_timetable_seconds, 1_323);
        assert_eq!(result.technical_reference_seconds, 1_260);
        assert_eq!(
            result
                .sections
                .iter()
                .map(|section| section.effective_speed_kph)
                .collect::<Vec<_>>(),
            vec![83, 116, 129]
        );
        assert_eq!(
            result
                .sections
                .iter()
                .map(|section| section.technical_deviation_seconds)
                .collect::<Vec<_>>(),
            vec![1, 1, 1]
        );
    }
}
