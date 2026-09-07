//! Integrationsbeweise fuer den strikten Fahrzeugkatalog-Compiler.

use std::fs;
use std::process::Command;

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_fleet::release_catalog::{
    COMPILE_RECEIPT_SCHEMA, COMPILER_VERSION, EvidenceKind, FLEET_AUTHORITY_CATALOG_SCHEMA,
    FLEET_AUTHORITY_SCHEMA, OPERATIONAL_INVENTORY_SCHEMA, VehicleCatalogCompilation,
    VehicleEconomyProjection, VehicleSourceCatalog, VehicleWorldSeed, compile_vehicle_catalog,
    parse_source_catalog, parse_world_seed, recompute_economy_release_checksum,
    recompute_vehicle_economy_projection_sha256, to_pretty_json, validate_compilation,
    validate_compilation_against_inputs,
};

const SOURCE: &str = include_str!("fixtures/vehicle-catalog-source-v2.json");
const SEED: &str = include_str!("fixtures/vehicle-world-seed-v3.json");
const DEPLOYABLE_AUTHORITY_CATALOG: &str =
    include_str!("fixtures/fleet-authority-release-catalog-v1.json");

fn inputs() -> (VehicleSourceCatalog, VehicleWorldSeed) {
    (
        parse_source_catalog(SOURCE).expect("fiktiver Quellkatalog"),
        parse_world_seed(SEED).expect("fiktiver Welt-Seed"),
    )
}

fn source_value() -> Value {
    serde_json::from_str(SOURCE).expect("Source-JSON")
}

fn seed_value() -> Value {
    serde_json::from_str(SEED).expect("Seed-JSON")
}

fn reseal_economy_projection(seed: &mut Value) {
    let mut projection: VehicleEconomyProjection =
        serde_json::from_value(seed["economy"].clone()).expect("Economy-Projektion");
    projection.projection_sha256 =
        recompute_vehicle_economy_projection_sha256(&projection).expect("Projektions-Hash");
    seed["economy"] = serde_json::to_value(projection).expect("Economy-Projektions-JSON");
}

