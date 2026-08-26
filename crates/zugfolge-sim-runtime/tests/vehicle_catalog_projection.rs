//! Beweist, dass ein Katalog-Compile-Lauf beide autoritativen Runtimes speist.

use serde_json::{Value, json};
use zugfolge_fleet::release_catalog::{
    OperationalFormation, VehicleEconomyProjection, VehicleSourceCatalog, VehicleWorldSeed,
    compile_vehicle_catalog, recompute_vehicle_economy_projection_sha256, validate_compilation,
    validate_compilation_against_inputs,
};
use zugfolge_infra::validate_operational_infrastructure_v2_file;
use zugfolge_runtime::initialize_fleet_world;
use zugfolge_sim_runtime::operational_runtime::{
    OperationalRuntimeError,
    initialize_operational_simulation as initialize_operational_simulation_from_file,
};

const SOURCE_CATALOG: &str =
    include_str!("../../zugfolge-fleet/tests/fixtures/vehicle-catalog-source-v2.json");
const WORLD_SEED: &str =
    include_str!("../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3.json");

fn reseal_economy_projection(seed: &mut Value) {
    let mut projection: VehicleEconomyProjection =
        serde_json::from_value(seed["economy"].clone()).expect("Economy-Projektion");
    projection.projection_sha256 =
        recompute_vehicle_economy_projection_sha256(&projection).expect("Projektions-Hash");
    seed["economy"] = serde_json::to_value(projection).expect("Economy-Projektions-JSON");
}

fn configured_type(
    base: &Value,
    type_id: &str,
    numeric_id: u64,
    class_designation: &str,
    role: &str,
    control_stands: Value,
) -> Value {
    let mut vehicle_type = base.clone();
    vehicle_type["typeId"] = json!(type_id);
    vehicle_type["numericId"] = json!(numeric_id);
    vehicle_type["classDesignation"]["value"] = json!(class_designation);
    vehicle_type["tradeName"]["value"] = json!(format!("Test-{class_designation}"));
    vehicle_type["role"]["value"] = json!(role);
    vehicle_type["controlStands"]["value"] = control_stands;
    if matches!(role, "coach" | "control-car") {
        vehicle_type["traction"]["value"] = json!("unpowered");
        vehicle_type["electricSystems"]["value"] = json!([]);
        vehicle_type["technical"]["continuousPowerKw"]["value"] = json!(0);
        vehicle_type["technical"]["startingTractiveEffortKn"]["value"] = json!(0);
        vehicle_type["operationalProfile"]["maximumAccelerationCapMmps2"]["value"] = json!(0);
    }
    if role == "coach" {
        vehicle_type["standardProtection"]["value"] = json!([]);
        vehicle_type["protectionOptions"] = json!([]);
    }
    vehicle_type
}

fn configured_asset(
    base: &Value,
    id: &str,
    numeric_id: u64,
    type_id: &str,
    installed_protection: Value,
    orientation: &str,
) -> Value {
    let mut asset = base.clone();
    asset["id"] = json!(id);
    asset["numericId"] = json!(numeric_id);
    asset["typeId"] = json!(type_id);
    asset["installedProtection"] = installed_protection;
    asset["orientation"] = json!(orientation);
    asset
}

