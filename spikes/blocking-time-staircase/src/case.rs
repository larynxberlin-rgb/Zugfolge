//! Die Betriebsfälle, die der Spike vorführt.
//!
//! Vier Fälle, jeweils zwei Züge. Zwei zeigen einen echten Belegungskonflikt,
//! zwei die konfliktfreie Lage — denn eine Prüfung, die immer Rot meldet, ist
//! genauso wertlos wie eine, die immer Grün meldet.
//!
//! | Fall | Was er zeigt |
//! |------|--------------|
//! | `crossing-conflict` | Gegenfahrt auf dem eingleisigen Ast |
//! | `crossing-sandberg` | dieselbe Lage, gelöst durch Kreuzung in Sandberg |
//! | `headway-conflict` | zu dichte Zugfolge auf der zweigleisigen Strecke |
//! | `headway-clear` | dieselbe Lage mit der kleinsten zulässigen Zugfolgezeit |
//!
//! Die beiden konfliktfreien Fälle sind **nicht von Hand ausgerechnet**, wo es
//! vermeidbar war: `headway-clear` entsteht aus `headway-conflict` durch die
//! Verschiebung, die die Konfliktprüfung selbst meldet. Damit kann der Fall
//! nicht stillschweigend von der Prüfung abdriften.

use zugfolge_determinism::SimTime;

use crate::blocking::{BlockingTimeStaircase, staircase};
use crate::conflict::{OccupationConflict, ShiftResult, conflicts, earliest_conflict_free_shift};
use crate::network::{Direction, Network};
use crate::train::{REGIONAL_TRAIN, TrainRun};
use crate::{clock, duration};

/// 08:00:00 des ersten Welttages — der Bezugspunkt aller Fälle.
const ACHT_UHR: i64 = 8 * 3600;

/// Ein Betriebsfall: Netz, Züge und die Frage, die er beantwortet.
#[derive(Clone, Debug)]
pub struct Case {
    /// Kennung — zugleich der Dateiname des Bildfahrplans.
    pub id: &'static str,
    /// Überschrift des Bildfahrplans.
    pub title: &'static str,
    /// Was der Fall zeigt, in einem Satz.
    pub summary: &'static str,
    /// Das Netz.
    pub network: Network,
    /// Die beiden Zugfahrten.
    pub runs: Vec<TrainRun>,
}

impl Case {
    /// Alle Fälle in fester Reihenfolge.
    pub fn all() -> Vec<Self> {
        vec![
            Self::crossing_conflict(),
            Self::crossing_sandberg(),
            Self::headway_conflict(),
            Self::headway_clear(),
        ]
    }

    /// Ein Fall zu seiner Kennung.
    pub fn by_id(id: &str) -> Option<Self> {
        Self::all().into_iter().find(|fall| fall.id == id)
    }

    /// Gegenfahrt: Beide Züge wollen zur selben Zeit auf den eingleisigen Ast.
    pub fn crossing_conflict() -> Self {
        let network = Network::example();
        let runs = vec![
            hinfahrt(&network, ACHT_UHR),
            gegenfahrt(&network, ACHT_UHR + 7 * 60),
        ];
        Self {
            id: "crossing-conflict",
            title: "Gegenfahrt auf dem eingleisigen Ast",
            summary: "RB 26802 fährt in Talheim ab, während RB 26801 den Ast noch befährt. \
                      Beide Züge beanspruchen dieselben Blockabschnitte in entgegengesetzter Richtung.",
            network,
            runs,
        }
    }

    /// Dieselbe Lage, betrieblich richtig gelöst: Die Züge kreuzen in Sandberg.
    pub fn crossing_sandberg() -> Self {
        let network = Network::example();
        let runs = vec![
            hinfahrt(&network, ACHT_UHR),
            gegenfahrt(&network, ACHT_UHR + 60),
        ];
        Self {
            id: "crossing-sandberg",
            title: "Kreuzung in Sandberg",
            summary: "RB 26802 räumt den Ast, bevor RB 26801 ihn befährt. Die beiden Züge \
                      begegnen sich in Sandberg an verschiedenen Bahnsteiggleisen — konfliktfrei.",
            network,
            runs,
        }
    }

    /// Zugfolgefall: Der zweite Zug folgt zwei Minuten nach dem ersten.
    pub fn headway_conflict() -> Self {
        let network = Network::example();
        let runs = vec![
            hinfahrt(&network, ACHT_UHR),
            nachfahrt(&network, ACHT_UHR + 2 * 60),
        ];
        Self {
            id: "headway-conflict",
            title: "Zugfolge zu dicht",
            summary: "RB 26803 folgt zwei Minuten nach RB 26801. Das unterschreitet die \
                      Mindestzugfolgezeit — auf der Strecke wie auf dem Ast.",
            network,
            runs,
        }
    }