fn compile_values(source: Value, seed: Value) -> Result<(), String> {
    let source: VehicleSourceCatalog = serde_json::from_value(source).map_err(|e| e.to_string())?;
    let seed: VehicleWorldSeed = serde_json::from_value(seed).map_err(|e| e.to_string())?;
    compile_vehicle_catalog(&source, &seed)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn pretty_json_sha256<T: Serialize>(value: &T) -> String {
    let mut json = serde_json::to_string_pretty(value).expect("serialisierbarer Testwert");
    json.push('\n');
    sha256(json.as_bytes())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestOutputSetHash<'a> {
    schema_version: &'a str,
    compiler_version: &'a str,
    source_catalog_release_id: &'a str,
    world_seed_id: &'a str,
    world_id: &'a str,
    produced_at: u64,
    economy_release_id: &'a str,
    source_catalog_sha256: &'a str,
    world_seed_sha256: &'a str,
    economy_release_sha256: &'a str,
    economy_projection_sha256: &'a str,
    compiled_catalog_sha256: &'a str,
    fleet_authority_sha256: &'a str,
    fleet_authority_catalog_sha256: &'a str,
    operational_inventory_sha256: &'a str,
}

fn reseal_compilation(compilation: &mut VehicleCatalogCompilation) {
    let [entry] = compilation.fleet_authority_catalog.entries.as_mut_slice() else {
        panic!("Test-Kompilierung besitzt genau einen Authority-Katalogeintrag");
    };
    entry.world_id.clone_from(&compilation.receipt.world_id);
    entry.produced_at = compilation.receipt.produced_at;
    entry
        .authority_release
        .clone_from(&compilation.fleet_authority);
    reseal_output_hashes(compilation);
}

fn reseal_output_hashes(compilation: &mut VehicleCatalogCompilation) {
    let catalog_hash = pretty_json_sha256(&compilation.catalog);
    let authority_hash = pretty_json_sha256(&compilation.fleet_authority);
    let authority_catalog_hash = pretty_json_sha256(&compilation.fleet_authority_catalog);
    let operational_hash = pretty_json_sha256(&compilation.operational_inventory);
    compilation.receipt.compiled_catalog_sha256 = catalog_hash;
    compilation.receipt.fleet_authority_sha256 = authority_hash;
    compilation.receipt.fleet_authority_catalog_sha256 = authority_catalog_hash;
    compilation.receipt.operational_inventory_sha256 = operational_hash;
    compilation.receipt.output_set_sha256 = pretty_json_sha256(&TestOutputSetHash {
        schema_version: COMPILE_RECEIPT_SCHEMA,
        compiler_version: COMPILER_VERSION,
        source_catalog_release_id: &compilation.receipt.source_catalog_release_id,
        world_seed_id: &compilation.receipt.world_seed_id,
        world_id: &compilation.receipt.world_id,
        produced_at: compilation.receipt.produced_at,
        economy_release_id: &compilation.receipt.economy_release_id,
        source_catalog_sha256: &compilation.receipt.source_catalog_sha256,
        world_seed_sha256: &compilation.receipt.world_seed_sha256,
        economy_release_sha256: &compilation.receipt.economy_release_sha256,
        economy_projection_sha256: &compilation.receipt.economy_projection_sha256,
        compiled_catalog_sha256: &compilation.receipt.compiled_catalog_sha256,
        fleet_authority_sha256: &compilation.receipt.fleet_authority_sha256,
        fleet_authority_catalog_sha256: &compilation.receipt.fleet_authority_catalog_sha256,
        operational_inventory_sha256: &compilation.receipt.operational_inventory_sha256,
    });
}

#[test]
fn neuversiegelte_m5_konfiguration_bleibt_an_katalogfakten_und_welt_seed_gebunden() {
    let source = parse_source_catalog(include_str!(
        "fixtures/vehicle-catalog-source-v2-interior.json"
    ))
    .unwrap();
    let seed =
        parse_world_seed(include_str!("fixtures/vehicle-world-seed-v3-interior.json")).unwrap();
    let original = compile_vehicle_catalog(&source, &seed).unwrap();
    let mut wrong_length = original.clone();
    wrong_length.fleet_authority.assets[0]
        .vehicle_configuration
        .as_mut()
        .unwrap()
        .structural
        .body_length_mm += 1;
    reseal_compilation(&mut wrong_length);
    assert!(
        validate_compilation(&wrong_length)
            .unwrap_err()
            .to_string()
            .contains("LengthMismatch")
    );
    let mut other_interior = original;
    other_interior.fleet_authority.assets[0]
        .vehicle_configuration
        .as_mut()
        .unwrap()
        .interior
        .toilets += 1;
    reseal_compilation(&mut other_interior);
    // Die Fachwerte können in sich gültig sein; ihr echter Seed bleibt dennoch nötig.
    validate_compilation(&other_interior).unwrap();
    assert!(validate_compilation_against_inputs(&source, &seed, &other_interior).is_err());
}

fn configured_type(
    base: &Value,
    type_id: &str,
    numeric_id: u64,
    class_designation: &str,
    role: &str,
    control_stands: Value,
    seats: u32,
) -> Value {
    let mut vehicle_type = base.clone();
    vehicle_type["typeId"] = json!(type_id);
    vehicle_type["numericId"] = json!(numeric_id);
    vehicle_type["classDesignation"]["value"] = json!(class_designation);
    vehicle_type["tradeName"]["value"] = json!(format!("Test-{class_designation}"));
    vehicle_type["role"]["value"] = json!(role);
    vehicle_type["controlStands"]["value"] = control_stands;
    vehicle_type["passenger"]["seats"]["value"] = json!(seats);
    vehicle_type["passenger"]["firstClassSeats"]["value"] = json!(seats.min(8));
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

#[test]
fn fixture_kompiliert_beide_runtime_projektionen_und_receipt() {
    let (source, seed) = inputs();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("gueltige Kompilierung");
    assert_eq!(
        compilation.fleet_authority.schema_version,
        FLEET_AUTHORITY_SCHEMA
    );
    assert_eq!(
        compilation.operational_inventory.schema_version,
        OPERATIONAL_INVENTORY_SCHEMA
    );
    assert_eq!(
        compilation.fleet_authority_catalog.schema_version,
        FLEET_AUTHORITY_CATALOG_SCHEMA
    );
    let [catalog_entry] = compilation.fleet_authority_catalog.entries.as_slice() else {
        panic!("Compiler erzeugt genau einen deploybaren Welteintrag");
    };
    assert_eq!(catalog_entry.world_id, seed.world_id);
    assert_eq!(catalog_entry.produced_at, seed.produced_at);
    assert_eq!(compilation.receipt.produced_at, seed.produced_at);
    assert_eq!(catalog_entry.authority_release, compilation.fleet_authority);
    assert_eq!(
        to_pretty_json(&compilation.fleet_authority_catalog).unwrap(),
        DEPLOYABLE_AUTHORITY_CATALOG,
        "Game-API-Fixture bleibt bytegleich zur echten Compiler-Serialisierung"
    );
    assert_eq!(
        compilation.receipt.economy_release_sha256,
        seed.economy.release.checksum
    );
    assert_eq!(
        recompute_economy_release_checksum(&seed.economy.release).unwrap(),
        "35b5199c3949ec7af65762f38184462d23fc23c584aaf5f02e35da44ae9e9857"
    );
    assert_eq!(
        compilation.receipt.economy_projection_sha256,
        recompute_vehicle_economy_projection_sha256(&seed.economy).unwrap()
    );
    assert_eq!(
        compilation.fleet_authority.assets[0]
            .technical
            .acceleration_mm_per_s2,
        1_000,
        "powered-unit uebernimmt sein belegtes Typfahrprofil"
    );
    assert_eq!(
        compilation.fleet_authority.assets[0]
            .technical
            .deceleration_mm_per_s2,
        900
    );
    assert_eq!(
        compilation.operational_inventory.vehicle_types[0]
            .vehicle_type
            .maximum_speed_mmps,
        44_444,
        "160 km/h wird sicherheitsgerichtet abgerundet"
    );
    assert_eq!(
        serde_json::to_value(
            compilation.operational_inventory.vehicle_types[0]
                .vehicle_type
                .traction
        )
        .unwrap(),
        json!("electric")
    );
    assert_eq!(
        serde_json::to_value(
            &compilation.operational_inventory.vehicle_types[0]
                .vehicle_type
                .electric_systems
        )
        .unwrap(),
        json!(["ac15kv"])
    );
    assert_eq!(
        compilation.operational_inventory.vehicles[0].restrictions["catalog-protection-unavailable:lzb"],
        zugfolge_sim::operational::VehicleRestriction::ProtectionUnavailable("lzb".to_owned())
    );
    assert_eq!(
        compilation.fleet_authority.assets[0].restrictions,
        compilation.operational_inventory.vehicles[0].restrictions,
        "Authority und Operational muessen dieselbe effektive Restriktionsmap binden"
    );
    assert_eq!(
        compilation.fleet_authority.assets[0].condition,
        seed.assets[0].condition
    );
    assert_eq!(
        compilation.fleet_authority.assets[0].history,
        seed.assets[0].history
    );
    assert_eq!(
        compilation.fleet_authority.assets[0].condition,
        compilation.operational_inventory.vehicles[0].condition
    );
    assert_eq!(
        compilation.fleet_authority.assets[0].history,
        compilation.operational_inventory.vehicles[0].history
    );
    validate_compilation(&compilation).expect("Ausgaben sind kreuzvalidiert");
    validate_compilation_against_inputs(&source, &seed, &compilation)
        .expect("Receipt bindet beide Eingaben");
}

#[test]
fn world_seed_muss_loaderkompatible_kanonische_uuid_besitzen() {
    for invalid_world_id in [
        "fixture-world",
        "00000000-0000-4000-8000-00000000038",
        "00000000-0000-4000-8000-00000000038G",
        "00000000-0000-4000-8000-000000000ABC",
    ] {
        let mut seed = seed_value();
        seed["worldId"] = json!(invalid_world_id);
        let error = compile_values(source_value(), seed).unwrap_err();
        assert!(error.contains("kleingeschriebene kanonische UUID"));
    }
}

#[test]
fn lokomotive_behaelt_formationsabhaengiges_fleet_profil_bei_null() {
    let mut source = source_value();
    source["vehicleTypes"][0]["role"]["value"] = json!("locomotive");
    source["vehicleTypes"][0]["passenger"]["seats"]["value"] = json!(0);
    source["vehicleTypes"][0]["passenger"]["firstClassSeats"]["value"] = json!(0);
    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed_value()).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("gueltige Lokomotive");
    assert_eq!(
        compilation.fleet_authority.assets[0]
            .technical
            .acceleration_mm_per_s2,
        0
    );
    assert_eq!(
        compilation.fleet_authority.assets[0]
            .technical
            .deceleration_mm_per_s2,
        0
    );
}

#[test]
fn normalisierung_macht_reihenfolge_hashstabil() {
    let (source, seed) = inputs();
    let first = compile_vehicle_catalog(&source, &seed).unwrap();
    let mut reordered = source_value();
    reordered["vehicleTypes"][0]["passenger"]["equipment"]["value"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let reordered: VehicleSourceCatalog = serde_json::from_value(reordered).unwrap();
    let second = compile_vehicle_catalog(&reordered, &seed).unwrap();
    assert_eq!(first, second);

    let mut reordered_seed = seed_value();
    reordered_seed["economy"]["release"]["tenderProfiles"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let reordered_seed: VehicleWorldSeed = serde_json::from_value(reordered_seed).unwrap();
    let third = compile_vehicle_catalog(&source, &reordered_seed).unwrap();
    assert_eq!(first, third);
}

#[test]
fn unbekannte_felder_werden_in_beiden_eingaben_abgewiesen() {
    let mut source = source_value();
    source["vehicleTypes"][0]["technical"]["unknownUnit"] = json!(1);
    assert!(serde_json::from_value::<VehicleSourceCatalog>(source).is_err());

    let mut seed = seed_value();
    seed["assets"][0]["browserOwned"] = json!(true);
    assert!(serde_json::from_value::<VehicleWorldSeed>(seed).is_err());
}

#[test]
fn rechte_quellen_und_evidenz_schliessen_fail_closed() {
    let mut source = source_value();
    source["sources"][0]["rightsDecision"]["status"] = json!("pruefung");
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("nicht freigegeben")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["classDesignation"]["sourceIds"] = json!([]);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("keinen Quellenbeleg")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["tradeName"]["sourceIds"] = json!(["fixture-manufacturer-sheet"]);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Spielannahme")
    );

    let mut source = source_value();
    let mut unused = source["sources"][0].clone();
    unused["id"] = json!("unused-source");
    source["sources"].as_array_mut().unwrap().push(unused);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("ungenutzte")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["classDesignation"]["sourceIds"] = json!(["unknown-source"]);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("unbekannte Quelle")
    );

    let mut source = source_value();
    source["sources"][0]["contentSha256"] = json!("ABC");
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("SHA-256")
    );

    let mut source = source_value();
    source["sources"][0]["retrievedAt"] = json!("2026-02-30");
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Kalenderdatum")
    );
}

