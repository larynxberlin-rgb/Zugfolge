//! Integrationsbeweise fuer den nativen Deutschland-Class-B-Ableiter.

use std::collections::BTreeSet;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_infra::{derive_germany_operational_v2, validate_operational_infrastructure_v2_file};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn create() -> Self {
        let id = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zugfolge-germany-operational-v2-test-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("eindeutiges Testverzeichnis");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_sequence(path: &Path, records: &[Value]) {
    let mut bytes = Vec::new();
    for record in records {
        bytes.push(0x1e);
        bytes.extend(serde_json::to_vec(record).expect("Testdatensatz serialisieren"));
        bytes.push(b'\n');
    }
    fs::write(path, bytes).expect("GeoJSONSeq-Testlayer schreiben");
}

fn canonical_json(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("Teststring kanonisieren"));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("Testschluessel kanonisieren"));
                output.push(':');
                canonical_json(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn alpha_hash(schema: &str, value: &Value) -> String {
    let mut canonical = String::new();
    canonical_json(&json!({"schema": schema, "value": value}), &mut canonical);
    sha256(canonical.as_bytes())
}

fn feature(geometry: Value, properties: Value) -> Value {
    json!({"type": "Feature", "geometry": geometry, "properties": properties})
}

fn track(
    id: &str,
    from: i64,
    to: i64,
    length_mm: i64,
    left: [Value; 2],
    right: [Value; 2],
) -> Value {
    track_with_tags(
        id,
        from,
        to,
        length_mm,
        left,
        right,
        "{\"railway\":\"rail\",\"railway:pzb\":\"yes\",\"usage\":\"main\"}",
    )
}

fn track_with_tags(
    id: &str,
    from: i64,
    to: i64,
    length_mm: i64,
    left: [Value; 2],
    right: [Value; 2],
    osm_tags_json: &str,
) -> Value {
    feature(
        json!({"type": "LineString", "coordinates": [left, right]}),
        json!({
            "feature_id": id,
            "feature_type": "track",
            "from_osm_node_id": from,
            "to_osm_node_id": to,
            "length_mm": length_mm,
            "orderable": true,
            "quality_class": "B",
            "model_state": "observed_osm_topology_with_conservative_defaults",
            "source_id": "test-osm-source",
            "osm_way_id": from.abs().max(1),
            "speed_forward_kmh": 80,
            "speed_backward_kmh": 70,
            "osm_tags_json": osm_tags_json
        }),
    )
}

fn prepare_layers(root: &TestDirectory) {
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track(
                "track-1",
                1,
                2,
                1_000,
                [json!(12.0), json!(51.0)],
                [json!(12.0001), json!(51.0)],
            ),
            track(
                "track-2",
                2,
                3,
                1_200,
                [json!(12.0001), json!(51.0)],
                [json!(12.0002), json!(51.0)],
            ),
        ],
    );
    write_sequence(
        &root.join("platforms.geojsonseq"),
        &[
            feature(
                json!({"type": "Point", "coordinates": [12.00005, 51.0]}),
                json!({"feature_id": "platform-point", "feature_type": "platform", "quality_class": "C", "orderable": false}),
            ),
            feature(
                json!({"type": "LineString", "coordinates": [[12.00015, 50.999], [12.00015, 51.001]]}),
                json!({"feature_id": "platform-line", "feature_type": "platform", "quality_class": "C", "orderable": false}),
            ),
            feature(
                json!({"type": "Polygon", "coordinates": [[[12.00002, 50.999], [12.00008, 50.999], [12.00008, 51.001], [12.00002, 51.001], [12.00002, 50.999]]]}),
                json!({"feature_id": "platform-polygon", "feature_type": "platform", "quality_class": "C", "orderable": false}),
            ),
        ],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
            json!({
                "feature_id": "switch-2",
                "feature_type": "switch",
                "osm_node_id": 2,
                "incident_track_ids_json": "[\"track-1\",\"track-2\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("signals.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0, 51.0]}),
            json!({
                "feature_id": "signal-observed-1",
                "feature_type": "signal",
                "incident_track_ids_json": "[\"track-1\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("blocks.geojsonseq"),
        &[
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "block-1",
                    "track_ids_json": "[\"track-1\"]",
                    "boundary_signal_ids_json": "[\"signal-observed-1\"]"
                }),
            ),
            feature(
                json!({"type": "LineString", "coordinates": [[12.0001, 51.0], [12.0002, 51.0]]}),
                json!({
                    "feature_id": "block-2",
                    "track_ids_json": "[\"track-2\"]",
                    "boundary_signal_ids_json": "[]"
                }),
            ),
        ],
    );
    write_sequence(
        &root.join("conflict-resources.geojsonseq"),
        &[
            feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                json!({
                    "feature_id": "resource-switch-2",
                    "resource_kind": "switch",
                    "switch_id": "switch-2",
                    "incident_track_ids_json": serde_json::to_string(&["track-1", "track-2"]).expect("Trackliste")
                }),
            ),
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "resource-block-1",
                    "resource_kind": "block",
                    "block_id": "block-1",
                    "track_ids_json": serde_json::to_string(&["track-1"]).expect("Trackliste")
                }),
            ),
            feature(
                json!({"type": "LineString", "coordinates": [[12.0001, 51.0], [12.0002, 51.0]]}),
                json!({
                    "feature_id": "resource-track-section-2",
                    "resource_kind": "track_section",
                    "track_ids_json": serde_json::to_string(&["track-2"]).expect("Trackliste")
                }),
            ),
        ],
    );
}

fn prepare_shared_middle_layers(root: &TestDirectory) {
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track(
                "a-in",
                1,
                2,
                1_000,
                [json!(12.0), json!(51.0)],
                [json!(12.0001), json!(51.0)],
            ),
            track(
                "shared",
                2,
                3,
                1_000,
                [json!(12.0001), json!(51.0)],
                [json!(12.0002), json!(51.0)],
            ),
            track(
                "a-branch",
                3,
                4,
                1_000,
                [json!(12.0002), json!(51.0)],
                [json!(12.0003), json!(51.0)],
            ),
            track(
                "a-out",
                4,
                5,
                1_000,
                [json!(12.0003), json!(51.0)],
                [json!(12.0004), json!(51.0)],
            ),
            track(
                "b-in",
                6,
                2,
                1_000,
                [json!(12.0001), json!(50.9999)],
                [json!(12.0001), json!(51.0)],
            ),
            track(
                "b-branch",
                3,
                7,
                1_000,
                [json!(12.0002), json!(51.0)],
                [json!(12.0002), json!(51.0001)],
            ),
            track(
                "b-out",
                7,
                8,
                1_000,
                [json!(12.0002), json!(51.0001)],
                [json!(12.0002), json!(51.0002)],
            ),
        ],
    );
    write_sequence(
        &root.join("platforms.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.00015, 51.0]}),
            json!({"feature_id": "platform-shared", "feature_type": "platform", "quality_class": "C", "orderable": false}),
        )],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[
            feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                json!({
                    "feature_id": "switch-2",
                    "feature_type": "switch",
                    "osm_node_id": 2,
                    "incident_track_ids_json": serde_json::to_string(&["a-in", "b-in", "shared"]).expect("Trackliste")
                }),
            ),
            feature(
                json!({"type": "Point", "coordinates": [12.0002, 51.0]}),
                json!({
                    "feature_id": "switch-3",
                    "feature_type": "switch",
                    "osm_node_id": 3,
                    "incident_track_ids_json": serde_json::to_string(&["shared", "a-branch", "b-branch"]).expect("Trackliste")
                }),
            ),
        ],
    );
    write_sequence(
        &root.join("signals.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0, 51.0]}),
            json!({
                "feature_id": "signal-shared-fixture",
                "feature_type": "signal",
                "incident_track_ids_json": "[\"a-in\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("blocks.geojsonseq"),
        &[feature(
            json!({"type": "LineString", "coordinates": [[12.0001, 51.0], [12.0002, 51.0]]}),
            json!({
                "feature_id": "block-shared-fixture",
                "track_ids_json": "[\"shared\"]",
                "boundary_signal_ids_json": "[\"signal-shared-fixture\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("conflict-resources.geojsonseq"),
        &[
            feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                json!({
                    "feature_id": "resource-switch-2",
                    "resource_kind": "switch",
                    "switch_id": "switch-2",
                    "incident_track_ids_json": serde_json::to_string(&["a-in", "b-in", "shared"]).expect("Trackliste")
                }),
            ),
            feature(
                json!({"type": "Point", "coordinates": [12.0002, 51.0]}),
                json!({
                    "feature_id": "resource-switch-3",
                    "resource_kind": "switch",
                    "switch_id": "switch-3",
                    "incident_track_ids_json": serde_json::to_string(&["shared", "a-branch", "b-branch"]).expect("Trackliste")
                }),
            ),
        ],
    );
}

fn prepare_self_loop_layers(root: &TestDirectory) {
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track(
                "loop",
                1,
                1,
                1_000,
                [json!(12.0), json!(51.0)],
                [json!(12.0001), json!(51.0)],
            ),
            track(
                "out",
                1,
                2,
                1_000,
                [json!(12.0001), json!(51.0)],
                [json!(12.0002), json!(51.0)],
            ),
        ],
    );
    write_sequence(
        &root.join("platforms.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.00005, 51.0]}),
            json!({"feature_id": "platform-loop", "feature_type": "platform", "quality_class": "C", "orderable": false}),
        )],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
            json!({
                "feature_id": "switch-loop",
                "feature_type": "switch",
                "osm_node_id": 1,
                "incident_track_ids_json": "[\"loop\",\"out\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("signals.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0, 51.0]}),
            json!({
                "feature_id": "signal-loop",
                "feature_type": "signal",
                "incident_track_ids_json": "[\"loop\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("blocks.geojsonseq"),
        &[feature(
            json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
            json!({
                "feature_id": "block-loop",
                "track_ids_json": "[\"loop\"]",
                "boundary_signal_ids_json": "[\"signal-loop\"]"
            }),
        )],
    );
    write_sequence(
        &root.join("conflict-resources.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
            json!({
                "feature_id": "resource-switch-loop",
                "resource_kind": "switch",
                "switch_id": "switch-loop",
                "incident_track_ids_json": "[\"loop\",\"out\"]"
            }),
        )],
    );
}

fn prepare_platform_tie_layers(root: &TestDirectory, reverse: bool) {
    prepare_layers(root);
    let mut tracks = vec![
        track(
            "track-1",
            1,
            2,
            1_000,
            [json!(12.0), json!(51.0)],
            [json!(12.0001), json!(51.0)],
        ),
        track(
            "track-2",
            2,
            3,
            1_200,
            [json!(12.0001), json!(51.0)],
            [json!(12.0002), json!(51.0)],
        ),
        track(
            "track-a",
            10,
            11,
            1_000,
            [json!(13.0), json!(52.0)],
            [json!(13.0001), json!(52.0)],
        ),
        track(
            "track-b",
            12,
            13,
            1_000,
            [json!(13.0), json!(52.0002)],
            [json!(13.0001), json!(52.0002)],
        ),
    ];
    if reverse {
        tracks.reverse();
    }
    write_sequence(&root.join("tracks.geojsonseq"), &tracks);
    write_sequence(
        &root.join("platforms.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [13.00005, 52.0001]}),
            json!({"feature_id": "platform-tie", "feature_type": "platform", "quality_class": "C", "orderable": false}),
        )],
    );
}

const CONNEWITZ_TERMINAL_EDGE: &str = "track:osm-way-885621179-segment-3-n4158877934-n8235223466";
const CONNEWITZ_CONNECTOR_2: &str = "track:osm-way-885621179-segment-2-n2407262407-n4158877934";
const CONNEWITZ_CONNECTOR_1: &str = "track:osm-way-885621179-segment-1-n8235223464-n2407262407";
const CONNEWITZ_BERTH_EDGE: &str = "track:osm-way-184332926-segment-1-n6569301007-n8235223464";
const MULTI_SEGMENT_APPROACH_EDGE: &str =
    "track:osm-way-123131206-segment-3-n9100000001-n8235223466";
const THROUGH_OUTBOUND_EDGE: &str = "track:osm-way-99112233-segment-1-n4158877934-n9100000002";

fn prepare_connewitz_turnaround_layers(
    root: &TestDirectory,
    berth_length_mm: i64,
    berth_tags: &str,
    include_alternate_path: bool,
) {
    let main_tags = concat!(
        "{\"railway\":\"rail\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"usage\":\"main\"}"
    );
    let siding_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}"
    );
    let mut tracks = vec![
        track_with_tags(
            CONNEWITZ_TERMINAL_EDGE,
            4_158_877_934,
            8_235_223_466,
            73_204,
            [json!(12.37), json!(51.30)],
            [json!(12.371), json!(51.30)],
            main_tags,
        ),
        track_with_tags(
            CONNEWITZ_CONNECTOR_2,
            2_407_262_407,
            4_158_877_934,
            35_259,
            [json!(12.369), json!(51.30)],
            [json!(12.37), json!(51.30)],
            siding_tags,
        ),
        track_with_tags(
            CONNEWITZ_CONNECTOR_1,
            8_235_223_464,
            2_407_262_407,
            31_515,
            [json!(12.368), json!(51.30)],
            [json!(12.369), json!(51.30)],
            siding_tags,
        ),
        track_with_tags(
            CONNEWITZ_BERTH_EDGE,
            6_569_301_007,
            8_235_223_464,
            berth_length_mm,
            [json!(12.366), json!(51.30)],
            [json!(12.368), json!(51.30)],
            berth_tags,
        ),
    ];
    if include_alternate_path {
        tracks.extend([
            track_with_tags(
                "track:alternate-siding-terminal-to-mid",
                9_000_000_001,
                4_158_877_934,
                40_000,
                [json!(12.3688), json!(51.3002)],
                [json!(12.37), json!(51.30)],
                siding_tags,
            ),
            track_with_tags(
                "track:alternate-siding-mid-to-berth",
                8_235_223_464,
                9_000_000_001,
                40_000,
                [json!(12.368), json!(51.30)],
                [json!(12.3688), json!(51.3002)],
                siding_tags,
            ),
        ]);
    }
    write_sequence(&root.join("tracks.geojsonseq"), &tracks);
    write_sequence(
        &root.join("platforms.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.3705, 51.30]}),
            json!({
                "feature_id": "platform:connewitz:test-evidence",
                "feature_type": "platform",
                "quality_class": "C",
                "orderable": false
            }),
        )],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.37, 51.30]}),
            json!({
                "feature_id": "switch:connewitz:terminal",
                "feature_type": "switch",
                "osm_node_id": 4_158_877_934_i64,
                "incident_track_ids_json": serde_json::to_string(&[
                    CONNEWITZ_TERMINAL_EDGE,
                    CONNEWITZ_CONNECTOR_2
                ]).expect("Weichenkanten")
            }),
        )],
    );
    write_sequence(
        &root.join("signals.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.37, 51.30]}),
            json!({
                "feature_id": "signal:connewitz:terminal",
                "feature_type": "signal",
                "incident_track_ids_json": serde_json::to_string(&[CONNEWITZ_TERMINAL_EDGE])
                    .expect("Signalkanten")
            }),
        )],
    );
    write_sequence(
        &root.join("blocks.geojsonseq"),
        &[feature(
            json!({"type": "LineString", "coordinates": [[12.37, 51.30], [12.371, 51.30]]}),
            json!({
                "feature_id": "block:connewitz:terminal",
                "track_ids_json": serde_json::to_string(&[CONNEWITZ_TERMINAL_EDGE])
                    .expect("Blockkanten"),
                "boundary_signal_ids_json": serde_json::to_string(&["signal:connewitz:terminal"])
                    .expect("Blocksignale")
            }),
        )],
    );
    write_sequence(
        &root.join("conflict-resources.geojsonseq"),
        &[feature(
            json!({"type": "LineString", "coordinates": [[12.37, 51.30], [12.371, 51.30]]}),
            json!({
                "feature_id": "resource:connewitz:terminal",
                "resource_kind": "track_section",
                "track_ids_json": serde_json::to_string(&[CONNEWITZ_TERMINAL_EDGE])
                    .expect("Ressourcenkanten")
            }),
        )],
    );
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[
            json!({
                "routeVersionId": "passenger:connewitz:inbound",
                "templateId": "passenger-template:connewitz:inbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "against",
                    "edgeEntryMm": 73_204,
                    "edgeExitMm": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
            json!({
                "routeVersionId": "passenger:connewitz:outbound",
                "templateId": "passenger-template:connewitz:outbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "along",
                    "edgeEntryMm": 0,
                    "edgeExitMm": 73_204,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
        ],
    );
}

fn prepare_multi_segment_terminal_turnaround_layers(root: &TestDirectory) {
    let siding_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}"
    );
    let main_tags = concat!(
        "{\"railway\":\"rail\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"usage\":\"main\"}"
    );
    prepare_connewitz_turnaround_layers(root, 126_822, siding_tags, false);
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track_with_tags(
                MULTI_SEGMENT_APPROACH_EDGE,
                9_100_000_001,
                8_235_223_466,
                30_000,
                [json!(12.372), json!(51.30)],
                [json!(12.371), json!(51.30)],
                main_tags,
            ),
            track_with_tags(
                CONNEWITZ_TERMINAL_EDGE,
                4_158_877_934,
                8_235_223_466,
                47_716,
                [json!(12.37), json!(51.30)],
                [json!(12.371), json!(51.30)],
                main_tags,
            ),
            track_with_tags(
                CONNEWITZ_CONNECTOR_2,
                2_407_262_407,
                4_158_877_934,
                35_259,
                [json!(12.369), json!(51.30)],
                [json!(12.37), json!(51.30)],
                siding_tags,
            ),
            track_with_tags(
                CONNEWITZ_CONNECTOR_1,
                8_235_223_464,
                2_407_262_407,
                31_515,
                [json!(12.368), json!(51.30)],
                [json!(12.369), json!(51.30)],
                siding_tags,
            ),
            track_with_tags(
                CONNEWITZ_BERTH_EDGE,
                6_569_301_007,
                8_235_223_464,
                126_822,
                [json!(12.366), json!(51.30)],
                [json!(12.368), json!(51.30)],
                siding_tags,
            ),
        ],
    );
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[
            json!({
                "routeVersionId": "passenger:multi-segment:inbound",
                "templateId": "passenger-template:multi-segment:inbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [
                    {
                        "edgeId": MULTI_SEGMENT_APPROACH_EDGE,
                        "direction": "along",
                        "edgeEntryMm": 0,
                        "edgeExitMm": 30_000,
                        "availableProtectionSystems": ["pzb"],
                        "simultaneouslyRequiredProtectionSystems": []
                    },
                    {
                        "edgeId": CONNEWITZ_TERMINAL_EDGE,
                        "direction": "against",
                        "edgeEntryMm": 47_716,
                        "edgeExitMm": 0,
                        "availableProtectionSystems": ["pzb"],
                        "simultaneouslyRequiredProtectionSystems": []
                    }
                ]
            }),
            json!({
                "routeVersionId": "passenger:multi-segment:outbound",
                "templateId": "passenger-template:multi-segment:outbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [
                    {
                        "edgeId": CONNEWITZ_TERMINAL_EDGE,
                        "direction": "along",
                        "edgeEntryMm": 0,
                        "edgeExitMm": 47_716,
                        "availableProtectionSystems": ["pzb"],
                        "simultaneouslyRequiredProtectionSystems": []
                    },
                    {
                        "edgeId": MULTI_SEGMENT_APPROACH_EDGE,
                        "direction": "against",
                        "edgeEntryMm": 30_000,
                        "edgeExitMm": 0,
                        "availableProtectionSystems": ["pzb"],
                        "simultaneouslyRequiredProtectionSystems": []
                    }
                ]
            }),
        ],
    );
}