fn operational_infra_source() -> Value {
    json!({
        "id": "infra:vehicle-catalog-test:v1",
        "directedEdges": { "edge:1": 100_000 },
        "edgeGeometries": {
            "edge:1": [
                {
                    "edgeOffsetMm": 0,
                    "latitudeE7": 510_000_000,
                    "longitudeE7": 120_000_000,
                    "bearingMilliDegrees": 90_000
                },
                {
                    "edgeOffsetMm": 100_000,
                    "latitudeE7": 510_000_000,
                    "longitudeE7": 120_100_000,
                    "bearingMilliDegrees": null
                }
            ]
        },
        "routeVersions": {
            "route:1": {
                "id": "route:1",
                "templateId": "route-template:1",
                "predecessorId": null,
                "transitionRouteMm": null,
                "legs": [{
                    "edgeId": "edge:1",
                    "direction": "along",
                    "edgeEntryMm": 0,
                    "edgeExitMm": 100_000,
                    "routeStartMm": 0,
                    "blockIds": ["block:1"],
                    "speedLimitMmps": 20_000,
                    "gradientPerMille": 0,
                    "availableProtectionSystems": ["pzb"],
                    "simultaneouslyRequiredProtectionSystems": []
                }]
            }
        },
        "interlockingRoutes": {
            "interlocking:1": {
                "id": "interlocking:1",
                "routeTemplateId": "route-template:1",
                "signalId": "signal:1",
                "movementKind": "train",
                "pathResources": ["block:1"],
                "overlapResources": ["overlap:1"],
                "flankResources": ["flank:1"],
                "switchPositions": { "switch:1": "straight" },
                "authorityEndRouteMm": 90_000,
                "releaseAfterTailRouteMm": 80_000
            }
        },
        "signals": ["signal:1"],
        "switches": ["switch:1"],
        "blockResources": ["block:1", "flank:1", "overlap:1"],
        "platformIntervals": {},
        "regionBoundaries": [],
        "rzueLayoutId": "rzue:vehicle-catalog-test:v1"
    })
}

fn operational_infrastructure_fixture() -> &'static (Value, String) {
    static FIXTURE: std::sync::OnceLock<(Value, String)> = std::sync::OnceLock::new();
    FIXTURE.get_or_init(|| {
        let source = operational_infra_source();
        let directory = (0_u64..1_024)
            .find_map(|id| {
                let path = std::env::temp_dir().join(format!(
                    "zugfolge-vehicle-catalog-operational-{}-{id}",
                    std::process::id()
                ));
                match std::fs::create_dir(&path) {
                    Ok(()) => Some(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => panic!("Testverzeichnis kann nicht angelegt werden: {error}"),
                }
            })
            .expect("eindeutiges Operational-v2-Testverzeichnis");
        let candidate = directory.join("candidate.json");
        let deployed = directory.join("operational-infrastructure-v2.json");
        std::fs::write(
            &candidate,
            serde_json::to_vec(&source).expect("Operational-v2-Testquelle"),
        )
        .expect("Operational-v2-Testquelle kann geschrieben werden");
        let evidence = validate_operational_infrastructure_v2_file(
            &candidate,
            source["id"].as_str().expect("InfraRelease-ID"),
            Some(&deployed),
        )
        .expect("Operational-v2-Testquelle ist gueltig");
        (
            json!({
                "schemaVersion": "zugfolge-operational-infrastructure-binding/v2",
                "infraReleaseId": source["id"],
                "file": "operational-infrastructure-v2.json",
                "bytes": evidence["bytes"],
                "sha256": evidence["sha256"],
                "stateHash": evidence["stateHash"],
            }),
            deployed.to_str().expect("UTF-8-Testpfad").to_owned(),
        )
    })
}

fn operational_infra_release() -> Value {
    operational_infrastructure_fixture().0.clone()
}

fn initialize_operational_simulation(input_json: &str) -> Result<String, OperationalRuntimeError> {
    initialize_operational_simulation_from_file(input_json, &operational_infrastructure_fixture().1)
}

fn initialization_formations(formations: &[OperationalFormation]) -> Vec<Value> {
    formations
        .iter()
        .map(|formation| {
            json!({
                "id": formation.id,
                "predecessorId": formation.predecessor_id,
                "vehicleIds": formation.vehicle_ids,
            })
        })
        .collect()
}

fn fleet_initialization_formations(formations: &[OperationalFormation]) -> Vec<Value> {
    formations
        .iter()
        .map(|formation| {
            json!({
                "id": formation.id,
                "vehicleIds": formation.vehicle_ids,
                "pathReceiptId": formation.path_receipt_id,
            })
        })
        .collect()
}