#[test]
fn nicht_registrierte_deterministische_ableitung_wird_abgewiesen() {
    let mut source = source_value();
    source["vehicleTypes"][0]["technical"]["lengthMm"]["kind"] = json!("deterministic-derivation");
    source["vehicleTypes"][0]["technical"]["lengthMm"]["method"] =
        json!("frei behauptete Multiplikation ohne Compilerregistrierung");

    let error = compile_values(source, seed_value()).unwrap_err();
    assert!(error.contains("nicht registrierte deterministische Ableitung"));

    let (source, seed) = inputs();
    let mut compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    let evidence = compilation.catalog.vehicle_types[0]
        .evidence
        .values_mut()
        .find(|evidence| evidence.kind == EvidenceKind::PublishedFact)
        .expect("Fixture besitzt publizierten Feldbeleg");
    evidence.kind = EvidenceKind::DeterministicDerivation;
    evidence.method = "nachtraeglich behauptete Ausgabeableitung".to_owned();
    reseal_compilation(&mut compilation);
    let error = validate_compilation(&compilation).unwrap_err().to_string();
    assert!(error.contains("nicht registrierte deterministische Ableitung"));
}

#[test]
fn e6_erlaubt_keine_reale_marke_als_trade_name_fakt() {
    let mut source = source_value();
    source["vehicleTypes"][0]["tradeName"]["kind"] = json!("published-fact");
    source["vehicleTypes"][0]["tradeName"]["sourceIds"] = json!(["fixture-manufacturer-sheet"]);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("gemaess E6")
    );
}

