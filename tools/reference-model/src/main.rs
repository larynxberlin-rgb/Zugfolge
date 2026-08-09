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

const CONFIG_SCHEMA: &str = "zugfolge-pilot-model/v1";
const RESULTS_SCHEMA: &str = "zugfolge-model-results/v1";
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
struct ComparisonBasis {
    corpus_path: String,
    corpus_group_id: String,
    source_archive_sha256: String,
    technical_reference_seconds: i64,
    section_references: Vec<SectionReference>,
    dwell_method: String,
    limitation: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SectionReference {
    segment_id: String,
    running_seconds: i64,
    dwell_after_seconds: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelResults<'a> {
    schema: &'static str,
    release_checksum: &'a str,
    model_input_sha256: &'a str,
    results: Vec<ModelResult<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelResult<'a> {
    group_id: &'a str,
    characteristics_id: &'a str,
    calculated_seconds: i64,
    running_seconds: i64,
    dwell_seconds: i64,
    sections: Vec<SectionResult<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionResult<'a> {
    segment_id: &'a str,
    running_seconds: i64,
    dwell_after_seconds: i64,
    technical_reference_seconds: i64,
    technical_deviation_seconds: i64,
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
        config.comparison_basis.section_references.len() == config.segments.len(),
        "für jedes Segment ist genau eine technische Abschnittsreferenz erforderlich",
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
        let reference = &config.comparison_basis.section_references[index];
        require(
            reference.segment_id == segment.id,
            format!(
                "Abschnittsreferenz für '{}' fehlt an der richtigen Stelle",
                segment.id
            ),
        )?;
        require(
            reference.running_seconds > 0 && reference.dwell_after_seconds >= 0,
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
        .section_references
        .iter()
        .map(|reference| {
            reference
                .running_seconds
                .saturating_add(reference.dwell_after_seconds)
        })
        .sum::<i64>();
    require(
        component_total == config.comparison_basis.technical_reference_seconds,
        "Abschnittsreferenzen ergeben nicht die technische Gesamtreferenz",
    )?;
    require(
        config.release.infrastructure_source.confidence == "assumed",
        "die provisorische Pilotinfrastruktur muss Confidence 'assumed' tragen",
    )?;
    Ok(())
}

fn build_release(config: &ModelConfig) -> Result<(InfraRelease, Vec<TrackId>)> {
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
    for (index, segment) in config.segments.iter().enumerate() {
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
                segment.maximum_speed_kph,
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

fn run<'a>(
    config: &'a ModelConfig,
    release: &InfraRelease,
    path_tracks: &[TrackId],
) -> Result<ModelResult<'a>> {
    let train = train(&config.characteristics)?;
    let dwells: BTreeMap<_, _> = config
        .intermediate_dwells
        .iter()
        .map(|dwell| (dwell.operating_point_id.as_str(), dwell.seconds))
        .collect();
    let mut sections = Vec::with_capacity(config.segments.len());
    let mut running_seconds = 0_i64;
    let mut dwell_seconds = 0_i64;

    for ((segment, reference), track_id) in config
        .segments
        .iter()
        .zip(&config.comparison_basis.section_references)
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
        let dwell_after = dwells
            .get(segment.to_operating_point_id.as_str())
            .copied()
            .unwrap_or(0);
        running_seconds = running_seconds.saturating_add(section_running);
        dwell_seconds = dwell_seconds.saturating_add(dwell_after);
        sections.push(SectionResult {
            segment_id: &segment.id,
            running_seconds: section_running,
            dwell_after_seconds: dwell_after,
            technical_reference_seconds: reference
                .running_seconds
                .saturating_add(reference.dwell_after_seconds),
            technical_deviation_seconds: section_running
                .saturating_add(dwell_after)
                .saturating_sub(
                    reference
                        .running_seconds
                        .saturating_add(reference.dwell_after_seconds),
                ),
        });
    }

    Ok(ModelResult {
        group_id: &config.group_id,
        characteristics_id: &config.characteristics.id,
        calculated_seconds: running_seconds.saturating_add(dwell_seconds),
        running_seconds,
        dwell_seconds,
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
    let model_input_sha256 = Sha256::digest(&input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (release, path_tracks) = build_release(&config)?;
    let release_checksum = release.checksum().to_hex();
    let result = run(&config, &release, &path_tracks)?;

    write_json(
        &arguments[2],
        &ModelResults {
            schema: RESULTS_SCHEMA,
            release_checksum: &release_checksum,
            model_input_sha256: &model_input_sha256,
            results: vec![result],
        },
    )?;
    write_json(
        &arguments[3],
        &ReleaseManifest {
            schema: RELEASE_SCHEMA,
            release_checksum: &release_checksum,
            model_input_sha256: &model_input_sha256,
            confidence: "assumed",
            limitation: &config.comparison_basis.limitation,
            model_config: &config,
        },
    )?;
    println!("InfraRelease {release_checksum} reproduziert und Modelllauf geschrieben.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ModelConfig, Sha256, build_release, run, validate};
    use sha2::Digest;

    const PILOT_CONFIG: &[u8] =
        include_bytes!("../../reference-corpus/pilot/2026-08/model-config.json");

    #[test]
    fn pilot_release_und_negativer_modellvergleich_bleiben_reproduzierbar() {
        let config: ModelConfig =
            serde_json::from_slice(PILOT_CONFIG).expect("versionierte Pilotkonfiguration");
        validate(&config).expect("Pilotkonfiguration ist vollständig");
        let (release, tracks) = build_release(&config).expect("Pilot-InfraRelease");
        let result = run(&config, &release, &tracks).expect("Pilot-Modelllauf");
        let input_sha256 = Sha256::digest(PILOT_CONFIG)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        assert_eq!(
            release.checksum().to_hex(),
            "3b891ef47ac78615465d67f01eb24a0e161b781b4ea689a207b0741200563cdd"
        );
        assert_eq!(
            input_sha256,
            "f1a3cdfc5296da4ae12bc7c85acc511d322bc258997fe3626c29d6f598f0821b"
        );
        assert_eq!(result.running_seconds, 954);
        assert_eq!(result.dwell_seconds, 60);
        assert_eq!(result.calculated_seconds, 1_014);
        assert_eq!(
            result
                .sections
                .iter()
                .map(|section| section.technical_deviation_seconds)
                .collect::<Vec<_>>(),
            vec![-122, -96, -148]
        );
    }
}
