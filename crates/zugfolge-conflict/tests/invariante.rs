//! Invariante 1 als Property-Test — **M3.3**.
//!
//! `crates/CLAUDE.md`: „Invariante 1 (‚keine zwei Züge auf derselben
//! Konfliktressource') gehört ab M3 in einen Property-Test, nicht in
//! Beispieltests." Genau das steht hier.
//!
//! Der Test streut **400 Lagen**: zufällige Zugcharakteristiken, Laufwege in
//! beiden Richtungen und Abfahrtszeiten über ein Fenster von zwei Stunden. Jede
//! Fahrt wird über [`OccupationLedger::try_insert`] angeboten; angenommen wird
//! sie nur, wenn der Prüfer sie freigibt.
//!
//! Geprüft wird gegen eine **zweite, unabhängige Implementierung**: ein
//! stumpfer paarweiser Vergleich aller angenommenen Belegungen. Ein Prüfer, der
//! sich selbst prüft, prüft nichts — der Vergleich muss von außen kommen.
//!
//! Der Zufall stammt aus einem benannten Substream des Weltseeds. Ein
//! Fehlschlag ist dadurch reproduzierbar; ein `thread_rng` wäre hier wertlos.

use zugfolge_conflict::{
    ConflictKind, ConflictResource, Infrastructure, Itinerary, OccupationLedger, OccupationProfile,
    ResourceExclusions, TrainCategory, TrainNumber, TrainRun, derive_occupation_profile,
    example::{
        freight_train, nordstadt_bis_talheim, reference_infrastructure, regional_train,
        talheim_bis_nordstadt,
    },
    minimum_headway,
};
use zugfolge_determinism::{Rng, SimTime, Substream, WorldSeed};

/// Wie viele Lagen gestreut werden.
const LAGEN: u32 = 400;

/// Wie viele Fahrten je Lage angeboten werden.
const FAHRTEN_JE_LAGE: usize = 6;

/// Das Fenster, über das die Abfahrten gestreut werden, in Sekunden.
const FENSTER_S: u64 = 7_200;

/// Zieht einen Eintrag aus einer Liste — ganzzahlig und ohne stillen
/// Zahlenverlust (Invariante 3).
fn ziehe<'a, T>(rng: &mut Rng, items: &'a [T]) -> &'a T {
    let bound = u64::try_from(items.len()).expect("die Liste passt in u64");
    let index = usize::try_from(rng.below(bound)).expect("der Index passt in usize");
    &items[index]
}

/// Die vier Profile, aus denen eine Lage schöpft: zwei Richtungen, zwei
/// Zugcharakteristiken.
fn profile(infrastructure: &Infrastructure) -> Vec<(Itinerary, OccupationProfile)> {
    let mut alle = Vec::new();
    for laufweg in [
        nordstadt_bis_talheim(infrastructure),
        talheim_bis_nordstadt(infrastructure),
    ] {
        for zug in [regional_train(), freight_train()] {
            let profil =
                derive_occupation_profile(infrastructure, &laufweg, &zug).expect("gültiges Profil");
            alle.push((laufweg.clone(), profil));
        }
    }
    alle
}

/// Der stumpfe, zweite Prüfer: Vergleicht **alle** Paare von Belegungen.
///
/// Er ist absichtlich langsam und dumm — er teilt keine Zeile mit dem Prüfer,
/// den er prüft.
fn zweite_pruefung(runs: &[TrainRun], exclusions: &ResourceExclusions) -> Vec<String> {
    let mut befunde = Vec::new();
    for (index, erste) in runs.iter().enumerate() {
        for zweite in runs.iter().skip(index + 1) {
            for a in erste.staircase().steps() {
                for b in zweite.staircase().steps() {
                    let dieselbe = a.resource() == b.resource();
                    let ausschluss = exclusions.excludes(a.resource(), b.resource());
                    if !(dieselbe || ausschluss) {
                        continue;
                    }
                    let ueberschneidung = a.start().seconds() < b.end().seconds()
                        && b.start().seconds() < a.end().seconds();
                    if ueberschneidung {
                        befunde.push(format!(
                            "{} und {} überschneiden sich auf {} von {} bis {}",
                            erste.reference(),
                            zweite.reference(),
                            a.resource(),
                            a.start().seconds().max(b.start().seconds()),
                            a.end().seconds().min(b.end().seconds()),
                        ));
                    }
                }
            }
        }
    }
    befunde
}

