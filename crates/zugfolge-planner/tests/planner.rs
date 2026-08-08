//! Der Beweis von M3.4: Der Planner findet die betrieblich richtige Auflösung,
//! nicht bloß eine zulässige.
//!
//! Der Spike aus M0.3 hat den Fall vorgeführt, an dem sich das entscheidet:
//! Zwei Züge geraten auf dem eingleisigen Ast in Gegenfahrt. Die Prüfung
//! antwortet „so viel später"; betrieblich richtig ist „zur gewünschten Zeit
//! fahren und in einer Betriebsstelle kreuzen". Genau das prüfen diese Tests.

use zugfolge_conflict::{
    ConflictResource, Infrastructure, Itinerary, OccupationLedger, ShiftOutcome, TrainCategory,
    TrainNumber, TrainRun, derive_occupation_profile,
    example::{
        freight_train, nordstadt_bis_talheim, reference_infrastructure, regional_train,
        talheim_bis_nordstadt,
    },
};
use zugfolge_conflict::{OperatingDays, RelativeOccupation};
use zugfolge_determinism::SimTime;
use zugfolge_infra::{OperatingPointId, TrackId, TrainCharacteristics};
use zugfolge_planner::{
    PathDecision, PathRequest, PathRequestId, PathTolerances, PlannerError, PlannerOptions,
    TrainPathPlanner,
};

/// Nordstadt.
const NORDSTADT: u32 = 1;
/// Waldhof — ein Haltepunkt, er kann nicht kreuzen.
const WALDHOF: u32 = 2;
/// Sandberg — die Betriebsstelle vor dem eingleisigen Ast.
const SANDBERG: u32 = 3;
/// Talheim, am Ende des Astes.
const TALHEIM: u32 = 4;

/// Die Wunschabfahrt aller Anträge dieser Tests.
const WUNSCH_S: i64 = 28_800;

fn antrag(
    id: u32,
    nummer: u32,
    zug: TrainCharacteristics,
    von: u32,
    nach: u32,
    toleranz: PathTolerances,
) -> PathRequest {
    PathRequest::new(
        PathRequestId::new(id),
        TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Zugnummer"),
        zug,
        OperatingPointId::new(von),
        OperatingPointId::new(nach),
        Vec::new(),
        SimTime::from_seconds(WUNSCH_S),
        OperatingDays::DAILY,
        toleranz,
    )
    .expect("gültiger Antrag")
}

/// Die Zeitspanne, in der eine Fahrt den eingleisigen Ast belegt — relativ zu
/// ihrer Abfahrt.
fn ast_fenster(infra: &Infrastructure, laufweg: &Itinerary) -> (i64, i64) {
    let profil =
        derive_occupation_profile(infra, laufweg, &regional_train()).expect("gültiges Profil");
    let auf_dem_ast: Vec<&RelativeOccupation> = profil
        .occupations()
        .iter()
        .filter(|belegung| {
            matches!(
                belegung.resource(),
                ConflictResource::Block { track, .. } if track == TrackId::new(3001)
            )
        })
        .collect();
    let von = auf_dem_ast
        .iter()
        .map(|belegung| belegung.start_s())
        .min()
        .expect("der Laufweg führt über den Ast");
    let bis = auf_dem_ast
        .iter()
        .map(|belegung| belegung.end_s())
        .max()
        .expect("der Laufweg führt über den Ast");
    (von, bis)
}

/// Ein Belegungsbuch, in dem ein Gegenzug den Ast genau dann befährt, wenn ein
/// von Nordstadt um [`WUNSCH_S`] abfahrender Zug ihn befahren würde.
fn buch_mit_gegenzug(infra: &Infrastructure) -> OccupationLedger {
    let hin = nordstadt_bis_talheim(infra);
    let zurueck = talheim_bis_nordstadt(infra);
    let (hin_von, hin_bis) = ast_fenster(infra, &hin);
    let (zurueck_von, zurueck_bis) = ast_fenster(infra, &zurueck);

    // Die Mitten beider Astbelegungen zur Deckung bringen — so entsteht die
    // Gegenfahrt zuverlässig, ohne einen geratenen Zeitpunkt.
    let versatz = (hin_von + hin_bis) / 2 - (zurueck_von + zurueck_bis) / 2;

    let profil =
        derive_occupation_profile(infra, &zurueck, &regional_train()).expect("gültiges Profil");
    let mut buch = OccupationLedger::new(infra.exclusions().clone());
    for tag in 0..8_i64 {
        buch.insert(&TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, 26_801).expect("gültige Zugnummer"),
            SimTime::from_seconds(
                tag.saturating_mul(86_400)
                    .saturating_add(WUNSCH_S)
                    .saturating_add(versatz),
            ),
            &profil,
        ));
    }
    buch
}

#[test]
fn in_ein_leeres_netz_passt_die_wunschlage() {
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = OccupationLedger::new(infra.exclusions().clone());

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(600, 600, 300, 900, 1).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");

    assert_eq!(ergebnis.decision(), PathDecision::Granted);
    let angebot = ergebnis.offer().expect("ein Angebot");
    assert!(angebot.deviation().is_exact(), "{}", angebot.explain());
    assert!(ergebnis.desired_conflicts().is_clear());
    assert!(ergebnis.explain().contains("Annahme"));
}

