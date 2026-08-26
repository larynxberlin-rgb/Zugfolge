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
            .contains("Kandidat und Bericht muessen verschiedene Ziele"),
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
        Some(1)
    );
    let templates = candidate["interlockingRoutes"]
        .as_object()
        .expect("Fahrstrassenvorlagen");
    let full = templates
        .values()
        .find(|template| template["authorityEndRouteMm"] == json!(2_200))
        .expect("vollstaendige Gesamtfahrstrasse");
    assert_eq!(full["releaseAfterTailRouteMm"], json!(2_200));

    let full_path = string_set(full, "pathResources");
    assert_eq!(full_path.len(), 5);
    assert!(full_path.contains("resource-block-1"));
    assert!(full_path.contains("resource-track-section-2"));

    assert_eq!(
        string_set(full, "flankResources"),
        BTreeSet::from([
            "resource:synthetic-stellzone-node:1",
            "resource:synthetic-stellzone-node:2",
        ])
    );
    assert_eq!(
        string_set(full, "overlapResources"),
        BTreeSet::from(["resource:synthetic-stellzone-node:3"])
    );
    assert_ne!(full["switchPositions"]["switch-2"], Value::Null);

    let full_overlap = string_set(full, "overlapResources");
    let full_flank = string_set(full, "flankResources");
    assert!(full_path.is_disjoint(&full_overlap));
    assert!(full_path.is_disjoint(&full_flank));
    assert!(full_overlap.is_disjoint(&full_flank));
    let report: Value =
        serde_json::from_slice(&fs::read(report).expect("Report")).expect("Report JSON");
    assert_eq!(report["routeCoverage"], "complete-pinned-timetable-routes");
    assert_eq!(report["unresolvedRequired"], 0);
    assert_eq!(report["counts"]["source"]["timetableRoutes"], 1);
    assert_eq!(report["counts"]["source"]["timetableLegs"], 2);
    assert_eq!(report["counts"]["candidate"]["interlockingRoutes"], 1);
    assert_eq!(
        report["counts"]["provenance"]["syntheticBoundarySignals"],
        2
    );
    assert_eq!(
        report["scope"]["interlockingModel"],
        "deterministic-full-route-node-stellzone-mutex-and-authority/v2"
    );
}

#[test]
fn kumulative_fahrstrassen_verriegeln_eine_gemeinsame_zwischenkante() {
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
    assert_eq!(templates.len(), 2);
    let full_template = |route_template_id: &str| {
        templates
            .values()
            .find(|template| {
                template["routeTemplateId"] == json!(route_template_id)
                    && template["authorityEndRouteMm"] == json!(4_000)
            })
            .expect("vollstaendige Fahrstrasse")
    };
    let full_a = full_template("template-a");
    let full_b = full_template("template-b");
    let path_a = string_set(full_a, "pathResources");
    let path_b = string_set(full_b, "pathResources");
    assert!(!path_a.is_disjoint(&path_b));
    for shared_resource in ["resource-switch-2", "resource-switch-3"] {
        assert!(path_a.contains(shared_resource));
        assert!(path_b.contains(shared_resource));
    }
    assert!(string_set(full_a, "flankResources").contains("resource:synthetic-stellzone-node:2"));
    assert!(string_set(full_b, "flankResources").contains("resource:synthetic-stellzone-node:3"));
    assert_ne!(
        full_a["switchPositions"]["switch-2"],
        full_b["switchPositions"]["switch-2"]
    );
    assert!(!resources(full_a).is_disjoint(&resources(full_b)));
}

#[test]
fn self_loop_gesamtfahrstrasse_bleibt_kumulativ_getrennt_und_deterministisch() {
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
    assert_eq!(templates.len(), 1);
    let full = templates
        .values()
        .find(|template| template["authorityEndRouteMm"] == json!(2_000))
        .expect("vollstaendige Self-Loop-Gesamtfahrstrasse");
    let full_flank = string_set(full, "flankResources");
    assert!(
        full_flank
            .iter()
            .any(|resource| resource.starts_with("resource:synthetic-self-loop-flank:"))
    );
    assert!(full_flank.contains("resource:synthetic-stellzone-node:1"));
    assert_eq!(string_set(full, "pathResources").len(), 3);

    let full_path = string_set(full, "pathResources");
    let full_overlap = string_set(full, "overlapResources");
    assert!(full_path.is_disjoint(&full_overlap));
    assert!(full_path.is_disjoint(&full_flank));
    assert!(full_overlap.is_disjoint(&full_flank));
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