#[test]
fn einheiten_rollen_und_zugsicherung_sind_harte_invarianten() {
    let mut source = source_value();
    source["vehicleTypes"][0]["classDesignation"]["value"] = json!("Fixture ET 100");
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("classDesignation")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["technical"]["lengthMm"]["value"] = json!(70);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("lengthMm")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["role"]["value"] = json!("coach");
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Rolle und Traktionsart")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["standardProtection"]["value"] = json!(["lzb"]);
    source["vehicleTypes"][0]["protectionOptions"] = json!([]);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("LZB erfordert PZB")
    );
}

#[test]
fn basispunkte_oberhalb_zehntausend_werden_abgewiesen() {
    let mut seed = seed_value();
    seed["assets"][0]["condition"]["driveBasisPoints"] = json!(10_001);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("10000 Basispunkte")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["massKg"]["confidenceBasisPoints"] = json!(10_001);
    // Der absichtlich falsche Pfad bleibt unbekannt und wird schon durch das
    // strikte Schema abgefangen; die echte Evidenzgrenze folgt separat.
    assert!(compile_values(source, seed_value()).is_err());

    let mut source = source_value();
    source["vehicleTypes"][0]["technical"]["massKg"]["confidenceBasisPoints"] = json!(10_001);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("zwischen 1 und 10000")
    );

    let mut seed = seed_value();
    seed["assets"][0]["restrictions"] = json!({"power-damage": {"power-basis-points": 10_001}});
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("1..=10000")
    );
}

#[test]
fn trassenbeleg_verlangt_alle_linien_und_elektrifizierungen() {
    let mut seed = seed_value();
    seed["pathReceipts"][0]["serviceLineIds"] = json!(["fixture-line-1", "fixture-line-2"]);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("nicht fuer alle Linien")
    );

    let mut seed = seed_value();
    seed["pathReceipts"][0]["electrifications"] = json!(["overhead-ac15kv", "overhead-ac25kv"]);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("nicht alle Elektrifizierungen")
    );

    let mut seed = seed_value();
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([9_007_199_254_740_992_i64]);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("sicheren JSON-Ganzzahlbereich")
    );
}

#[test]
fn formationen_mischen_keine_fleet_inkompatiblen_antriebe_oder_stromsystemmengen() {
    let incompatible_pair = |second_traction: &str, second_systems: Value| {
        let mut source = source_value();
        let base_type = source["vehicleTypes"][0].clone();
        let mut second_type = configured_type(
            &base_type,
            "fixture.et.101",
            101,
            "ET101",
            "powered-unit",
            json!({"front": true, "rear": true}),
            180,
        );
        second_type["traction"]["value"] = json!(second_traction);
        second_type["electricSystems"]["value"] = second_systems;
        source["vehicleTypes"]
            .as_array_mut()
            .unwrap()
            .push(second_type);

        let mut seed = seed_value();
        let second_asset = configured_asset(
            &seed["assets"][0],
            "fixture-vehicle-2",
            1002,
            "fixture.et.101",
            json!(["pzb"]),
            "along",
        );
        seed["assets"].as_array_mut().unwrap().push(second_asset);
        seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
        seed["economy"]["operatingCosts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"typeId": "fixture.et.101", "centsPerTrainKm": 450}));
        reseal_economy_projection(&mut seed);
        seed["personnelPools"][0]["classDesignations"] = json!(["ET100", "ET101"]);
        seed["pathReceipts"][0]["approvedClasses"] = json!(["ET100", "ET101"]);
        seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);

        compile_values(source, seed).expect_err("Fleet-inkompatible Formation muss scheitern")
    };

    let mixed_traction = incompatible_pair("diesel", json!([]));
    assert!(mixed_traction.contains("unterschiedlicher Traktion oder Stromsystemmenge"));

    let different_electric_systems = incompatible_pair("electric", json!(["ac15kv", "ac25kv"]));
    assert!(
        different_electric_systems.contains("unterschiedlicher Traktion oder Stromsystemmenge")
    );
}

#[test]
fn formationen_qualifizieren_fleet_passagier_und_kostensummen_vor() {
    let paired_seed = || {
        let mut seed = seed_value();
        let mut second_asset = seed["assets"][0].clone();
        second_asset["id"] = json!("fixture-vehicle-2");
        second_asset["numericId"] = json!(1002);
        seed["assets"].as_array_mut().unwrap().push(second_asset);
        seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
        seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
        seed
    };

    for (field, value, expected) in [
        ("seats", json!(u32::MAX), "Fleet-Sitzplatzsumme"),
        ("bicyclePlaces", json!(u16::MAX), "Fleet-Fahrradplatzsumme"),
        (
            "wheelchairPlaces",
            json!(u16::MAX),
            "Fleet-Rollstuhlplatzsumme",
        ),
    ] {
        let mut source = source_value();
        source["vehicleTypes"][0]["passenger"][field]["value"] = value;
        let error = compile_values(source, paired_seed())
            .expect_err("Fleet-Passagiersumme darf nicht ueberlaufen");
        assert!(error.contains(expected), "unerwarteter Fehler: {error}");
    }

    let mut cost_seed = paired_seed();
    cost_seed["economy"]["operatingCosts"][0]["centsPerTrainKm"] = json!(u32::MAX);
    reseal_economy_projection(&mut cost_seed);
    let error = compile_values(source_value(), cost_seed)
        .expect_err("Fleet-Betriebskostensumme darf nicht ueberlaufen");
    assert!(
        error.contains("Fleet-Betriebskostensumme"),
        "unerwarteter Fehler: {error}"
    );
}