fn prepare_same_direction_through_layers(root: &TestDirectory) {
    let siding_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}"
    );
    let main_tags = concat!(
        "{\"railway\":\"rail\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"usage\":\"main\"}"
    );
    prepare_connewitz_turnaround_layers(root, 126_822, siding_tags, false);
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track_with_tags(
                CONNEWITZ_TERMINAL_EDGE,
                4_158_877_934,
                8_235_223_466,
                73_204,
                [json!(12.37), json!(51.30)],
                [json!(12.371), json!(51.30)],
                main_tags,
            ),
            track_with_tags(
                THROUGH_OUTBOUND_EDGE,
                4_158_877_934,
                9_100_000_002,
                100_000,
                [json!(12.37), json!(51.30)],
                [json!(12.372), json!(51.301)],
                main_tags,
            ),
            track_with_tags(
                CONNEWITZ_CONNECTOR_2,
                2_407_262_407,
                4_158_877_934,
                35_259,
                [json!(12.369), json!(51.30)],
                [json!(12.37), json!(51.30)],
                siding_tags,
            ),
            track_with_tags(
                CONNEWITZ_CONNECTOR_1,
                8_235_223_464,
                2_407_262_407,
                31_515,
                [json!(12.368), json!(51.30)],
                [json!(12.369), json!(51.30)],
                siding_tags,
            ),
            track_with_tags(
                CONNEWITZ_BERTH_EDGE,
                6_569_301_007,
                8_235_223_464,
                126_822,
                [json!(12.366), json!(51.30)],
                [json!(12.368), json!(51.30)],
                siding_tags,
            ),
        ],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.37, 51.30]}),
            json!({
                "feature_id": "switch:connewitz:through",
                "feature_type": "switch",
                "osm_node_id": 4_158_877_934_i64,
                "incident_track_ids_json": serde_json::to_string(&[
                    CONNEWITZ_TERMINAL_EDGE,
                    THROUGH_OUTBOUND_EDGE,
                    CONNEWITZ_CONNECTOR_2
                ]).expect("Through-Weichenkanten")
            }),
        )],
    );
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[
            json!({
                "routeVersionId": "passenger:through:inbound",
                "templateId": "passenger-template:through:inbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "against",
                    "edgeEntryMm": 73_204,
                    "edgeExitMm": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
            json!({
                "routeVersionId": "passenger:through:outbound",
                "templateId": "passenger-template:through:outbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": THROUGH_OUTBOUND_EDGE,
                    "direction": "along",
                    "edgeEntryMm": 0,
                    "edgeExitMm": 100_000,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
        ],
    );
}

fn prepare_mid_edge_direct_layers(root: &TestDirectory) {
    let main_tags = concat!(
        "{\"railway\":\"rail\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"usage\":\"main\"}"
    );
    prepare_connewitz_turnaround_layers(root, 126_822, main_tags, false);
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[track_with_tags(
            CONNEWITZ_TERMINAL_EDGE,
            4_158_877_934,
            8_235_223_466,
            200_000,
            [json!(12.37), json!(51.30)],
            [json!(12.373), json!(51.30)],
            main_tags,
        )],
    );
    write_sequence(
        &root.join("switches.geojsonseq"),
        &[feature(
            json!({"type": "Point", "coordinates": [12.37, 51.30]}),
            json!({
                "feature_id": "switch:mid-edge-fixture",
                "feature_type": "switch",
                "osm_node_id": 4_158_877_934_i64,
                "incident_track_ids_json": serde_json::to_string(&[
                    CONNEWITZ_TERMINAL_EDGE
                ]).expect("Mid-edge-Weichenkante")
            }),
        )],
    );
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[
            json!({
                "routeVersionId": "passenger:mid-edge:inbound",
                "templateId": "passenger-template:mid-edge:inbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "along",
                    "edgeEntryMm": 0,
                    "edgeExitMm": 100_000,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
            json!({
                "routeVersionId": "passenger:mid-edge:outbound",
                "templateId": "passenger-template:mid-edge:outbound",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "against",
                    "edgeEntryMm": 100_000,
                    "edgeExitMm": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
            json!({
                "routeVersionId": "passenger:mid-edge:outbound-id-only",
                "templateId": "passenger-template:mid-edge:outbound-id-only",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": CONNEWITZ_TERMINAL_EDGE,
                    "direction": "against",
                    "edgeEntryMm": 99_999,
                    "edgeExitMm": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }),
        ],
    );
}

fn write_turnaround_spec(root: &TestDirectory) -> PathBuf {
    let path = write_spec(root, Some("timetable-routes.geojsonseq"));
    let mut value: Value = serde_json::from_slice(&fs::read(&path).expect("Turnaround-Spec lesen"))
        .expect("Turnaround-Spec JSON");
    value["policy"]["terminalFormationLengthsMm"] = json!([46_560, 69_860]);
    fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("Turnaround-Spec serialisieren"),
    )
    .expect("Turnaround-Spec schreiben");
    path
}

fn write_spec(root: &TestDirectory, timetable_routes: Option<&str>) -> PathBuf {
    let path = root.join("spec.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "schema": "zugfolge-germany-operational-infrastructure-derivation/v2",
            "mode": "deterministic-conservative-v1",
            "infraReleaseId": "infra-deutschland-test-v2",
            "layers": {
                "tracks": "tracks.geojsonseq",
                "platforms": "platforms.geojsonseq",
                "switches": "switches.geojsonseq",
                "signals": "signals.geojsonseq",
                "blocks": "blocks.geojsonseq",
                "conflictResources": "conflict-resources.geojsonseq",
                "timetableRoutes": timetable_routes,
                "transferDemands": null,
            },
            "policy": {
                "id": "synthetic-operational-b/v2",
                "qualityClass": "B",
                "sourceId": "zugfolge-synthetic-operational-model",
                "derivationRule": "synthetic-operational-b/v2",
                "unknownMainlineSpeedKmh": 80,
                "unknownServiceSpeedKmh": 40,
                "unknownGradientAbsPermille": 25,
                "minimumPlatformLengthMm": 60_000,
                "maximumPlatformSnapDistanceMm": 25_000,
                "minimumOverlapMm": 200_000,
                "minimumBerthEndClearanceMm": 10_000,
                "maximumDirectDwellMs": 1_200_000,
                "terminalFormationLengthsMm": [],
                "defaultProtectionSystem": "pzb",
                "regionBoundaryId": "region:deutschland-ebo",
                "rzueLayoutId": "rzue-deutschland-test-synthetic-b-v1"
            }
        }))
        .expect("Spec serialisieren"),
    )
    .expect("Spec schreiben");
    path
}