#[test]
fn ein_compile_lauf_initialisiert_flotte_und_operational_v2() {
    let source: VehicleSourceCatalog =
        serde_json::from_str(SOURCE_CATALOG).expect("fiktiver Quellkatalog ist gueltig");
    let seed: VehicleWorldSeed =
        serde_json::from_str(WORLD_SEED).expect("fiktiver Welt-Seed ist gueltig");
    let compilation =
        compile_vehicle_catalog(&source, &seed).expect("beide Projektionen werden kompiliert");
    validate_compilation(&compilation).expect("Compile-Receipt bindet alle Ausgaben");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("Compile-Receipt bindet auch beide Eingaben");

    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
            })
            .to_string(),
        )
        .expect("Fleet-Runtime akzeptiert die Compilerprojektion"),
    )
    .expect("Fleet-Runtime antwortet mit JSON");
    assert_eq!(
        fleet_initialized["state"]["authorityRelease"]["releaseId"],
        compilation.fleet_authority.release_id
    );
    assert_eq!(
        fleet_initialized["snapshot"]["formations"]
            .as_array()
            .map(Vec::len),
        Some(compilation.operational_inventory.formations.len()),
    );
    for expected in &compilation.operational_inventory.formations {
        let persisted = &fleet_initialized["state"]["formations"][&expected.id];
        if expected.performance.mobile {
            assert_eq!(
                persisted["dynamics"],
                json!({
                    "accelerationMmPerS2": expected.performance.acceleration_mmps2,
                    "decelerationMmPerS2": expected.performance.service_brake_mmps2,
                }),
                "Fleet muss den Compiler-Rohverband ohne caller-supplied dynamics exakt reproduzieren",
            );
        } else {
            assert!(persisted.get("dynamics").is_none());
        }
    }

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational v2 akzeptiert dieselbe Compilerprojektion"),
    )
    .expect("Operational v2 antwortet mit JSON");

    let world = &operational_initialized["state"]["world"];
    assert_eq!(
        world["vehicleTypes"].as_object().map(|values| values.len()),
        Some(compilation.operational_inventory.vehicle_types.len())
    );
    assert_eq!(
        world["vehicles"].as_object().map(|values| values.len()),
        Some(compilation.operational_inventory.vehicles.len())
    );
    assert_eq!(
        world["vehicleTypes"]["fixture.et.100"]["role"],
        "powered-unit"
    );
    assert_eq!(
        world["vehicleTypes"]["fixture.et.100"]["controlStands"],
        json!({"front": true, "rear": true})
    );
    assert_eq!(
        world["vehicleTypes"]["fixture.et.100"]["traction"],
        "electric"
    );
    assert_eq!(
        world["vehicleTypes"]["fixture.et.100"]["electricSystems"],
        json!(["ac15kv"])
    );

    for expected in &compilation.operational_inventory.formations {
        assert_eq!(
            world["formations"][&expected.id]["performance"],
            serde_json::to_value(&expected.performance)
                .expect("erwartete Formationsleistung ist serialisierbar"),
            "Operational v2 muss die vom Compiler vorab geprüfte Formation reproduzieren",
        );
    }
}

#[test]
fn markt_seed_ohne_formationen_initialisiert_beide_runtimes() {
    let source: VehicleSourceCatalog =
        serde_json::from_str(SOURCE_CATALOG).expect("fiktiver Quellkatalog ist gueltig");
    let mut seed: VehicleWorldSeed =
        serde_json::from_str(WORLD_SEED).expect("fiktiver Welt-Seed ist gueltig");
    seed.formations.clear();
    seed.personnel_pools.clear();
    seed.path_receipts.clear();
    let compilation =
        compile_vehicle_catalog(&source, &seed).expect("Marktbestand wird kompiliert");

    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": [],
            })
            .to_string(),
        )
        .expect("Fleet-Runtime akzeptiert Assets ohne Formationen"),
    )
    .expect("Fleet-Antwort ist JSON");
    assert_eq!(fleet_initialized["snapshot"]["formations"], json!([]));

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-market-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": [],
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational v2 akzeptiert Assets ohne Formationen"),
    )
    .expect("Operational-Antwort ist JSON");
    assert_eq!(
        operational_initialized["state"]["world"]["formations"],
        json!({})
    );
}

