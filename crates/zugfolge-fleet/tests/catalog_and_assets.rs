//! Ende-zu-Ende-Beweise für Fahrzeugkatalog und individuelle Flotte (M5.1).

use zugfolge_determinism::{assert_golden, golden_path};
use zugfolge_fleet::{
    AssetError, CatalogError, CatalogSource, CatalogSourceId, FleetSnapshot, MaintenanceDeadline,
    MarketAvailability, MarketEvidence, ProcurementChannel, ProtectionEquipment, ProtectionFitment,
    ProtectionOption, VehicleApproval, VehicleAsset, VehicleCatalogEntry, VehicleCatalogRelease,
    VehicleEra, VehicleWorldSettings, YearRange,
};
use zugfolge_infra::{FleetClass, ProtectionSystem, TrainProtection};

const TYPE_OLD: u64 = 41;
const TYPE_NEW: u64 = 42;

fn class(value: &str) -> FleetClass {
    FleetClass::new(value).unwrap()
}

fn source_id(value: &str) -> CatalogSourceId {
    CatalogSourceId::new(value).unwrap()
}

fn source(value: &str, exact_class: &str) -> CatalogSource {
    CatalogSource::new(
        source_id(value),
        format!("Fachblatt {exact_class}"),
        format!("https://example.invalid/{value}"),
        [class(exact_class)],
    )
    .unwrap()
}

fn documented(source: &str) -> MarketEvidence {
    MarketEvidence::documented([source_id(source)]).unwrap()
}

fn estimated(reason: &str) -> MarketEvidence {
    MarketEvidence::estimated(reason).unwrap()
}

fn old_entry() -> VehicleCatalogEntry {
    let evidence = source_id("fachblatt-z100");
    let protection = ProtectionEquipment::new(
        [ProtectionSystem::Pzb],
        [evidence.clone()],
        vec![
            ProtectionOption::new(
                ProtectionSystem::Lzb,
                ProtectionFitment::FactoryOption,
                YearRange::new(2000, 2004).unwrap(),
                [evidence.clone()],
            )
            .unwrap(),
            ProtectionOption::new(
                ProtectionSystem::EtcsLevel2,
                ProtectionFitment::Retrofit,
                YearRange::new(2012, 9_999).unwrap(),
                [evidence.clone()],
            )
            .unwrap(),
        ],
    )
    .unwrap();
    VehicleCatalogEntry::new(
        TYPE_OLD,
        class("Z100"),
        "Stromstern",
        YearRange::new(1998, 2004).unwrap(),
        [evidence],
        [
            MarketAvailability::new(
                ProcurementChannel::NewBuild,
                YearRange::new(1998, 2004).unwrap(),
                documented("fachblatt-z100"),
            ),
            MarketAvailability::new(
                ProcurementChannel::Leasing,
                YearRange::new(2005, 9_999).unwrap(),
                estimated("Spielannahme: nach Auslieferung im Leasingpool"),
            ),
            MarketAvailability::new(
                ProcurementChannel::Used,
                YearRange::new(2006, 9_999).unwrap(),
                estimated("Spielannahme: Sekundärmarkt nach Flottenwechsel"),
            ),
        ],
        protection,
    )
    .unwrap()
}

fn new_entry() -> VehicleCatalogEntry {
    let evidence = source_id("fachblatt-z200");
    let protection = ProtectionEquipment::new(
        [ProtectionSystem::Pzb, ProtectionSystem::Lzb],
        [evidence.clone()],
        Vec::new(),
    )
    .unwrap();
    VehicleCatalogEntry::new(
        TYPE_NEW,
        class("Z200"),
        "Flussfalke",
        YearRange::new(2015, 2024).unwrap(),
        [evidence],
        [
            MarketAvailability::new(
                ProcurementChannel::NewBuild,
                YearRange::new(2015, 2024).unwrap(),
                documented("fachblatt-z200"),
            ),
            MarketAvailability::new(
                ProcurementChannel::Leasing,
                YearRange::new(2018, 9_999).unwrap(),
                estimated("Spielannahme: Leasing nach Flottenhochlauf"),
            ),
            MarketAvailability::new(
                ProcurementChannel::Used,
                YearRange::new(2025, 9_999).unwrap(),
                estimated("Spielannahme: Gebrauchtmarkt nach Serienende"),
            ),
        ],
        protection,
    )
    .unwrap()
}

fn catalog(reverse: bool) -> VehicleCatalogRelease {
    let old_source = source("fachblatt-z100", "Z100");
    let new_source = source("fachblatt-z200", "Z200");
    let builder = VehicleCatalogRelease::builder("test-2026");
    if reverse {
        builder
            .source(new_source)
            .source(old_source)
            .vehicle(new_entry())
            .vehicle(old_entry())
            .build()
            .unwrap()
    } else {
        builder
            .source(old_source)
            .source(new_source)
            .vehicle(old_entry())
            .vehicle(new_entry())
            .build()
            .unwrap()
    }
}