fn string_set<'a>(template: &'a Value, field: &str) -> BTreeSet<&'a str> {
    template[field]
        .as_array()
        .expect("Ressourcenarray")
        .iter()
        .map(|value| value.as_str().expect("Ressourcen-ID"))
        .collect()
}

fn resources(template: &Value) -> BTreeSet<&str> {
    ["pathResources", "overlapResources", "flankResources"]
        .into_iter()
        .flat_map(|field| string_set(template, field))
        .collect()
}

fn route_length_mm(route: &Value) -> i64 {
    route["legs"]
        .as_array()
        .expect("Laufweg-Legs")
        .last()
        .map(|leg| {
            leg["routeStartMm"].as_i64().expect("Leg-Anfang")
                + i64::try_from(
                    leg["edgeEntryMm"]
                        .as_i64()
                        .expect("Kanteneintritt")
                        .abs_diff(leg["edgeExitMm"].as_i64().expect("Kantenaustritt")),
                )
                .expect("Leg-Laenge")
        })
        .expect("nichtleerer Laufweg")
}

#[test]
fn connewitz_abstellung_ist_fuer_beide_formationslaengen_physisch_und_stabil() {
    let root = TestDirectory::create();
    let berth_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"railway:track_ref\":\"5\"}"
    );
    prepare_connewitz_turnaround_layers(&root, 126_822, berth_tags, true);
    let spec = write_turnaround_spec(&root);
    let first_candidate = root.join("connewitz-first.json");
    let first_report = root.join("connewitz-first-report.json");
    let first_receipt =
        derive_germany_operational_v2(&spec, &root.0, &first_candidate, &first_report)
            .expect("Connewitz-Turnaround ableiten");
    validate_operational_infrastructure_v2_file(
        &first_candidate,
        "infra-deutschland-test-v2",
        None,
    )
    .expect("Connewitz-Kandidat nativ validieren");

    let first_sidecar = root.join("connewitz-first.movement-route-templates-v2.json");
    let candidate: Value =
        serde_json::from_slice(&fs::read(&first_candidate).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    let sidecar: Value = serde_json::from_slice(&fs::read(&first_sidecar).expect("Sidecar lesen"))
        .expect("Sidecar JSON");
    assert_eq!(sidecar["schema"], "movement-route-templates-v2");
    assert_eq!(sidecar["infraReleaseId"], "infra-deutschland-test-v2");
    assert_eq!(
        sidecar["operationalStateHash"],
        first_receipt["candidate"]["stateHash"]
    );
    assert_eq!(
        first_receipt["movementRouteTemplates"]["file"],
        "connewitz-first.movement-route-templates-v2.json"
    );
    assert_eq!(
        first_receipt["movementRouteTemplates"]["stateHash"],
        sidecar["stateHash"]
    );
    let templates = sidecar["templates"].as_array().expect("Templates");
    assert_eq!(
        templates.len(),
        2,
        "dieselbe Track-5-Zielkante darf trotz zweier Wege nur einen Berth je Laengenklasse anbieten"
    );
    assert!(candidate.get("turnaroundTemplates").is_none());
    let direct_templates = sidecar["directTemplates"]
        .as_array()
        .expect("Direct-Templates");
    assert_eq!(direct_templates.len(), 4);
    let demanded_direct = direct_templates
        .iter()
        .filter(|template| {
            template["inboundRouteVersionId"] == "passenger:connewitz:inbound"
                && template["outboundRouteVersionId"] == "passenger:connewitz:outbound"
        })
        .collect::<Vec<_>>();
    assert_eq!(demanded_direct.len(), 2);
    assert!(demanded_direct.iter().all(|template| {
        template["continuity"] == "reverse-direction"
            && template["through"].is_null()
            && template["outbound"]["continuity"] == "reverse-direction"
            && template["maximumDwellMs"] == 1_200_000
            && !template["resourceIds"].as_array().unwrap().is_empty()
    }));
    for template in &demanded_direct {
        let outbound =
            &candidate["routeVersions"][template["outbound"]["routeVersionId"].as_str().unwrap()];
        assert_eq!(
            template["outbound"]["predecessorBaseRouteVersionId"],
            outbound["predecessorId"]
        );
    }

    for (length_mm, berth_from_mm, berth_to_mm, shunt_in_length_mm) in [
        (46_560, 40_131, 86_691, 200_025),
        (69_860, 28_481, 98_341, 234_975),
    ] {
        let template = templates
            .iter()
            .find(|template| template["formationLengthMm"] == length_mm)
            .expect("formationsspezifisches Template");
        assert_eq!(
            template["inboundRouteVersionId"],
            "passenger:connewitz:inbound"
        );
        assert_eq!(
            template["outboundRouteVersionId"],
            "passenger:connewitz:outbound"
        );
        assert_eq!(template["terminalEdgeId"], CONNEWITZ_TERMINAL_EDGE);
        assert_eq!(template["terminalNodeId"], 4_158_877_934_i64);
        assert_eq!(template["inboundDirection"], "against");
        assert_eq!(template["outboundDirection"], "along");
        assert_eq!(template["candidateRank"], 0);
        assert_eq!(template["stablingPathLengthMm"], 193_596);
        assert_eq!(template["shuntIn"]["continuity"], "same-direction");
        assert_eq!(template["shuntOut"]["continuity"], "reverse-direction");
        assert_eq!(template["outbound"]["continuity"], "same-direction");
        assert_eq!(
            template["terminalIntervals"],
            json!([{"edgeId": CONNEWITZ_TERMINAL_EDGE, "fromMm": 0, "toMm": length_mm}])
        );
        assert_eq!(
            template["berth"],
            json!({
                "edgeId": CONNEWITZ_BERTH_EDGE,
                "fromMm": berth_from_mm,
                "toMm": berth_to_mm,
                "leftClearanceMm": berth_from_mm,
                "rightClearanceMm": 126_822 - berth_to_mm
            })
        );

        for field in ["shuntIn", "shuntOut", "outbound"] {
            assert_eq!(template[field]["headRouteMm"], length_mm);
            let route_id = template[field]["routeVersionId"].as_str().unwrap();
            assert_eq!(
                template[field]["predecessorBaseRouteVersionId"],
                candidate["routeVersions"][route_id]["predecessorId"]
            );
            let resource_ids = template[field]["resourceIds"]
                .as_array()
                .expect("kompakte Konfliktressourcen");
            assert!(!resource_ids.is_empty());
            assert!(resource_ids.windows(2).all(|ids| {
                ids[0].as_str().expect("Ressourcen-ID").as_bytes()
                    < ids[1].as_str().expect("Ressourcen-ID").as_bytes()
            }));
            assert!(template[field]["minimumRuntimeMs"].as_i64().unwrap_or(0) > 0);
            assert!(template[field]["routeLegCount"].as_u64().unwrap_or(0) > 0);
            assert!(
                !template[field]["protectionContractRuns"]
                    .as_array()
                    .expect("Schutzvertragslaeufe")
                    .is_empty()
            );
        }

        let shunt_in_id = template["shuntIn"]["routeVersionId"]
            .as_str()
            .expect("Shunt-in-ID");
        let shunt_out_id = template["shuntOut"]["routeVersionId"]
            .as_str()
            .expect("Shunt-out-ID");
        let qualified_outbound_id = template["outbound"]["routeVersionId"]
            .as_str()
            .expect("qualifizierte Ausgangsroute");
        let shunt_in = &candidate["routeVersions"][shunt_in_id];
        let shunt_out = &candidate["routeVersions"][shunt_out_id];
        let qualified_outbound = &candidate["routeVersions"][qualified_outbound_id];
        assert_eq!(shunt_in["predecessorId"], "passenger:connewitz:inbound");
        assert_eq!(shunt_in["transitionRouteMm"], length_mm);
        assert_eq!(route_length_mm(shunt_in), shunt_in_length_mm);
        assert_eq!(shunt_out["predecessorId"], shunt_in_id);
        assert_eq!(shunt_out["transitionRouteMm"], length_mm);
        assert_eq!(qualified_outbound["predecessorId"], shunt_out_id);
        assert_eq!(qualified_outbound["transitionRouteMm"], length_mm);
        assert_ne!(qualified_outbound_id, "passenger:connewitz:outbound");
        assert_eq!(qualified_outbound["legs"][0]["routeStartMm"], 0);
        assert_eq!(qualified_outbound["legs"][1]["routeStartMm"], length_mm);

        for field in ["shuntIn", "shuntOut"] {
            let interlocking_id = template[field]["dispatchInterlockingRouteId"]
                .as_str()
                .expect("Rangierfahrstrasse");
            let interlocking = &candidate["interlockingRoutes"][interlocking_id];
            assert_eq!(interlocking["movementKind"], "shunting");
            assert_eq!(interlocking["authorityStartRouteMm"], length_mm);
            let route_id = template[field]["routeVersionId"]
                .as_str()
                .expect("Rangierlaufweg");
            assert_eq!(
                interlocking["authorityEndRouteMm"],
                route_length_mm(&candidate["routeVersions"][route_id])
            );
        }
        let outbound_interlocking_id = template["outbound"]["dispatchInterlockingRouteId"]
            .as_str()
            .expect("Ausgangsfahrstrasse");
        assert_eq!(
            candidate["interlockingRoutes"][outbound_interlocking_id]["authorityStartRouteMm"],
            length_mm
        );
    }

    let second_candidate = root.join("connewitz-second.json");
    let second_report = root.join("connewitz-second-report.json");
    derive_germany_operational_v2(&spec, &root.0, &second_candidate, &second_report)
        .expect("stabile Connewitz-Wiederholung");
    assert_eq!(
        fs::read(&first_candidate).expect("erster Kandidat"),
        fs::read(&second_candidate).expect("zweiter Kandidat")
    );
    assert_eq!(
        fs::read(first_sidecar).expect("erster Sidecar"),
        fs::read(root.join("connewitz-second.movement-route-templates-v2.json"))
            .expect("zweiter Sidecar")
    );
}

#[test]
fn mehrkantiges_terminal_bildet_69860_mm_lueckenlos_und_in_fahrtrichtung_ab() {
    let root = TestDirectory::create();
    prepare_multi_segment_terminal_turnaround_layers(&root);
    let spec = write_turnaround_spec(&root);
    let candidate_path = root.join("multi-segment-terminal.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_path,
        &root.join("multi-segment-terminal-report.json"),
    )
    .expect("mehrkantiges Terminal ableiten");
    let candidate: Value =
        serde_json::from_slice(&fs::read(&candidate_path).expect("Mehrkanten-Kandidat lesen"))
            .expect("Mehrkanten-Kandidat JSON");
    let sidecar: Value = serde_json::from_slice(
        &fs::read(root.join("multi-segment-terminal.movement-route-templates-v2.json"))
            .expect("Mehrkanten-Sidecar lesen"),
    )
    .expect("Mehrkanten-Sidecar JSON");
    let expected_intervals = json!([
        {"edgeId": MULTI_SEGMENT_APPROACH_EDGE, "fromMm": 7_856, "toMm": 30_000},
        {"edgeId": CONNEWITZ_TERMINAL_EDGE, "fromMm": 0, "toMm": 47_716}
    ]);
    let direct = sidecar["directTemplates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|template| {
            template["inboundRouteVersionId"] == "passenger:multi-segment:inbound"
                && template["outboundRouteVersionId"] == "passenger:multi-segment:outbound"
                && template["formationLengthMm"] == 69_860
        })
        .expect("mehrkantiges Direct-Template");
    assert_eq!(direct["terminalIntervals"], expected_intervals);
    assert_eq!(direct["continuity"], "reverse-direction");
    assert!(direct["through"].is_null());
    let direct_route =
        &candidate["routeVersions"][direct["outbound"]["routeVersionId"].as_str().unwrap()];
    assert_eq!(direct_route["legs"][0]["edgeId"], CONNEWITZ_TERMINAL_EDGE);
    assert_eq!(direct_route["legs"][0]["routeStartMm"], 0);
    assert_eq!(
        direct_route["legs"][1]["edgeId"],
        MULTI_SEGMENT_APPROACH_EDGE
    );
    assert_eq!(direct_route["legs"][1]["routeStartMm"], 47_716);
    assert_eq!(direct_route["legs"][2]["routeStartMm"], 69_860);

    let stabling = sidecar["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|template| {
            template["inboundRouteVersionId"] == "passenger:multi-segment:inbound"
                && template["outboundRouteVersionId"] == "passenger:multi-segment:outbound"
                && template["formationLengthMm"] == 69_860
        })
        .expect("mehrkantiges Stabling-Template");
    assert_eq!(stabling["terminalIntervals"], expected_intervals);
    let shunt_in_route =
        &candidate["routeVersions"][stabling["shuntIn"]["routeVersionId"].as_str().unwrap()];
    assert_eq!(
        shunt_in_route["legs"][0]["edgeId"],
        MULTI_SEGMENT_APPROACH_EDGE
    );
    assert_eq!(shunt_in_route["legs"][1]["edgeId"], CONNEWITZ_TERMINAL_EDGE);
    assert_eq!(shunt_in_route["legs"][2]["routeStartMm"], 69_860);
    assert_eq!(
        candidate["interlockingRoutes"][stabling["shuntIn"]["dispatchInterlockingRouteId"]
            .as_str()
            .unwrap()]["authorityStartRouteMm"],
        69_860
    );
}

