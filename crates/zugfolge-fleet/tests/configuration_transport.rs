//! Echte M5-Domänenvalidierung des vollständigen Konfigurationstransports.

use serde_json::{Value, json};
use zugfolge_fleet::{
    Amenity, FleetError, SeatType, SeatingDensity, VehicleConfigurationError,
    VehicleConfigurationFacts, VehicleConfigurationV1,
};

fn configuration() -> Value {
    // Ausdrücklich fiktive Spielkonfiguration, kein reales Baureihendatenblatt.
    json!({
        "schemaVersion": "m5-vehicle-configuration/v1",
        "structural": {"doorCountPerSide": 4, "doorWidthMm": 1300, "bodyLengthMm": 70000},
        "interior": {
            "firstClassSeats": 16, "secondClassSeats": 184, "density": "standard", "seatType": "row",
            "multipurpose": {"bicycles": 12, "pushchairs": 4, "wheelchairs": 2, "standing": 40},
            "toilets": 2, "accessibleToilets": 1,
            "amenities": ["air_conditioning", "wifi", "power_sockets", "passenger_information"]
        }
    })
}

fn facts() -> VehicleConfigurationFacts {
    VehicleConfigurationFacts {
        length_mm: 70000,
        seats: 200,
        first_class_seats: 16,
        bicycle_places: 12,
        wheelchair_places: 2,
        accessible: true,
    }
}

#[test]
fn vollstaendiger_transport_erhaelt_alle_m5_domaenenwerte() {
    let input = configuration();
    let parsed: VehicleConfigurationV1 = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), input);
    parsed.validate_against(facts()).unwrap();
    let domain = parsed.to_domain().unwrap();
    assert_eq!(domain.structural().door_count_per_side(), 4);
    assert_eq!(domain.structural().door_width_mm(), 1300);
    assert_eq!(domain.structural().body_length().millimetres(), 70000);
    assert_eq!(domain.interior().first_class_seats, 16);
    assert_eq!(domain.interior().second_class_seats, 184);
    assert_eq!(domain.interior().density, SeatingDensity::Standard);
    assert_eq!(domain.interior().seat_type, SeatType::Row);
    assert_eq!(domain.interior().multipurpose.bicycles, 12);
    assert_eq!(domain.interior().multipurpose.pushchairs, 4);
    assert_eq!(domain.interior().multipurpose.wheelchairs, 2);
    assert_eq!(domain.interior().multipurpose.standing, 40);
    assert_eq!(domain.interior().toilets, 2);
    assert_eq!(domain.interior().accessible_toilets, 1);
    assert!(domain.interior().amenities.contains(&Amenity::Wifi));
    assert_eq!(domain.interior().amenities.len(), 4);
    // Die übernommenen Türen wirken weiterhin über die vorhandene M5-Haltezeit.
    let mut narrow = parsed.clone();
    narrow.structural.door_count_per_side = 2;
    narrow.structural.door_width_mm = 1000;
    assert!(
        domain.dwell_time_seconds(80, 60, 1)
            < narrow.to_domain().unwrap().dwell_time_seconds(80, 60, 1)
    );
}

#[test]
fn fehlende_unbekannte_und_fachlich_ungueltige_konfiguration_werden_nicht_ergaenzt() {
    for path in ["structural", "interior"] {
        let mut missing = configuration();
        missing.as_object_mut().unwrap().remove(path);
        assert!(serde_json::from_value::<VehicleConfigurationV1>(missing).is_err());
    }
    for (object, field) in [("structural", "doorWidthMm"), ("interior", "toilets")] {
        let mut missing = configuration();
        missing[object].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<VehicleConfigurationV1>(missing).is_err());
    }
    for (pointer, bad) in [
        ("/structural/doorCountPerSide", json!(-1)),
        ("/structural/bodyLengthMm", json!(1.5)),
        ("/interior/secondClassSeats", json!(65536)),
        ("/interior/seatType", json!("unknown")),
    ] {
        let mut input = configuration();
        *input.pointer_mut(pointer).unwrap() = bad;
        assert!(serde_json::from_value::<VehicleConfigurationV1>(input).is_err());
    }
    let mut unknown = configuration();
    unknown["structural"]["inventedDecks"] = json!(2);
    assert!(serde_json::from_value::<VehicleConfigurationV1>(unknown).is_err());
    let mut parsed: VehicleConfigurationV1 = serde_json::from_value(configuration()).unwrap();
    parsed.structural.door_count_per_side = 0;
    assert_eq!(
        parsed.validate(),
        Err(VehicleConfigurationError::InvalidDomain(
            FleetError::InvalidStructuralConfiguration
        ))
    );
    parsed.structural.door_count_per_side = 4;
    parsed.interior.accessible_toilets = 3;
    assert_eq!(
        parsed.validate(),
        Err(VehicleConfigurationError::InvalidDomain(
            FleetError::InvalidAccessibleToilets
        ))
    );
    parsed.interior.accessible_toilets = 1;
    parsed.interior.first_class_seats = 0;
    parsed.interior.second_class_seats = 0;
    parsed.interior.multipurpose.standing = 0;
    assert_eq!(
        parsed.validate(),
        Err(VehicleConfigurationError::InvalidDomain(
            FleetError::EmptyPassengerArea
        ))
    );
}