    /// Derselbe Zugfolgefall mit der kleinsten Zugfolgezeit, die die Prüfung
    /// zulässt. Die Verschiebung stammt aus der Prüfung selbst.
    ///
    /// # Panics
    ///
    /// Wenn die Prüfung für `headway-conflict` keine auflösende Verschiebung
    /// findet — dann stimmt entweder der Fall oder die Prüfung nicht.
    pub fn headway_clear() -> Self {
        let eng = Self::headway_conflict();
        let ShiftResult::Later(verschiebung) =
            earliest_conflict_free_shift(&eng.network, &eng.runs, 1)
        else {
            panic!("für 'headway-conflict' gibt es keine auflösende Verschiebung");
        };

        let runs = vec![eng.runs[0].clone(), eng.runs[1].shifted(verschiebung)];
        Self {
            id: "headway-clear",
            title: "Zugfolge auf Mindestabstand",
            summary: "Dieselben beiden Züge, nur so weit auseinandergezogen, wie die \
                      Sperrzeiten es verlangen. Den Abstand bestimmt der eingleisige Ast, \
                      nicht die zweigleisige Strecke.",
            network: eng.network,
            runs,
        }
    }

    /// Die Sperrzeitentreppen beider Züge.
    pub fn staircases(&self) -> Vec<BlockingTimeStaircase> {
        self.runs
            .iter()
            .map(|fahrt| staircase(&self.network, fahrt))
            .collect()
    }

    /// Die Belegungskonflikte des Falls.
    pub fn conflicts(&self) -> Vec<OccupationConflict> {
        conflicts(&self.staircases())
    }

    /// Der Prüfbericht als Text — dasselbe Ergebnis wie im Bildfahrplan, nur
    /// lesbar ohne Bild.
    pub fn report(&self) -> String {
        let treppen = self.staircases();
        let befunde = conflicts(&treppen);

        let mut text = String::new();
        text.push_str(&format!("{} — {}\n", self.id, self.title));
        text.push_str(&format!("{}\n\n", self.summary));

        for (fahrt, treppe) in self.runs.iter().zip(treppen.iter()) {
            let erster = self.network.section(fahrt.itinerary.sections[0]);
            let letzter = self.network.section(
                *fahrt
                    .itinerary
                    .sections
                    .last()
                    .expect("Laufweg ist nicht leer"),
            );
            text.push_str(&format!(
                "  {}  {} ab {}  →  {} an {}  ({} Abschnitte, {})\n",
                fahrt.number,
                erster.name,
                clock(fahrt.departure),
                letzter.name,
                clock(treppe.arrival()),
                treppe.steps.len(),
                fahrt.itinerary.direction.label(),
            ));
        }

        if befunde.is_empty() {
            text.push_str("\n  Belegungskonflikte: keine.\n");
            return text;
        }

        text.push_str(&format!("\n  Belegungskonflikte: {}\n", befunde.len()));
        for befund in &befunde {
            let abschnitt = self.network.section(befund.section);
            let erster = &self.runs[befund.first_run];
            let zweiter = &self.runs[befund.second_run];
            text.push_str(&format!(
                "\n  {}  {}  ({})\n",
                befund.label,
                abschnitt.name,
                befund.kind.label()
            ));
            text.push_str(&format!(
                "      {} sperrt {} – {}\n",
                erster.number,
                clock(befund.first.start),
                clock(befund.first.end)
            ));
            text.push_str(&format!(
                "      {} sperrt {} – {}\n",
                zweiter.number,
                clock(befund.second.start),
                clock(befund.second.end)
            ));
            text.push_str(&format!(
                "      Überschneidung {} – {} ({} min)\n",
                clock(befund.overlap_start),
                clock(befund.overlap_end),
                duration(befund.overlap_seconds())
            ));
            text.push_str(&format!("      {}\n", befund.kind.explanation()));
        }

        match earliest_conflict_free_shift(&self.network, &self.runs, 1) {
            ShiftResult::None => {}
            ShiftResult::Later(sekunden) => {
                text.push_str(&format!(
                    "\n  Konfliktfrei, sobald {} um {} min später verkehrt.\n",
                    self.runs[1].number,
                    duration(sekunden)
                ));
            }
            ShiftResult::Impossible => {
                text.push_str("\n  Durch Verschieben der zweiten Fahrt allein nicht auflösbar.\n");
            }
        }

        text
    }
}

/// RB 26801, Nordstadt → Talheim, Halt in Sandberg.
fn hinfahrt(network: &Network, departure: i64) -> TrainRun {
    TrainRun::new(
        "RB 26801",
        REGIONAL_TRAIN,
        network.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]),
        SimTime::from_seconds(departure),
        halte(),
    )
}

/// RB 26802, Talheim → Nordstadt, Halt in Sandberg.
fn gegenfahrt(network: &Network, departure: i64) -> TrainRun {
    TrainRun::new(
        "RB 26802",
        REGIONAL_TRAIN,
        network.itinerary(Direction::Inbound, &["Gleis 2", "Gleis 3", "Gleis 2"]),
        SimTime::from_seconds(departure),
        halte(),
    )
}

