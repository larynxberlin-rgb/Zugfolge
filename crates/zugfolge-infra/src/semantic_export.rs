//! Deterministischer OSM-PBF-Export fuer die semantischen Kartenlayer.
//!
//! Der Export verwendet ausschliesslich reale E7-Koordinaten und die im
//! gepinnten PBF enthaltenen OSM-Tags. Ungepruefte OSM-Objekte werden nie als
//! Klasse A ausgegeben. Fehlende Blockgrenzen erzeugen groessere, nicht
//! kleinere Konfliktressourcen: Kanten werden ueber jeden Knoten verbunden,
//! der kein belegtes Haupt- oder Kombinationssignal traegt.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::str::FromStr as _;

use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    Coordinate, EXCLUDED_RAILWAY_VALUES, ExclusionReason, ImportError, OsmNodeId, PbfDocument,
    RawEdge, RawGraph, classify, filter_network,
};

const LAYERS: [(&str, &str); 7] = [
    ("tracks", "tracks.geojsonseq"),
    ("switches", "switches.geojsonseq"),
    ("signals", "signals.geojsonseq"),
    ("platforms", "platforms.geojsonseq"),
    ("blocks", "blocks.geojsonseq"),
    ("conflict_resources", "conflict-resources.geojsonseq"),
    ("rail_context", "rail-context.geojsonseq"),
];

type FeatureSet = BTreeMap<String, Value>;

/// Fehler beim Erzeugen eines semantischen GeoJSON-Sequenzexports.
#[derive(Debug)]
pub enum SemanticExportError {
    /// Das PBF konnte nicht in einen Rohgraphen umgewandelt werden.
    Import(ImportError),
    /// Eine Datei konnte nicht gelesen oder geschrieben werden.
    Io(io::Error),
    /// Ein GeoJSON-Feature konnte nicht kanonisch serialisiert werden.
    Json(serde_json::Error),
    /// Zwei Eingangselemente wuerden dieselbe stabile Feature-ID erzeugen.
    DuplicateFeature {
        /// Name des betroffenen GeoJSON-Sequenzlayers.
        layer: String,
        /// Kollidierende stabile Kennung.
        feature_id: String,
    },
    /// Ein im PBF referenzierter Geometrieknoten fehlt.
    MissingGeometryNode {
        /// OSM-Kennung des betroffenen Wegs.
        way_id: i64,
        /// Im PBF fehlende OSM-Knotenkennung.
        node_id: i64,
    },
    /// Ziel oder reserviertes Bauverzeichnis existiert bereits.
    OutputPathExists {
        /// Der nicht ueberschriebene kollidierende Pfad.
        path: PathBuf,
    },
}

impl fmt::Display for SemanticExportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Import(error) => write!(formatter, "PBF-Import fehlgeschlagen: {error}"),
            Self::Io(error) => write!(formatter, "Dateizugriff fehlgeschlagen: {error}"),
            Self::Json(error) => {
                write!(formatter, "GeoJSON-Serialisierung fehlgeschlagen: {error}")
            }
            Self::DuplicateFeature { layer, feature_id } => {
                write!(
                    formatter,
                    "Layer {layer} enthaelt die Feature-ID {feature_id} doppelt"
                )
            }
            Self::MissingGeometryNode { way_id, node_id } => write!(
                formatter,
                "OSM-Weg {way_id} referenziert den fehlenden Geometrieknoten {node_id}"
            ),
            Self::OutputPathExists { path } => write!(
                formatter,
                "Exportziel existiert bereits und wird nicht ueberschrieben: {}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for SemanticExportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Import(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::DuplicateFeature { .. }
            | Self::MissingGeometryNode { .. }
            | Self::OutputPathExists { .. } => None,
        }
    }
}

impl From<ImportError> for SemanticExportError {
    fn from(value: ImportError) -> Self {
        Self::Import(value)
    }
}

impl From<io::Error> for SemanticExportError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for SemanticExportError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

/// Ergebnis eines vollstaendigen semantischen Exports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticExportSummary {
    source_id: String,
    raw_graph_sha256: String,
    ebo_graph_sha256: String,
    corpus_sha256: String,
    layers: BTreeMap<String, LayerSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LayerSummary {
    file: String,
    features: usize,
    sha256: String,
    quality: BTreeMap<String, usize>,
}

impl SemanticExportSummary {
    /// Die Quellenkennung des gepinnten PBF.
    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    /// Hash ueber Namen, Anzahl und Dateihash aller sieben Layer.
    pub fn corpus_sha256(&self) -> &str {
        &self.corpus_sha256
    }

    /// Anzahl der exportierten Features je Layer.
    pub fn layer_counts(&self) -> BTreeMap<String, usize> {
        self.layers
            .iter()
            .map(|(name, summary)| (name.clone(), summary.features))
            .collect()
    }

    /// Maschinenlesbarer, kanonisch geordneter Releasebericht.
    pub fn as_json(&self) -> Value {
        let layers: Map<String, Value> = self
            .layers
            .iter()
            .map(|(name, summary)| {
                (
                    name.clone(),
                    json!({
                        "file": summary.file,
                        "features": summary.features,
                        "quality": summary.quality,
                        "sha256": summary.sha256,
                    }),
                )
            })
            .collect();
        json!({
            "schema": "zugfolge-osm-semantic-export-report/v1",
            "sourceId": self.source_id,
            "rawGraphSha256": self.raw_graph_sha256,
            "eboGraphSha256": self.ebo_graph_sha256,
            "corpusSha256": self.corpus_sha256,
            "qualityPolicy": {
                "classAFromUnreviewedOsm": false,
                "conservativeBidirectionalTrackSections": true,
                "missingBlockBoundaryMergesResources": true,
                "classCOrderable": false,
            },
            "layers": layers,
        })
    }
}

#[derive(Debug)]
struct DisjointSet {
    parent: Vec<usize>,
}

impl DisjointSet {
    fn new(length: usize) -> Self {
        Self {
            parent: (0..length).collect(),
        }
    }

    fn root(&mut self, index: usize) -> usize {
        let parent = self.parent[index];
        if parent == index {
            index
        } else {
            let root = self.root(parent);
            self.parent[index] = root;
            root
        }
    }

    fn union(&mut self, left: usize, right: usize) {
        let left_root = self.root(left);
        let right_root = self.root(right);
        if left_root == right_root {
            return;
        }
        let (first, second) = if left_root < right_root {
            (left_root, right_root)
        } else {
            (right_root, left_root)
        };
        self.parent[second] = first;
    }
}

fn decimal_degree(value_e7: i32) -> Number {
    let negative = value_e7.is_negative();
    let absolute = value_e7.unsigned_abs();
    let degrees = absolute / 10_000_000;
    let fraction = absolute % 10_000_000;
    let text = if fraction == 0 {
        format!("{}{degrees}", if negative { "-" } else { "" })
    } else {
        let fraction = format!("{fraction:07}").trim_end_matches('0').to_owned();
        format!("{}{degrees}.{fraction}", if negative { "-" } else { "" })
    };
    Number::from_str(&text).expect("eine ganzzahlig formatierte E7-Koordinate ist gueltiges JSON")
}

fn point_coordinates(coordinate: Coordinate) -> Value {
    Value::Array(vec![
        Value::Number(decimal_degree(coordinate.longitude_e7())),
        Value::Number(decimal_degree(coordinate.latitude_e7())),
    ])
}

fn point_geometry(coordinate: Coordinate) -> Value {
    json!({ "type": "Point", "coordinates": point_coordinates(coordinate) })
}

fn line_coordinates(coordinates: &[Coordinate]) -> Value {
    Value::Array(coordinates.iter().copied().map(point_coordinates).collect())
}

