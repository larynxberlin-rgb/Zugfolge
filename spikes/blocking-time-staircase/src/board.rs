//! Dieselbe Rechnung als Zustandsmodell.
//!
//! `docs/CLAUDE.md` unter `crates/`: „Zustandsrelevantes Modell? Dann
//! `DeterministicModel` implementieren und einen Golden-Master anlegen."
//! Der Spike ist Wegwerf-Code, aber genau das darf keine Ausnahme sein: Die
//! Sperrzeitenrechnung ist die erste zustandsrelevante Rechnung des Projekts.
//! Wäre sie plattformabhängig, fiele das sonst erst in M3 auf — dann aber
//! unter allen späteren Schichten begraben.
//!
//! Der Zustand ist bewusst vollständig: Laufwege, Sperrzeiten, Belegungen je
//! Konfliktressource und Befunde. Was nicht in den Hash geht, prüft kein
//! Determinismus-Test je.

use std::collections::BTreeMap;

use zugfolge_determinism::{DeterministicModel, SimTime, StateHasher};

use crate::blocking::{BlockingTimeStaircase, staircase};
use crate::conflict::{ConflictKind, OccupationConflict, conflicts};
use crate::network::{Direction, Network, ResourceId};
use crate::train::TrainRun;

/// Was an der Belegungstafel geschehen kann.
#[derive(Clone, Debug)]
pub enum Command {
    /// Eine Zugfahrt wird angemeldet. Der Zeitpunkt des Kommandos ist der
    /// Anmeldezeitpunkt, nicht die Abfahrt.
    Schedule(Box<TrainRun>),
}

/// Angemeldete Fahrten, ihre Sperrzeiten und die daraus folgenden Befunde.
#[derive(Clone, Debug)]
pub struct ConflictBoard {
    network: Network,
    filed_at: Vec<SimTime>,
    runs: Vec<TrainRun>,
    staircases: Vec<BlockingTimeStaircase>,
    findings: Vec<OccupationConflict>,
}

impl ConflictBoard {
    /// Eine leere Tafel über einem Netz.
    pub const fn new(network: Network) -> Self {
        Self {
            network,
            filed_at: Vec::new(),
            runs: Vec::new(),
            staircases: Vec::new(),
            findings: Vec::new(),
        }
    }

    /// Die angemeldeten Fahrten.
    pub fn runs(&self) -> &[TrainRun] {
        &self.runs
    }

    /// Die Sperrzeitentreppen aller angemeldeten Fahrten.
    pub fn staircases(&self) -> &[BlockingTimeStaircase] {
        &self.staircases
    }

    /// Die Befunde der letzten Prüfung.
    pub fn findings(&self) -> &[OccupationConflict] {
        &self.findings
    }

    /// Belegungen je Konfliktressource, geordnet — die Sicht, die eine
    /// Trassenvergabe später braucht.
    pub fn occupation(&self) -> BTreeMap<ResourceId, Vec<(SimTime, SimTime, usize)>> {
        let mut tafel: BTreeMap<ResourceId, Vec<(SimTime, SimTime, usize)>> = BTreeMap::new();
        for (index, treppe) in self.staircases.iter().enumerate() {
            for stufe in &treppe.steps {
                tafel
                    .entry(stufe.section)
                    .or_default()
                    .push((stufe.start, stufe.end, index));
            }
        }
        for eintraege in tafel.values_mut() {
            eintraege.sort_by_key(|(start, ende, lauf)| (start.seconds(), ende.seconds(), *lauf));
        }
        tafel
    }
}

impl DeterministicModel for ConflictBoard {
    type Command = Command;
    const SCHEMA: &'static str = "blocking-time-staircase/v1";