#[test]
fn der_planner_kreuzt_in_sandberg_statt_zu_warten() {
    // Das ist der Beweis von M3.4. Der Konfliktprüfer aus M3.3 kennt für diese
    // Lage nur eine Antwort: später fahren. Der Planner hält die Wunschzeit und
    // legt einen Betriebshalt in Sandberg ein — die Kreuzung.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = buch_mit_gegenzug(&infra);

    let antrag = antrag(
        1,
        26_802,
        regional_train(),
        NORDSTADT,
        TALHEIM,
        PathTolerances::new(1_800, 1_800, 300, 1_800, 1).expect("gültige Toleranz"),
    );
    let ergebnis = planner.plan(&buch, &antrag).expect("planbar");

    assert_eq!(
        ergebnis.decision(),
        PathDecision::Alternative,
        "{}",
        ergebnis.explain()
    );

    let angebot = ergebnis.offer().expect("ein Angebot");
    assert_eq!(
        angebot.deviation().operational_stops(),
        [OperatingPointId::new(SANDBERG)],
        "der Planner kreuzt nicht in Sandberg: {}",
        angebot.explain()
    );
    assert_eq!(
        angebot.deviation().shift_s(),
        0,
        "die Wunschzeit wurde aufgegeben, obwohl die Kreuzung sie hält: {}",
        angebot.explain()
    );

    // Und die angebotene Trasse liegt wirklich frei — an jedem Verkehrstag.
    let mut probe = buch.clone();
    for tag in 0..7_i64 {
        let fahrt = angebot.pattern().materialise(tag).expect("Verkehrstag");
        probe
            .try_insert(&fahrt)
            .expect("die angebotene Trasse ist konfliktfrei");
    }
}

#[test]
fn die_kreuzung_ist_besser_als_die_auskunft_des_pruefers() {
    // Der Vergleich, um den es geht: Der Prüfer kann nur „so viel später"
    // sagen. Der Planner hält die Zeitlage. Beides ist zulässig — nur eines ist
    // gut.
    let infra = reference_infrastructure();
    let buch = buch_mit_gegenzug(&infra);
    let hin = nordstadt_bis_talheim(&infra);
    let profil =
        derive_occupation_profile(&infra, &hin, &regional_train()).expect("gültiges Profil");
    let fahrt = TrainRun::new(
        TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Zugnummer"),
        SimTime::from_seconds(WUNSCH_S),
        &profil,
    );

    let ShiftOutcome::Later(verspaetung) = buch.earliest_conflict_free_shift(&fahrt, 14_400) else {
        panic!(
            "der Prüfer findet keine auflösende Verspätung — die Lage ist nicht konfliktbehaftet"
        );
    };
    assert!(verspaetung > 0);

    let planner = TrainPathPlanner::new(&infra);
    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(1_800, 1_800, 300, 1_800, 1).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");

    let angebot = ergebnis.offer().expect("ein Angebot");
    assert!(
        angebot.deviation().shift_s().abs() < verspaetung,
        "der Planner ist nicht besser als die triviale Auflösung: {} gegen {verspaetung} s",
        angebot.explain()
    );
}

#[test]
fn ohne_zulaessigen_betriebshalt_bleibt_nur_die_verschiebung() {
    // Die Gegenprobe: Verbietet der Antrag den Betriebshalt, muss der Planner
    // auf die Zeitlage ausweichen. Ohne sie prüfte der Test oben nur, dass
    // irgendein Kandidat entsteht.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = buch_mit_gegenzug(&infra);

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(1_800, 1_800, 300, 0, 0).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");

    match ergebnis.decision() {
        PathDecision::Alternative => {
            let angebot = ergebnis.offer().expect("ein Angebot");
            assert!(angebot.deviation().operational_stops().is_empty());
            assert_ne!(angebot.deviation().shift_s(), 0);
        }
        PathDecision::Rejected => {}
        PathDecision::Granted => panic!("die Wunschlage ist belegt, kann also nicht frei sein"),
    }
}

#[test]
fn ein_antrag_ohne_abweichung_wird_abgelehnt_und_begruendet() {
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = buch_mit_gegenzug(&infra);

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::EXACT,
            ),
        )
        .expect("planbar");

    assert_eq!(ergebnis.decision(), PathDecision::Rejected);
    assert!(ergebnis.offer().is_none());

    // Die Begründung nennt Ressource, Fenster, Gegenzug und Konfliktart —
    // maschinenlesbar über den Bericht, verständlich über den Text.
    let bericht = ergebnis.desired_conflicts();
    assert!(!bericht.is_clear());
    let befund = &bericht.conflicts()[0];
    let text = ergebnis.explain();
    assert!(text.contains("Ablehnung"), "{text}");
    assert!(text.contains(&befund.resource().to_string()), "{text}");
    assert!(text.contains("RV 26801"), "{text}");
    assert!(text.contains("Gegenfahrt"), "{text}");
}

