//! Invariante 1 unter Streuung.
//!
//! > Keine zwei Züge dürfen zur gleichen Zeit inkompatible Belegungen derselben
//! > Konfliktressource besitzen.
//!
//! Die Beispieltests in den Modulen prüfen einzelne Lagen. Dieser Test prüft
//! sie über 400 gestreute Abfahrtszeiten hinweg und stellt der Konfliktprüfung
//! dabei eine **zweite, unabhängig geschriebene** Prüfung gegenüber: eine
//! stumpfe Doppelschleife über alle Paare von Sperrzeiten. Weichen die beiden
//! voneinander ab, ist eine von ihnen falsch.
//!
//! Der eigentliche Property-Test zu Invariante 1 gehört nach M3 — dort gegen
//! den echten Konfliktprüfer und mit einem richtigen Generator. Dies hier ist
//! seine kleine Vorstufe, und sie kostet fast nichts.
//!
//! Die Streuung stammt aus einem benannten Substream des Weltseeds, nicht aus
//! einem Zufallsgenerator des Betriebssystems: Ein fehlgeschlagener Lauf muss
//! wiederholbar sein.

use zugfolge_determinism::{SimTime, Substream, WorldSeed};
use zugfolge_spike_blocking_time_staircase::blocking::{BlockingTimeStaircase, staircase};
use zugfolge_spike_blocking_time_staircase::case::Case;
use zugfolge_spike_blocking_time_staircase::conflict::{
    ConflictKind, ShiftResult, conflicts, earliest_conflict_free_shift,
};
use zugfolge_spike_blocking_time_staircase::network::Network;
use zugfolge_spike_blocking_time_staircase::train::TrainRun;

/// Zahl der geprüften Lagen je Betriebsfall.
const LAGEN: u32 = 100;

/// Die zweite, absichtlich stumpfe Prüfung: jedes Paar von Sperrzeiten auf
/// derselben Ressource, ohne Sortierung, ohne Gruppierung, ohne Kunstgriff.
fn ueberschneidungen(treppen: &[BlockingTimeStaircase]) -> Vec<(u16, i64, i64)> {
    let mut gefunden = Vec::new();
    for (links, erste) in treppen.iter().enumerate() {
        for zweite in treppen.iter().skip(links + 1) {
            for a in &erste.steps {
                for b in &zweite.steps {
                    if a.section != b.section {
                        continue;
                    }
                    let von = a.start.seconds().max(b.start.seconds());
                    let bis = a.end.seconds().min(b.end.seconds());
                    if von < bis {
                        gefunden.push((a.section.raw(), von, bis));
                    }
                }
            }
        }
    }
    gefunden.sort_unstable();
    gefunden
}

fn treppen(network: &Network, runs: &[TrainRun]) -> Vec<BlockingTimeStaircase> {
    runs.iter().map(|fahrt| staircase(network, fahrt)).collect()
}

/// Gestreute Lagen eines Betriebsfalls: der zweite Zug wandert um bis zu
/// ±12 Minuten, in Sekundenschritten aus einem benannten Substream.
fn lagen(fall: &Case) -> Vec<Vec<TrainRun>> {
    let mut rng = WorldSeed::new(20_260_806, 1).substream(Substream::Tiebreak);
    (0..LAGEN)
        .map(|_| {
            let versatz = i64::try_from(rng.below(1_441)).expect("Wurf passt in 64 Bit") - 720;
            vec![fall.runs[0].clone(), fall.runs[1].shifted(versatz)]
        })
        .collect()
}

#[test]
fn beide_pruefungen_finden_dieselben_ueberschneidungen() {
    for fall in Case::all() {
        for runs in lagen(&fall) {
            let treppen = treppen(&fall.network, &runs);
            let befunde = conflicts(&treppen);
            let stumpf = ueberschneidungen(&treppen);

            let mut aus_befunden: Vec<(u16, i64, i64)> = befunde
                .iter()
                .map(|befund| {
                    (
                        befund.section.raw(),
                        befund.overlap_start.seconds(),
                        befund.overlap_end.seconds(),
                    )
                })
                .collect();
            aus_befunden.sort_unstable();

            assert_eq!(
                aus_befunden,
                stumpf,
                "{}: die Konfliktprüfung weicht von der stumpfen Prüfung ab \
                 (Abfahrt zweiter Zug {})",
                fall.id,
                runs[1].departure.seconds()
            );
        }
    }
}