#[test]
fn konfiguration_veraendert_keine_authority_kapazitaet_oder_barrierefreiheitszusage() {
    let parsed: VehicleConfigurationV1 = serde_json::from_value(configuration()).unwrap();
    for (facts, expected) in [
        (
            VehicleConfigurationFacts {
                length_mm: 70001,
                ..facts()
            },
            VehicleConfigurationError::LengthMismatch,
        ),
        (
            VehicleConfigurationFacts {
                seats: 199,
                ..facts()
            },
            VehicleConfigurationError::SeatCountMismatch,
        ),
        (
            VehicleConfigurationFacts {
                first_class_seats: 15,
                ..facts()
            },
            VehicleConfigurationError::FirstClassMismatch,
        ),
        (
            VehicleConfigurationFacts {
                bicycle_places: 11,
                ..facts()
            },
            VehicleConfigurationError::BicyclePlacesMismatch,
        ),
        (
            VehicleConfigurationFacts {
                wheelchair_places: 1,
                ..facts()
            },
            VehicleConfigurationError::WheelchairPlacesMismatch,
        ),
        (
            VehicleConfigurationFacts {
                accessible: false,
                ..facts()
            },
            VehicleConfigurationError::AccessibilityMismatch,
        ),
    ] {
        assert_eq!(parsed.validate_against(facts), Err(expected));
    }
    // Barrierefreiheit allein behauptet keine Toilette oder reservierte Rollstuhlquote.
    let mut accessible_without_wc = parsed;
    accessible_without_wc.interior.toilets = 0;
    accessible_without_wc.interior.accessible_toilets = 0;
    accessible_without_wc.interior.multipurpose.wheelchairs = 0;
    accessible_without_wc
        .validate_against(VehicleConfigurationFacts {
            wheelchair_places: 0,
            ..facts()
        })
        .unwrap();
}

#[test]
fn alle_sitzarten_und_dichten_sind_domaenengleich_und_ausstattung_ist_eine_menge() {
    for density in ["dense", "standard", "spacious"] {
        for seat in ["row", "face_to_face", "folding"] {
            let mut input = configuration();
            input["interior"]["density"] = json!(density);
            input["interior"]["seatType"] = json!(seat);
            let parsed: VehicleConfigurationV1 = serde_json::from_value(input).unwrap();
            parsed.validate_against(facts()).unwrap();
        }
    }
    let mut original: VehicleConfigurationV1 = serde_json::from_value(configuration()).unwrap();
    let mut reversed = original.clone();
    reversed.interior.amenities.reverse();
    reversed.normalize();
    assert_eq!(reversed, original);
    original
        .interior
        .amenities
        .push(original.interior.amenities[0]);
    original.normalize();
    assert_eq!(
        original.validate(),
        Err(VehicleConfigurationError::DuplicateAmenity)
    );
    original.schema_version = "m5-vehicle-configuration/v0".into();
    assert_eq!(
        original.validate(),
        Err(VehicleConfigurationError::UnsupportedSchema)
    );
}

#[test]
fn bekannte_ausstattungszusagen_stimmen_exakt_ueberein_und_aliase_werden_explizit_gelesen() {
    let parsed: VehicleConfigurationV1 = serde_json::from_value(configuration()).unwrap();
    let equipment = [
        "air-conditioning",
        "wifi",
        "power-sockets",
        "pis",
        "unrelated-equipment",
    ]
    .map(str::to_owned)
    .to_vec();
    parsed.validate_equipment(&equipment).unwrap();
    let without_wifi = equipment
        .iter()
        .filter(|item| item.as_str() != "wifi")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        parsed.validate_equipment(&without_wifi),
        Err(VehicleConfigurationError::EquipmentMismatch)
    );
    let mut fewer = parsed;
    fewer.interior.amenities.pop();
    assert_eq!(
        fewer.validate_equipment(&equipment),
        Err(VehicleConfigurationError::EquipmentMismatch)
    );
    fewer.interior.amenities.clear();
    fewer
        .validate_equipment(&["unrelated-equipment".into()])
        .unwrap();
}