    fn apply(&mut self, at: SimTime, command: &Command) {
        match command {
            Command::Schedule(run) => {
                self.filed_at.push(at);
                self.staircases.push(staircase(&self.network, run));
                self.runs.push((**run).clone());
                self.findings = conflicts(&self.staircases);
            }
        }
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher.seq("fahrten", self.runs.len());
        for (index, run) in self.runs.iter().enumerate() {
            hasher.text("zug", run.number);
            hasher.int("abfahrt", run.departure.seconds());
            hasher.int(
                "angemeldet",
                self.filed_at
                    .get(index)
                    .map_or(0, |zeitpunkt| zeitpunkt.seconds()),
            );
            hasher.int(
                "richtung",
                match run.itinerary.direction {
                    Direction::Outbound => 0,
                    Direction::Inbound => 1,
                },
            );
            let treppe = &self.staircases[index];
            hasher.seq("stufen", treppe.steps.len());
            for stufe in &treppe.steps {
                hasher.uint("ressource", u64::from(stufe.section.raw()));
                hasher.int("sperrbeginn", stufe.start.seconds());
                hasher.int("annaeherung", stufe.approach_start.seconds());
                hasher.int("einfahrt", stufe.entry.seconds());
                hasher.int("ausfahrt", stufe.exit.seconds());
                hasher.int("geraeumt", stufe.cleared.seconds());
                hasher.int("sperrende", stufe.end.seconds());
            }
        }

        let tafel = self.occupation();
        hasher.seq("ressourcen", tafel.len());
        for (ressource, eintraege) in &tafel {
            hasher.uint("ressource", u64::from(ressource.raw()));
            hasher.seq("belegungen", eintraege.len());
            for (start, ende, lauf) in eintraege {
                hasher.int("von", start.seconds());
                hasher.int("bis", ende.seconds());
                hasher.uint(
                    "lauf",
                    u64::try_from(*lauf).expect("Laufindex passt in 64 Bit"),
                );
            }
        }

        hasher.seq("befunde", self.findings.len());
        for befund in &self.findings {
            hasher.text("kennung", &befund.label);
            hasher.uint("ressource", u64::from(befund.section.raw()));
            hasher.int(
                "art",
                match befund.kind {
                    ConflictKind::Headway => 0,
                    ConflictKind::OpposingMove => 1,
                },
            );
            hasher.uint(
                "erster",
                u64::try_from(befund.first_run).expect("Laufindex passt in 64 Bit"),
            );
            hasher.uint(
                "zweiter",
                u64::try_from(befund.second_run).expect("Laufindex passt in 64 Bit"),
            );
            hasher.int("von", befund.overlap_start.seconds());
            hasher.int("bis", befund.overlap_end.seconds());
        }
    }
}

#[cfg(test)]
mod tests {
    use zugfolge_determinism::{DeterministicModel, SimTime};

    use super::{Command, ConflictBoard};
    use crate::case::Case;
    use crate::network::Network;

    fn tafel(fall: &Case) -> ConflictBoard {
        let mut board = ConflictBoard::new(Network::example());
        for (nummer, fahrt) in fall.runs.iter().enumerate() {
            board.apply(
                SimTime::from_seconds(i64::try_from(nummer).expect("Index passt") * 60),
                &Command::Schedule(Box::new(fahrt.clone())),
            );
        }
        board
    }

    #[test]
    fn die_tafel_findet_dieselben_befunde_wie_die_direkte_pruefung() {
        for fall in Case::all() {
            let board = tafel(&fall);
            let direkt = fall.conflicts();
            assert_eq!(board.findings().len(), direkt.len(), "{}", fall.id);
            for (a, b) in board.findings().iter().zip(direkt.iter()) {
                assert_eq!(a.label, b.label);
                assert_eq!(a.section, b.section);
                assert_eq!(a.overlap_start, b.overlap_start);
            }
        }
    }

    #[test]
    fn der_zustand_haengt_am_anmeldezeitpunkt() {
        // Der Anmeldezeitpunkt gehört zum Zustand: Er entscheidet später über
        // Reihenfolge und Nachweisbarkeit. Ginge er nicht in den Hash, wäre der
        // Golden-Master blind dafür.
        let fall = Case::crossing_conflict();
        let mut frueh = ConflictBoard::new(Network::example());
        let mut spaet = ConflictBoard::new(Network::example());
        for fahrt in &fall.runs {
            frueh.apply(SimTime::EPOCH, &Command::Schedule(Box::new(fahrt.clone())));
            spaet.apply(
                SimTime::from_seconds(3600),
                &Command::Schedule(Box::new(fahrt.clone())),
            );
        }
        assert_ne!(frueh.state_hash(), spaet.state_hash());
    }

    #[test]
    fn die_belegungstafel_ist_nach_ressource_und_zeit_geordnet() {
        let board = tafel(&Case::headway_conflict());
        for (_, eintraege) in board.occupation() {
            for paar in eintraege.windows(2) {
                assert!(paar[0].0.seconds() <= paar[1].0.seconds());
            }
        }
    }
}