#[test]
fn markt_und_optionsfenster_binden_konkrete_assets() {
    let mut seed = seed_value();
    seed["assets"][0]["installedProtection"] = json!(["pzb", "lzb"]);
    let source: VehicleSourceCatalog = serde_json::from_value(source_value()).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("gueltige Werksoption");
    assert!(
        !compilation.operational_inventory.vehicles[0]
            .restrictions
            .contains_key("catalog-protection-unavailable:lzb")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["protectionOptions"][0]["years"] = json!({"from": 2020, "to": 2022});
    let mut seed = seed_value();
    seed["assets"][0]["installedProtection"] = json!(["pzb", "lzb"]);
    assert!(
        compile_values(source, seed)
            .unwrap_err()
            .contains("nicht freigegebene")
    );
}

#[test]
fn neubau_werksoption_und_referenzjahr_sind_begrenzt() {
    let mut source = source_value();
    source["vehicleTypes"][0]["markets"]["newBuild"]["value"]["to"] = json!(2027);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("new-build")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["protectionOptions"][0]["years"]["to"] = json!(2027);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("factory-option")
    );

    let mut seed = seed_value();
    seed["assets"][0]["acquisitionYear"] = json!(2027);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("Referenzjahr")
    );
}

#[test]
fn manipulierte_ausgaben_brechen_receipt_validierung() {
    let (source, seed) = inputs();
    let mut compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    compilation.fleet_authority.assets[0].passenger.seats = 999;
    assert!(
        validate_compilation(&compilation)
            .unwrap_err()
            .to_string()
            .contains("bindet nicht exakt Welt und Einzel-Authority")
    );
}

#[test]
fn neuversiegelter_wrapper_darf_weder_welt_noch_authority_austauschen() {
    let (source, seed) = inputs();
    let mut wrong_world = compile_vehicle_catalog(&source, &seed).unwrap();
    wrong_world.fleet_authority_catalog.entries[0].world_id =
        "00000000-0000-4000-8000-000000000999".to_owned();
    reseal_output_hashes(&mut wrong_world);
    assert!(
        validate_compilation(&wrong_world)
            .unwrap_err()
            .to_string()
            .contains("bindet nicht exakt Welt und Einzel-Authority")
    );

    let mut wrong_authority = compile_vehicle_catalog(&source, &seed).unwrap();
    wrong_authority.fleet_authority_catalog.entries[0]
        .authority_release
        .release_id = "ausgetauschte-authority".to_owned();
    reseal_output_hashes(&mut wrong_authority);
    assert!(
        validate_compilation(&wrong_authority)
            .unwrap_err()
            .to_string()
            .contains("bindet nicht exakt Welt und Einzel-Authority")
    );

    let mut wrong_time = compile_vehicle_catalog(&source, &seed).unwrap();
    wrong_time.fleet_authority_catalog.entries[0].produced_at = 0;
    reseal_output_hashes(&mut wrong_time);
    assert!(
        validate_compilation(&wrong_time)
            .unwrap_err()
            .to_string()
            .contains("bindet nicht exakt Welt und Einzel-Authority")
    );
}

#[test]
fn receipt_v4_verlangt_den_wrapper_hash_ohne_stille_v3_erweiterung() {
    let (source, seed) = inputs();
    let compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    let mut missing_hash = serde_json::to_value(&compilation).unwrap();
    missing_hash["receipt"]
        .as_object_mut()
        .unwrap()
        .remove("fleetAuthorityCatalogSha256");
    assert!(serde_json::from_value::<VehicleCatalogCompilation>(missing_hash).is_err());

    let mut legacy_schema = compilation;
    legacy_schema.receipt.schema_version = "zugfolge-vehicle-catalog-compile-receipt/v3".to_owned();
    let error = validate_compilation(&legacy_schema)
        .unwrap_err()
        .to_string();
    assert!(error.contains("compile-receipt/v4"));
}

#[test]
fn neuversiegelte_authority_darf_operational_restriktionen_nicht_verlieren() {
    let (source, seed) = inputs();
    let mut compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    compilation.fleet_authority.assets[0]
        .restrictions
        .remove("catalog-protection-unavailable:lzb");
    reseal_compilation(&mut compilation);
    let error = validate_compilation(&compilation).unwrap_err().to_string();
    assert!(error.contains("weicht von Fleet Authority ab"));
}

#[test]
fn assetzustand_und_lebenslauf_bleiben_zwischen_beiden_projektionen_identisch() {
    let source: VehicleSourceCatalog = serde_json::from_value(source_value()).unwrap();
    let mut seed = seed_value();
    seed["assets"][0]["condition"]["driveBasisPoints"] = json!(9_321);
    seed["assets"][0]["condition"]["kilometresSinceMaintenance"] = json!(123_456);
    seed["assets"][0]["history"] = json!(["entered-world", "condition-recorded"]);
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("Zustandsprojektionen");
    let authority = &compilation.fleet_authority.assets[0];
    let operational = &compilation.operational_inventory.vehicles[0];
    assert_eq!(authority.condition, operational.condition);
    assert_eq!(authority.history, operational.history);
    assert_eq!(authority.condition, seed.assets[0].condition);
    assert_eq!(authority.history, seed.assets[0].history);

    let mut condition_tampered = compilation.clone();
    condition_tampered.fleet_authority.assets[0]
        .condition
        .drive_basis_points = 9_000;
    reseal_compilation(&mut condition_tampered);
    assert!(
        validate_compilation(&condition_tampered)
            .unwrap_err()
            .to_string()
            .contains("weicht von Fleet Authority ab")
    );

    let mut history_tampered = compilation;
    history_tampered.fleet_authority.assets[0]
        .history
        .push("silent-rewrite".to_owned());
    reseal_compilation(&mut history_tampered);
    assert!(
        validate_compilation(&history_tampered)
            .unwrap_err()
            .to_string()
            .contains("weicht von Fleet Authority ab")
    );
}

