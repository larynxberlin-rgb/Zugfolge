//! Determinismus- und Golden-Master-Test der Sperrzeitenrechnung.
//!
//! Die Rechnung ist ganzzahlig und ohne Uhr, ohne Zufall und ohne ungeordnete
//! Menge. Genau das behauptet jede solche Rechnung von sich, bis ein zweiter
//! Rechner das Gegenteil zeigt. Dieser Test hält die Behauptung fest: derselbe
//! Kommandolog ergibt denselben Zustands-Hash — auf Linux und auf Windows,
//! heute und in zwei Jahren.

use zugfolge_determinism::{
    Scenario, SimTime, StateHash, WorldSeed, assert_deterministic, assert_golden, golden_path, run,
};
use zugfolge_spike_blocking_time_staircase::board::{Command, ConflictBoard};
use zugfolge_spike_blocking_time_staircase::case::Case;
use zugfolge_spike_blocking_time_staircase::network::Network;

/// Der Weltseed des Spikes. Der Zufall spielt hier keine Rolle — der Spike
/// entscheidet nichts im Gleichstand —, aber der Seed gehört trotzdem in jeden
/// Lauf: Er ist Teil des Vertrags des Harnischs.
fn seed() -> WorldSeed {
    WorldSeed::new(20_260_806, 1)
}

/// Meldet alle Fahrten aller Betriebsfälle an einer Tafel an. Ein Kommandolog
/// über alle vier Fälle prüft mehr als vier einzelne Läufe: Die Fälle teilen
/// sich die Ressourcen und erzeugen dadurch mehr Belegungen je Abschnitt, als
/// jeder einzelne Fall hätte.
fn kommandolog() -> Scenario<Command> {
    let mut scenario = Scenario::new(seed());
    let mut angemeldet = 0_i64;
    for fall in Case::all() {
        for fahrt in fall.runs {
            scenario = scenario.at(
                SimTime::from_seconds(angemeldet * 30),
                Command::Schedule(Box::new(fahrt)),
            );
            angemeldet += 1;
        }
    }
    scenario
}

fn lauf() -> StateHash {
    run::<ConflictBoard, _>(&kommandolog(), |_seed| {
        ConflictBoard::new(Network::example())
    })
}

#[test]
fn zwei_laeufe_ergeben_denselben_zustand() {
    assert_deterministic::<ConflictBoard, _>("sperrzeitentreppe", &kommandolog(), |_seed| {
        ConflictBoard::new(Network::example())
    });
}

#[test]
fn golden_master_haelt_ueber_plattformen() {
    // Der Beweis von M0.3, soweit er maschinell prüfbar ist: Die
    // Sperrzeitenrechnung liefert auf jeder Plattform denselben Zustand.
    // Ändert sich dieser Hash, hat sich entweder eine Regel geändert — dann
    // gehört die Begründung in den Commit — oder etwas ist kaputt.
    assert_golden(golden_path!("blocking-time-staircase"), lauf());
}

#[test]
fn eine_andere_abfahrtszeit_ergibt_einen_anderen_zustand() {
    // Ohne diesen Test wäre der Golden-Master auch dann grün, wenn die
    // Rechnung die Abfahrtszeit gar nicht mehr beachtete.
    let fall = Case::crossing_conflict();
    let verschoben = Scenario::new(seed())
        .at(
            SimTime::EPOCH,
            Command::Schedule(Box::new(fall.runs[0].clone())),
        )
        .at(
            SimTime::from_seconds(30),
            Command::Schedule(Box::new(fall.runs[1].shifted(60))),
        );
    let original = Scenario::new(seed())
        .at(
            SimTime::EPOCH,
            Command::Schedule(Box::new(fall.runs[0].clone())),
        )
        .at(
            SimTime::from_seconds(30),
            Command::Schedule(Box::new(fall.runs[1].clone())),
        );

    assert_ne!(
        run::<ConflictBoard, _>(&original, |_seed| ConflictBoard::new(Network::example())),
        run::<ConflictBoard, _>(&verschoben, |_seed| ConflictBoard::new(Network::example())),
    );
}

#[test]
fn der_zustand_enthaelt_die_befunde() {
    // Ein Zustands-Hash, der die Konflikte nicht enthält, prüft die Hälfte der
    // Rechnung nicht. Dieser Test hält fest, dass sie enthalten sind.
    let fall = Case::crossing_conflict();
    let mit_konflikt = Scenario::new(seed())
        .at(
            SimTime::EPOCH,
            Command::Schedule(Box::new(fall.runs[0].clone())),
        )
        .at(
            SimTime::EPOCH,
            Command::Schedule(Box::new(fall.runs[1].clone())),
        );
    let mut board = ConflictBoard::new(Network::example());
    for (at, command) in mit_konflikt.commands() {
        zugfolge_determinism::DeterministicModel::apply(&mut board, *at, command);
    }
    assert_eq!(board.findings().len(), 2);
    assert_eq!(board.runs().len(), 2);
    assert_eq!(board.staircases().len(), 2);
}
