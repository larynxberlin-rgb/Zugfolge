//! Der Beweis von M1 — **M1.12 und M1.13** zusammen.
//!
//! `docs/milestones.md` M1 verlangt einen reproduzierbaren
//! `InfraRelease`-Kandidaten des Pilotkorridors, dessen berechnete Fahrzeiten
//! innerhalb definierter Toleranz zur technischen Referenz liegen — begleitet
//! von einem Abdeckungsreport und einem getrennten GTFS-Fahrplan-Holdout. Die
//! produktive unabhängige Qualifizierung und echte Signatur folgen in M9.
//!
//! Das Netz ist das Beispielnetz (erfundene Daten, `betriebsgraph.md` 6), nicht
//! die echte Pilotregion — die Rechte am realen Extract und an den realen
//! Fahrzeiten sind noch nicht so weit (`docs/rechte.md`). Was der Test zeigt,
//! ist deshalb das **Verfahren**: aus einem geprüften Graphen ein
//! unveränderliches, versioniertes Release mit Herkunft, Lizenz, Prüfsumme und
//! Abdeckung, und daneben ein Abweichungsreport, der jede berechnete Fahrzeit
//! gegen eine Referenz und eine Toleranz stellt.

use zugfolge_infra::{
    Acceleration, DeviationReport, InfraRelease, Length, Mass, ProtectionSystem, QualityClass,
    ReferenceCorpus, ReferenceRun, ReleaseSource, ReleaseVersion, RunPath, RunningTime, SourceId,
    Speed, SpeedCategory, Tolerance, TrackId, TractionType, TrainCharacteristics,
    TrainCharacteristicsId, TrainProtection, TravelDirection, reference_network,
};

/// Das Release des Beispielnetzes: eine einzige Quelle, `beispielnetz`.
fn beispiel_release() -> InfraRelease {
    InfraRelease::builder(
        ReleaseVersion::new(1, 0, 0),
        "Beispielnetz",
        reference_network(),
    )
    .source(
        ReleaseSource::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            "erfunden — kein Import (docs/betriebsgraph.md 6)",
            "Zugfolge-Beispielnetz",
        )
        .expect("gültige Quelle"),
    )
    .build()
    .expect("das Beispielnetz nennt nur die Quelle 'beispielnetz'")
}

/// Ein Dieseltriebwagen mit PZB — befährt den eingleisigen, nicht
/// elektrifizierten Ast.
fn regionaltriebwagen() -> TrainCharacteristics {
    TrainCharacteristics::new(
        TrainCharacteristicsId::new(1),
        "Referenztriebwagen",
        Mass::from_tonnes(120),
        Length::from_metres(80),
        Speed::from_km_h(120),
        SpeedCategory::Standard,
        Acceleration::from_millimetres_per_second_squared(700),
        Acceleration::from_millimetres_per_second_squared(800),
        TractionType::Diesel,
        TrainProtection::single(ProtectionSystem::Pzb),
    )
    .expect("gültige Zugcharakteristik")
}

/// Ein Fahrweg über den Ast Sandberg – Talheim (Gleis 3001), in einer Richtung.
fn ast_fahrweg(
    release: &InfraRelease,
    train: &TrainCharacteristics,
    direction: TravelDirection,
) -> RunPath {
    let ast = release
        .graph()
        .track(TrackId::new(3001))
        .expect("das eingleisige Gleis");
    let mut fahrweg = RunPath::new();
    fahrweg
        .push_track_range(train, ast, direction, Length::ZERO, ast.length())
        .expect("Diesel mit PZB passt zum Ast");
    fahrweg
}

#[test]
fn ein_release_traegt_herkunft_lizenz_pruefsumme_und_abdeckung() {
    let release = beispiel_release();

    // Versioniert und mit Region gepinnt.
    assert_eq!(release.version(), ReleaseVersion::new(1, 0, 0));
    assert_eq!(release.region(), "Beispielnetz");

    // Herkunft und Lizenz je Quelle.
    assert_eq!(release.source_count(), 1);
    let quelle = release
        .source(&SourceId::new("beispielnetz").expect("gültig"))
        .expect("die Quelle ist deklariert");
    assert!(!quelle.license().is_empty());

    // Prüfsumme über das Ganze.
    assert_eq!(release.checksum().to_hex().len(), 64);

    // Abdeckung je Attribut und Abschnitt (M1.4): Das Beispielnetz erreicht
    // wegen seiner abgeleiteten Neigung nirgends Klasse A.
    let klassen = release.coverage().class_totals();
    assert!(!klassen.contains_key(&QualityClass::A));
    assert!(klassen.values().any(|laenge| laenge.is_positive()));
}