#[test]
fn zwei_gleiche_antraege_ergeben_dasselbe_ergebnis() {
    // Der Planner ist eine Funktion, kein Verfahren mit Gedächtnis. Ohne diese
    // Zusicherung wäre der `PlanningRun` aus M3.5 nicht reproduzierbar.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = buch_mit_gegenzug(&infra);
    let antrag = antrag(
        1,
        26_802,
        regional_train(),
        NORDSTADT,
        TALHEIM,
        PathTolerances::new(1_800, 1_800, 300, 1_800, 1).expect("gültige Toleranz"),
    );

    let erste = planner.plan(&buch, &antrag).expect("planbar");
    let zweite = planner.plan(&buch, &antrag).expect("planbar");
    assert_eq!(erste.decision(), zweite.decision());
    assert_eq!(erste.candidates(), zweite.candidates());
    assert_eq!(erste.explain(), zweite.explain());
}

#[test]
fn die_kandidaten_stehen_in_der_veroeffentlichten_rangfolge() {
    // E11: kein einzelner Optimierungswert. Der Planner liefert alle
    // zulässigen Kandidaten, geordnet nach einer festgelegten Rangfolge — die
    // Alternative bleibt sichtbar.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = buch_mit_gegenzug(&infra);

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(1_800, 1_800, 300, 1_800, 1).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");

    assert!(
        ergebnis.candidates().len() > 1,
        "nur ein Kandidat — die Alternative ist nicht sichtbar"
    );
    for paar in ergebnis.candidates().windows(2) {
        let a = paar[0].deviation();
        let b = paar[1].deviation();
        assert!(
            a.shift_s().abs() <= b.shift_s().abs(),
            "die Rangfolge ist verletzt: {} vor {}",
            paar[0].explain(),
            paar[1].explain()
        );
    }
}

#[test]
fn eine_unzulaessige_zugcharakteristik_faellt_auf() {
    // Der Ast nach Talheim hat keinen Fahrdraht. Ein rein elektrischer Zug
    // kommt dort nicht hin — und das ist eine Aussage über den Antrag, keine
    // leere Kandidatenliste.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = OccupationLedger::new(infra.exclusions().clone());

    let ergebnis = planner.plan(
        &buch,
        &antrag(
            1,
            26_802,
            elektrischer_triebzug(),
            NORDSTADT,
            TALHEIM,
            PathTolerances::EXACT,
        ),
    );
    assert!(matches!(ergebnis, Err(PlannerError::Conflict(_))));
}

#[test]
fn ein_gueterzug_findet_seinen_weg_ohne_bahnsteig() {
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::new(&infra);
    let buch = OccupationLedger::new(infra.exclusions().clone());

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                freight_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(600, 600, 300, 900, 0).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");
    assert_eq!(ergebnis.decision(), PathDecision::Granted);
}

#[test]
fn der_haltepunkt_taugt_nicht_zum_kreuzen() {
    // Waldhof ist ein Haltepunkt ohne Weichen. Ein dort wartender Zug stünde
    // dem Gegenzug im Weg — der Planner darf ihn deshalb nie als Betriebshalt
    // wählen.
    let infra = reference_infrastructure();
    let planner = TrainPathPlanner::with_options(
        &infra,
        PlannerOptions::default().with_max_route_candidates(4),
    );
    let buch = buch_mit_gegenzug(&infra);

    let ergebnis = planner
        .plan(
            &buch,
            &antrag(
                1,
                26_802,
                regional_train(),
                NORDSTADT,
                TALHEIM,
                PathTolerances::new(1_800, 1_800, 300, 1_800, 1).expect("gültige Toleranz"),
            ),
        )
        .expect("planbar");

    for kandidat in ergebnis.candidates() {
        assert!(
            !kandidat
                .deviation()
                .operational_stops()
                .contains(&OperatingPointId::new(WALDHOF)),
            "Betriebshalt im Haltepunkt Waldhof: {}",
            kandidat.explain()
        );
    }
}

/// Ein rein elektrischer Triebzug — er kann den nicht elektrifizierten Ast
/// nach Talheim nicht befahren.
fn elektrischer_triebzug() -> TrainCharacteristics {
    use zugfolge_infra::{
        Acceleration, ElectricSystems, Length, Mass, PowerSystem, ProtectionSystem, Speed,
        SpeedCategory, TractionType, TrainCharacteristicsId, TrainProtection,
    };
    TrainCharacteristics::new(
        TrainCharacteristicsId::new(3),
        "Elektrotriebzug",
        Mass::from_tonnes(130),
        Length::from_metres(70),
        Speed::from_km_h(160),
        SpeedCategory::Standard,
        Acceleration::from_millimetres_per_second_squared(900),
        Acceleration::from_millimetres_per_second_squared(1_000),
        TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
        TrainProtection::single(ProtectionSystem::Pzb),
    )
    .expect("gültige Zugcharakteristik")
}