#[test]
fn halt_innerhalb_einer_osm_kante_bleibt_direct_aber_erfindet_keinen_abstellknoten() {
    let root = TestDirectory::create();
    prepare_mid_edge_direct_layers(&root);
    let spec = write_turnaround_spec(&root);
    let candidate_path = root.join("mid-edge-direct.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_path,
        &root.join("mid-edge-direct-report.json"),
    )
    .expect("Direct-Halt innerhalb der OSM-Kante ableiten");
    let sidecar: Value = serde_json::from_slice(
        &fs::read(root.join("mid-edge-direct.movement-route-templates-v2.json"))
            .expect("Mid-edge-Sidecar lesen"),
    )
    .expect("Mid-edge-Sidecar JSON");
    let demanded = sidecar["directTemplates"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|template| {
            template["inboundRouteVersionId"] == "passenger:mid-edge:inbound"
                && template["outboundRouteVersionId"] == "passenger:mid-edge:outbound"
        })
        .collect::<Vec<_>>();
    assert_eq!(demanded.len(), 2);
    assert!(demanded.iter().all(|template| {
        template["continuity"] == "reverse-direction"
            && template["outbound"]["continuity"] == "reverse-direction"
            && template["through"].is_null()
    }));
    assert!(
        sidecar["templates"].as_array().unwrap().is_empty(),
        "ohne reale OSM-Knotengrenze darf kein Abstellpfad erfunden werden"
    );
    assert!(
        sidecar["directTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|template| template["outboundRouteVersionId"]
                != "passenger:mid-edge:outbound-id-only"),
        "eine aehnliche ID darf eine um 1 mm abweichende Startposition nicht verdecken"
    );
}

#[test]
fn same_direction_direct_nutzt_eigenen_through_und_danach_die_vollstaendige_basisroute() {
    let root = TestDirectory::create();
    prepare_same_direction_through_layers(&root);
    let spec = write_turnaround_spec(&root);
    let candidate_path = root.join("same-direction-through.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_path,
        &root.join("same-direction-through-report.json"),
    )
    .expect("Same-Direction-Through ableiten");
    let candidate: Value =
        serde_json::from_slice(&fs::read(&candidate_path).expect("Through-Kandidat lesen"))
            .expect("Through-Kandidat JSON");
    let sidecar: Value = serde_json::from_slice(
        &fs::read(root.join("same-direction-through.movement-route-templates-v2.json"))
            .expect("Through-Sidecar lesen"),
    )
    .expect("Through-Sidecar JSON");

    for formation_length_mm in [46_560_i64, 69_860] {
        let direct = sidecar["directTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|template| {
                template["inboundRouteVersionId"] == "passenger:through:inbound"
                    && template["outboundRouteVersionId"] == "passenger:through:outbound"
                    && template["formationLengthMm"] == formation_length_mm
            })
            .expect("formationsspezifisches Through-Template");
        assert_eq!(direct["continuity"], "same-direction");
        assert_eq!(
            direct["terminalIntervals"],
            json!([{
                "edgeId": CONNEWITZ_TERMINAL_EDGE,
                "fromMm": 0,
                "toMm": formation_length_mm
            }])
        );

        let through = direct["through"].as_object().expect("Through-Dispatch");
        assert_eq!(through["continuity"], "same-direction");
        assert_eq!(
            through["predecessorBaseRouteVersionId"],
            "passenger:through:inbound"
        );
        assert!(
            !through["resourceIds"].as_array().unwrap().is_empty(),
            "Through braucht konfliktentscheidende Ressourcen"
        );
        let through_route_id = through["routeVersionId"].as_str().unwrap();
        let through_route = &candidate["routeVersions"][through_route_id];
        assert_eq!(through_route["predecessorId"], "passenger:through:inbound");
        assert_eq!(through_route["transitionRouteMm"], formation_length_mm);
        assert_eq!(through_route["legs"].as_array().unwrap().len(), 2);
        assert_eq!(through_route["legs"][0]["edgeId"], CONNEWITZ_TERMINAL_EDGE);
        assert_eq!(through_route["legs"][0]["direction"], "against");
        assert_eq!(through_route["legs"][0]["edgeEntryMm"], formation_length_mm);
        assert_eq!(through_route["legs"][0]["edgeExitMm"], 0);
        assert_eq!(through_route["legs"][0]["routeStartMm"], 0);
        assert_eq!(through_route["legs"][1]["edgeId"], THROUGH_OUTBOUND_EDGE);
        assert_eq!(through_route["legs"][1]["direction"], "along");
        assert_eq!(through_route["legs"][1]["edgeEntryMm"], 0);
        assert_eq!(through_route["legs"][1]["edgeExitMm"], formation_length_mm);
        assert_eq!(
            through_route["legs"][1]["routeStartMm"],
            formation_length_mm
        );
        assert_eq!(route_length_mm(through_route), formation_length_mm * 2);
        let through_interlocking = &candidate["interlockingRoutes"]
            [through["dispatchInterlockingRouteId"].as_str().unwrap()];
        assert_eq!(through_interlocking["movementKind"], "train");
        assert_eq!(
            through_interlocking["authorityStartRouteMm"],
            formation_length_mm
        );
        assert_eq!(
            through_interlocking["authorityEndRouteMm"],
            formation_length_mm * 2
        );

        let outbound = direct["outbound"].as_object().expect("Outbound-Dispatch");
        assert_eq!(outbound["continuity"], "same-direction");
        assert_eq!(outbound["predecessorBaseRouteVersionId"], through_route_id);
        let outbound_route =
            &candidate["routeVersions"][outbound["routeVersionId"].as_str().unwrap()];
        assert_eq!(outbound_route["predecessorId"], through_route_id);
        assert_eq!(outbound_route["transitionRouteMm"], formation_length_mm);
        assert_eq!(outbound_route["legs"].as_array().unwrap().len(), 2);
        assert_eq!(outbound_route["legs"][0]["edgeId"], THROUGH_OUTBOUND_EDGE);
        assert_eq!(outbound_route["legs"][0]["edgeEntryMm"], 0);
        assert_eq!(outbound_route["legs"][0]["edgeExitMm"], formation_length_mm);
        assert_eq!(outbound_route["legs"][0]["routeStartMm"], 0);
        assert_eq!(outbound_route["legs"][1]["edgeId"], THROUGH_OUTBOUND_EDGE);
        assert_eq!(
            outbound_route["legs"][1]["edgeEntryMm"],
            formation_length_mm
        );
        assert_eq!(outbound_route["legs"][1]["edgeExitMm"], 100_000);
        assert_eq!(
            outbound_route["legs"][1]["routeStartMm"],
            formation_length_mm
        );
        assert_eq!(route_length_mm(outbound_route), 100_000);
        let outbound_interlocking = &candidate["interlockingRoutes"]
            [outbound["dispatchInterlockingRouteId"].as_str().unwrap()];
        assert_eq!(
            outbound_interlocking["authorityStartRouteMm"], formation_length_mm,
            "das bereits durch Through belegte Basisprefix darf nicht erneut befahren werden"
        );
        assert_eq!(outbound_interlocking["authorityEndRouteMm"], 100_000);

        let direct_resources = string_set(direct, "resourceIds");
        for resource in through["resourceIds"].as_array().unwrap() {
            assert!(
                direct_resources.contains(resource.as_str().unwrap()),
                "Through-Ressource muss die Direct-Belegung begrenzen"
            );
        }
    }
}