#[test]
fn die_berechneten_fahrzeiten_liegen_in_der_toleranz_zur_referenz() {
    let release = beispiel_release();
    let zug = regionaltriebwagen();

    // Die aus dem Release berechneten Fahrzeiten in beide Richtungen.
    let hin = ast_fahrweg(&release, &zug, TravelDirection::WithChainage);
    let zurueck = ast_fahrweg(&release, &zug, TravelDirection::AgainstChainage);

    let hin_zeit = ReferenceRun::new(
        "Sandberg → Talheim",
        hin.clone(),
        zug.clone(),
        Speed::ZERO,
        RunningTime::from_seconds(1),
        Tolerance::seconds(0),
    )
    .expect("gültig")
    .computed()
    .expect("gültige Fahrzeit");
    let zurueck_zeit = ReferenceRun::new(
        "Talheim → Sandberg",
        zurueck.clone(),
        zug.clone(),
        Speed::ZERO,
        RunningTime::from_seconds(1),
        Tolerance::seconds(0),
    )
    .expect("gültig")
    .computed()
    .expect("gültige Fahrzeit");

    // Der Korpus: eine Referenz, die die Rechnung exakt trifft, und eine, die
    // um 15 s daneben liegt — beide innerhalb einer Toleranz von 30 s oder
    // 10 %, dem größeren. So prüft der Test die Toleranz und nicht nur den
    // Gleichstand.
    let toleranz = Tolerance::of(30, 100);
    let korpus = ReferenceCorpus::new("Beispielnetz")
        .run(
            ReferenceRun::new(
                "Sandberg → Talheim",
                hin,
                zug.clone(),
                Speed::ZERO,
                hin_zeit,
                toleranz,
            )
            .expect("gültig"),
        )
        .run(
            ReferenceRun::new(
                "Talheim → Sandberg",
                zurueck,
                zug,
                Speed::ZERO,
                RunningTime::from_seconds(zurueck_zeit.seconds() + 15),
                toleranz,
            )
            .expect("gültig"),
        );

    let report = DeviationReport::measure(&korpus).expect("gültiger Report");
    assert_eq!(report.len(), 2);
    assert!(
        report.all_within_tolerance(),
        "jede Fahrzeit liegt in der Toleranz — sonst: {:?}",
        report.breaches().collect::<Vec<_>>()
    );
    assert_eq!(report.breaches().count(), 0);

    // Der erste Lauf trifft die Referenz genau, der zweite weicht um 15 s ab.
    assert_eq!(report.deviations()[0].deviation_seconds(), 0);
    assert_eq!(report.deviations()[1].deviation_seconds(), -15);
}

#[test]
fn eine_referenz_ausserhalb_der_toleranz_faellt_im_report_auf() {
    let release = beispiel_release();
    let zug = regionaltriebwagen();
    let fahrweg = ast_fahrweg(&release, &zug, TravelDirection::WithChainage);

    let berechnet = ReferenceRun::new(
        "Sandberg → Talheim",
        fahrweg.clone(),
        zug.clone(),
        Speed::ZERO,
        RunningTime::from_seconds(1),
        Tolerance::seconds(0),
    )
    .expect("gültig")
    .computed()
    .expect("gültige Fahrzeit");

    // Eine Referenz beim Doppelten der Rechnung mit enger Toleranz muss der
    // Report als Abweichung melden — der Beweis prüft, dass er nicht immer nur
    // Grün meldet.
    let korpus = ReferenceCorpus::new("Beispielnetz").run(
        ReferenceRun::new(
            "Sandberg → Talheim (falsche Referenz)",
            fahrweg,
            zug,
            Speed::ZERO,
            RunningTime::from_seconds(berechnet.seconds() * 2),
            Tolerance::seconds(30),
        )
        .expect("gültig"),
    );

    let report = DeviationReport::measure(&korpus).expect("gültiger Report");
    assert!(!report.all_within_tolerance());
    assert_eq!(report.breaches().count(), 1);
}