fn line_geometry(coordinates: &[Coordinate]) -> Value {
    json!({ "type": "LineString", "coordinates": line_coordinates(coordinates) })
}

fn feature(properties: Value, geometry: Value) -> Value {
    json!({ "type": "Feature", "properties": properties, "geometry": geometry })
}

fn insert_feature(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    layer: &'static str,
    feature_id: String,
    value: Value,
) -> Result<(), SemanticExportError> {
    let entries = layers
        .get_mut(layer)
        .expect("alle semantischen Layer werden vor dem Export angelegt");
    if entries.insert(feature_id.clone(), value).is_some() {
        return Err(SemanticExportError::DuplicateFeature {
            layer: layer.to_owned(),
            feature_id,
        });
    }
    Ok(())
}

fn tags_json(tags: &BTreeMap<String, String>) -> Result<String, SemanticExportError> {
    Ok(serde_json::to_string(tags)?)
}

fn common_properties(
    feature_id: &str,
    feature_type: &str,
    quality_class: &str,
    model_state: &str,
    source_id: &str,
) -> Map<String, Value> {
    [
        ("feature_id", json!(feature_id)),
        ("feature_type", json!(feature_type)),
        ("model_state", json!(model_state)),
        ("orderable", json!(quality_class != "C")),
        ("quality_class", json!(quality_class)),
        ("source_id", json!(source_id)),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn edge_feature_id(edge: &RawEdge, segment: usize) -> String {
    format!(
        "track:osm-way-{}-segment-{segment}-n{}-n{}",
        edge.way().value(),
        edge.from().value(),
        edge.to().value()
    )
}

fn integer_sqrt(value: i128) -> i128 {
    if value <= 1 {
        return value;
    }
    let mut estimate = value;
    loop {
        let next = (estimate + value / estimate) / 2;
        if next >= estimate {
            return estimate;
        }
        estimate = next;
    }
}

fn coordinate_distance_mm(left: Coordinate, right: Coordinate) -> i64 {
    let latitude = (i128::from(left.latitude_e7()) - i128::from(right.latitude_e7())) * 11_132;
    let longitude = (i128::from(left.longitude_e7()) - i128::from(right.longitude_e7())) * 6_999;
    let micro_mm = integer_sqrt(latitude * latitude + longitude * longitude);
    i64::try_from((micro_mm + 500) / 1_000).unwrap_or(i64::MAX)
}

fn geometry_length_mm(coordinates: &[Coordinate]) -> i64 {
    coordinates
        .windows(2)
        .map(|pair| coordinate_distance_mm(pair[0], pair[1]))
        .fold(0_i64, i64::saturating_add)
}

fn parse_osm_speed_kmh(value: &str) -> Option<u32> {
    let normalized = value.trim();
    let numeric = normalized
        .strip_suffix("km/h")
        .map(str::trim)
        .unwrap_or(normalized);
    let speed = numeric.parse::<u32>().ok()?;
    (speed > 0 && speed <= 600).then_some(speed)
}

fn conservative_default_speed(tags: &BTreeMap<String, String>) -> u32 {
    if tags.get("service").is_some_and(|value| !value.is_empty()) {
        10
    } else {
        20
    }
}

fn modeled_speed(tags: &BTreeMap<String, String>, directional_key: &str) -> (u32, &'static str) {
    if let Some(value) = tags.get(directional_key) {
        return parse_osm_speed_kmh(value)
            .map(|speed| (speed, "observed_osm_directional"))
            .unwrap_or_else(|| (conservative_default_speed(tags), "conservative_default"));
    }
    tags.get("maxspeed")
        .and_then(|value| parse_osm_speed_kmh(value))
        .map(|speed| (speed, "observed_osm_common"))
        .unwrap_or_else(|| (conservative_default_speed(tags), "conservative_default"))
}

fn is_signal(tags: &BTreeMap<String, String>) -> bool {
    tags.get("railway").map(String::as_str) == Some("signal")
        || tags.keys().any(|key| key.starts_with("railway:signal:"))
}

fn is_block_boundary(tags: &BTreeMap<String, String>) -> bool {
    if !is_signal(tags) {
        return false;
    }
    let active_main = tags.contains_key("railway:signal:main")
        && tags
            .get("railway:signal:main:deactivated")
            .map(String::as_str)
            != Some("yes");
    let active_combined = tags.contains_key("railway:signal:combined")
        && tags
            .get("railway:signal:combined:deactivated")
            .map(String::as_str)
            != Some("yes");
    let explicit_block = tags.contains_key("railway:signal:block")
        || tags.get("railway:signal:main:function").map(String::as_str) == Some("block")
        || tags
            .get("railway:signal:combined:function")
            .map(String::as_str)
            == Some("block");
    active_main || active_combined || explicit_block
}

fn is_switch(tags: &BTreeMap<String, String>) -> bool {
    tags.get("railway").map(String::as_str) == Some("switch")
}

fn is_rail_platform(tags: &BTreeMap<String, String>) -> bool {
    tags.get("railway").map(String::as_str) == Some("platform")
        || (tags.get("public_transport").map(String::as_str) == Some("platform")
            && tags.get("train").map(String::as_str) == Some("yes"))
}

fn rail_context_kind(tags: &BTreeMap<String, String>) -> Option<&str> {
    match tags.get("railway").map(String::as_str) {
        Some(
            value @ ("station" | "halt" | "stop" | "buffer_stop" | "railway_crossing"
            | "level_crossing" | "crossing" | "milestone"),
        ) => Some(value),
        _ if tags.get("public_transport").map(String::as_str) == Some("station")
            && tags.get("train").map(String::as_str) == Some("yes") =>
        {
            Some("station")
        }
        _ if tags.get("public_transport").map(String::as_str) == Some("stop_position")
            && tags.get("train").map(String::as_str) == Some("yes") =>
        {
            Some("stop_position")
        }
        _ => None,
    }
}

fn has_explicit_non_ebo_tags(tags: &BTreeMap<String, String>) -> bool {
    let excluded_mode = tags
        .get("railway")
        .is_some_and(|value| EXCLUDED_RAILWAY_VALUES.contains(&value.as_str()))
        || ["tram", "light_rail", "subway", "funicular", "monorail"]
            .iter()
            .any(|key| tags.get(*key).map(String::as_str) == Some("yes"))
        || tags
            .get("station")
            .is_some_and(|value| matches!(value.as_str(), "light_rail" | "subway"));
    let bostrab_signal = tags
        .values()
        .any(|value| value.to_ascii_lowercase().contains("bostrab"));
    let non_standard_gauge = tags.get("gauge").is_some_and(|value| {
        value
            .split(';')
            .next()
            .map(str::trim)
            .and_then(|gauge| gauge.parse::<i64>().ok())
            != Some(1_435)
    });
    let third_rail = tags.get("electrified").map(String::as_str) == Some("rail");

    excluded_mode || bostrab_signal || non_standard_gauge || third_rail
}

fn is_explicit_non_ebo_railway_way(tags: &BTreeMap<String, String>) -> bool {
    if has_explicit_non_ebo_tags(tags) {
        return true;
    }
    match classify(tags) {
        Ok(()) | Err(ExclusionReason::MissingRailwayTag) => false,
        Err(ExclusionReason::NotRail(value)) => {
            !matches!(value.as_str(), "platform" | "station" | "halt")
        }
        Err(ExclusionReason::Gauge(_) | ExclusionReason::ThirdRail) => true,
    }
}

#[derive(Debug)]
struct EboPointScope {
    retained_nodes: BTreeSet<i64>,
    excluded_nodes: BTreeSet<i64>,
}

impl EboPointScope {
    fn from_retained_graph(document: &PbfDocument, graph: &RawGraph) -> Self {
        let retained_way_ids: BTreeSet<i64> = graph
            .edges()
            .iter()
            .map(|edge| edge.way().value())
            .collect();
        let mut retained_nodes = BTreeSet::new();
        let mut excluded_nodes = BTreeSet::new();

        for way in document.ways() {
            if retained_way_ids.contains(&way.id().value()) {
                retained_nodes.extend(way.nodes().iter().map(|node| node.value()));
            }
            if is_explicit_non_ebo_railway_way(way.tags()) {
                excluded_nodes.extend(way.nodes().iter().map(|node| node.value()));
            }
        }

        Self {
            retained_nodes,
            excluded_nodes,
        }
    }

    fn contains(&self, node_id: i64, tags: &BTreeMap<String, String>) -> bool {
        self.retained_nodes.contains(&node_id)
            && !self.excluded_nodes.contains(&node_id)
            && !has_explicit_non_ebo_tags(tags)
    }
}

fn stable_set_hash(namespace: &str, values: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    for value in values {
        hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn osm_way_geometry(
    document: &PbfDocument,
    way_id: i64,
    nodes: &[OsmNodeId],
) -> Result<Vec<Coordinate>, SemanticExportError> {
    nodes
        .iter()
        .map(|node_id| {
            document.node(*node_id).map(|node| node.coordinate()).ok_or(
                SemanticExportError::MissingGeometryNode {
                    way_id,
                    node_id: node_id.value(),
                },
            )
        })
        .collect()
}

fn add_tracks(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    graph: &RawGraph,
    source_id: &str,
) -> Result<Vec<String>, SemanticExportError> {
    let mut way_segments = BTreeMap::<i64, usize>::new();
    let mut track_ids = Vec::with_capacity(graph.edge_count());
    for edge in graph.edges() {
        let segment = way_segments.entry(edge.way().value()).or_default();
        *segment += 1;
        let feature_id = edge_feature_id(edge, *segment);
        let mut properties = common_properties(
            &feature_id,
            "track",
            "B",
            "observed_osm_topology_with_conservative_defaults",
            source_id,
        );
        properties.insert("from_osm_node_id".to_owned(), json!(edge.from().value()));
        properties.insert(
            "length_mm".to_owned(),
            json!(geometry_length_mm(edge.geometry())),
        );
        let (speed_forward_kmh, speed_forward_model) =
            modeled_speed(edge.tags(), "maxspeed:forward");
        let (speed_backward_kmh, speed_backward_model) =
            modeled_speed(edge.tags(), "maxspeed:backward");
        properties.insert("speed_backward_kmh".to_owned(), json!(speed_backward_kmh));
        properties.insert(
            "speed_backward_model".to_owned(),
            json!(speed_backward_model),
        );
        properties.insert("speed_forward_kmh".to_owned(), json!(speed_forward_kmh));
        properties.insert("speed_forward_model".to_owned(), json!(speed_forward_model));
        properties.insert("osm_tags_json".to_owned(), json!(tags_json(edge.tags())?));
        properties.insert("osm_way_id".to_owned(), json!(edge.way().value()));
        properties.insert("to_osm_node_id".to_owned(), json!(edge.to().value()));
        insert_feature(
            layers,
            "tracks",
            feature_id.clone(),
            feature(Value::Object(properties), line_geometry(edge.geometry())),
        )?;
        track_ids.push(feature_id);
    }
    Ok(track_ids)
}

fn add_point_objects(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    document: &PbfDocument,
    graph: &RawGraph,
    track_ids: &[String],
    source_id: &str,
) -> Result<(BTreeSet<i64>, BTreeSet<i64>), SemanticExportError> {
    let mut incident = BTreeMap::<i64, Vec<usize>>::new();
    for (index, edge) in graph.edges().iter().enumerate() {
        incident.entry(edge.from().value()).or_default().push(index);
        incident.entry(edge.to().value()).or_default().push(index);
    }
    let scope = EboPointScope::from_retained_graph(document, graph);
    let mut boundary_nodes = BTreeSet::new();
    let mut switch_nodes = BTreeSet::new();
    for node in document.nodes() {
        let node_id = node.id().value();
        if !scope.contains(node_id, node.tags()) {
            continue;
        }
        let incident_edges = incident.get(&node_id).cloned().unwrap_or_default();
        let attached = !incident_edges.is_empty();
        let incident_track_ids: Vec<&str> = incident_edges
            .iter()
            .map(|index| track_ids[*index].as_str())
            .collect();
        if is_switch(node.tags()) {
            switch_nodes.insert(node_id);
            let quality = if incident_edges.len() >= 3 { "B" } else { "C" };
            let feature_id = format!("switch:osm-node-{node_id}");
            let mut properties = common_properties(
                &feature_id,
                "switch",
                quality,
                if quality == "B" {
                    "observed_osm_track_junction"
                } else {
                    "unresolved_track_assignment"
                },
                source_id,
            );
            properties.insert(
                "incident_track_ids_json".to_owned(),
                json!(serde_json::to_string(&incident_track_ids)?),
            );
            properties.insert("osm_node_id".to_owned(), json!(node_id));
            properties.insert("osm_tags_json".to_owned(), json!(tags_json(node.tags())?));
            insert_feature(
                layers,
                "switches",
                feature_id.clone(),
                feature(Value::Object(properties), point_geometry(node.coordinate())),
            )?;

            let resource_id = format!("conflict_resource:switch-osm-node-{node_id}");
            let mut resource_properties = common_properties(
                &resource_id,
                "conflict_resource",
                quality,
                if quality == "B" {
                    "derived_switch_exclusion"
                } else {
                    "unresolved_switch_exclusion"
                },
                source_id,
            );
            resource_properties.insert("resource_kind".to_owned(), json!("switch"));
            resource_properties.insert("compatibility".to_owned(), json!("exclusive"));
            resource_properties.insert(
                "incident_track_ids_json".to_owned(),
                json!(serde_json::to_string(&incident_track_ids)?),
            );
            resource_properties.insert("switch_id".to_owned(), json!(feature_id));
            insert_feature(
                layers,
                "conflict_resources",
                resource_id.clone(),
                feature(
                    Value::Object(resource_properties),
                    point_geometry(node.coordinate()),
                ),
            )?;
        }
        if is_signal(node.tags()) {
            let block_boundary = attached && is_block_boundary(node.tags());
            if block_boundary {
                boundary_nodes.insert(node_id);
            }
            let quality = if attached { "B" } else { "C" };
            let feature_id = format!("signal:osm-node-{node_id}");
            let mut properties = common_properties(
                &feature_id,
                "signal",
                quality,
                if attached {
                    if block_boundary {
                        "observed_osm_block_boundary"
                    } else {
                        "observed_osm_non_block_signal"
                    }
                } else {
                    "unresolved_track_assignment"
                },
                source_id,
            );
            properties.insert("block_boundary".to_owned(), json!(block_boundary));
            properties.insert(
                "incident_track_ids_json".to_owned(),
                json!(serde_json::to_string(&incident_track_ids)?),
            );
            properties.insert("osm_node_id".to_owned(), json!(node_id));
            properties.insert("osm_tags_json".to_owned(), json!(tags_json(node.tags())?));
            insert_feature(
                layers,
                "signals",
                feature_id.clone(),
                feature(Value::Object(properties), point_geometry(node.coordinate())),
            )?;
        }
        if let Some(kind) = rail_context_kind(node.tags()) {
            let feature_id = format!("rail_context:osm-node-{node_id}");
            let mut properties = common_properties(
                &feature_id,
                "rail_context",
                "B",
                "observed_osm_context",
                source_id,
            );
            properties.insert("context_kind".to_owned(), json!(kind));
            properties.insert("orderable".to_owned(), json!(false));
            properties.insert("osm_node_id".to_owned(), json!(node_id));
            properties.insert("osm_tags_json".to_owned(), json!(tags_json(node.tags())?));
            insert_feature(
                layers,
                "rail_context",
                feature_id.clone(),
                feature(Value::Object(properties), point_geometry(node.coordinate())),
            )?;
        }
    }
    Ok((boundary_nodes, switch_nodes))
}

fn add_platforms(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    document: &PbfDocument,
    source_id: &str,
) -> Result<(), SemanticExportError> {
    for node in document
        .nodes()
        .filter(|node| is_rail_platform(node.tags()))
    {
        let feature_id = format!("platform:osm-node-{}", node.id().value());
        let mut properties = common_properties(
            &feature_id,
            "platform",
            "C",
            "observed_geometry_without_track_assignment",
            source_id,
        );
        properties.insert("osm_node_id".to_owned(), json!(node.id().value()));
        properties.insert("osm_tags_json".to_owned(), json!(tags_json(node.tags())?));
        insert_feature(
            layers,
            "platforms",
            feature_id.clone(),
            feature(Value::Object(properties), point_geometry(node.coordinate())),
        )?;
    }
    for way in document.ways().filter(|way| is_rail_platform(way.tags())) {
        let coordinates = osm_way_geometry(document, way.id().value(), way.nodes())?;
        let feature_id = format!("platform:osm-way-{}", way.id().value());
        let mut properties = common_properties(
            &feature_id,
            "platform",
            "C",
            "observed_geometry_without_track_assignment",
            source_id,
        );
        properties.insert("osm_tags_json".to_owned(), json!(tags_json(way.tags())?));
        properties.insert("osm_way_id".to_owned(), json!(way.id().value()));
        let closed = way.nodes().len() >= 4 && way.nodes().first() == way.nodes().last();
        let geometry = if closed && way.tags().get("area").map(String::as_str) != Some("no") {
            json!({ "type": "Polygon", "coordinates": [line_coordinates(&coordinates)] })
        } else {
            line_geometry(&coordinates)
        };
        insert_feature(
            layers,
            "platforms",
            feature_id.clone(),
            feature(Value::Object(properties), geometry),
        )?;
    }
    Ok(())
}

fn add_blocks(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    graph: &RawGraph,
    track_ids: &[String],
    boundary_nodes: &BTreeSet<i64>,
    source_id: &str,
) -> Result<(), SemanticExportError> {
    let mut incident = BTreeMap::<i64, Vec<usize>>::new();
    for (index, edge) in graph.edges().iter().enumerate() {
        incident.entry(edge.from().value()).or_default().push(index);
        incident.entry(edge.to().value()).or_default().push(index);
    }
    let mut groups = DisjointSet::new(graph.edge_count());
    for (node_id, edge_indices) in &incident {
        if boundary_nodes.contains(node_id) || edge_indices.len() < 2 {
            continue;
        }
        let first = edge_indices[0];
        for &next in &edge_indices[1..] {
            groups.union(first, next);
        }
    }

    let mut blocks = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..graph.edge_count() {
        blocks.entry(groups.root(index)).or_default().push(index);
    }
    for edge_indices in blocks.values_mut() {
        edge_indices.sort_by(|left, right| track_ids[*left].cmp(&track_ids[*right]));
    }

    for edge_indices in blocks.values() {
        let member_track_ids: Vec<String> = edge_indices
            .iter()
            .map(|index| track_ids[*index].clone())
            .collect();
        let block_hash = stable_set_hash("zugfolge-conservative-block/v1", &member_track_ids);
        let block_id = format!("block:osm-{block_hash}");
        let boundary_signal_ids: BTreeSet<String> = edge_indices
            .iter()
            .flat_map(|index| {
                let edge = &graph.edges()[*index];
                [edge.from().value(), edge.to().value()]
            })
            .filter(|node_id| boundary_nodes.contains(node_id))
            .map(|node_id| format!("signal:osm-node-{node_id}"))
            .collect();
        let lines: Vec<Value> = edge_indices
            .iter()
            .map(|index| line_coordinates(graph.edges()[*index].geometry()))
            .collect();
        let length_mm = edge_indices
            .iter()
            .map(|index| geometry_length_mm(graph.edges()[*index].geometry()))
            .fold(0_i64, i64::saturating_add);
        let model_state = if boundary_signal_ids.is_empty() {
            "derived_conservative_connected_component"
        } else {
            "derived_conservative_signal_bounded_block"
        };
        let mut properties = common_properties(&block_id, "block", "B", model_state, source_id);
        properties.insert(
            "boundary_signal_count".to_owned(),
            json!(boundary_signal_ids.len()),
        );
        properties.insert(
            "boundary_signal_ids_json".to_owned(),
            json!(serde_json::to_string(&boundary_signal_ids)?),
        );
        properties.insert("length_mm".to_owned(), json!(length_mm));
        properties.insert("track_count".to_owned(), json!(member_track_ids.len()));
        properties.insert(
            "track_ids_json".to_owned(),
            json!(serde_json::to_string(&member_track_ids)?),
        );
        let geometry = json!({ "type": "MultiLineString", "coordinates": lines });
        insert_feature(
            layers,
            "blocks",
            block_id.clone(),
            feature(Value::Object(properties), geometry.clone()),
        )?;

        let resource_id = format!("conflict_resource:block-{block_hash}");
        let mut resource_properties = common_properties(
            &resource_id,
            "conflict_resource",
            "B",
            "derived_block_exclusion",
            source_id,
        );
        resource_properties.insert("block_id".to_owned(), json!(block_id));
        resource_properties.insert("resource_kind".to_owned(), json!("block"));
        resource_properties.insert(
            "track_ids_json".to_owned(),
            json!(serde_json::to_string(&member_track_ids)?),
        );
        insert_feature(
            layers,
            "conflict_resources",
            resource_id.clone(),
            feature(Value::Object(resource_properties), geometry),
        )?;
    }
    Ok(())
}

fn add_bidirectional_track_sections(
    layers: &mut BTreeMap<&'static str, FeatureSet>,
    graph: &RawGraph,
    track_ids: &[String],
    switch_nodes: &BTreeSet<i64>,
    source_id: &str,
) -> Result<(), SemanticExportError> {
    let mut incident = BTreeMap::<i64, Vec<usize>>::new();
    for (index, edge) in graph.edges().iter().enumerate() {
        incident.entry(edge.from().value()).or_default().push(index);
        incident.entry(edge.to().value()).or_default().push(index);
    }

    let mut sections = DisjointSet::new(graph.edge_count());
    for (node_id, edge_indices) in &incident {
        if switch_nodes.contains(node_id) || edge_indices.len() < 2 {
            continue;
        }
        let first = edge_indices[0];
        for &next in &edge_indices[1..] {
            sections.union(first, next);
        }
    }

    let mut section_edges = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..graph.edge_count() {
        section_edges
            .entry(sections.root(index))
            .or_default()
            .push(index);
    }
    for indices in section_edges.values_mut() {
        indices.sort_by(|left, right| track_ids[*left].cmp(&track_ids[*right]));
    }

    for indices in section_edges.values() {
        let member_track_ids: Vec<String> = indices
            .iter()
            .map(|index| track_ids[*index].clone())
            .collect();
        let section_hash =
            stable_set_hash("zugfolge-exclusive-track-section/v1", &member_track_ids);
        let resource_id = format!("conflict_resource:track-section-{section_hash}");
        let lines: Vec<Value> = indices
            .iter()
            .map(|index| line_coordinates(graph.edges()[*index].geometry()))
            .collect();
        let mut properties = common_properties(
            &resource_id,
            "conflict_resource",
            "B",
            "derived_conservative_bidirectional_exclusion",
            source_id,
        );
        properties.insert("compatibility".to_owned(), json!("exclusive"));
        properties.insert("opposing_movements_serialized".to_owned(), json!(true));
        properties.insert("resource_kind".to_owned(), json!("track_section"));
        properties.insert(
            "track_ids_json".to_owned(),
            json!(serde_json::to_string(&member_track_ids)?),
        );
        insert_feature(
            layers,
            "conflict_resources",
            resource_id.clone(),
            feature(
                Value::Object(properties),
                json!({ "type": "MultiLineString", "coordinates": lines }),
            ),
        )?;
    }
    Ok(())
}

fn count_quality(features: &FeatureSet) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::from([
        ("A".to_owned(), 0_usize),
        ("B".to_owned(), 0_usize),
        ("C".to_owned(), 0_usize),
    ]);
    for feature in features.values() {
        if let Some(quality) = feature
            .get("properties")
            .and_then(|properties| properties.get("quality_class"))
            .and_then(Value::as_str)
        {
            *counts.entry(quality.to_owned()).or_default() += 1;
        }
    }
    counts
}

fn write_layer(
    output_root: &Path,
    file_name: &str,
    features: &FeatureSet,
) -> Result<(String, usize), SemanticExportError> {
    let path = output_root.join(file_name);
    let mut writer = BufWriter::new(File::create(path)?);
    let mut hasher = Sha256::new();
    for feature in features.values() {
        let mut line = serde_json::to_vec(feature)?;
        line.push(b'\n');
        hasher.update(&line);
        writer.write_all(&line)?;
    }
    writer.flush()?;
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((sha256, features.len()))
}

/// Exportiert sieben streng nach `feature_id` sortierte GeoJSON-Sequenzlayer.
///
/// Das Zielverzeichnis erhaelt zusaetzlich `semantic-export-report.json` mit
/// Dateihashes, Zaehlern, Graphhashes und der expliziten Qualitaetspolitik.
///
/// # Errors
///
/// Gibt [`SemanticExportError`] bei einem ungueltigen PBF-Dokument, fehlender
/// Geometrie, ID-Kollision oder einem Dateisystemfehler zurueck.
fn build_semantic_geojsonseq(
    document: &PbfDocument,
    output_root: &Path,
) -> Result<SemanticExportSummary, SemanticExportError> {
    let raw = document.raw_graph()?;
    let ebo_outcome = filter_network(&raw);
    let ebo = ebo_outcome.graph();
    let source_id = document.source().as_str();
    let mut layers: BTreeMap<&'static str, FeatureSet> = LAYERS
        .iter()
        .map(|(name, _file)| (*name, BTreeMap::new()))
        .collect();

    let track_ids = add_tracks(&mut layers, ebo, source_id)?;
    let (boundary_nodes, switch_nodes) =
        add_point_objects(&mut layers, document, ebo, &track_ids, source_id)?;
    add_platforms(&mut layers, document, source_id)?;
    add_blocks(&mut layers, ebo, &track_ids, &boundary_nodes, source_id)?;
    add_bidirectional_track_sections(&mut layers, ebo, &track_ids, &switch_nodes, source_id)?;

    let mut layer_summaries = BTreeMap::new();
    for (name, file_name) in LAYERS {
        let features = layers
            .get(name)
            .expect("alle semantischen Pflichtlayer sind angelegt");
        let (sha256, count) = write_layer(output_root, file_name, features)?;
        layer_summaries.insert(
            name.to_owned(),
            LayerSummary {
                file: file_name.to_owned(),
                features: count,
                sha256,
                quality: count_quality(features),
            },
        );
    }

    let corpus_values: Vec<String> = layer_summaries
        .iter()
        .map(|(name, summary)| format!("{name}:{}:{}", summary.features, summary.sha256))
        .collect();
    let summary = SemanticExportSummary {
        source_id: source_id.to_owned(),
        raw_graph_sha256: raw.checksum(),
        ebo_graph_sha256: ebo.checksum(),
        corpus_sha256: stable_set_hash("zugfolge-osm-semantic-corpus/v1", &corpus_values),
        layers: layer_summaries,
    };
    let report_path = output_root.join("semantic-export-report.json");
    let mut report = serde_json::to_vec_pretty(&summary.as_json())?;
    report.push(b'\n');
    fs::write(report_path, report)?;
    Ok(summary)
}

fn staging_path(output_root: &Path) -> PathBuf {
    let mut staging = output_root.as_os_str().to_os_string();
    staging.push(".building");
    PathBuf::from(staging)
}

/// Exportiert sieben streng nach `feature_id` sortierte GeoJSON-Sequenzlayer.
///
/// Der Export reserviert zuerst ein separates `.building`-Verzeichnis. Nur
/// nach vollstaendiger Serialisierung aller Layer und des Berichts wird dieses
/// Verzeichnis zum Ziel umbenannt. Vorhandene Ziele oder parallele Bauversuche
/// werden nie ueberschrieben.
///
/// # Errors
///
/// Gibt [`SemanticExportError`] bei einem ungueltigen PBF-Dokument, fehlender
/// Geometrie, ID-Kollision, vorhandenen Ausgabepfaden oder einem
/// Dateisystemfehler zurueck.
pub fn export_semantic_geojsonseq(
    document: &PbfDocument,
    output_root: impl AsRef<Path>,
) -> Result<SemanticExportSummary, SemanticExportError> {
    let output_root = output_root.as_ref();
    if output_root.try_exists()? {
        return Err(SemanticExportError::OutputPathExists {
            path: output_root.to_path_buf(),
        });
    }
    let staging = staging_path(output_root);
    if staging.try_exists()? {
        return Err(SemanticExportError::OutputPathExists { path: staging });
    }
    if let Some(parent) = output_root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&staging)?;
    let result = build_semantic_geojsonseq(document, &staging);
    match result {
        Ok(summary) => {
            if output_root.try_exists()? {
                fs::remove_dir_all(&staging)?;
                return Err(SemanticExportError::OutputPathExists {
                    path: output_root.to_path_buf(),
                });
            }
            if let Err(error) = fs::rename(&staging, output_root) {
                let _cleanup_result = fs::remove_dir_all(&staging);
                return Err(SemanticExportError::Io(error));
            }
            Ok(summary)
        }
        Err(error) => {
            let _cleanup_result = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write as _};

    use flate2::Compression;
    use flate2::write::ZlibEncoder;

    use super::*;
    use crate::{SourceId, import_pbf_document};

    const KNOWN_BOSTRAB_SIGNAL_NODE_ID: i64 = 12_472_736_971;

    fn write_varint(buffer: &mut Vec<u8>, mut value: u64) {
        loop {
            let byte = u8::try_from(value & 0x7f).expect("sieben Bit passen in u8");
            value >>= 7;
            if value == 0 {
                buffer.push(byte);
                return;
            }
            buffer.push(byte | 0x80);
        }
    }

    fn write_tag(buffer: &mut Vec<u8>, field: u32, wire_type: u8) {
        write_varint(buffer, (u64::from(field) << 3) | u64::from(wire_type));
    }

    fn write_bytes(buffer: &mut Vec<u8>, field: u32, value: &[u8]) {
        write_tag(buffer, field, 2);
        write_varint(buffer, value.len() as u64);
        buffer.extend_from_slice(value);
    }

    fn write_string(buffer: &mut Vec<u8>, field: u32, value: &str) {
        write_bytes(buffer, field, value.as_bytes());
    }

    fn write_unsigned(buffer: &mut Vec<u8>, field: u32, value: u64) {
        write_tag(buffer, field, 0);
        write_varint(buffer, value);
    }

    fn write_zigzag(buffer: &mut Vec<u8>, value: i64) {
        let magnitude = value.unsigned_abs();
        let doubled = magnitude.checked_mul(2).expect("kleine Fixturewerte");
        write_varint(buffer, if value < 0 { doubled - 1 } else { doubled });
    }

    fn write_packed_unsigned(buffer: &mut Vec<u8>, field: u32, values: &[u64]) {
        let mut packed = Vec::new();
        for value in values {
            write_varint(&mut packed, *value);
        }
        write_bytes(buffer, field, &packed);
    }

    fn write_packed_zigzag(buffer: &mut Vec<u8>, field: u32, values: &[i64]) {
        let mut packed = Vec::new();
        for value in values {
            write_zigzag(&mut packed, *value);
        }
        write_bytes(buffer, field, &packed);
    }

    fn append_block(file: &mut Vec<u8>, block_type: &str, payload: &[u8]) {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(payload).expect("Fixture komprimierbar");
        let compressed = encoder.finish().expect("Fixture-Kompression endet");
        let mut blob = Vec::new();
        write_unsigned(&mut blob, 2, payload.len() as u64);
        write_bytes(&mut blob, 3, &compressed);
        let mut header = Vec::new();
        write_string(&mut header, 1, block_type);
        write_unsigned(&mut header, 3, blob.len() as u64);
        file.extend_from_slice(
            &u32::try_from(header.len())
                .expect("Fixture-Kopf passt in u32")
                .to_be_bytes(),
        );
        file.extend_from_slice(&header);
        file.extend_from_slice(&blob);
    }

    #[derive(Default)]
    struct StringTable(Vec<String>);

    impl StringTable {
        fn new() -> Self {
            Self(vec![String::new()])
        }

        fn index(&mut self, value: &str) -> u64 {
            if let Some(index) = self.0.iter().position(|stored| stored == value) {
                return index as u64;
            }
            self.0.push(value.to_owned());
            (self.0.len() - 1) as u64
        }

        fn encode(&self) -> Vec<u8> {
            let mut encoded = Vec::new();
            for value in &self.0 {
                write_bytes(&mut encoded, 1, value.as_bytes());
            }
            encoded
        }
    }

    struct FixtureNode {
        id: i64,
        latitude_e7: i32,
        longitude_e7: i32,
        tags: Vec<(&'static str, &'static str)>,
    }

    struct FixtureWay {
        id: i64,
        nodes: Vec<i64>,
        tags: Vec<(&'static str, &'static str)>,
    }

    fn dense_nodes(nodes: &[FixtureNode]) -> Vec<u8> {
        let mut table = StringTable::new();
        let mut ids = Vec::new();
        let mut latitudes = Vec::new();
        let mut longitudes = Vec::new();
        let mut key_values = Vec::new();
        let (mut previous_id, mut previous_latitude, mut previous_longitude) =
            (0_i64, 0_i64, 0_i64);
        for node in nodes {
            ids.push(node.id - previous_id);
            previous_id = node.id;
            let latitude = i64::from(node.latitude_e7);
            let longitude = i64::from(node.longitude_e7);
            latitudes.push(latitude - previous_latitude);
            longitudes.push(longitude - previous_longitude);
            previous_latitude = latitude;
            previous_longitude = longitude;
            for (key, value) in &node.tags {
                key_values.push(table.index(key));
                key_values.push(table.index(value));
            }
            key_values.push(0);
        }
        let mut dense = Vec::new();
        write_packed_zigzag(&mut dense, 1, &ids);
        write_packed_zigzag(&mut dense, 8, &latitudes);
        write_packed_zigzag(&mut dense, 9, &longitudes);
        write_packed_unsigned(&mut dense, 10, &key_values);
        let mut group = Vec::new();
        write_bytes(&mut group, 2, &dense);
        let mut block = Vec::new();
        write_bytes(&mut block, 1, &table.encode());
        write_bytes(&mut block, 2, &group);
        block
    }

    fn ways(ways: &[FixtureWay]) -> Vec<u8> {
        let mut table = StringTable::new();
        let mut encoded_ways = Vec::new();
        for way in ways {
            let mut keys = Vec::new();
            let mut values = Vec::new();
            for (key, value) in &way.tags {
                keys.push(table.index(key));
                values.push(table.index(value));
            }
            let mut references = Vec::new();
            let mut previous = 0_i64;
            for node_id in &way.nodes {
                references.push(*node_id - previous);
                previous = *node_id;
            }
            let mut encoded = Vec::new();
            write_unsigned(
                &mut encoded,
                1,
                u64::try_from(way.id).expect("Fixture-Wegkennungen sind positiv"),
            );
            write_packed_unsigned(&mut encoded, 2, &keys);
            write_packed_unsigned(&mut encoded, 3, &values);
            write_packed_zigzag(&mut encoded, 8, &references);
            encoded_ways.push(encoded);
        }
        let mut group = Vec::new();
        for way in encoded_ways {
            write_bytes(&mut group, 3, &way);
        }
        let mut block = Vec::new();
        write_bytes(&mut block, 1, &table.encode());
        write_bytes(&mut block, 2, &group);
        block
    }

    fn pbf_fixture(nodes: &[FixtureNode], ways_fixture: &[FixtureWay]) -> Vec<u8> {
        let mut header = Vec::new();
        write_string(&mut header, 4, "OsmSchema-V0.6");
        write_string(&mut header, 4, "DenseNodes");
        let mut pbf = Vec::new();
        append_block(&mut pbf, "OSMHeader", &header);
        append_block(&mut pbf, "OSMData", &dense_nodes(nodes));
        append_block(&mut pbf, "OSMData", &ways(ways_fixture));
        pbf
    }

    fn semantic_fixture() -> Vec<u8> {
        let nodes = [
            FixtureNode {
                id: 1,
                latitude_e7: 512_300_000,
                longitude_e7: 123_000_000,
                tags: vec![("railway", "station"), ("name", "Testmitte")],
            },
            FixtureNode {
                id: 2,
                latitude_e7: 512_300_000,
                longitude_e7: 123_050_000,
                tags: vec![
                    ("railway", "signal"),
                    ("railway:signal:main", "DE-ESO:ks"),
                    ("railway:signal:direction", "forward"),
                ],
            },
            FixtureNode {
                id: 3,
                latitude_e7: 512_300_000,
                longitude_e7: 123_100_000,
                tags: vec![("railway", "switch"), ("ref", "12")],
            },
            FixtureNode {
                id: 4,
                latitude_e7: 512_300_000,
                longitude_e7: 123_200_000,
                tags: vec![("railway", "buffer_stop")],
            },
            FixtureNode {
                id: 5,
                latitude_e7: 512_350_000,
                longitude_e7: 123_150_000,
                tags: vec![("railway", "buffer_stop")],
            },
            FixtureNode {
                id: 10,
                latitude_e7: 512_299_000,
                longitude_e7: 123_020_000,
                tags: vec![],
            },
            FixtureNode {
                id: 11,
                latitude_e7: 512_299_000,
                longitude_e7: 123_040_000,
                tags: vec![],
            },
            FixtureNode {
                id: 12,
                latitude_e7: 512_301_000,
                longitude_e7: 123_040_000,
                tags: vec![],
            },
        ];
        let ways_fixture = [
            FixtureWay {
                id: 100,
                nodes: vec![1, 2, 3, 4],
                tags: vec![
                    ("railway", "rail"),
                    ("gauge", "1435"),
                    ("maxspeed", "100"),
                    ("maxspeed:forward", "120"),
                    ("maxspeed:backward", "80 km/h"),
                    ("electrified", "contact_line"),
                ],
            },
            FixtureWay {
                id: 101,
                nodes: vec![3, 5],
                tags: vec![
                    ("railway", "rail"),
                    ("gauge", "1435"),
                    ("service", "crossover"),
                ],
            },
            FixtureWay {
                id: 200,
                nodes: vec![10, 11, 12, 10],
                tags: vec![("railway", "platform"), ("ref", "1")],
            },
        ];
        pbf_fixture(&nodes, &ways_fixture)
    }

    fn ebo_point_scope_fixture() -> Vec<u8> {
        let nodes = [
            FixtureNode {
                id: 1,
                latitude_e7: 520_000_000,
                longitude_e7: 130_000_000,
                tags: vec![("railway", "station"), ("name", "EBO-Test")],
            },
            FixtureNode {
                id: 2,
                latitude_e7: 520_000_000,
                longitude_e7: 130_010_000,
                tags: vec![("railway", "signal"), ("railway:signal:main", "DE-ESO:ks")],
            },
            FixtureNode {
                id: 3,
                latitude_e7: 520_000_000,
                longitude_e7: 130_030_000,
                tags: vec![("railway", "switch")],
            },
            FixtureNode {
                id: 4,
                latitude_e7: 520_000_000,
                longitude_e7: 130_040_000,
                tags: vec![("railway", "buffer_stop")],
            },
            FixtureNode {
                id: 5,
                latitude_e7: 520_010_000,
                longitude_e7: 130_040_000,
                tags: vec![("railway", "buffer_stop")],
            },
            FixtureNode {
                id: 6,
                latitude_e7: 520_000_000,
                longitude_e7: 130_020_000,
                tags: vec![("public_transport", "stop_position"), ("train", "yes")],
            },
            FixtureNode {
                id: 20,
                latitude_e7: 521_000_000,
                longitude_e7: 131_000_000,
                tags: vec![],
            },
            FixtureNode {
                id: 21,
                latitude_e7: 521_000_000,
                longitude_e7: 131_020_000,
                tags: vec![("railway", "switch")],
            },
            FixtureNode {
                id: 22,
                latitude_e7: 521_000_000,
                longitude_e7: 131_030_000,
                tags: vec![("railway", "level_crossing")],
            },
            FixtureNode {
                id: 23,
                latitude_e7: 521_000_000,
                longitude_e7: 131_040_000,
                tags: vec![],
            },
            FixtureNode {
                id: 30,
                latitude_e7: 522_000_000,
                longitude_e7: 132_000_000,
                tags: vec![("railway", "signal"), ("railway:signal:main", "DE-ESO:ks")],
            },
            FixtureNode {
                id: 40,
                latitude_e7: 523_000_000,
                longitude_e7: 133_010_000,
                tags: vec![("railway", "switch")],
            },
            FixtureNode {
                id: 41,
                latitude_e7: 523_000_000,
                longitude_e7: 133_000_000,
                tags: vec![],
            },
            FixtureNode {
                id: 42,
                latitude_e7: 523_000_000,
                longitude_e7: 133_020_000,
                tags: vec![],
            },
            FixtureNode {
                id: 43,
                latitude_e7: 523_010_000,
                longitude_e7: 133_010_000,
                tags: vec![],
            },
            FixtureNode {
                id: 50,
                latitude_e7: 524_000_000,
                longitude_e7: 134_010_000,
                tags: vec![
                    ("railway", "signal"),
                    ("railway:signal:main", "DE-BOStrab:h1"),
                ],
            },
            FixtureNode {
                id: 51,
                latitude_e7: 524_000_000,
                longitude_e7: 134_000_000,
                tags: vec![],
            },
            FixtureNode {
                id: 52,
                latitude_e7: 524_000_000,
                longitude_e7: 134_020_000,
                tags: vec![],
            },
            FixtureNode {
                id: KNOWN_BOSTRAB_SIGNAL_NODE_ID,
                latitude_e7: 521_000_000,
                longitude_e7: 131_010_000,
                tags: vec![
                    ("railway", "signal"),
                    ("railway:signal:speed_limit", "DE-BOStrab:g3"),
                ],
            },
        ];
        let ways_fixture = [
            FixtureWay {
                id: 100,
                nodes: vec![1, 2, 6, 3, 4],
                tags: vec![("railway", "rail"), ("gauge", "1435")],
            },
            FixtureWay {
                id: 101,
                nodes: vec![3, 5],
                tags: vec![("railway", "rail"), ("gauge", "1435")],
            },
            FixtureWay {
                id: 300,
                nodes: vec![41, 40, 42],
                tags: vec![("railway", "rail"), ("gauge", "1435")],
            },
            FixtureWay {
                id: 301,
                nodes: vec![40, 43],
                tags: vec![("railway", "tram"), ("tram", "yes")],
            },
            FixtureWay {
                id: 400,
                nodes: vec![51, 50, 52],
                tags: vec![("railway", "rail"), ("gauge", "1435")],
            },
            FixtureWay {
                id: 106_059_932,
                nodes: vec![20, KNOWN_BOSTRAB_SIGNAL_NODE_ID],
                tags: vec![("railway", "tram"), ("tram", "yes"), ("operator", "BVG")],
            },
            FixtureWay {
                id: 1_348_391_986,
                nodes: vec![KNOWN_BOSTRAB_SIGNAL_NODE_ID, 21, 22, 23],
                tags: vec![("railway", "tram"), ("tram", "yes"), ("operator", "BVG")],
            },
        ];
        pbf_fixture(&nodes, &ways_fixture)
    }

    fn read_features(root: &Path, file: &str) -> Vec<Value> {
        fs::read_to_string(root.join(file))
            .expect("Layer lesbar")
            .lines()
            .map(|line| serde_json::from_str(line).expect("gueltiges GeoJSON-Feature"))
            .collect()
    }

    #[test]
    fn richtungswert_ueberschreibt_den_allgemeinen_wert_auch_als_sichere_luecke() {
        let tags = BTreeMap::from([
            ("maxspeed".to_owned(), "160".to_owned()),
            ("maxspeed:forward".to_owned(), "signals".to_owned()),
            ("service".to_owned(), "siding".to_owned()),
        ]);
        assert_eq!(
            modeled_speed(&tags, "maxspeed:forward"),
            (10, "conservative_default")
        );
        assert_eq!(
            modeled_speed(&tags, "maxspeed:backward"),
            (160, "observed_osm_common")
        );
    }

    #[test]
    fn synthetisches_pbf_wird_deterministisch_und_konservativ_exportiert() {
        let mut reader = Cursor::new(semantic_fixture());
        let document = import_pbf_document(
            &mut reader,
            SourceId::new("osm-pbf-deutschland").expect("Quellenkennung"),
        )
        .expect("Fixture-PBF");
        let base =
            std::env::temp_dir().join(format!("zugfolge-semantic-export-{}", std::process::id()));
        let first = base.join("first");
        let second = base.join("second");
        if base.exists() {
            fs::remove_dir_all(&base).expect("alter Testordner entfernbar");
        }
        let first_summary = export_semantic_geojsonseq(&document, &first).expect("erster Export");
        let second_summary =
            export_semantic_geojsonseq(&document, &second).expect("zweiter Export");
        assert_eq!(first_summary, second_summary);
        assert_eq!(first_summary.layer_counts()["tracks"], 4);
        assert_eq!(first_summary.layer_counts()["switches"], 1);
        assert_eq!(first_summary.layer_counts()["signals"], 1);
        assert_eq!(first_summary.layer_counts()["platforms"], 1);
        assert_eq!(first_summary.layer_counts()["blocks"], 2);
        assert!(!staging_path(&first).exists());
        assert!(!staging_path(&second).exists());

        for (layer, file) in LAYERS {
            let features = read_features(&first, file);
            assert!(!features.is_empty(), "{layer} ist belegt");
            let ids: Vec<&str> = features
                .iter()
                .map(|feature| {
                    feature["properties"]["feature_id"]
                        .as_str()
                        .expect("feature_id")
                })
                .collect();
            assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(
                features
                    .iter()
                    .all(|feature| feature["properties"]["quality_class"] != "A")
            );
            assert!(
                features
                    .iter()
                    .all(|feature| feature["properties"].get("validation_evidence").is_none())
            );
        }

        let tracks = read_features(&first, "tracks.geojsonseq");
        assert_eq!(
            tracks[0]["geometry"]["coordinates"][0].to_string(),
            "[12.3,51.23]"
        );
        let tags: BTreeMap<String, String> = serde_json::from_str(
            tracks[0]["properties"]["osm_tags_json"]
                .as_str()
                .expect("kanonische OSM-Tags"),
        )
        .expect("OSM-Tags als JSON");
        assert_eq!(tags.get("maxspeed").map(String::as_str), Some("100"));
        assert_eq!(tracks[0]["properties"]["speed_forward_kmh"], 120);
        assert_eq!(tracks[0]["properties"]["speed_backward_kmh"], 80);
        assert_eq!(
            tracks[0]["properties"]["speed_forward_model"],
            "observed_osm_directional"
        );

        let branch = tracks
            .iter()
            .find(|feature| feature["properties"]["osm_way_id"] == 101)
            .expect("Nebengleis");
        assert_eq!(branch["properties"]["speed_forward_kmh"], 10);
        assert_eq!(
            branch["properties"]["speed_forward_model"],
            "conservative_default"
        );

        let blocks = read_features(&first, "blocks.geojsonseq");
        assert_eq!(blocks[0]["geometry"]["type"], "MultiLineString");
        assert!(
            blocks
                .iter()
                .any(|block| block["properties"]["track_count"] == 3)
        );

        let resources = read_features(&first, "conflict-resources.geojsonseq");
        let track_sections: Vec<&Value> = resources
            .iter()
            .filter(|feature| feature["properties"]["resource_kind"] == "track_section")
            .collect();
        assert_eq!(track_sections.len(), 3);
        assert!(track_sections.iter().all(|feature| {
            feature["properties"]["compatibility"] == "exclusive"
                && feature["properties"]["opposing_movements_serialized"] == true
        }));
        assert!(track_sections.iter().any(|feature| {
            serde_json::from_str::<Vec<String>>(
                feature["properties"]["track_ids_json"]
                    .as_str()
                    .expect("Gleiskennungen"),
            )
            .is_ok_and(|tracks| tracks.len() == 2)
        }));

        let original_report =
            fs::read(first.join("semantic-export-report.json")).expect("fertiger Bericht");
        let collision = export_semantic_geojsonseq(&document, &first)
            .expect_err("fertiges Ziel darf nie ueberschrieben werden");
        assert!(matches!(
            collision,
            SemanticExportError::OutputPathExists { path } if path == first
        ));
        assert_eq!(
            fs::read(first.join("semantic-export-report.json")).expect("Bericht bleibt bestehen"),
            original_report
        );

        let third = base.join("third");
        let third_staging = staging_path(&third);
        fs::create_dir(&third_staging).expect("fremdes Bauverzeichnis reservierbar");
        fs::write(third_staging.join("owner"), b"anderer lauf").expect("Reservierungsmarker");
        let parallel = export_semantic_geojsonseq(&document, &third)
            .expect_err("paralleler Bauversuch muss scheitern");
        assert!(matches!(
            parallel,
            SemanticExportError::OutputPathExists { path } if path == third_staging
        ));
        assert!(!third.exists());
        assert_eq!(
            fs::read(third_staging.join("owner")).expect("fremder Marker bleibt erhalten"),
            b"anderer lauf"
        );
        fs::remove_dir_all(base).expect("Testordner entfernbar");
    }

    #[test]
    fn punktobjekte_bleiben_fail_closed_im_ebo_scope() {
        let mut reader = Cursor::new(ebo_point_scope_fixture());
        let document = import_pbf_document(
            &mut reader,
            SourceId::new("osm-pbf-deutschland").expect("Quellenkennung"),
        )
        .expect("Fixture-PBF");
        let base = std::env::temp_dir().join(format!(
            "zugfolge-semantic-ebo-point-scope-{}",
            std::process::id()
        ));
        if base.exists() {
            fs::remove_dir_all(&base).expect("alter Testordner entfernbar");
        }

        let summary = export_semantic_geojsonseq(&document, &base).expect("Semantikexport");
        assert_eq!(summary.layer_counts()["signals"], 1);
        assert_eq!(summary.layer_counts()["switches"], 1);

        let signals = read_features(&base, "signals.geojsonseq");
        let signal_ids: BTreeSet<&str> = signals
            .iter()
            .map(|feature| {
                feature["properties"]["feature_id"]
                    .as_str()
                    .expect("Signal-ID")
            })
            .collect();
        assert_eq!(signal_ids, BTreeSet::from(["signal:osm-node-2"]));
        for excluded_id in [
            format!("signal:osm-node-{KNOWN_BOSTRAB_SIGNAL_NODE_ID}"),
            "signal:osm-node-30".to_owned(),
            "signal:osm-node-50".to_owned(),
        ] {
            assert!(!signal_ids.contains(excluded_id.as_str()));
        }

        let switches = read_features(&base, "switches.geojsonseq");
        let switch_ids: BTreeSet<&str> = switches
            .iter()
            .map(|feature| {
                feature["properties"]["feature_id"]
                    .as_str()
                    .expect("Weichen-ID")
            })
            .collect();
        assert_eq!(switch_ids, BTreeSet::from(["switch:osm-node-3"]));
        assert!(!switch_ids.contains("switch:osm-node-21"));
        assert!(!switch_ids.contains("switch:osm-node-40"));

        let contexts = read_features(&base, "rail-context.geojsonseq");
        let context_ids: BTreeSet<&str> = contexts
            .iter()
            .map(|feature| {
                feature["properties"]["feature_id"]
                    .as_str()
                    .expect("Kontext-ID")
            })
            .collect();
        assert!(context_ids.contains("rail_context:osm-node-1"));
        assert!(
            context_ids.contains("rail_context:osm-node-6"),
            "ein innenliegender, per EBO-Weg belegter Stop bleibt erhalten"
        );
        assert!(!context_ids.contains("rail_context:osm-node-22"));

        let blocks = read_features(&base, "blocks.geojsonseq");
        let boundary_signal_ids: BTreeSet<String> = blocks
            .iter()
            .flat_map(|feature| {
                serde_json::from_str::<BTreeSet<String>>(
                    feature["properties"]["boundary_signal_ids_json"]
                        .as_str()
                        .expect("Blockgrenzen"),
                )
                .expect("Signal-IDs als JSON")
            })
            .collect();
        assert!(boundary_signal_ids.contains("signal:osm-node-2"));
        assert!(
            !boundary_signal_ids
                .contains(&format!("signal:osm-node-{KNOWN_BOSTRAB_SIGNAL_NODE_ID}"))
        );
        assert!(!boundary_signal_ids.contains("signal:osm-node-50"));

        let resources = read_features(&base, "conflict-resources.geojsonseq");
        let resource_ids: BTreeSet<&str> = resources
            .iter()
            .map(|feature| {
                feature["properties"]["feature_id"]
                    .as_str()
                    .expect("Ressourcen-ID")
            })
            .collect();
        assert!(resource_ids.contains("conflict_resource:switch-osm-node-3"));
        assert!(!resource_ids.contains("conflict_resource:switch-osm-node-21"));
        assert!(!resource_ids.contains("conflict_resource:switch-osm-node-40"));

        let known_node_id = KNOWN_BOSTRAB_SIGNAL_NODE_ID.to_string();
        for (_layer, file) in LAYERS {
            let bytes = fs::read_to_string(base.join(file)).expect("Semantiklayer lesbar");
            assert!(
                !bytes.contains(&known_node_id),
                "bekannter BOStrab-Knoten darf nicht in {file} erscheinen"
            );
        }

        fs::remove_dir_all(base).expect("Testordner entfernbar");
    }
}