#[test]
fn transfer_demands_erzeugen_formationsspezifische_reale_ketten_und_sidecar_bindung() {
    let root = TestDirectory::create();
    let berth_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}"
    );
    prepare_connewitz_turnaround_layers(&root, 126_822, berth_tags, false);
    let passenger_route_id = "route:gtfs:leg-transfer-loop:v1";
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[json!({
            "routeVersionId": passenger_route_id,
            "templateId": "template:gtfs:leg-transfer-loop:v1",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [{
                "edgeId": CONNEWITZ_TERMINAL_EDGE,
                "direction": "along",
                "edgeEntryMm": 0,
                "edgeExitMm": 73_204,
                "availableProtectionSystems": ["pzb"],
                "simultaneouslyRequiredProtectionSystems": []
            }]
        })],
    );
    let demand = json!({
        "id": "transfer-test-loop",
        "lotId": "lot-test",
        "assetCompatibilityKey": "asset-test",
        "sourceCirculationId": "circulation-test",
        "targetCirculationId": "circulation-test",
        "sourcePassengerLegId": "leg-transfer-loop",
        "targetPassengerLegId": "leg-transfer-loop",
        "sourceLocationId": "location-b",
        "targetLocationId": "location-a",
        "sourcePhysicalStopId": "stop-b",
        "targetPhysicalStopId": "stop-a",
        "earliestDepartureS": 2_300,
        "latestArrivalS": 87_100,
        "availableWindowS": 84_800,
        "movementKind": "train"
    });
    let mut plan_body = json!({
        "schema": "zugfolge-daily-circulation-plan/v1",
        "rule": "daily-circulation-permutation-and-real-transfer/v1",
        "gtfsReleaseId": "gtfs-test",
        "repeatEveryS": 86_400,
        "minimumTurnaroundS": 300,
        "metrics": {
            "lotCount": 1,
            "journeyChainCount": 1,
            "circulationCount": 1,
            "rolloverAssignmentCount": 1,
            "transferDemandCount": 1,
            "transferLotCount": 1
        },
        "circulations": [{
            "id": "circulation-test",
            "lotId": "lot-test",
            "serviceLineId": "line-test",
            "assetCompatibilityKey": "asset-test",
            "journeyChainIds": ["journey-test"],
            "passengerLegIds": ["leg-transfer-loop"],
            "passengerTrainRunIds": ["run-test"],
            "start": {"legId": "leg-transfer-loop", "locationId": "location-a", "physicalStopId": "stop-a", "timeS": 1_000},
            "end": {"legId": "leg-transfer-loop", "locationId": "location-b", "physicalStopId": "stop-b", "timeS": 2_000}
        }],
        "rolloverAssignments": [{
            "kind": "transfer",
            "sourceCirculationId": "circulation-test",
            "targetCirculationId": "circulation-test"
        }],
        "transferDemands": [demand.clone()]
    });
    let plan_sha256 = alpha_hash("zugfolge-daily-circulation-plan/v1", &plan_body);
    plan_body["planSha256"] = json!(plan_sha256);
    let speed_mmps = 70_u64 * 1_000_000 / 3_600;
    let minimum_runtime_ms = (73_204_u64 * 1_000).div_ceil(speed_mmps);
    let mut route = demand.clone();
    let route_values = route.as_object_mut().expect("Transferroute");
    route_values.insert(
        "sourcePassengerRouteVersionId".to_owned(),
        json!(passenger_route_id),
    );
    route_values.insert(
        "targetPassengerRouteVersionId".to_owned(),
        json!(passenger_route_id),
    );
    route_values.insert("formationLengthsMm".to_owned(), json!([46_560, 69_860]));
    route_values.insert(
        "routeVersionId".to_owned(),
        json!("route:transfer-test-loop:movement:v1"),
    );
    route_values.insert(
        "templateId".to_owned(),
        json!("template:transfer-test-loop:movement:v1"),
    );
    route_values.insert(
        "legs".to_owned(),
        json!([{
            "edgeId": CONNEWITZ_TERMINAL_EDGE,
            "direction": "against",
            "edgeEntryMm": 73_204,
            "edgeExitMm": 0,
            "availableProtectionSystems": ["pzb"],
            "simultaneouslyRequiredProtectionSystems": []
        }]),
    );
    route_values.insert("totalLengthMm".to_owned(), json!(73_204));
    route_values.insert("weightedCostMm".to_owned(), json!(73_204));
    route_values.insert("minimumRuntimeMs".to_owned(), json!(minimum_runtime_ms));
    let mut canonical_route = String::new();
    canonical_json(&route, &mut canonical_route);
    let transfer_set_sha256 = sha256(format!("{canonical_route}\n").as_bytes());
    let transfer_input = json!({
        "schema": "zugfolge-timetable-transfer-demands/v1",
        "infraReleaseId": "infra-deutschland-test-v2",
        "gtfsSnapshotHash": "a".repeat(64),
        "dailyPlan": plan_body,
        "formationLengthsMm": [46_560, 69_860],
        "transferRoutes": [route],
        "transferSetSha256": transfer_set_sha256
    });
    let transfer_bytes = serde_json::to_vec(&transfer_input).expect("Transferinput serialisieren");
    fs::write(root.join("transfer-demands.json"), &transfer_bytes)
        .expect("Transferinput schreiben");
    let spec = write_turnaround_spec(&root);
    let mut spec_value: Value =
        serde_json::from_slice(&fs::read(&spec).expect("Spec lesen")).expect("Spec JSON");
    spec_value["layers"]["transferDemands"] = json!({
        "path": "transfer-demands.json",
        "expectedBytes": transfer_bytes.len(),
        "expectedSha256": sha256(&transfer_bytes)
    });
    fs::write(
        &spec,
        serde_json::to_vec_pretty(&spec_value).expect("Spec serialisieren"),
    )
    .expect("Spec schreiben");

    let first_candidate = root.join("transfer-first.json");
    let first_report = root.join("transfer-first-report.json");
    let receipt = derive_germany_operational_v2(&spec, &root.0, &first_candidate, &first_report)
        .expect("Transferketten ableiten");
    let first_sidecar = root.join("transfer-first.movement-route-templates-v2.json");
    let sidecar: Value =
        serde_json::from_slice(&fs::read(&first_sidecar).expect("Movement-Sidecar lesen"))
            .expect("Movement-Sidecar JSON");
    let candidate: Value =
        serde_json::from_slice(&fs::read(&first_candidate).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    assert_eq!(sidecar["timetableTransferSetSha256"], transfer_set_sha256);
    assert_eq!(sidecar["metrics"]["transferDemandCount"], 1);
    assert_eq!(sidecar["metrics"]["transferTemplateCount"], 2);
    assert!(sidecar["directTemplates"].as_array().unwrap().is_empty());
    assert!(sidecar["templates"].as_array().unwrap().is_empty());
    for template in sidecar["transferTemplates"].as_array().unwrap() {
        assert_eq!(template["demandId"], "transfer-test-loop");
        assert_eq!(template["movementKind"], "train");
        assert_eq!(template["transfer"]["continuity"], "same-direction");
        assert_eq!(template["targetOutbound"]["continuity"], "same-direction");
        assert!(template["transfer"]["minimumRuntimeMs"].as_i64().unwrap() > 0);
        assert!(
            template["targetOutbound"]["minimumRuntimeMs"]
                .as_i64()
                .unwrap()
                > 0
        );
        assert!(!template["resourceIds"].as_array().unwrap().is_empty());
        for field in ["transfer", "targetOutbound"] {
            let route_id = template[field]["routeVersionId"].as_str().unwrap();
            let route = &candidate["routeVersions"][route_id];
            assert_eq!(route["transitionRouteMm"], template["formationLengthMm"]);
            assert_eq!(
                template[field]["predecessorBaseRouteVersionId"],
                route["predecessorId"]
            );
            assert!(
                !template[field]["protectionContractRuns"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
    }
    assert_eq!(
        receipt["movementRouteTemplates"]["stateHash"],
        sidecar["stateHash"]
    );
    let report: Value = serde_json::from_slice(&fs::read(&first_report).expect("Report lesen"))
        .expect("Report JSON");
    assert_eq!(report["inputs"]["transferDemands"]["records"], 1);
    assert_eq!(report["timetableRouteEvidence"]["circulationCount"], 1);
    assert_eq!(report["timetableRouteEvidence"]["transferDemandCount"], 1);

    let second_candidate = root.join("transfer-second.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &second_candidate,
        &root.join("transfer-second-report.json"),
    )
    .expect("stabile Transfer-Wiederholung");
    assert_eq!(
        fs::read(first_candidate).expect("erster Transferkandidat"),
        fs::read(second_candidate).expect("zweiter Transferkandidat")
    );
    assert_eq!(
        fs::read(first_sidecar).expect("erster Transfer-Sidecar"),
        fs::read(root.join("transfer-second.movement-route-templates-v2.json"))
            .expect("zweiter Transfer-Sidecar")
    );

    let mut invalid_input = transfer_input;
    invalid_input["transferRoutes"][0]["minimumRuntimeMs"] = json!(minimum_runtime_ms + 1);
    let mut invalid_canonical_route = String::new();
    canonical_json(
        &invalid_input["transferRoutes"][0],
        &mut invalid_canonical_route,
    );
    invalid_input["transferSetSha256"] =
        json!(sha256(format!("{invalid_canonical_route}\n").as_bytes()));
    let invalid_bytes = serde_json::to_vec(&invalid_input).expect("Driftinput serialisieren");
    fs::write(root.join("transfer-demands.json"), &invalid_bytes).expect("Driftinput schreiben");
    spec_value["layers"]["transferDemands"] = json!({
        "path": "transfer-demands.json",
        "expectedBytes": invalid_bytes.len(),
        "expectedSha256": sha256(&invalid_bytes)
    });
    fs::write(
        &spec,
        serde_json::to_vec_pretty(&spec_value).expect("Driftspec serialisieren"),
    )
    .expect("Driftspec schreiben");
    let error = derive_germany_operational_v2(
        &spec,
        &root.0,
        &root.join("transfer-runtime-drift.json"),
        &root.join("transfer-runtime-drift-report.json"),
    )
    .expect_err("native Transferlaufzeit muss Inputdrift fail-closed verwerfen");
    assert!(
        error
            .to_string()
            .contains("driftet in nativer Laenge/Laufzeit"),
        "{error}"
    );
}

#[test]
fn ungeeignete_abstellgleise_werden_nicht_erfunden_waehrend_direct_erhalten_bleibt() {
    let valid_tags = concat!(
        "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",",
        "\"electrified\":\"contact_line\",\"voltage\":\"15000\",",
        "\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}"
    );
    let cases = [
        ("too-short", 80_000, valid_tags),
        (
            "one-way",
            126_822,
            "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",\"electrified\":\"contact_line\",\"voltage\":\"15000\",\"frequency\":\"16.7\",\"railway:pzb\":\"yes\",\"oneway\":\"yes\"}",
        ),
        (
            "incompatible-voltage",
            126_822,
            "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",\"electrified\":\"contact_line\",\"voltage\":\"25000\",\"frequency\":\"50\",\"railway:pzb\":\"yes\"}",
        ),
        (
            "not-a-siding",
            126_822,
            "{\"railway\":\"rail\",\"gauge\":\"1435\",\"electrified\":\"contact_line\",\"voltage\":\"15000\",\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}",
        ),
    ];
    for (name, berth_length_mm, berth_tags) in cases {
        let root = TestDirectory::create();
        prepare_connewitz_turnaround_layers(&root, berth_length_mm, berth_tags, false);
        let spec = write_turnaround_spec(&root);
        let candidate = root.join(&format!("{name}.json"));
        let report = root.join(&format!("{name}-report.json"));
        derive_germany_operational_v2(&spec, &root.0, &candidate, &report)
            .expect("Direct-Kontinuitaet bleibt ohne erfundene Abstellung");
        let sidecar: Value = serde_json::from_slice(
            &fs::read(root.join(&format!("{name}.movement-route-templates-v2.json")))
                .expect("Movement-Sidecar"),
        )
        .expect("Movement-Sidecar JSON");
        let stabling = sidecar["templates"].as_array().expect("Stabling-Templates");
        if name == "too-short" {
            assert!(
                !stabling.is_empty()
                    && stabling
                        .iter()
                        .all(|template| template["formationLengthMm"] == 46_560),
                "80-m-Kante darf die kurze, aber nicht die lange Formation aufnehmen"
            );
        } else {
            assert!(
                stabling.is_empty(),
                "{name} darf kein Abstellgleis erfinden"
            );
        }
        assert!(
            sidecar["directTemplates"]
                .as_array()
                .expect("Direct-Templates")
                .len()
                >= 2
        );
    }
}

#[test]
fn ungenutzte_ankunftsroute_erzeugt_ohne_nachfolger_keine_falsche_kontinuitaet() {
    let root = TestDirectory::create();
    let berth_tags = "{\"railway\":\"rail\",\"service\":\"siding\",\"gauge\":\"1435\",\"electrified\":\"contact_line\",\"voltage\":\"15000\",\"frequency\":\"16.7\",\"railway:pzb\":\"yes\"}";
    prepare_connewitz_turnaround_layers(&root, 126_822, berth_tags, false);
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[json!({
            "routeVersionId": "passenger:connewitz:inbound",
            "templateId": "passenger-template:connewitz:inbound",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [{
                "edgeId": CONNEWITZ_TERMINAL_EDGE,
                "direction": "against",
                "edgeEntryMm": 73_204,
                "edgeExitMm": 0,
                "availableProtectionSystems": ["pzb"],
                "simultaneouslyRequiredProtectionSystems": []
            }]
        })],
    );
    let spec = write_turnaround_spec(&root);
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &root.join("missing-reverse.json"),
        &root.join("missing-reverse-report.json"),
    )
    .expect("irrelevante Route ohne Fahrplanpaar darf keine erfundene Gegenrichtung verlangen");
    let sidecar: Value = serde_json::from_slice(
        &fs::read(root.join("missing-reverse.movement-route-templates-v2.json"))
            .expect("Movement-Sidecar"),
    )
    .expect("Movement-Sidecar JSON");
    assert!(sidecar["directTemplates"].as_array().unwrap().is_empty());
    assert!(sidecar["templates"].as_array().unwrap().is_empty());
}

#[test]
fn nativer_compiler_verwirft_v1_policy_id_und_derivation_rule() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let valid: Value =
        serde_json::from_slice(&fs::read(&spec).expect("Spec lesen")).expect("Spec JSON");
    for field in ["id", "derivationRule"] {
        let mut invalid = valid.clone();
        invalid["policy"][field] = json!("synthetic-operational-b/v1");
        fs::write(
            &spec,
            serde_json::to_vec_pretty(&invalid).expect("ungueltige Spec serialisieren"),
        )
        .expect("ungueltige Spec schreiben");
        let error = derive_germany_operational_v2(
            &spec,
            &root.0,
            &root.join(&format!("v1-{field}-candidate.json")),
            &root.join(&format!("v1-{field}-report.json")),
        )
        .expect_err("v1-Compilerpolicy muss scheitern");
        assert!(
            error.to_string().contains("synthetic-operational-b/v2"),
            "{field}: {error}"
        );
    }
}

#[cfg(unix)]
#[test]
fn nativer_compiler_verwirft_symlink_in_einem_layerpfad_fail_closed() {
    use std::os::unix::fs::symlink;

    let root = TestDirectory::create();
    let external = TestDirectory::create();
    prepare_layers(&root);
    fs::copy(
        root.join("tracks.geojsonseq"),
        external.join("tracks.geojsonseq"),
    )
    .expect("externen gueltigen Gleislayer bereitstellen");
    symlink(&external.0, root.join("linked")).expect("Layerverzeichnis verlinken");
    let spec = write_spec(&root, None);
    let mut value: Value =
        serde_json::from_slice(&fs::read(&spec).expect("Spec lesen")).expect("Spec JSON");
    value["layers"]["tracks"] = json!("linked/tracks.geojsonseq");
    fs::write(
        &spec,
        serde_json::to_vec_pretty(&value).expect("Spec serialisieren"),
    )
    .expect("Spec schreiben");
    let candidate = root.join("symlink-candidate.json");
    let report = root.join("symlink-report.json");

    let error = derive_germany_operational_v2(&spec, &root.0, &candidate, &report)
        .expect_err("Zwischenverzeichnis-Symlink muss fail-closed scheitern");
    assert!(error.to_string().contains("Symlink"), "{error}");
    assert!(!candidate.exists());
    assert!(!report.exists());
}

#[test]
fn nativer_compiler_verwirft_einen_unbegrenzt_grossen_einzeldatensatz() {
    const RAW_RECORD_BYTES: usize = 8 * 1024 * 1024 + 1;
    let root = TestDirectory::create();
    prepare_layers(&root);
    let tracks = root.join("tracks.geojsonseq");
    let mut writer = BufWriter::new(fs::File::create(&tracks).expect("Gleislayer anlegen"));
    writer
        .write_all(&[0x1e])
        .expect("Record-Separator schreiben");
    let chunk = vec![b'x'; 64 * 1024];
    let mut remaining = RAW_RECORD_BYTES;
    while remaining > 0 {
        let length = remaining.min(chunk.len());
        writer
            .write_all(&chunk[..length])
            .expect("Datensatzblock schreiben");
        remaining -= length;
    }
    writer.write_all(b"\n").expect("Datensatz abschliessen");
    writer.flush().expect("Gleislayer abschliessen");
    drop(writer);
    let spec = write_spec(&root, None);
    let candidate = root.join("oversized-candidate.json");
    let report = root.join("oversized-report.json");

    let error = derive_germany_operational_v2(&spec, &root.0, &candidate, &report)
        .expect_err("uebergrosser Einzeldatensatz muss fail-closed scheitern");
    assert!(
        error.to_string().contains("Einzeldatensatz") && error.to_string().contains("8-MiB-Grenze"),
        "{error}"
    );
    assert!(!candidate.exists());
    assert!(!report.exists());
}

