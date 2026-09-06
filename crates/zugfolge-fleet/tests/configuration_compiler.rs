//! Konfiguration kommt ausschließlich aus dem gehashten Welt-Seed in die Authority.

use serde_json::{Value, json};
use zugfolge_fleet::release_catalog::{
    compile_vehicle_catalog, parse_source_catalog, parse_world_seed, to_pretty_json,
    validate_compilation, validate_compilation_against_inputs,
};

const SOURCE: &str = include_str!("fixtures/vehicle-catalog-source-v2-interior.json");
const LEGACY_SEED: &str = include_str!("fixtures/vehicle-world-seed-v3.json");
const CONFIGURED_SEED: &str = include_str!("fixtures/vehicle-world-seed-v3-interior.json");

#[test]
fn drei_fiktive_m5_spielkonfigurationen_werden_verlustfrei_und_reproduzierbar_kompiliert() {
    let source = parse_source_catalog(SOURCE).unwrap();
    let seed = parse_world_seed(CONFIGURED_SEED).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    validate_compilation_against_inputs(&source, &seed, &compilation).unwrap();
    assert_eq!(compilation.fleet_authority.assets.len(), 3);
    for (authority, original) in compilation.fleet_authority.assets.iter().zip(&seed.assets) {
        assert_eq!(
            authority.vehicle_configuration,
            original.vehicle_configuration
        );
        assert_eq!(
            authority.passenger.seats,
            u32::from(
                original
                    .vehicle_configuration
                    .as_ref()
                    .unwrap()
                    .interior
                    .first_class_seats
            ) + u32::from(
                original
                    .vehicle_configuration
                    .as_ref()
                    .unwrap()
                    .interior
                    .second_class_seats
            )
        );
        assert_eq!(authority.passenger.first_class_seats, 16);
        assert_eq!(authority.passenger.bicycle_places, 12);
        assert_eq!(authority.passenger.wheelchair_places, 2);
        assert_eq!(authority.technical.length_mm, 70000);
    }
    let mut reversed = seed.clone();
    reversed.assets.reverse();
    reversed.formations.reverse();
    for asset in &mut reversed.assets {
        asset
            .vehicle_configuration
            .as_mut()
            .unwrap()
            .interior
            .amenities
            .reverse();
    }
    let repeated = compile_vehicle_catalog(&source, &reversed).unwrap();
    assert_eq!(
        to_pretty_json(&compilation.fleet_authority).unwrap(),
        to_pretty_json(&repeated.fleet_authority).unwrap()
    );
    assert_eq!(
        compilation.receipt.output_set_sha256,
        repeated.receipt.output_set_sha256
    );
}

#[test]
fn der_compiler_verweigert_konfigurationsfehler_statt_katalogkapazitaeten_zu_ersetzen() {
    let source = parse_source_catalog(SOURCE).unwrap();
    let mut explicit_null: Value = serde_json::from_str(CONFIGURED_SEED).unwrap();
    explicit_null["assets"][0]["vehicleConfiguration"] = Value::Null;
    assert!(parse_world_seed(&explicit_null.to_string()).is_err());
    for (pointer, value) in [
        ("/structural/bodyLengthMm", json!(70001)),
        ("/structural/doorWidthMm", json!(0)),
        ("/interior/secondClassSeats", json!(183)),
        ("/interior/firstClassSeats", json!(15)),
        ("/interior/multipurpose/bicycles", json!(11)),
        ("/interior/multipurpose/wheelchairs", json!(1)),
        ("/interior/accessibleToilets", json!(3)),
        ("/interior/amenities", json!(["wifi", "wifi"])),
        (
            "/interior/amenities",
            json!(["air_conditioning", "wifi", "passenger_information"]),
        ),
    ] {
        let mut input: Value = serde_json::from_str(CONFIGURED_SEED).unwrap();
        *input["assets"][0]["vehicleConfiguration"]
            .pointer_mut(pointer)
            .unwrap() = value;
        let seed = parse_world_seed(&input.to_string()).unwrap();
        let error = compile_vehicle_catalog(&source, &seed).unwrap_err();
        assert!(
            error.to_string().contains("M5-Fahrzeugkonfiguration"),
            "{pointer}: {error}"
        );
    }
}

#[test]
fn konfigurationsaenderung_aendert_seed_authority_und_receipt_ohne_betriebswerte_umzuschreiben() {
    let source = parse_source_catalog(SOURCE).unwrap();
    let seed = parse_world_seed(CONFIGURED_SEED).unwrap();
    let original = compile_vehicle_catalog(&source, &seed).unwrap();
    let mut changed_seed = seed.clone();
    changed_seed.assets[0]
        .vehicle_configuration
        .as_mut()
        .unwrap()
        .interior
        .toilets += 1;
    let changed = compile_vehicle_catalog(&source, &changed_seed).unwrap();
    assert_ne!(
        original.receipt.world_seed_sha256,
        changed.receipt.world_seed_sha256
    );
    assert_ne!(
        original.receipt.fleet_authority_sha256,
        changed.receipt.fleet_authority_sha256
    );
    assert_ne!(
        original.receipt.fleet_authority_catalog_sha256,
        changed.receipt.fleet_authority_catalog_sha256
    );
    assert_ne!(
        original.receipt.output_set_sha256,
        changed.receipt.output_set_sha256
    );
    assert_eq!(
        original.receipt.compiled_catalog_sha256,
        changed.receipt.compiled_catalog_sha256
    );
    assert_eq!(
        original.receipt.operational_inventory_sha256,
        changed.receipt.operational_inventory_sha256
    );
    assert!(validate_compilation_against_inputs(&source, &seed, &changed).is_err());
    let mut corrupted = original;
    corrupted.fleet_authority.assets[0]
        .vehicle_configuration
        .as_mut()
        .unwrap()
        .interior
        .toilets += 1;
    assert!(validate_compilation(&corrupted).is_err());
}

#[test]
fn alte_releases_erhalten_keine_konfiguration_und_behalten_die_bisherigen_ausgabebytes() {
    let source =
        parse_source_catalog(include_str!("fixtures/vehicle-catalog-source-v2.json")).unwrap();
    let seed = parse_world_seed(LEGACY_SEED).unwrap();
    let compilation = compile_vehicle_catalog(&source, &seed).unwrap();
    assert!(
        compilation
            .fleet_authority
            .assets
            .iter()
            .all(|asset| asset.vehicle_configuration.is_none())
    );
    assert!(
        !to_pretty_json(&seed)
            .unwrap()
            .contains("vehicleConfiguration")
    );
    assert_eq!(
        to_pretty_json(&compilation.fleet_authority_catalog).unwrap(),
        include_str!("fixtures/fleet-authority-release-catalog-v1.json").replace("\r\n", "\n")
    );
}