#[test]
fn kein_belegungsbuch_verletzt_invariante_eins() {
    let infra = reference_infrastructure();
    let profile = profile(&infra);

    let mut angenommen_gesamt = 0_usize;
    let mut abgewiesen_gesamt = 0_usize;

    for lage in 0..LAGEN {
        let mut rng = WorldSeed::new(u64::from(lage), 1).substream(Substream::Tiebreak);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        let mut angenommen: Vec<TrainRun> = Vec::new();

        for nummer in 0..FAHRTEN_JE_LAGE {
            let (_, profil) = ziehe(&mut rng, &profile);
            let abfahrt = SimTime::from_seconds(
                28_800_i64.saturating_add(i64::try_from(rng.below(FENSTER_S)).unwrap_or(0)),
            );
            let zugnummer = TrainNumber::new(
                TrainCategory::Regional,
                20_000 + u32::try_from(nummer).unwrap_or(0),
            )
            .expect("gültige Zugnummer");
            let fahrt = TrainRun::new(zugnummer, abfahrt, profil);

            match buch.try_insert(&fahrt) {
                Ok(()) => {
                    angenommen.push(fahrt);
                    angenommen_gesamt = angenommen_gesamt.saturating_add(1);
                }
                Err(bericht) => {
                    abgewiesen_gesamt = abgewiesen_gesamt.saturating_add(1);
                    // Ein Befund muss echt sein: Die genannten Sperrzeiten
                    // überschneiden sich wirklich, und die Ressourcen gehören
                    // wirklich zusammen.
                    assert!(!bericht.is_clear());
                    for befund in bericht.conflicts() {
                        assert!(
                            befund.own().overlaps(&befund.other()),
                            "Lage {lage}: gemeldeter Befund ohne Überschneidung"
                        );
                        let zusammen = befund.resource() == befund.other_resource()
                            || infra
                                .exclusions()
                                .excludes(befund.resource(), befund.other_resource());
                        assert!(
                            zusammen,
                            "Lage {lage}: Befund über zwei unabhängige Ressourcen"
                        );
                    }
                }
            }
        }

        let fremdbefunde = zweite_pruefung(&angenommen, infra.exclusions());
        assert!(
            fremdbefunde.is_empty(),
            "Lage {lage}: der zweite Prüfer findet, was der erste durchgelassen hat:\n{}",
            fremdbefunde.join("\n")
        );
    }

    // Eine Prüfung, die nie ablehnt, prüft nichts; eine, die nie annimmt,
    // ebenso wenig.
    assert!(angenommen_gesamt > 0, "keine einzige Fahrt angenommen");
    assert!(abgewiesen_gesamt > 0, "keine einzige Fahrt abgewiesen");
}

#[test]
fn jede_gemeldete_verschiebung_ist_die_kleinste() {
    // Der schärfste Test des Prüfers: Der gemeldete Wert muss stimmen, nicht
    // nur grob in die richtige Richtung zeigen — über 200 gestreute Lagen.
    let infra = reference_infrastructure();
    let profile = profile(&infra);
    let mut geprueft = 0_usize;

    for lage in 0..200_u32 {
        let mut rng = WorldSeed::new(u64::from(lage), 2).substream(Substream::Tiebreak);
        let (_, erstes) = ziehe(&mut rng, &profile);
        let (_, zweites) = ziehe(&mut rng, &profile);

        let erste = TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            SimTime::from_seconds(28_800),
            erstes,
        );
        let zweite = TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, 26_804).expect("gültige Nummer"),
            SimTime::from_seconds(
                28_800_i64.saturating_add(i64::try_from(rng.below(1_800)).unwrap_or(0)),
            ),
            zweites,
        );

        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&erste);
        if buch.check(&zweite).is_clear() {
            continue;
        }

        let Some(abstand) = minimum_headway(&erste, &zweite, infra.exclusions(), 14_400) else {
            continue;
        };
        let verschiebung = abstand - (zweite.departure().seconds() - erste.departure().seconds());
        assert!(
            buch.check(&zweite.shifted(verschiebung)).is_clear(),
            "Lage {lage}: die gemeldete Verschiebung um {verschiebung} s löst nicht auf"
        );
        assert!(
            !buch.check(&zweite.shifted(verschiebung - 1)).is_clear(),
            "Lage {lage}: eine Sekunde weniger ist bereits frei — {verschiebung} s ist nicht der \
             kleinste Wert"
        );
        geprueft = geprueft.saturating_add(1);
    }

    assert!(
        geprueft > 0,
        "keine einzige Lage war überhaupt konfliktbehaftet"
    );
}

#[test]
fn die_konfliktart_folgt_aus_der_gleisigkeit() {
    // Der Befund des Spikes aus M0.3, hier als Zusicherung: Eine Gegenfahrt
    // kann es nur dort geben, wo ein Gleis beide Richtungen trägt. Auf einem
    // Richtungsgleis ist sie ausgeschlossen — ohne dass der Prüfer eine
    // zweite Regel dafür bräuchte.
    let infra = reference_infrastructure();
    let profile = profile(&infra);
    let mut gegenfahrten = 0_usize;

    for lage in 0..LAGEN {
        let mut rng = WorldSeed::new(u64::from(lage), 3).substream(Substream::Tiebreak);
        let (_, erstes) = ziehe(&mut rng, &profile);
        let (_, zweites) = ziehe(&mut rng, &profile);

        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            SimTime::from_seconds(28_800),
            erstes,
        ));
        let bericht = buch.check(&TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, 26_801).expect("gültige Nummer"),
            SimTime::from_seconds(
                28_800_i64.saturating_add(i64::try_from(rng.below(3_600)).unwrap_or(0)),
            ),
            zweites,
        ));

        for befund in bericht.conflicts() {
            if befund.kind() != ConflictKind::OpposingMove {
                continue;
            }
            gegenfahrten = gegenfahrten.saturating_add(1);
            let gleis = match befund.resource() {
                ConflictResource::Block { track, .. } | ConflictResource::Track(track) => track,
                andere => panic!("Lage {lage}: Gegenfahrt auf {andere}"),
            };
            let gleis = infra.track(gleis).expect("bekanntes Gleis");
            assert!(
                gleis.direction().permits_opposing_moves(),
                "Lage {lage}: Gegenfahrt auf dem Richtungsgleis {gleis}"
            );
        }
    }

    assert!(gegenfahrten > 0, "keine einzige Gegenfahrt gefunden");
}