#[test]
fn nativer_compiler_verwirft_aliasierende_ausgabeziele_vor_der_ableitung() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let output = root.join("output");
    fs::create_dir(&output).expect("Ausgabeverzeichnis");
    let candidate = output.join("result.json");
    let report_alias = output.join(".").join("result.json");

    let error = derive_germany_operational_v2(&spec, &root.0, &candidate, &report_alias)
        .expect_err("Pfadaliasse desselben Ziels muessen scheitern");
    assert!(
        error
            .to_string()
            .contains("Kandidat, Movement-Route-Sidecar und Bericht muessen verschiedene Ziele"),
        "{error}"
    );
    assert!(!candidate.exists());
}

#[test]
fn spaete_berichtskollision_hinterlaesst_keine_builder_eigenen_publish_oder_stagingreste() {
    const LAYER_RECORD_PADDING_BYTES: usize = 7 * 1024 * 1024;
    const CLAIM_POLL_ATTEMPTS: usize = 10_000;
    const CLAIM_POLL_INTERVAL: Duration = Duration::from_millis(1);

    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let tracks = root.join("tracks.geojsonseq");
    let mut track_bytes = fs::read(&tracks).expect("Gleislayer lesen");
    let first_record_end = track_bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("erster Gleisdatensatz endet mit Newline");
    track_bytes.splice(
        first_record_end..first_record_end,
        std::iter::repeat_n(b' ', LAYER_RECORD_PADDING_BYTES),
    );
    fs::write(&tracks, track_bytes).expect("Gleislayer fuer reproduzierbares Race polstern");

    let candidate = root.join("late-candidate.json");
    let report = root.join("late-report.json");
    let candidate_claim = root.join(".late-candidate.json.zugfolge-publish.lock");
    let report_claim = root.join(".late-report.json.zugfolge-publish.lock");
    let builder_spec = spec.clone();
    let builder_source = root.0.clone();
    let builder_candidate = candidate.clone();
    let builder_report = report.clone();
    let builder = thread::spawn(move || {
        derive_germany_operational_v2(
            &builder_spec,
            &builder_source,
            &builder_candidate,
            &builder_report,
        )
    });

    let builder_staging_exists = || {
        fs::read_dir(&root.0)
            .expect("Testverzeichnis lesen")
            .map(|entry| entry.expect("Verzeichniseintrag").file_name())
            .any(|name| {
                name.to_string_lossy()
                    .starts_with(".zugfolge-germany-operational-")
            })
    };
    let mut publish_boundary_reached = false;
    for _ in 0..CLAIM_POLL_ATTEMPTS {
        if candidate_claim.is_file() && report_claim.is_file() && builder_staging_exists() {
            publish_boundary_reached = true;
            break;
        }
        assert!(
            !builder.is_finished(),
            "Builder endete, bevor die spaete Berichtskollision injiziert werden konnte"
        );
        thread::sleep(CLAIM_POLL_INTERVAL);
    }
    assert!(
        publish_boundary_reached,
        "Publish-Claims und Builder-Staging erschienen nicht innerhalb von {} Poll-Intervallen",
        CLAIM_POLL_ATTEMPTS
    );
    fs::write(&report, b"foreign-late-report")
        .expect("fremden Bericht nach dem Abwesenheitscheck anlegen");

    let error = builder
        .join()
        .expect("Builder-Thread darf nicht panicen")
        .expect_err("spaeter Bericht muss den Paar-Publish fail-closed abbrechen");
    assert!(
        error
            .to_string()
            .contains("Operational-v2-Bericht create-new veroeffentlichen"),
        "unerwarteter Fehler: {error}"
    );
    assert!(
        !candidate.exists(),
        "partieller builder-eigener Kandidat muss entfernt sein"
    );
    assert_eq!(
        fs::read(&report).expect("fremden Bericht lesen"),
        b"foreign-late-report",
        "der fremde Race-Gewinner muss bytegleich erhalten bleiben"
    );
    assert!(!candidate_claim.exists(), "Kandidaten-Claim blieb liegen");
    assert!(!report_claim.exists(), "Bericht-Claim blieb liegen");
    let scratch_remainders = fs::read_dir(&root.0)
        .expect("Testverzeichnis lesen")
        .map(|entry| entry.expect("Verzeichniseintrag").file_name())
        .filter(|name| {
            name.to_string_lossy()
                .starts_with(".zugfolge-germany-operational-")
        })
        .collect::<Vec<_>>();
    assert!(
        scratch_remainders.is_empty(),
        "private Builder-Stagingreste blieben liegen: {scratch_remainders:?}"
    );
}

#[test]
fn zwei_parallele_publisher_koennen_nicht_beide_dasselbe_create_new_paar_gewinnen() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let candidate = root.join("parallel-candidate.json");
    let report = root.join("parallel-report.json");
    let barrier = Arc::new(Barrier::new(3));

    let publishers = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let spec = spec.clone();
            let source_root = root.0.clone();
            let candidate = candidate.clone();
            let report = report.clone();
            thread::spawn(move || {
                barrier.wait();
                derive_germany_operational_v2(&spec, &source_root, &candidate, &report)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();

    let results = publishers
        .into_iter()
        .map(|publisher| {
            publisher
                .join()
                .expect("Publisher-Thread darf nicht panicen")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "genau ein paralleler Publisher muss das create-new Paar gewinnen: {results:?}"
    );
    let rejection = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .expect("ein Publisher muss fail-closed abgewiesen werden");
    assert!(
        rejection.to_string().contains("Publish-Claim")
            || rejection.to_string().contains("create-new"),
        "unerwarteter Konkurrenzfehler: {rejection}"
    );
    assert!(candidate.is_file(), "Gewinner-Kandidat fehlt");
    assert!(report.is_file(), "Gewinner-Bericht fehlt");
    validate_operational_infrastructure_v2_file(&candidate, "infra-deutschland-test-v2", None)
        .expect("Gewinner-Kandidat muss byte- und schemagueltig bleiben");
    assert!(
        !root
            .join(".parallel-candidate.json.zugfolge-publish.lock")
            .exists(),
        "Kandidaten-Claim blieb liegen"
    );
    assert!(
        !root
            .join(".parallel-report.json.zugfolge-publish.lock")
            .exists(),
        "Bericht-Claim blieb liegen"
    );
    assert!(
        fs::read_dir(&root.0)
            .expect("Testverzeichnis lesen")
            .map(|entry| entry.expect("Verzeichniseintrag").file_name())
            .all(|name| !name
                .to_string_lossy()
                .starts_with(".zugfolge-germany-operational-")),
        "Publisher-Stagingrest blieb liegen"
    );
}

#[test]
fn lokaler_vollkorpus_ist_deterministisch_aber_fail_closed_und_verriegelt_den_knoten() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let candidate_a = root.join("candidate-a.json");
    let report_a = root.join("report-a.json");
    let candidate_b = root.join("candidate-b.json");
    let report_b = root.join("report-b.json");

    let receipt_a = derive_germany_operational_v2(&spec, &root.0, &candidate_a, &report_a)
        .expect("erster lokaler Class-B-Korpus");
    let receipt_b = derive_germany_operational_v2(&spec, &root.0, &candidate_b, &report_b)
        .expect("zweiter lokaler Class-B-Korpus");

    assert_eq!(
        fs::read(&candidate_a).expect("Kandidat A"),
        fs::read(&candidate_b).expect("Kandidat B")
    );
    assert_eq!(receipt_a["candidate"], receipt_b["candidate"]);
    assert_eq!(receipt_a["activationEligible"], false);
    assert_eq!(receipt_a["unresolvedRequired"], 1);

    let report: Value =
        serde_json::from_slice(&fs::read(&report_a).expect("Report lesen")).expect("Report JSON");
    assert_eq!(report["routeCoverage"], "local-directed-track-templates");
    assert_eq!(report["activationEligible"], false);
    assert_eq!(
        report["unresolvedRequiredDimensions"],
        json!(["complete-timetable-route-versions"])
    );
    assert_eq!(report["realInterlockingFactsClaimed"], false);
    assert_eq!(report["counts"]["candidate"]["platformIntervals"], 3);
    assert_eq!(report["policy"]["sha256"].as_str().map(str::len), Some(64));

    let candidate: Value = serde_json::from_slice(&fs::read(&candidate_a).expect("Kandidat lesen"))
        .expect("Kandidat JSON");
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassen");
    assert_eq!(templates.len(), 4);
    let shared = "resource:synthetic-stellzone-node:2";
    assert!(
        templates
            .values()
            .all(|template| resources(template).contains(shared))
    );
    assert!(
        templates
            .values()
            .all(|template| template["authorityStartRouteMm"] == json!(0))
    );
    for template in templates.values() {
        let path: BTreeSet<_> = template["pathResources"]
            .as_array()
            .expect("path")
            .iter()
            .map(|value| value.as_str().expect("path-ID"))
            .collect();
        let overlap: BTreeSet<_> = template["overlapResources"]
            .as_array()
            .expect("overlap")
            .iter()
            .map(|value| value.as_str().expect("overlap-ID"))
            .collect();
        let flank: BTreeSet<_> = template["flankResources"]
            .as_array()
            .expect("flank")
            .iter()
            .map(|value| value.as_str().expect("flank-ID"))
            .collect();
        assert!(path.is_disjoint(&overlap));
        assert!(path.is_disjoint(&flank));
        assert!(overlap.is_disjoint(&flank));
    }
    validate_operational_infrastructure_v2_file(&candidate_a, "infra-deutschland-test-v2", None)
        .expect("materialisierter Kandidat bleibt nativ gueltig");
}

#[test]
fn etcs_osm_level_werden_kanonisch_abgeleitet_und_ambiguous_nicht_behauptet() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track_with_tags(
                "track-1",
                1,
                2,
                1_000,
                [json!(12.0), json!(51.0)],
                [json!(12.0001), json!(51.0)],
                "{\"railway\":\"rail\",\"railway:etcs\":\"2\",\"usage\":\"main\"}",
            ),
            track_with_tags(
                "track-2",
                2,
                3,
                1_200,
                [json!(12.0001), json!(51.0)],
                [json!(12.0002), json!(51.0)],
                "{\"railway\":\"rail\",\"railway:etcs:forward\":\"1\",\"railway:etcs:backward\":\"2\",\"usage\":\"main\"}",
            ),
        ],
    );
    let spec = write_spec(&root, None);
    let candidate_path = root.join("canonical-etcs-candidate.json");
    let report_path = root.join("canonical-etcs-report.json");
    derive_germany_operational_v2(&spec, &root.0, &candidate_path, &report_path)
        .expect("kanonische ETCS-Level");

    let candidate: Value =
        serde_json::from_slice(&fs::read(&candidate_path).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    let route_versions = candidate["routeVersions"]
        .as_object()
        .expect("Routenversionen");
    let systems_for_track = |track_id: &str| {
        route_versions
            .values()
            .find(|route| route["legs"][0]["edgeId"] == track_id)
            .unwrap_or_else(|| panic!("lokale Route fuer {track_id}"))["legs"][0]
            ["availableProtectionSystems"]
            .clone()
    };
    let track_1_systems = systems_for_track("track-1");
    assert_eq!(track_1_systems, json!(["etcs-level2"]));
    let track_2_systems = systems_for_track("track-2");
    assert_eq!(track_2_systems, json!(["etcs-level1", "etcs-level2"]));
    assert!(
        !fs::read_to_string(&candidate_path)
            .expect("Kandidat als Text lesen")
            .contains("\"etcs\""),
        "der nichtkanonische Sammelbezeichner darf nie materialisiert werden"
    );

    write_sequence(
        &root.join("tracks.geojsonseq"),
        &[
            track_with_tags(
                "track-1",
                1,
                2,
                1_000,
                [json!(12.0), json!(51.0)],
                [json!(12.0001), json!(51.0)],
                "{\"railway\":\"rail\",\"railway:etcs\":\"yes\",\"usage\":\"main\"}",
            ),
            track(
                "track-2",
                2,
                3,
                1_200,
                [json!(12.0001), json!(51.0)],
                [json!(12.0002), json!(51.0)],
            ),
        ],
    );
    let fallback_candidate = root.join("ambiguous-etcs-candidate.json");
    let fallback_report = root.join("ambiguous-etcs-report.json");
    derive_germany_operational_v2(&spec, &root.0, &fallback_candidate, &fallback_report)
        .expect("ambiguous ETCS-Angabe wird nicht als beobachtetes System behauptet");
    let fallback: Value =
        serde_json::from_slice(&fs::read(fallback_candidate).expect("Fallback-Kandidat lesen"))
            .expect("Fallback-Kandidat JSON");
    let fallback_route = fallback["routeVersions"]
        .as_object()
        .expect("Fallback-Routenversionen")
        .values()
        .find(|route| route["legs"][0]["edgeId"] == "track-1")
        .expect("Fallback-Route fuer track-1");
    assert_eq!(
        fallback_route["legs"][0]["availableProtectionSystems"],
        json!(["pzb"])
    );
    assert_eq!(
        fallback_route["legs"][0]["simultaneouslyRequiredProtectionSystems"],
        json!([])
    );
    let fallback_report: Value =
        serde_json::from_slice(&fs::read(fallback_report).expect("Fallback-Bericht lesen"))
            .expect("Fallback-Bericht JSON");
    assert_eq!(
        fallback_report["counts"]["provenance"]["simulatedProtectionAssignments"],
        1
    );
}

