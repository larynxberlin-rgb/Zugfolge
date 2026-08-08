//! Der Fingerabdruck des Netzfahrplans.
//!
//! Ein Netzfahrplan wird über Jahre fortgeschrieben. Die Frage „hat sich etwas
//! geändert, das sich nicht ändern durfte" beantwortet nur ein Fingerabdruck —
//! erzeugt auf Linux **und** auf Windows, gegen dieselbe Datei.
//!
//! Ein geänderter Golden-Master ist entweder eine bewusste Änderung des
//! Sperrzeitenmodells oder ein Fehler. Beides muss im Commit begründet werden.

use zugfolge_conflict::{
    DEFAULT_HORIZON_DAYS, NetworkTimetable, OperatingDays, ServicePattern, TimetableCommand,
    TrainCategory, TrainNumber, derive_occupation_profile,
    example::{
        freight_train, nordstadt_bis_talheim, reference_infrastructure, regional_train,
        talheim_bis_nordstadt,
    },
};
use zugfolge_determinism::{
    DeterministicModel, Scenario, SimTime, WorldSeed, assert_deterministic, assert_golden,
    golden_path,
};
use zugfolge_infra::TrainCharacteristicsId;

/// Ein Szenario mit vier Verkehrsangeboten in beiden Richtungen — zwei davon
/// geraten miteinander in Konflikt und werden abgewiesen.
fn szenario() -> Scenario<TimetableCommand> {
    let infra = reference_infrastructure();
    let hin = nordstadt_bis_talheim(&infra);
    let zurueck = talheim_bis_nordstadt(&infra);

    let regional_hin =
        derive_occupation_profile(&infra, &hin, &regional_train()).expect("gültiges Profil");
    let regional_zurueck =
        derive_occupation_profile(&infra, &zurueck, &regional_train()).expect("gültiges Profil");
    let gueterzug_hin =
        derive_occupation_profile(&infra, &hin, &freight_train()).expect("gültiges Profil");

    let angebot = |nummer: u32,
                   charakteristik: u32,
                   laufweg: &zugfolge_conflict::Itinerary,
                   profil: &zugfolge_conflict::OccupationProfile,
                   abfahrt_s: i64,
                   tage: OperatingDays| {
        TimetableCommand::Schedule(Box::new(
            ServicePattern::new(
                TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Nummer"),
                TrainCharacteristicsId::new(charakteristik),
                laufweg.clone(),
                profil.clone(),
                abfahrt_s,
                tage,
            )
            .expect("gültiges Verkehrsangebot"),
        ))
    };

    Scenario::new(WorldSeed::new(1, 1))
        .at(
            SimTime::from_seconds(0),
            angebot(26_802, 1, &hin, &regional_hin, 28_800, OperatingDays::DAILY),
        )
        .at(
            SimTime::from_seconds(1),
            angebot(
                26_801,
                1,
                &zurueck,
                &regional_zurueck,
                28_800,
                OperatingDays::DAILY,
            ),
        )
        // Zu dicht hinter 26 802 — dieses Angebot muss abgewiesen werden.
        .at(
            SimTime::from_seconds(2),
            angebot(
                26_804,
                2,
                &hin,
                &gueterzug_hin,
                28_860,
                OperatingDays::WORKDAYS,
            ),
        )
        // Eine Stunde später ist Platz.
        .at(
            SimTime::from_seconds(3),
            angebot(
                26_806,
                1,
                &hin,
                &regional_hin,
                32_400,
                OperatingDays::WORKDAYS,
            ),
        )
        .at(
            SimTime::from_seconds(4),
            TimetableCommand::Withdraw(
                TrainNumber::new(TrainCategory::Regional, 26_806).expect("gültige Nummer"),
            ),
        )
}

fn fahrplan() -> NetworkTimetable {
    NetworkTimetable::new(
        reference_infrastructure().exclusions().clone(),
        DEFAULT_HORIZON_DAYS,
    )
}

#[test]
fn zwei_laeufe_ergeben_denselben_zustand() {
    let szenario = szenario();
    let hash =
        assert_deterministic::<NetworkTimetable, _>("netzfahrplan", &szenario, |_seed| fahrplan());
    assert_eq!(hash.to_hex().len(), 64);
}

#[test]
fn der_golden_master_haelt() {
    let szenario = szenario();
    let hash = zugfolge_determinism::run::<NetworkTimetable, _>(&szenario, |_seed| fahrplan());
    assert_golden(golden_path!("network-timetable"), hash);
}

#[test]
fn das_szenario_nimmt_an_und_weist_ab() {
    // Ohne diese Gegenprobe prüfte der Golden-Master nur, dass irgendetwas
    // stabil ist — nicht, dass er einen Fahrplan mit Annahme und Ablehnung
    // beschreibt.
    let mut fahrplan = fahrplan();
    for (at, command) in szenario().commands() {
        fahrplan.apply(*at, command);
    }

    assert_eq!(fahrplan.accepted_count(), 2, "26 802 und 26 801 bleiben");
    assert_eq!(
        fahrplan.rejected().collect::<Vec<_>>(),
        vec![TrainNumber::new(TrainCategory::Regional, 26_804).expect("gültige Nummer")],
        "der Güterzug lag zu dicht hinter 26 802"
    );
    assert!(fahrplan.ledger().occupation_count() > 0);
}

#[test]
fn die_reihenfolge_der_kommandos_ist_sichtbar() {
    // Ein Fahrplan ist kein Vergabeverfahren: Wer zuerst kommt, liegt zuerst.
    // Genau deshalb braucht M3.5 einen eigenen `PlanningRun` — und genau
    // deshalb darf dieser Zustand nicht so tun, als sei die Reihenfolge egal.
    let infra = reference_infrastructure();
    let hin = nordstadt_bis_talheim(&infra);
    let profil =
        derive_occupation_profile(&infra, &hin, &regional_train()).expect("gültiges Profil");
    let angebot = |nummer: u32, abfahrt_s: i64| {
        ServicePattern::new(
            TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Nummer"),
            TrainCharacteristicsId::new(1),
            hin.clone(),
            profil.clone(),
            abfahrt_s,
            OperatingDays::DAILY,
        )
        .expect("gültiges Verkehrsangebot")
    };

    let mut zuerst_a = fahrplan();
    assert!(zuerst_a.schedule(angebot(26_802, 28_800)));
    assert!(!zuerst_a.schedule(angebot(26_804, 28_860)));

    let mut zuerst_b = fahrplan();
    assert!(zuerst_b.schedule(angebot(26_804, 28_860)));
    assert!(!zuerst_b.schedule(angebot(26_802, 28_800)));

    assert_ne!(zuerst_a.state_hash(), zuerst_b.state_hash());
}