/// RB 26803, Nordstadt → Talheim auf denselben Streckengleisen wie RB 26801,
/// aber an anderen Bahnsteiggleisen — sonst wäre schon der Bahnsteig der
/// Konflikt und nicht die Zugfolge.
fn nachfahrt(network: &Network, departure: i64) -> TrainRun {
    TrainRun::new(
        "RB 26803",
        REGIONAL_TRAIN,
        network.itinerary(Direction::Outbound, &["Gleis 3", "Gleis 1", "Gleis 2"]),
        SimTime::from_seconds(departure),
        halte(),
    )
}

/// Haltezeiten: 60 s in der mittleren Betriebsstelle, 240 s Wendezeit am Ziel.
fn halte() -> Vec<i64> {
    vec![0, 0, 0, 0, 60, 0, 0, 240]
}

#[cfg(test)]
mod tests {
    use super::Case;
    use crate::conflict::{ConflictKind, ShiftResult, earliest_conflict_free_shift};

    #[test]
    fn jeder_fall_hat_genau_zwei_zuege() {
        for fall in Case::all() {
            assert_eq!(fall.runs.len(), 2, "{}", fall.id);
        }
    }

    #[test]
    fn die_konfliktfaelle_melden_konflikte() {
        let kreuzung = Case::crossing_conflict();
        let befunde = kreuzung.conflicts();
        assert_eq!(befunde.len(), 2, "beide Astabschnitte sind betroffen");
        for befund in &befunde {
            assert_eq!(befund.kind, ConflictKind::OpposingMove);
        }

        let zugfolge = Case::headway_conflict();
        let befunde = zugfolge.conflicts();
        assert!(
            befunde.len() >= 3,
            "eine zu dichte Zugfolge trifft mehrere Abschnitte, gemeldet: {}",
            befunde.len()
        );
        for befund in &befunde {
            assert_eq!(befund.kind, ConflictKind::Headway);
        }
    }

    #[test]
    fn die_freien_faelle_sind_wirklich_frei() {
        for fall in [Case::crossing_sandberg(), Case::headway_clear()] {
            assert!(
                fall.conflicts().is_empty(),
                "{} meldet Konflikte: {:?}",
                fall.id,
                fall.conflicts()
                    .iter()
                    .map(|b| b.label.clone())
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn der_freie_zugfolgefall_liegt_genau_an_der_grenze() {
        // Eine Sekunde früher, und die Mindestzugfolgezeit ist unterschritten.
        // Ohne diesen Test könnte der Fall unbemerkt großzügig werden und
        // nichts mehr beweisen.
        let fall = Case::headway_clear();
        let knapp = [fall.runs[0].clone(), fall.runs[1].shifted(-1)];
        let treppen: Vec<_> = knapp
            .iter()
            .map(|f| crate::blocking::staircase(&fall.network, f))
            .collect();
        assert!(
            !crate::conflict::conflicts(&treppen).is_empty(),
            "eine Sekunde weniger Abstand ist immer noch konfliktfrei"
        );
    }

    #[test]
    fn die_kreuzung_in_sandberg_ist_die_bessere_loesung() {
        // Der Prüfer kennt nur die triviale Auflösung: warten, bis der Ast frei
        // ist. Betrieblich richtig ist hier das Gegenteil — früher fahren und in
        // Sandberg kreuzen. Genau diese Lücke ist der Auftrag von M3.4.
        let eng = Case::crossing_conflict();
        let ShiftResult::Later(verspaetung) =
            earliest_conflict_free_shift(&eng.network, &eng.runs, 1)
        else {
            panic!("keine auflösende Verschiebung gefunden");
        };
        let spaeter = eng.runs[1].departure.seconds() + verspaetung;
        let kreuzung = Case::crossing_sandberg();
        assert!(
            kreuzung.runs[1].departure.seconds() < spaeter,
            "die Kreuzungslösung liegt nicht früher als die Warteslösung"
        );
    }

    #[test]
    fn der_bericht_nennt_ressource_fenster_und_gegenzug() {
        let bericht = Case::crossing_conflict().report();
        assert!(bericht.contains("eingleisig"), "{bericht}");
        assert!(bericht.contains("Gegenfahrt"), "{bericht}");
        assert!(bericht.contains("RB 26801"), "{bericht}");
        assert!(bericht.contains("RB 26802"), "{bericht}");
        assert!(bericht.contains("Überschneidung"), "{bericht}");
    }

    #[test]
    fn kennungen_sind_eindeutig() {
        let alle = Case::all();
        for (index, fall) in alle.iter().enumerate() {
            assert!(Case::by_id(fall.id).is_some());
            for anderer in alle.iter().skip(index + 1) {
                assert_ne!(fall.id, anderer.id);
            }
        }
    }
}