#[test]
fn point_linestring_und_polygon_erzeugen_nur_interne_synthetische_bahnsteigintervalle() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let candidate_path = root.join("platform-geometries-candidate.json");
    let report_path = root.join("platform-geometries-report.json");
    derive_germany_operational_v2(&spec, &root.0, &candidate_path, &report_path)
        .expect("Point-, LineString- und Polygon-Bahnsteige");

    let candidate: Value =
        serde_json::from_slice(&fs::read(candidate_path).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    assert_eq!(
        candidate["platformIntervals"]["platform-point"]["edgeId"],
        "track-1"
    );
    assert_eq!(
        candidate["platformIntervals"]["platform-line"]["edgeId"],
        "track-2"
    );
    assert_eq!(
        candidate["platformIntervals"]["platform-polygon"]["edgeId"],
        "track-1"
    );
    for platform in candidate["platformIntervals"]
        .as_object()
        .expect("Bahnsteigintervalle")
        .values()
    {
        assert!(platform.get("qualityClass").is_none());
        assert!(platform.get("orderable").is_none());
    }

    let report: Value =
        serde_json::from_slice(&fs::read(report_path).expect("Report lesen")).expect("Report JSON");
    assert_eq!(report["counts"]["source"]["platforms"], 3);
    assert_eq!(report["counts"]["candidate"]["platformIntervals"], 3);
    assert_eq!(
        report["counts"]["provenance"]["excludedPlatformEvidence"],
        0
    );
    assert_eq!(
        report["scope"]["platformModel"],
        "deterministic-nearest-observed-track-within-policy-radius/v1"
    );
    assert!(
        report.get("mapClassCReclassified").is_none(),
        "der native Ableiter darf keinen Karten-Umetikettierungsclaim einfuehren"
    );
    assert_eq!(report["realInterlockingFactsClaimed"], false);
}

#[test]
fn plattform_snap_tie_ist_von_der_track_reihenfolge_unabhaengig() {
    let first = TestDirectory::create();
    let second = TestDirectory::create();
    prepare_platform_tie_layers(&first, false);
    prepare_platform_tie_layers(&second, true);
    let first_spec = write_spec(&first, None);
    let second_spec = write_spec(&second, None);
    let first_candidate = first.join("tie-candidate.json");
    let second_candidate = second.join("tie-candidate.json");
    derive_germany_operational_v2(
        &first_spec,
        &first.0,
        &first_candidate,
        &first.join("tie-report.json"),
    )
    .expect("Tie in erster Reihenfolge");
    derive_germany_operational_v2(
        &second_spec,
        &second.0,
        &second_candidate,
        &second.join("tie-report.json"),
    )
    .expect("Tie in umgekehrter Reihenfolge");
    let first_bytes = fs::read(&first_candidate).expect("erster Tie-Kandidat");
    let second_bytes = fs::read(&second_candidate).expect("zweiter Tie-Kandidat");
    assert_eq!(first_bytes, second_bytes);
    let candidate: Value = serde_json::from_slice(&first_bytes).expect("Tie-Kandidat JSON");
    assert_eq!(
        candidate["platformIntervals"]["platform-tie"]["edgeId"],
        "track-a"
    );
}

#[test]
fn plattformgeometrien_verwerfen_leere_malformed_und_multipart_formen() {
    let cases = [
        (
            "point-malformed",
            json!({"type": "Point", "coordinates": [12.0]}),
            "ist keine Koordinate",
        ),
        (
            "line-empty",
            json!({"type": "LineString", "coordinates": []}),
            "mindestens zwei",
        ),
        (
            "line-degenerate",
            json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0, 51.0]]}),
            "aufeinanderfolgend verschiedene Punkte",
        ),
        (
            "polygon-empty",
            json!({"type": "Polygon", "coordinates": []}),
            "besitzt keine Ringe",
        ),
        (
            "polygon-open",
            json!({"type": "Polygon", "coordinates": [[[12.0, 51.0], [12.0001, 51.0], [12.0001, 51.0001], [12.0, 51.0001]]]}),
            "ist nicht geschlossen",
        ),
        (
            "polygon-short-ring",
            json!({"type": "Polygon", "coordinates": [[[12.0, 51.0], [12.0001, 51.0], [12.0, 51.0]]]}),
            "weniger als vier Positionen",
        ),
        (
            "multi-line",
            json!({"type": "MultiLineString", "coordinates": [[[12.0, 51.0], [12.0001, 51.0]]]}),
            "Typ `MultiLineString` ist nicht unterstuetzt",
        ),
        (
            "multi-polygon",
            json!({"type": "MultiPolygon", "coordinates": [[[[12.0, 51.0], [12.0001, 51.0], [12.0001, 51.0001], [12.0, 51.0]]]]}),
            "Typ `MultiPolygon` ist nicht unterstuetzt",
        ),
    ];
    for (name, geometry, expected_error) in cases {
        let root = TestDirectory::create();
        prepare_layers(&root);
        write_sequence(
            &root.join("platforms.geojsonseq"),
            &[feature(
                geometry,
                json!({"feature_id": format!("platform-{name}"), "feature_type": "platform", "quality_class": "C", "orderable": false}),
            )],
        );
        let spec = write_spec(&root, None);
        let error = derive_germany_operational_v2(
            &spec,
            &root.0,
            &root.join(&format!("{name}-candidate.json")),
            &root.join(&format!("{name}-report.json")),
        )
        .expect_err("ungueltige Plattformgeometrie muss scheitern");
        assert!(
            error.to_string().contains(expected_error),
            "{name}: unerwarteter Fehler: {error}"
        );
    }
}

#[test]
fn konfliktressourcen_binden_switch_block_und_track_section_ueber_ihre_fachfelder() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let candidate_path = root.join("resource-kind-candidate.json");
    let report_path = root.join("resource-kind-report.json");
    derive_germany_operational_v2(&spec, &root.0, &candidate_path, &report_path)
        .expect("alle drei Konfliktressourcenarten");

    let candidate: Value =
        serde_json::from_slice(&fs::read(candidate_path).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassen");
    let path_membership = |resource_id: &str| {
        templates
            .values()
            .filter(|template| {
                template["pathResources"]
                    .as_array()
                    .expect("Pfadressourcen")
                    .iter()
                    .any(|value| value.as_str() == Some(resource_id))
            })
            .count()
    };
    assert_eq!(path_membership("resource-switch-2"), 4);
    assert_eq!(path_membership("resource-block-1"), 2);
    assert_eq!(path_membership("resource-track-section-2"), 2);

    let report: Value =
        serde_json::from_slice(&fs::read(report_path).expect("Report lesen")).expect("Report JSON");
    assert_eq!(report["counts"]["source"]["conflictResources"], 3);
}

#[test]
fn konfliktressourcen_verwerfen_fehlende_und_ungueltige_artabhaengige_gleisfelder() {
    let cases = [
        (
            "switch-missing",
            json!({
                "feature_id": "resource-switch-missing",
                "resource_kind": "switch",
                "switch_id": "switch-2",
                "track_ids_json": "[\"track-1\"]"
            }),
            "incident_track_ids_json fehlt",
        ),
        (
            "switch-invalid",
            json!({
                "feature_id": "resource-switch-invalid",
                "resource_kind": "switch",
                "switch_id": "switch-2",
                "incident_track_ids_json": "{\"track\":\"track-1\"}"
            }),
            "incident_track_ids_json ist ungueltig",
        ),
        (
            "block-missing",
            json!({
                "feature_id": "resource-block-missing",
                "resource_kind": "block",
                "block_id": "block-1",
                "incident_track_ids_json": "[\"track-1\"]"
            }),
            "track_ids_json fehlt",
        ),
        (
            "block-invalid",
            json!({
                "feature_id": "resource-block-invalid",
                "resource_kind": "block",
                "block_id": "block-1",
                "track_ids_json": "not-json"
            }),
            "track_ids_json ist ungueltig",
        ),
        (
            "track-section-missing",
            json!({
                "feature_id": "resource-track-section-missing",
                "resource_kind": "track_section",
                "incident_track_ids_json": "[\"track-2\"]"
            }),
            "track_ids_json fehlt",
        ),
        (
            "track-section-invalid",
            json!({
                "feature_id": "resource-track-section-invalid",
                "resource_kind": "track_section",
                "track_ids_json": "[]"
            }),
            "track_ids_json ist leer oder enthaelt leere IDs",
        ),
    ];
    for (name, properties, expected_error) in cases {
        let root = TestDirectory::create();
        prepare_layers(&root);
        write_sequence(
            &root.join("conflict-resources.geojsonseq"),
            &[feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                properties,
            )],
        );
        let spec = write_spec(&root, None);
        let error = derive_germany_operational_v2(
            &spec,
            &root.0,
            &root.join(&format!("{name}-candidate.json")),
            &root.join(&format!("{name}-report.json")),
        )
        .expect_err("ungueltige Konfliktressourcenbindung muss scheitern");
        assert!(
            error.to_string().contains(expected_error),
            "{name}: unerwarteter Fehler: {error}"
        );
    }
}

#[test]
fn quellreferenzen_werden_fuer_jede_referenzklasse_fail_closed_gegen_indizes_geprueft() {
    let cases = [
        (
            "switch-track",
            "switches.geojsonseq",
            feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                json!({
                    "feature_id": "switch-2",
                    "feature_type": "switch",
                    "osm_node_id": 2,
                    "incident_track_ids_json": "[\"track-unknown\"]"
                }),
            ),
            "switches Datensatz 1.incident_track_ids_json referenziert unbekanntes orderable Gleis `track-unknown`",
        ),
        (
            "signal-track",
            "signals.geojsonseq",
            feature(
                json!({"type": "Point", "coordinates": [12.0, 51.0]}),
                json!({
                    "feature_id": "signal-observed-1",
                    "feature_type": "signal",
                    "incident_track_ids_json": "[\"track-unknown\"]"
                }),
            ),
            "signals Datensatz 1.incident_track_ids_json referenziert unbekanntes orderable Gleis `track-unknown`",
        ),
        (
            "block-track",
            "blocks.geojsonseq",
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "block-1",
                    "track_ids_json": "[\"track-unknown\"]",
                    "boundary_signal_ids_json": "[]"
                }),
            ),
            "blocks Datensatz 1.track_ids_json referenziert unbekanntes orderable Gleis `track-unknown`",
        ),
        (
            "block-signal",
            "blocks.geojsonseq",
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "block-1",
                    "track_ids_json": "[\"track-1\"]",
                    "boundary_signal_ids_json": "[\"signal-unknown\"]"
                }),
            ),
            "blocks Datensatz 1.boundary_signal_ids_json referenziert unbekanntes Signal `signal-unknown`",
        ),
        (
            "resource-track",
            "conflict-resources.geojsonseq",
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "resource-track-unknown",
                    "resource_kind": "track_section",
                    "track_ids_json": "[\"track-unknown\"]"
                }),
            ),
            "conflictResources Datensatz 1.track_ids_json referenziert unbekanntes orderable Gleis `track-unknown`",
        ),
        (
            "resource-block",
            "conflict-resources.geojsonseq",
            feature(
                json!({"type": "LineString", "coordinates": [[12.0, 51.0], [12.0001, 51.0]]}),
                json!({
                    "feature_id": "resource-block-unknown",
                    "resource_kind": "block",
                    "block_id": "block-unknown",
                    "track_ids_json": "[\"track-1\"]"
                }),
            ),
            "conflictResources Datensatz 1.block_id referenziert unbekannten Block `block-unknown`",
        ),
        (
            "resource-switch",
            "conflict-resources.geojsonseq",
            feature(
                json!({"type": "Point", "coordinates": [12.0001, 51.0]}),
                json!({
                    "feature_id": "resource-switch-unknown",
                    "resource_kind": "switch",
                    "switch_id": "switch-unknown",
                    "incident_track_ids_json": "[\"track-1\"]"
                }),
            ),
            "conflictResources Datensatz 1.switch_id referenziert unbekannte Weiche `switch-unknown`",
        ),
    ];
    for (name, layer, record, expected_error) in cases {
        let root = TestDirectory::create();
        prepare_layers(&root);
        write_sequence(&root.join(layer), &[record]);
        let spec = write_spec(&root, None);
        let error = derive_germany_operational_v2(
            &spec,
            &root.0,
            &root.join(&format!("{name}-candidate.json")),
            &root.join(&format!("{name}-report.json")),
        )
        .expect_err("unbekannte Quellreferenz muss scheitern");
        assert!(
            error.to_string().contains(expected_error),
            "{name}: unerwarteter Fehler: {error}"
        );
    }
}