#[test]
fn gedrehter_steuerwagen_speist_beide_runtimes_mit_identischer_spitze() {
    let mut source: Value = serde_json::from_str(SOURCE_CATALOG).unwrap();
    let base_type = source["vehicleTypes"][0].clone();
    let locomotive = configured_type(
        &base_type,
        "fixture.loco.100",
        120,
        "L100",
        "locomotive",
        json!({"front": true, "rear": true}),
    );
    let mut coach = configured_type(
        &base_type,
        "fixture.coach.101",
        121,
        "W101",
        "coach",
        json!({"front": false, "rear": false}),
    );
    coach["standardProtection"]["value"] = json!([]);
    coach["protectionOptions"] = json!([]);
    let mut control_car = configured_type(
        &base_type,
        "fixture.control.102",
        122,
        "STW102",
        "control-car",
        json!({"front": false, "rear": true}),
    );
    control_car["standardProtection"]["value"] = json!(["etcs-level2"]);
    control_car["protectionOptions"] = json!([]);
    source["vehicleTypes"] = json!([locomotive, coach, control_car]);

    let mut seed: Value = serde_json::from_str(WORLD_SEED).unwrap();
    let base_asset = seed["assets"][0].clone();
    seed["assets"] = json!([
        configured_asset(
            &base_asset,
            "fixture-control-102",
            1202,
            "fixture.control.102",
            json!(["etcs-level2"]),
            "against",
        ),
        configured_asset(
            &base_asset,
            "fixture-coach-101",
            1201,
            "fixture.coach.101",
            json!([]),
            "along",
        ),
        configured_asset(
            &base_asset,
            "fixture-loco-100",
            1200,
            "fixture.loco.100",
            json!(["pzb"]),
            "along",
        ),
    ]);
    seed["formations"][0]["vehicleIds"] = json!([
        "fixture-control-102",
        "fixture-coach-101",
        "fixture-loco-100"
    ]);
    seed["economy"]["operatingCosts"] = json!([
        {"typeId": "fixture.loco.100", "centsPerTrainKm": 500},
        {"typeId": "fixture.coach.101", "centsPerTrainKm": 100},
        {"typeId": "fixture.control.102", "centsPerTrainKm": 150}
    ]);
    reseal_economy_projection(&mut seed);
    seed["personnelPools"][0]["classDesignations"] = json!(["L100", "STW102", "W101"]);
    seed["pathReceipts"][0]["approvedClasses"] = json!(["L100", "STW102", "W101"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([250_000]);
    seed["pathReceipts"][0]["requiredProtection"] = json!(["etcs-level2"]);

    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("Wendezugprojektionen");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("Wendezug-Receipt bindet beide Eingaben");
    let expected = compilation.operational_inventory.formations[0]
        .performance
        .clone();
    assert!(expected.mobile);
    assert!(expected.front_control_stand_available);
    assert!(expected.rear_control_stand_available);
    assert_eq!(
        expected.protection_systems,
        ["etcs-level2".to_owned()].into()
    );

    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
            })
            .to_string(),
        )
        .expect("Fleet-Runtime akzeptiert den Wendezug"),
    )
    .expect("Fleet-Wendezugantwort ist JSON");
    assert_eq!(
        fleet_initialized["snapshot"]["formations"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-wendezug-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational v2 akzeptiert denselben Wendezug"),
    )
    .expect("Operational-Wendezugantwort ist JSON");
    assert_eq!(
        operational_initialized["state"]["world"]["formations"]["fixture-formation-1"]["performance"],
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn gleichartige_bemu_doppeltraktion_initialisiert_beide_runtimes() {
    let mut source: Value = serde_json::from_str(SOURCE_CATALOG).unwrap();
    source["vehicleTypes"][0]["traction"]["value"] = json!("battery");

    let mut seed: Value = serde_json::from_str(WORLD_SEED).unwrap();
    let second_asset = configured_asset(
        &seed["assets"][0],
        "fixture-vehicle-2",
        1002,
        "fixture.et.100",
        json!(["pzb"]),
        "along",
    );
    seed["assets"].as_array_mut().unwrap().push(second_asset);
    seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
    seed["pathReceipts"][0]["electrifications"] = json!(["unelectrified", "overhead-ac15kv"]);

    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation =
        compile_vehicle_catalog(&source, &seed).expect("gleichartige BEMU-Doppeltraktion");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("BEMU-Receipt bindet beide Eingaben");
    assert!(
        compilation
            .fleet_authority
            .assets
            .iter()
            .all(|asset| asset.technical.traction
                == zugfolge_fleet::release_catalog::VehicleTraction::Battery
                && asset.technical.electric_systems
                    == [zugfolge_fleet::release_catalog::VehiclePowerSystem::Ac15kv])
    );
    let expected = compilation.operational_inventory.formations[0]
        .performance
        .clone();
    assert!(expected.mobile);
    assert_eq!(expected.power_watts, 6_000_000);

    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
            })
            .to_string(),
        )
        .expect("Fleet-Runtime akzeptiert gleichartige BEMU-Doppeltraktion"),
    )
    .expect("Fleet-BEMU-Antwort ist JSON");
    assert_eq!(
        fleet_initialized["snapshot"]["formations"][0]["characteristics"]["traction"],
        "battery"
    );

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-bemu-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational v2 akzeptiert dieselbe BEMU-Doppeltraktion"),
    )
    .expect("Operational-BEMU-Antwort ist JSON");
    assert_eq!(
        operational_initialized["state"]["world"]["vehicleTypes"]["fixture.et.100"]["traction"],
        "battery"
    );
    assert_eq!(
        operational_initialized["state"]["world"]["vehicleTypes"]["fixture.et.100"]["electricSystems"],
        json!(["ac15kv"])
    );
    assert_eq!(
        operational_initialized["state"]["world"]["formations"]["fixture-formation-1"]["performance"],
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn unbespannter_wagenpark_initialisiert_beide_runtimes_ohne_fahrdynamik() {
    let mut source: Value = serde_json::from_str(SOURCE_CATALOG).unwrap();
    let base_type = source["vehicleTypes"][0].clone();
    let coach = configured_type(
        &base_type,
        "fixture.coach.100",
        130,
        "W100",
        "coach",
        json!({"front": false, "rear": false}),
    );
    let control_car = configured_type(
        &base_type,
        "fixture.control.101",
        131,
        "STW101",
        "control-car",
        json!({"front": false, "rear": true}),
    );
    source["vehicleTypes"] = json!([coach, control_car]);

    let mut seed: Value = serde_json::from_str(WORLD_SEED).unwrap();
    let base_asset = seed["assets"][0].clone();
    seed["assets"] = json!([
        configured_asset(
            &base_asset,
            "fixture-coach-100",
            1300,
            "fixture.coach.100",
            json!([]),
            "along",
        ),
        configured_asset(
            &base_asset,
            "fixture-control-101",
            1301,
            "fixture.control.101",
            json!(["pzb"]),
            "along",
        ),
    ]);
    seed["formations"][0]["vehicleIds"] = json!(["fixture-coach-100", "fixture-control-101"]);
    seed["economy"]["operatingCosts"] = json!([
        {"typeId": "fixture.coach.100", "centsPerTrainKm": 100},
        {"typeId": "fixture.control.101", "centsPerTrainKm": 150}
    ]);
    reseal_economy_projection(&mut seed);
    seed["personnelPools"][0]["classDesignations"] = json!(["STW101", "W100"]);
    seed["pathReceipts"][0]["approvedClasses"] = json!(["STW101", "W100"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
    seed["pathReceipts"][0]["electrifications"] = json!(["unelectrified"]);
    seed["pathReceipts"][0]["requiredProtection"] = json!([]);

    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("unbespannter Wagenpark");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("Wagenpark-Receipt bindet beide Eingaben");
    let expected = compilation.operational_inventory.formations[0]
        .performance
        .clone();
    assert!(!expected.mobile);
    assert_eq!(expected.acceleration_mmps2, 0);

    let fleet_formations =
        fleet_initialization_formations(&compilation.operational_inventory.formations);
    assert!(fleet_formations[0].get("dynamics").is_none());
    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_formations,
            })
            .to_string(),
        )
        .expect("Fleet-Runtime akzeptiert Wagenpark ohne Fahrdynamik"),
    )
    .expect("Fleet-Wagenparkantwort ist JSON");
    assert_eq!(
        fleet_initialized["snapshot"]["formations"][0]["characteristics"]["traction"],
        "unpowered"
    );

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-wagenpark-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational v2 akzeptiert denselben Wagenpark"),
    )
    .expect("Operational-Wagenparkantwort ist JSON");
    assert_eq!(
        operational_initialized["state"]["world"]["formations"]["fixture-formation-1"]["performance"],
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn seed_restriktionen_bleiben_vom_compiler_bis_in_beide_runtimes_identisch() {
    let source: VehicleSourceCatalog = serde_json::from_str(SOURCE_CATALOG).unwrap();
    let mut seed: Value = serde_json::from_str(WORLD_SEED).unwrap();
    let mut second = configured_asset(
        &seed["assets"][0],
        "fixture-vehicle-2",
        1002,
        "fixture.et.100",
        json!(["pzb"]),
        "along",
    );
    second["restrictions"] = json!({"immobilized": "immobilized"});
    seed["assets"][0]["restrictions"] = json!({
        "door-failure": {"door-availability-basis-points": 0},
        "emergency-brake": {"emergency-brake": 700},
        "power-derate": {"power-basis-points": 3333},
        "protection-failure": {"protection-unavailable": "pzb"},
        "service-brake": {"service-brake": 600},
        "speed-limit": {"maximum-speed": 30000}
    });
    seed["assets"].as_array_mut().unwrap().push(second);
    seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
    seed["pathReceipts"][0]["requiredProtection"] = json!([]);

    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("Restriktionsprojektion");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("Receipt bindet die Restriktionsprojektion");
    let expected = compilation.operational_inventory.formations[0]
        .performance
        .clone();
    assert!(expected.mobile);
    assert_eq!(expected.power_watts, 999_000);
    assert_eq!(expected.acceleration_mmps2, 833);
    assert_eq!(expected.maximum_speed_mmps, 30_000);
    assert_eq!(expected.service_brake_mmps2, 600);
    assert_eq!(expected.emergency_brake_mmps2, 700);
    assert!(expected.protection_systems.is_empty());
    for (authority, operational) in compilation
        .fleet_authority
        .assets
        .iter()
        .zip(&compilation.operational_inventory.vehicles)
    {
        assert_eq!(authority.restrictions, operational.restrictions);
    }

    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
            })
            .to_string(),
        )
        .expect("Fleet wertet dieselben assetlokalen Restriktionen aus"),
    )
    .unwrap();
    let fleet_formation = &fleet_initialized["snapshot"]["formations"][0];
    assert_eq!(fleet_formation["availability"], "available");
    assert_eq!(fleet_formation["characteristics"]["traction"], "electric");
    assert_eq!(fleet_formation["characteristics"]["maximumSpeedKph"], 108);
    assert_eq!(
        fleet_initialized["state"]["authorityRelease"]["assets"][0]["restrictions"]["power-derate"],
        json!({"power-basis-points": 3333})
    );

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-restrictions-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational wertet dieselben assetlokalen Restriktionen aus"),
    )
    .unwrap();
    assert_eq!(
        operational_initialized["state"]["world"]["formations"]["fixture-formation-1"]["performance"],
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn voll_immobilisierte_powered_formation_bleibt_physisch_aber_nicht_betrieblich_angetrieben() {
    let source: VehicleSourceCatalog = serde_json::from_str(SOURCE_CATALOG).unwrap();
    let mut seed: Value = serde_json::from_str(WORLD_SEED).unwrap();
    let mut second = configured_asset(
        &seed["assets"][0],
        "fixture-vehicle-2",
        1002,
        "fixture.et.100",
        json!(["pzb"]),
        "along",
    );
    second["restrictions"] = json!({"immobilized": "immobilized"});
    seed["assets"][0]["restrictions"] = json!({
        "immobilized": "immobilized",
        "speed-limit": {"maximum-speed": 30000}
    });
    seed["assets"].as_array_mut().unwrap().push(second);
    seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
    seed["pathReceipts"][0]["requiredProtection"] = json!([]);

    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("Immobilized-Projektion");
    let expected = compilation.operational_inventory.formations[0]
        .performance
        .clone();
    assert!(!expected.mobile);
    assert_eq!(expected.power_watts, 0);
    assert_eq!(expected.acceleration_mmps2, 0);
    assert_eq!(expected.maximum_speed_mmps, 30_000);
    assert!(expected.protection_systems.is_empty());
    assert!(
        compilation
            .fleet_authority
            .assets
            .iter()
            .all(|asset| serde_json::to_value(asset.technical.role).unwrap() == "powered-unit")
    );

    let fleet_formations =
        fleet_initialization_formations(&compilation.operational_inventory.formations);
    assert!(fleet_formations[0].get("dynamics").is_none());
    let fleet_initialized: Value = serde_json::from_str(
        &initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": seed.world_id,
                "producedAt": seed.produced_at,
                "authorityRelease": compilation.fleet_authority,
                "formations": fleet_formations,
            })
            .to_string(),
        )
        .expect("Fleet bewahrt die physische Traktion ohne Fahrdynamik"),
    )
    .unwrap();
    let fleet_formation = &fleet_initialized["snapshot"]["formations"][0];
    assert_eq!(fleet_formation["availability"], "maintenance");
    assert_eq!(fleet_formation["characteristics"]["traction"], "electric");
    assert_eq!(fleet_formation["characteristics"]["maximumSpeedKph"], 108);

    let operational_initialized: Value = serde_json::from_str(
        &initialize_operational_simulation(
            &json!({
                "schemaVersion": "zugfolge-operational-simulation-initialize/v2",
                "worldId": seed.world_id,
                "regionId": "region:vehicle-catalog-immobilized-test",
                "nowMs": 0,
                "protectionModeSelectionPolicy": "zugfolge-protection-mode-selection/conservative-v1",
                "infraRelease": operational_infra_release(),
                "vehicleTypes": compilation.operational_inventory.vehicle_types,
                "vehicles": compilation.operational_inventory.vehicles,
                "formations": initialization_formations(
                    &compilation.operational_inventory.formations,
                ),
                "trains": [],
            })
            .to_string(),
        )
        .expect("Operational bewahrt dieselbe nichtmobile Performance"),
    )
    .unwrap();
    assert_eq!(
        operational_initialized["state"]["world"]["formations"]["fixture-formation-1"]["performance"],
        serde_json::to_value(expected).unwrap()
    );
}