#[test]
fn unformierte_assets_und_reiner_markt_seed_bleiben_gueltig() {
    let (source, mut seed) = inputs();
    let mut parked = seed.assets[0].clone();
    parked.id = "fixture-vehicle-parked".to_owned();
    parked.numeric_id = 1002;
    seed.assets.push(parked);

    let compilation = compile_vehicle_catalog(&source, &seed).expect("abgestelltes Asset");
    assert_eq!(compilation.fleet_authority.assets.len(), 2);
    assert_eq!(compilation.operational_inventory.vehicles.len(), 2);
    assert_eq!(compilation.operational_inventory.formations.len(), 1);
    assert!(
        compilation
            .operational_inventory
            .vehicles
            .iter()
            .any(|vehicle| vehicle.id == "fixture-vehicle-parked")
    );
    validate_compilation(&compilation).expect("unformierte Assets sind absichtlich zulaessig");

    seed.formations.clear();
    seed.personnel_pools.clear();
    seed.path_receipts.clear();
    let market_only = compile_vehicle_catalog(&source, &seed).expect("reiner Marktbestand");
    assert!(market_only.operational_inventory.formations.is_empty());
    assert!(market_only.fleet_authority.personnel_pools.is_empty());
    assert!(market_only.fleet_authority.path_receipts.is_empty());
    validate_compilation_against_inputs(&source, &seed, &market_only)
        .expect("Markt-Seed bindet alle Assets und Eingaben");
}

#[test]
fn unbespannter_wagenpark_ist_gueltig_aber_nicht_mobil() {
    let mut source = source_value();
    let base = source["vehicleTypes"][0].clone();
    source["vehicleTypes"] = json!([configured_type(
        &base,
        "fixture.coach.100",
        110,
        "W100",
        "coach",
        json!({"front": false, "rear": false}),
        80,
    )]);
    let mut seed = seed_value();
    seed["assets"][0]["typeId"] = json!("fixture.coach.100");
    seed["assets"][0]["installedProtection"] = json!([]);
    seed["economy"]["operatingCosts"][0]["typeId"] = json!("fixture.coach.100");
    reseal_economy_projection(&mut seed);
    seed["personnelPools"][0]["classDesignations"] = json!(["W100"]);
    seed["pathReceipts"][0]["approvedClasses"] = json!(["W100"]);
    seed["pathReceipts"][0]["requiredProtection"] = json!([]);
    seed["pathReceipts"][0]["electrifications"] = json!(["unelectrified"]);

    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("unbespannter Wagenpark");
    let performance = &compilation.operational_inventory.formations[0].performance;
    assert!(!performance.mobile);
    assert_eq!(performance.power_watts, 0);
    assert_eq!(performance.acceleration_mmps2, 0);
    assert!(!performance.front_control_stand_available);
    assert!(!performance.rear_control_stand_available);
}

#[test]
fn fahrzeugeinschraenkungen_werden_assetlokal_und_reihenfolgeunabhaengig_aggregiert() {
    let source: VehicleSourceCatalog = serde_json::from_value(source_value()).unwrap();
    let mut seed = seed_value();
    let mut second = seed["assets"][0].clone();
    second["id"] = json!("fixture-vehicle-2");
    second["numericId"] = json!(1002);
    second["restrictions"] = json!({
        "third-power": {"power-basis-points": 3333}
    });
    seed["assets"].as_array_mut().unwrap().push(second);
    seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-1", "fixture-vehicle-2"]);
    seed["pathReceipts"][0]["platformLengthsMm"] = json!([200_000]);
    let first_seed: VehicleWorldSeed = serde_json::from_value(seed.clone()).unwrap();
    let first = compile_vehicle_catalog(&source, &first_seed).unwrap();

    seed["formations"][0]["vehicleIds"] = json!(["fixture-vehicle-2", "fixture-vehicle-1"]);
    let second_seed: VehicleWorldSeed = serde_json::from_value(seed.clone()).unwrap();
    let second = compile_vehicle_catalog(&source, &second_seed).unwrap();

    assert_eq!(
        first.operational_inventory.formations[0].performance,
        second.operational_inventory.formations[0].performance
    );
    assert_eq!(
        first.operational_inventory.formations[0]
            .performance
            .power_watts,
        3_999_000
    );
    assert_eq!(
        first.fleet_authority.assets[1].restrictions,
        first.operational_inventory.vehicles[1].restrictions
    );

    seed["assets"][0]["restrictions"] = json!({"immobilized": "immobilized"});
    let one_drive_seed: VehicleWorldSeed = serde_json::from_value(seed.clone()).unwrap();
    let one_drive = compile_vehicle_catalog(&source, &one_drive_seed).unwrap();
    let one_drive_performance = &one_drive.operational_inventory.formations[0].performance;
    assert!(one_drive_performance.mobile);
    assert_eq!(one_drive_performance.power_watts, 999_000);
    assert_eq!(one_drive_performance.acceleration_mmps2, 833);

    seed["assets"][1]["restrictions"] = json!({"immobilized": "immobilized"});
    let no_drive_seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let no_drive = compile_vehicle_catalog(&source, &no_drive_seed).unwrap();
    let no_drive_performance = &no_drive.operational_inventory.formations[0].performance;
    assert!(!no_drive_performance.mobile);
    assert_eq!(no_drive_performance.power_watts, 0);
    assert_eq!(no_drive_performance.acceleration_mmps2, 0);
}

#[test]
fn auf_null_gerasterte_restleistung_ist_keine_nutzbare_traktion() {
    let mut source = source_value();
    source["vehicleTypes"][0]["technical"]["continuousPowerKw"]["value"] = json!(1);
    let mut seed = seed_value();
    seed["assets"][0]["restrictions"] = json!({"near-total-power-loss": {"power-basis-points": 1}});
    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation =
        compile_vehicle_catalog(&source, &seed).expect("1 kW mit einem Basispunkt kompiliert");
    let performance = &compilation.operational_inventory.formations[0].performance;
    assert_eq!(performance.power_watts, 0);
    assert_eq!(performance.acceleration_mmps2, 0);
    assert!(!performance.mobile);
}