#[test]
fn eine_gemeldete_konfliktfreiheit_haelt_der_gegenprobe_stand() {
    // Der teurere Fehler ist nicht der falsche Alarm, sondern der übersehene
    // Konflikt: Er landet im Fahrplan und fällt erst im Betrieb auf.
    let mut geprueft = 0_u32;
    for fall in Case::all() {
        for runs in lagen(&fall) {
            let treppen = treppen(&fall.network, &runs);
            if conflicts(&treppen).is_empty() {
                assert!(
                    ueberschneidungen(&treppen).is_empty(),
                    "{}: konfliktfrei gemeldet, aber es gibt eine Überschneidung",
                    fall.id
                );
                geprueft += 1;
            }
        }
    }
    assert!(
        geprueft > 0,
        "keine einzige Lage war konfliktfrei — der Test prüft nichts"
    );
}

#[test]
fn die_konfliktart_folgt_aus_der_gleisigkeit() {
    // Eine Gegenfahrt kann es nur auf einem eingleisigen Abschnitt geben.
    // Meldete die Prüfung sie auf einem Richtungsgleis, wäre das Netzmodell
    // oder die Zuordnung kaputt.
    for fall in Case::all() {
        for runs in lagen(&fall) {
            let treppen = treppen(&fall.network, &runs);
            for befund in conflicts(&treppen) {
                let abschnitt = fall.network.section(befund.section);
                if befund.kind == ConflictKind::OpposingMove {
                    assert!(
                        abschnitt.is_single_track(),
                        "{}: Gegenfahrt auf {} gemeldet",
                        fall.id,
                        abschnitt.name
                    );
                }
            }
        }
    }
}

#[test]
fn die_gemeldete_verschiebung_stimmt_in_jeder_lage() {
    // Die Auskunft „so viel später ist es konfliktfrei" muss stimmen — sonst
    // ist sie schlimmer als keine Auskunft. Geprüft wird beides: dass die
    // Verschiebung reicht und dass eine Sekunde weniger nicht reicht.
    let mut aufgeloest = 0_u32;
    for fall in Case::all() {
        for runs in lagen(&fall) {
            match earliest_conflict_free_shift(&fall.network, &runs, 1) {
                ShiftResult::None => {
                    assert!(
                        conflicts(&treppen(&fall.network, &runs)).is_empty(),
                        "{}",
                        fall.id
                    );
                }
                ShiftResult::Later(sekunden) => {
                    assert!(sekunden > 0);
                    let geloest = vec![runs[0].clone(), runs[1].shifted(sekunden)];
                    assert!(
                        conflicts(&treppen(&fall.network, &geloest)).is_empty(),
                        "{}: die gemeldete Verschiebung von {sekunden} s reicht nicht",
                        fall.id
                    );
                    let knapp = vec![runs[0].clone(), runs[1].shifted(sekunden - 1)];
                    assert!(
                        !conflicts(&treppen(&fall.network, &knapp)).is_empty(),
                        "{}: {sekunden} s ist nicht die kleinste auflösende Verschiebung",
                        fall.id
                    );
                    aufgeloest += 1;
                }
                ShiftResult::Impossible => {
                    panic!("{}: keine Auflösung gefunden", fall.id);
                }
            }
        }
    }
    assert!(aufgeloest > 0, "keine Lage war überhaupt aufzulösen");
}

#[test]
fn eine_einzelne_fahrt_ist_nie_mit_sich_selbst_im_konflikt() {
    // Die Stufen einer Treppe überschneiden sich zwangsläufig — sie gehören
    // aber demselben Zug. Wer das verwechselt, bekommt eine Prüfung, die jede
    // einzelne Zugfahrt ablehnt.
    let netz = Network::example();
    for fall in Case::all() {
        for fahrt in &fall.runs {
            for verschiebung in [-600, 0, 600] {
                let treppe = staircase(&netz, &fahrt.shifted(verschiebung));
                assert!(
                    conflicts(std::slice::from_ref(&treppe)).is_empty(),
                    "{} meldet einen Konflikt mit sich selbst",
                    fahrt.number
                );
                assert!(treppe.first_second() < treppe.last_second());
                assert!(treppe.arrival() > SimTime::EPOCH);
            }
        }
    }
}