#[test]
fn gepinnter_lueckenloser_zuglauf_schliesst_die_route_dimension() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[json!({
            "routeVersionId": "route-version-full-1",
            "templateId": "route-template-full-1",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [
                {"edgeId": "track-1", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                {"edgeId": "track-2", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_200, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}
            ]
        })],
    );
    let spec = write_spec(&root, Some("timetable-routes.geojsonseq"));
    let candidate = root.join("candidate.json");
    let report = root.join("report.json");

    let receipt = derive_germany_operational_v2(&spec, &root.0, &candidate, &report)
        .expect("vollstaendiger gepinnter Zuglauf");
    assert_eq!(receipt["activationEligible"], true);
    assert_eq!(receipt["unresolvedRequired"], 0);
    let candidate: Value =
        serde_json::from_slice(&fs::read(candidate).expect("Kandidat")).expect("Kandidat JSON");
    assert_eq!(
        candidate["routeVersions"]["route-version-full-1"]["legs"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        candidate["interlockingRoutes"]
            .as_object()
            .map(serde_json::Map::len),
        Some(2)
    );
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassenvorlagen");
    assert!(
        templates
            .keys()
            .all(|id| id.starts_with("interlocking:synthetic-segment:"))
    );
    let mut segments: Vec<_> = templates.values().collect();
    segments.sort_by_key(|template| {
        template["authorityStartRouteMm"]
            .as_i64()
            .expect("Fahrstrassenanfang")
    });
    let legs = candidate["routeVersions"]["route-version-full-1"]["legs"]
        .as_array()
        .expect("Laufweg-Legs");
    let mut expected_start = 0_i64;
    let mut total_segment_path_resources = 0_usize;
    for (segment, leg) in segments.iter().zip(legs) {
        assert_eq!(segment["authorityStartRouteMm"], json!(expected_start));
        assert_eq!(
            string_set(segment, "pathResources"),
            string_set(leg, "blockIds")
        );
        let authority_end = segment["authorityEndRouteMm"]
            .as_i64()
            .expect("Fahrstrassenende");
        assert!(authority_end > expected_start);
        assert_eq!(segment["releaseAfterTailRouteMm"], json!(authority_end));
        expected_start = authority_end;
        total_segment_path_resources += string_set(segment, "pathResources").len();

        let path = string_set(segment, "pathResources");
        let overlap = string_set(segment, "overlapResources");
        let flank = string_set(segment, "flankResources");
        assert!(path.is_disjoint(&overlap));
        assert!(path.is_disjoint(&flank));
        assert!(overlap.is_disjoint(&flank));
    }
    assert_eq!(expected_start, 2_200);
    assert_eq!(total_segment_path_resources, 6);
    assert_eq!(
        string_set(segments[0], "flankResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:1"])
    );
    assert_eq!(
        string_set(segments[0], "overlapResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:2"])
    );
    assert_eq!(
        string_set(segments[1], "flankResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:2"])
    );
    assert_eq!(
        string_set(segments[1], "overlapResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:3"])
    );
    assert_ne!(segments[0]["switchPositions"]["switch-2"], Value::Null);
    assert_ne!(segments[1]["switchPositions"]["switch-2"], Value::Null);
    let report: Value =
        serde_json::from_slice(&fs::read(report).expect("Report")).expect("Report JSON");
    assert_eq!(report["routeCoverage"], "complete-pinned-timetable-routes");
    assert_eq!(report["unresolvedRequired"], 0);
    assert_eq!(report["counts"]["source"]["timetableRoutes"], 1);
    assert_eq!(report["counts"]["source"]["timetableLegs"], 2);
    assert_eq!(report["counts"]["candidate"]["interlockingRoutes"], 2);
    assert_eq!(
        report["counts"]["provenance"]["syntheticBoundarySignals"],
        2
    );
    assert_eq!(
        report["scope"]["interlockingModel"],
        "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3"
    );
}

#[test]
fn segmentfahrstrassen_verriegeln_gemeinsame_kante_ohne_kumulative_ressourcen() {
    let root = TestDirectory::create();
    prepare_shared_middle_layers(&root);
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[
            json!({
                "routeVersionId": "route-a",
                "templateId": "template-a",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [
                    {"edgeId": "a-in", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "shared", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "a-branch", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "a-out", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}
                ]
            }),
            json!({
                "routeVersionId": "route-b",
                "templateId": "template-b",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [
                    {"edgeId": "b-in", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "shared", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "b-branch", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                    {"edgeId": "b-out", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}
                ]
            }),
        ],
    );
    let spec = write_spec(&root, Some("timetable-routes.geojsonseq"));
    let candidate_path = root.join("shared-middle-candidate.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_path,
        &root.join("shared-middle-report.json"),
    )
    .expect("zwei Laufwege mit gemeinsamer Zwischenkante");

    let candidate: Value =
        serde_json::from_slice(&fs::read(candidate_path).expect("Kandidat lesen"))
            .expect("Kandidat JSON");
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassen");
    assert_eq!(templates.len(), 8);
    let route_segments = |route_template_id: &str| {
        let mut segments: Vec<_> = templates
            .values()
            .filter(|template| template["routeTemplateId"] == json!(route_template_id))
            .collect();
        segments.sort_by_key(|template| {
            template["authorityStartRouteMm"]
                .as_i64()
                .expect("Segmentanfang")
        });
        segments
    };
    let segments_a = route_segments("template-a");
    let segments_b = route_segments("template-b");
    for (template_id, segments) in [("template-a", &segments_a), ("template-b", &segments_b)] {
        assert_eq!(segments.len(), 4);
        let route = candidate["routeVersions"]
            .as_object()
            .expect("Laufwege")
            .values()
            .find(|route| route["templateId"] == json!(template_id))
            .expect("Laufweg zur Vorlage");
        let legs = route["legs"].as_array().expect("Laufweg-Legs");
        for (index, (segment, leg)) in segments.iter().zip(legs).enumerate() {
            let start = i64::try_from(index).expect("Index") * 1_000;
            assert_eq!(segment["authorityStartRouteMm"], json!(start));
            assert_eq!(segment["authorityEndRouteMm"], json!(start + 1_000));
            assert_eq!(
                string_set(segment, "pathResources"),
                string_set(leg, "blockIds")
            );
        }
    }

    let shared_a = segments_a[1];
    let shared_b = segments_b[1];
    let path_a = string_set(shared_a, "pathResources");
    let path_b = string_set(shared_b, "pathResources");
    assert!(!path_a.is_disjoint(&path_b));
    for shared_resource in ["resource-switch-2", "resource-switch-3"] {
        assert!(path_a.contains(shared_resource));
        assert!(path_b.contains(shared_resource));
    }
    assert_eq!(
        string_set(shared_a, "flankResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:2"])
    );
    assert_eq!(
        string_set(shared_b, "flankResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:2"])
    );
    assert_eq!(
        string_set(shared_a, "overlapResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:3"])
    );
    assert_ne!(
        shared_a["switchPositions"]["switch-2"],
        shared_b["switchPositions"]["switch-2"]
    );
    assert!(!resources(shared_a).is_disjoint(&resources(shared_b)));
    assert_eq!(
        segments_a[0]["switchPositions"]
            .as_object()
            .expect("Switchlagen")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["switch-2"])
    );
    assert_eq!(
        shared_a["switchPositions"]
            .as_object()
            .expect("Switchlagen")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["switch-2", "switch-3"])
    );
    assert_eq!(
        segments_a[2]["switchPositions"]
            .as_object()
            .expect("Switchlagen")
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["switch-3"])
    );
    assert_eq!(
        segments_a[3]["switchPositions"]
            .as_object()
            .expect("Switchlagen")
            .len(),
        0
    );
}

#[test]
fn self_loop_segmentfahrstrassen_bleiben_getrennt_lueckenlos_und_deterministisch() {
    let root = TestDirectory::create();
    prepare_self_loop_layers(&root);
    write_sequence(
        &root.join("timetable-routes.geojsonseq"),
        &[json!({
            "routeVersionId": "route-loop",
            "templateId": "template-loop",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [
                {"edgeId": "loop", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                {"edgeId": "out", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}
            ]
        })],
    );
    let spec = write_spec(&root, Some("timetable-routes.geojsonseq"));
    let candidate_a = root.join("loop-candidate-a.json");
    let candidate_b = root.join("loop-candidate-b.json");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_a,
        &root.join("loop-report-a.json"),
    )
    .expect("erstes Self-Loop-Kompilat");
    derive_germany_operational_v2(
        &spec,
        &root.0,
        &candidate_b,
        &root.join("loop-report-b.json"),
    )
    .expect("zweites Self-Loop-Kompilat");
    assert_eq!(
        fs::read(&candidate_a).expect("Self-Loop-Kandidat A"),
        fs::read(&candidate_b).expect("Self-Loop-Kandidat B")
    );

    let candidate: Value = serde_json::from_slice(&fs::read(candidate_a).expect("Kandidat lesen"))
        .expect("Kandidat JSON");
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassen");
    assert_eq!(templates.len(), 2);
    let mut segments: Vec<_> = templates.values().collect();
    segments.sort_by_key(|template| {
        template["authorityStartRouteMm"]
            .as_i64()
            .expect("Segmentanfang")
    });
    assert_eq!(segments[0]["authorityStartRouteMm"], json!(0));
    assert_eq!(segments[0]["authorityEndRouteMm"], json!(1_000));
    assert_eq!(segments[1]["authorityStartRouteMm"], json!(1_000));
    assert_eq!(segments[1]["authorityEndRouteMm"], json!(2_000));
    let loop_flank = string_set(segments[0], "flankResources");
    assert!(
        loop_flank
            .iter()
            .any(|resource| resource.starts_with("resource:synthetic-self-loop-flank:"))
    );
    assert_eq!(loop_flank.len(), 1);
    assert_eq!(
        string_set(segments[1], "flankResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:1"])
    );
    let legs = candidate["routeVersions"]["route-loop"]["legs"]
        .as_array()
        .expect("Self-Loop-Legs");
    for (segment, leg) in segments.iter().zip(legs) {
        assert_eq!(
            string_set(segment, "pathResources"),
            string_set(leg, "blockIds")
        );
        let path = string_set(segment, "pathResources");
        let overlap = string_set(segment, "overlapResources");
        let flank = string_set(segment, "flankResources");
        assert!(path.is_disjoint(&overlap));
        assert!(path.is_disjoint(&flank));
        assert!(overlap.is_disjoint(&flank));
    }
}

#[test]
fn timetable_verwirft_unbekannte_und_nicht_lueckenlose_kanten_fail_closed() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let timetable = root.join("timetable-routes.geojsonseq");
    write_sequence(
        &timetable,
        &[json!({
            "routeVersionId": "route-broken",
            "templateId": "template-broken",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [{"edgeId": "unknown", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}]
        })],
    );
    let spec = write_spec(&root, Some("timetable-routes.geojsonseq"));
    let error = derive_germany_operational_v2(
        &spec,
        &root.0,
        &root.join("unknown-candidate.json"),
        &root.join("unknown-report.json"),
    )
    .expect_err("unbekannte Kante muss scheitern");
    assert!(error.to_string().contains("unbekannte Kante `unknown`"));

    write_sequence(
        &timetable,
        &[json!({
            "routeVersionId": "route-gap",
            "templateId": "template-gap",
            "predecessorId": null,
            "transitionRouteMm": null,
            "legs": [
                {"edgeId": "track-1", "direction": "along", "edgeEntryMm": 0, "edgeExitMm": 1_000, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []},
                {"edgeId": "track-2", "direction": "against", "edgeEntryMm": 1_200, "edgeExitMm": 0, "availableProtectionSystems": ["pzb"], "simultaneouslyRequiredProtectionSystems": []}
            ]
        })],
    );
    let error = derive_germany_operational_v2(
        &spec,
        &root.0,
        &root.join("gap-candidate.json"),
        &root.join("gap-report.json"),
    )
    .expect_err("Knotenluecke muss scheitern");
    assert!(
        error
            .to_string()
            .contains("keine lueckenlose gemeinsame Knotengrenze")
    );
}

#[test]
fn native_cli_besitzt_den_gepinnten_vier_pfad_vertrag() {
    let root = TestDirectory::create();
    prepare_layers(&root);
    let spec = write_spec(&root, None);
    let candidate = root.join("cli-candidate.json");
    let report = root.join("cli-report.json");
    let invocation = Command::new(env!("CARGO_BIN_EXE_zugfolge-infra-release"))
        .arg("derive-germany-operational-v2")
        .arg(&spec)
        .arg(&root.0)
        .arg(&candidate)
        .arg(&report)
        .output()
        .expect("nativen Deutschland-Ableiter starten");
    assert!(
        invocation.status.success(),
        "CLI muss gelingen: {}",
        String::from_utf8_lossy(&invocation.stderr)
    );
    let receipt: Value = serde_json::from_slice(&invocation.stdout).expect("kompaktes CLI-Receipt");
    assert_eq!(
        receipt["schema"],
        "germany-operational-v2-derivation-receipt-v1"
    );
    assert_eq!(receipt["activationEligible"], false);
    assert!(candidate.is_file());
    assert!(report.is_file());
}