#[test]
fn steuerwagen_an_der_zugspitze_liefert_fuehrerstand_und_zugsicherung() {
    let mut source = source_value();
    let base = source["vehicleTypes"][0].clone();
    let locomotive = configured_type(
        &base,
        "fixture.loco.100",
        120,
        "L100",
        "locomotive",
        json!({"front": true, "rear": true}),
        0,
    );
    let coach = configured_type(
        &base,
        "fixture.coach.101",
        121,
        "W101",
        "coach",
        json!({"front": false, "rear": false}),
        80,
    );
    let mut control_car = configured_type(
        &base,
        "fixture.control.102",
        122,
        "STW102",
        "control-car",
        json!({"front": false, "rear": true}),
        60,
    );
    control_car["standardProtection"]["value"] = json!(["etcs-level2"]);
    control_car["protectionOptions"] = json!([]);
    source["vehicleTypes"] = json!([locomotive, coach, control_car]);

    let mut seed = seed_value();
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
    let compilation = compile_vehicle_catalog(&source, &seed).expect("Wendezugverband");
    let performance = &compilation.operational_inventory.formations[0].performance;
    assert!(performance.mobile);
    assert!(performance.front_control_stand_available);
    assert!(performance.rear_control_stand_available);
    assert_eq!(
        performance.protection_systems,
        ["etcs-level2".to_owned()].into()
    );
    assert!(
        compilation
            .operational_inventory
            .vehicle_types
            .iter()
            .all(|kind| kind.vehicle_type.role.is_some()
                && kind.vehicle_type.control_stands.is_some())
    );

    let mut no_head_cab = seed.clone();
    no_head_cab.formations[0].vehicle_ids = vec![
        "fixture-coach-101".to_owned(),
        "fixture-loco-100".to_owned(),
    ];
    assert!(
        compile_vehicle_catalog(&source, &no_head_cab)
            .unwrap_err()
            .to_string()
            .contains("keinen nutzbaren Fuehrerstand")
    );

    let mut wagon_stock = seed.clone();
    wagon_stock.formations[0].vehicle_ids = vec![
        "fixture-coach-101".to_owned(),
        "fixture-control-102".to_owned(),
    ];
    wagon_stock
        .assets
        .iter_mut()
        .find(|asset| asset.id == "fixture-control-102")
        .unwrap()
        .orientation = zugfolge_sim::operational::Direction::Along;
    wagon_stock.path_receipts[0].required_protection.clear();
    let wagon_stock = compile_vehicle_catalog(&source, &wagon_stock).expect("Steuerwagenpark");
    let wagon_performance = &wagon_stock.operational_inventory.formations[0].performance;
    assert!(!wagon_performance.mobile);
    assert!(!wagon_performance.front_control_stand_available);
    assert!(wagon_performance.rear_control_stand_available);
}

#[test]
fn batterie_oberleitungs_hybrid_behaelt_beide_betriebsmodi() {
    let mut source = source_value();
    source["vehicleTypes"][0]["traction"]["value"] = json!("battery");
    let mut seed = seed_value();
    seed["pathReceipts"][0]["electrifications"] = json!(["unelectrified", "overhead-ac15kv"]);
    let source: VehicleSourceCatalog = serde_json::from_value(source).unwrap();
    let seed: VehicleWorldSeed = serde_json::from_value(seed).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).expect("BEMU auf Mischlaufweg");
    let technical = &compilation.fleet_authority.assets[0].technical;
    assert_eq!(
        serde_json::to_value(technical.traction).unwrap(),
        json!("battery")
    );
    assert_eq!(
        serde_json::to_value(&technical.electric_systems).unwrap(),
        json!(["ac15kv"])
    );
}

#[test]
fn plausibilitaetsgrenzen_und_sichere_json_zaehler_schliessen_fail_closed() {
    for (path, value, expected) in [
        ("continuousPowerKw", 100_001_u64, "continuousPowerKw"),
        (
            "startingTractiveEffortKn",
            5_001_u64,
            "startingTractiveEffortKn",
        ),
    ] {
        let mut source = source_value();
        source["vehicleTypes"][0]["technical"][path]["value"] = json!(value);
        assert!(
            compile_values(source, seed_value())
                .unwrap_err()
                .contains(expected)
        );
    }

    let mut source = source_value();
    source["vehicleTypes"][0]["operationalProfile"]["maximumAccelerationCapMmps2"]["value"] =
        json!(10_001);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Operational-Profilparameter")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["operationalProfile"]["serviceBrakeCapMmps2"]["value"] =
        json!(20_001);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Operational-Profilparameter")
    );

    let mut source = source_value();
    source["vehicleTypes"][0]["operationalProfile"]["emergencyBrakeMultiplierBasisPoints"]["value"] =
        json!(30_001);
    assert!(
        compile_values(source, seed_value())
            .unwrap_err()
            .contains("Operational-Profilparameter")
    );

    let mut seed = seed_value();
    seed["assets"][0]["condition"]["kilometresSinceMaintenance"] = json!(9_007_199_254_740_992_u64);
    assert!(
        compile_values(source_value(), seed)
            .unwrap_err()
            .contains("sicheren JSON")
    );
}

#[test]
fn operational_profil_wird_nach_neuversiegelung_reproduzierbar_geprueft() {
    let (source, seed) = inputs();
    let mut compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    compilation.catalog.vehicle_types[0]
        .operational_profile
        .maximum_acceleration_mmps2 = 999;
    reseal_compilation(&mut compilation);
    let error = validate_compilation(&compilation).unwrap_err().to_string();
    assert!(error.contains("reproduzierbares Operational-Profil"));
}