fn approvals() -> [VehicleApproval; 1] {
    [VehicleApproval::new("DE-EBO").unwrap()]
}

fn deadlines() -> [MaintenanceDeadline; 1] {
    [MaintenanceDeadline::new("IS-600", 900_000).unwrap()]
}

#[test]
fn bau_und_beschaffungsepoche_sind_unabhaengig() {
    let catalog = catalog(false);
    let settings = VehicleWorldSettings::new(
        VehicleEra::RailReform1994To2010,
        VehicleEra::ContemporaryFrom2011,
    );
    let available: Vec<_> = catalog
        .available_vehicles(settings, ProcurementChannel::Used, 2026)
        .map(VehicleCatalogEntry::id)
        .collect();
    assert_eq!(available, vec![TYPE_OLD]);
    assert_eq!(
        catalog
            .available_vehicles(settings, ProcurementChannel::NewBuild, 2026)
            .count(),
        0
    );
    VehicleAsset::acquire_secondary(
        &catalog,
        settings,
        7,
        1,
        TYPE_OLD,
        2002,
        2026,
        ProcurementChannel::Used,
        TrainProtection::single(ProtectionSystem::Pzb),
        approvals(),
        deadlines(),
    )
    .unwrap();

    let modern_only = VehicleWorldSettings::new(
        VehicleEra::ContemporaryFrom2011,
        VehicleEra::ContemporaryFrom2011,
    );
    assert_eq!(
        VehicleAsset::acquire_secondary(
            &catalog,
            modern_only,
            7,
            2,
            TYPE_OLD,
            2002,
            2026,
            ProcurementChannel::Used,
            TrainProtection::single(ProtectionSystem::Pzb),
            approvals(),
            deadlines(),
        ),
        Err(AssetError::ConstructionEraExcluded)
    );
}

#[test]
fn gebrauchtmarkt_und_leasing_erhalten_die_ist_ausruestung() {
    let catalog = catalog(false);
    let without_option = VehicleAsset::acquire_secondary(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2002,
        2026,
        ProcurementChannel::Used,
        TrainProtection::single(ProtectionSystem::Pzb),
        approvals(),
        deadlines(),
    )
    .unwrap();
    assert!(
        !without_option
            .installed_protection()
            .contains(ProtectionSystem::Lzb)
    );

    let with_option = VehicleAsset::acquire_secondary(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        2,
        TYPE_OLD,
        2002,
        2026,
        ProcurementChannel::Leasing,
        TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
        approvals(),
        deadlines(),
    )
    .unwrap();
    assert!(
        with_option
            .installed_protection()
            .contains(ProtectionSystem::Lzb)
    );
}

#[test]
fn neukauf_erlaubt_nur_serienausruestung_und_zeitgebundene_werksoptionen() {
    let catalog = catalog(false);
    let configured = VehicleAsset::buy_new(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2001,
        [ProtectionSystem::Lzb],
        approvals(),
        deadlines(),
    )
    .unwrap();
    assert!(
        configured
            .installed_protection()
            .contains(ProtectionSystem::Pzb)
    );
    assert!(
        configured
            .installed_protection()
            .contains(ProtectionSystem::Lzb)
    );

    assert_eq!(
        VehicleAsset::buy_new(
            &catalog,
            VehicleWorldSettings::all_eras(),
            7,
            2,
            TYPE_OLD,
            2001,
            [ProtectionSystem::EtcsLevel2],
            approvals(),
            deadlines(),
        ),
        Err(AssetError::NotAFactoryOption)
    );
    assert_eq!(
        VehicleAsset::buy_new(
            &catalog,
            VehicleWorldSettings::all_eras(),
            7,
            3,
            TYPE_OLD,
            1999,
            [ProtectionSystem::Lzb],
            approvals(),
            deadlines(),
        ),
        Err(AssetError::NotAFactoryOption)
    );
}

#[test]
fn nachruestung_gilt_nur_fuer_den_genauen_typ_und_ihr_zeitfenster() {
    let catalog = catalog(false);
    let mut vehicle = VehicleAsset::buy_new(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2001,
        [],
        approvals(),
        deadlines(),
    )
    .unwrap();
    assert_eq!(
        vehicle.install_protection_retrofit(&catalog, 2011, ProtectionSystem::EtcsLevel2),
        Err(AssetError::RetrofitNotAvailable)
    );
    vehicle
        .install_protection_retrofit(&catalog, 2012, ProtectionSystem::EtcsLevel2)
        .unwrap();
    assert!(
        vehicle
            .installed_protection()
            .contains(ProtectionSystem::EtcsLevel2)
    );

    let mut other_type = VehicleAsset::buy_new(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        2,
        TYPE_NEW,
        2020,
        [],
        approvals(),
        deadlines(),
    )
    .unwrap();
    assert_eq!(
        other_type.install_protection_retrofit(&catalog, 2026, ProtectionSystem::EtcsLevel2),
        Err(AssetError::RetrofitNotAvailable)
    );
}