#[test]
fn output_set_hash_bindet_auch_eingaben_ohne_ausgabeaenderung() {
    let (source, seed) = inputs();
    let first = compile_vehicle_catalog(&source, &seed).unwrap();
    let mut renamed_seed = seed.clone();
    renamed_seed.seed_id = "fixture-world-seed-renamed".to_owned();
    let second = compile_vehicle_catalog(&source, &renamed_seed).unwrap();

    assert_eq!(first.catalog, second.catalog);
    assert_eq!(first.fleet_authority, second.fleet_authority);
    assert_eq!(first.operational_inventory, second.operational_inventory);
    assert_ne!(
        first.receipt.world_seed_sha256,
        second.receipt.world_seed_sha256
    );
    assert_ne!(
        first.receipt.output_set_sha256,
        second.receipt.output_set_sha256
    );
}

#[test]
fn economy_release_projection_deckt_assettypen_exakt_ab() {
    let mut missing = seed_value();
    missing["economy"]["operatingCosts"] = json!([]);
    assert!(
        compile_values(source_value(), missing)
            .unwrap_err()
            .contains("exakt die Asset-Typen")
    );

    let mut unknown = seed_value();
    unknown["economy"]["operatingCosts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"typeId": "fixture.unknown", "centsPerTrainKm": 1}));
    assert!(
        compile_values(source_value(), unknown)
            .unwrap_err()
            .contains("unbekannten Typ")
    );

    let mut zero = seed_value();
    zero["economy"]["operatingCosts"][0]["centsPerTrainKm"] = json!(0);
    assert!(
        compile_values(source_value(), zero)
            .unwrap_err()
            .contains("muss positiv")
    );
}

#[test]
fn economy_inhalt_und_fahrzeugkosten_sind_getrennt_reproduzierbar_gebunden() {
    let mut changed_release = seed_value();
    changed_release["economy"]["release"]["rates"]["vehiclePerPeriodCents"] = json!("100001");
    let error = compile_values(source_value(), changed_release).unwrap_err();
    assert!(error.contains("EconomyRelease-Checksum bindet nicht den gelieferten Inhalt"));

    let mut changed_cost = seed_value();
    changed_cost["economy"]["operatingCosts"][0]["centsPerTrainKm"] = json!(751);
    let error = compile_values(source_value(), changed_cost).unwrap_err();
    assert!(error.contains("Projektions-SHA-256 bindet nicht EconomyRelease und Fahrzeugkosten"));

    let (source, seed) = inputs();
    let mut compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    compilation.fleet_authority.assets[0]
        .passenger
        .operating_cost_cents_per_train_km = 751;
    reseal_compilation(&mut compilation);
    let error = validate_compilation(&compilation).unwrap_err().to_string();
    assert!(error.contains("Projektionshash nicht an die Authority-Fahrzeugkosten"));
}

#[test]
fn cli_publiziert_vollstaendig_und_ueberschreibt_keinen_artefaktsatz() {
    let unique = format!("zugfolge-vehicle-catalog-cli-{}", std::process::id());
    let base = std::env::temp_dir().join(unique);
    let source_path = base.join("source.json");
    let seed_path = base.join("seed.json");
    let output = base.join("published-output");
    fs::create_dir_all(&base).expect("isoliertes Testverzeichnis");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&seed_path, SEED).unwrap();

    let first = Command::new(env!("CARGO_BIN_EXE_zugfolge-vehicle-catalog"))
        .arg(&source_path)
        .arg(&seed_path)
        .arg(&output)
        .status()
        .expect("CLI startet");
    assert!(first.success());
    let filenames = [
        "vehicle-catalog-v3.json",
        "fleet-authority-release-v2.json",
        "fleet-authority-release-catalog-v1.json",
        "operational-vehicle-inventory-v2.json",
        "vehicle-catalog-compile-receipt-v4.json",
    ];
    let before: Vec<_> = filenames
        .iter()
        .map(|name| fs::read(output.join(name)).expect("vollstaendiges Artefaktset"))
        .collect();
    let receipt: Value = serde_json::from_slice(&before[4]).expect("Compile-Receipt");
    assert_eq!(receipt["compiledCatalogSha256"], sha256(&before[0]));
    assert_eq!(receipt["fleetAuthoritySha256"], sha256(&before[1]));
    assert_eq!(receipt["fleetAuthorityCatalogSha256"], sha256(&before[2]));
    assert_eq!(receipt["operationalInventorySha256"], sha256(&before[3]));
    let authority_catalog: Value =
        serde_json::from_slice(&before[2]).expect("deploybarer Authority-Katalog");
    assert_eq!(
        authority_catalog,
        json!({
            "schemaVersion": FLEET_AUTHORITY_CATALOG_SCHEMA,
            "entries": [{
                "worldId": seed_value()["worldId"],
                "producedAt": seed_value()["producedAt"],
                "authorityRelease": serde_json::from_slice::<Value>(&before[1]).unwrap(),
            }],
        })
    );

    let second = Command::new(env!("CARGO_BIN_EXE_zugfolge-vehicle-catalog"))
        .arg(&source_path)
        .arg(&seed_path)
        .arg(&output)
        .status()
        .expect("zweiter CLI-Lauf startet");
    assert!(!second.success());
    let after: Vec<_> = filenames
        .iter()
        .map(|name| fs::read(output.join(name)).expect("bestehendes Artefakt bleibt"))
        .collect();
    assert_eq!(before, after);

    fs::remove_dir_all(&base).expect("nur isoliertes Testverzeichnis entfernen");
}