#[test]
fn release_prueft_eindeutigkeit_und_quellen_der_genauen_baureihe() {
    let wrong_source = source("falsche-quelle", "Z200");
    let wrong = VehicleCatalogRelease::builder("test")
        .source(wrong_source)
        .vehicle({
            let evidence = source_id("falsche-quelle");
            VehicleCatalogEntry::new(
                99,
                class("Z100"),
                "Quellenprobe",
                YearRange::new(2000, 2001).unwrap(),
                [evidence.clone()],
                [MarketAvailability::new(
                    ProcurementChannel::NewBuild,
                    YearRange::new(2000, 2001).unwrap(),
                    MarketEvidence::documented([evidence.clone()]).unwrap(),
                )],
                ProtectionEquipment::new([ProtectionSystem::Pzb], [evidence], Vec::new()).unwrap(),
            )
            .unwrap()
        })
        .build();
    assert_eq!(wrong, Err(CatalogError::SourceDoesNotCoverExactClass));

    let duplicate_trade_name = VehicleCatalogRelease::builder("test")
        .source(source("fachblatt-z100", "Z100"))
        .source(source("fachblatt-z200", "Z200"))
        .vehicle(old_entry())
        .vehicle({
            let entry = new_entry();
            // Der öffentliche Typ bietet absichtlich keinen Setter. Ein zweiter
            // regulär gebauter Eintrag weist dieselbe Kollision nach.
            VehicleCatalogEntry::new(
                77,
                entry.class_designation().clone(),
                "Stromstern",
                entry.construction(),
                [source_id("fachblatt-z200")],
                [
                    entry.market(ProcurementChannel::NewBuild).unwrap().clone(),
                    entry.market(ProcurementChannel::Leasing).unwrap().clone(),
                    entry.market(ProcurementChannel::Used).unwrap().clone(),
                ],
                entry.protection().clone(),
            )
            .unwrap()
        })
        .build();
    assert_eq!(duplicate_trade_name, Err(CatalogError::DuplicateTradeName));
}

#[test]
fn katalog_und_flotte_sind_einfuegereihenfolge_unabhaengig() {
    let forward = catalog(false);
    let reverse = catalog(true);
    assert_eq!(forward.checksum(), reverse.checksum());

    let old = VehicleAsset::acquire_secondary(
        &forward,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2002,
        2026,
        ProcurementChannel::Used,
        TrainProtection::single(ProtectionSystem::Pzb),
        approvals(),
        deadlines(),
    )
    .unwrap();
    let new = VehicleAsset::acquire_secondary(
        &forward,
        VehicleWorldSettings::all_eras(),
        7,
        2,
        TYPE_NEW,
        2020,
        2026,
        ProcurementChannel::Used,
        TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
        approvals(),
        deadlines(),
    )
    .unwrap();
    let mut first = FleetSnapshot::new(7, &forward);
    first.insert(old.clone()).unwrap();
    first.insert(new.clone()).unwrap();
    let mut second = FleetSnapshot::new(7, &forward);
    second.insert(new).unwrap();
    second.insert(old).unwrap();
    assert_eq!(first.checksum(), second.checksum());

    let mut upgraded = VehicleAsset::acquire_secondary(
        &forward,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2002,
        2020,
        ProcurementChannel::Used,
        TrainProtection::single(ProtectionSystem::Pzb),
        approvals(),
        deadlines(),
    )
    .unwrap();
    upgraded
        .install_protection_retrofit(&forward, 2021, ProtectionSystem::EtcsLevel2)
        .unwrap();
    let mut changed = FleetSnapshot::new(7, &forward);
    changed.insert(upgraded).unwrap();
    assert_ne!(first.checksum(), changed.checksum());
}

#[test]
fn fahrzeugkatalog_golden_master_bleibt_stabil() {
    assert_golden(golden_path!("vehicle-catalog"), catalog(false).checksum());
}

#[test]
fn flottensnapshot_golden_master_bleibt_stabil() {
    let catalog = catalog(false);
    let vehicle = VehicleAsset::acquire_secondary(
        &catalog,
        VehicleWorldSettings::all_eras(),
        7,
        1,
        TYPE_OLD,
        2002,
        2026,
        ProcurementChannel::Used,
        TrainProtection::single(ProtectionSystem::Pzb),
        approvals(),
        deadlines(),
    )
    .unwrap();
    let mut fleet = FleetSnapshot::new(7, &catalog);
    fleet.insert(vehicle).unwrap();
    assert_golden(golden_path!("fleet-snapshot"), fleet.checksum());
}
