//! Die Konfliktprüfung.
//!
//! > **Harte Invariante 1:** Keine zwei Züge dürfen zur gleichen Zeit
//! > inkompatible Belegungen derselben Konfliktressource besitzen.
//!
//! Der Spike prüft sie in ihrer einfachsten tragfähigen Form: Zwei Sperrzeiten
//! **derselben** Konfliktressource dürfen sich zeitlich nicht überschneiden.
//! Dass daraus zwei betrieblich sehr verschiedene Fälle werden — Zugfolge und
//! Gegenfahrt — ist keine zweite Regel, sondern eine Eigenschaft des Netzes:
//!
//! - Auf der zweigleisigen Strecke ist jedes Richtungsgleis eine eigene
//!   Ressource. Zwei Züge derselben Richtung teilen sie sich, zwei Züge
//!   entgegengesetzter Richtung nie.
//! - Auf dem eingleisigen Ast gibt es nur eine Ressource für beide Richtungen.
//!   Deshalb entsteht dort die Gegenfahrt — ohne eine einzige Sonderregel.
//!
//! Das ist das Ergebnis, auf das es M0.3 ankam: **Ein Ressourcenmodell, zwei
//! Konfliktarten.** Was es noch nicht kann, steht in der README des Spikes.

use std::collections::BTreeMap;

use zugfolge_determinism::SimTime;

use crate::blocking::{BlockingTime, BlockingTimeStaircase};
use crate::network::{Network, ResourceId};

/// Die betriebliche Art eines Belegungskonflikts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictKind {
    /// Zugfolgefall: zwei Fahrten derselben Richtung folgen zu dicht.
    Headway,
    /// Gegenfahrt: zwei Fahrten entgegengesetzter Richtung auf demselben
    /// eingleisigen Abschnitt.
    OpposingMove,
}

impl ConflictKind {
    /// Deutscher Name für Bericht und Bildfahrplan.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Headway => "Zugfolge",
            Self::OpposingMove => "Gegenfahrt",
        }
    }

    /// Die Erklärung, warum dieser Fall ein Konflikt ist.
    pub const fn explanation(self) -> &'static str {
        match self {
            Self::Headway => {
                "Der folgende Zug erreicht den Abschnitt, bevor die Sperrzeit des \
                 vorausfahrenden abgelaufen ist. Die Mindestzugfolgezeit ist unterschritten."
            }
            Self::OpposingMove => {
                "Beide Züge beanspruchen denselben eingleisigen Abschnitt in \
                 entgegengesetzter Richtung. Eine Kreuzung ist nur in einer Betriebsstelle möglich."
            }
        }
    }
}

/// Ein erkannter Belegungskonflikt — mit allem, was zur Erklärung nötig ist.
///
/// Die Felder sind so gewählt, dass sich daraus ohne weitere Abfrage der Satz
/// bilden lässt, den M3.3 verlangt: **welche Ressource, welches Fenster,
/// welcher Gegenzug.**
#[derive(Clone, Debug)]
pub struct OccupationConflict {
    /// Laufende Nummer im Prüflauf, für Bericht und Bildfahrplan: `K1`, `K2`, …
    pub label: String,
    /// Die betroffene Konfliktressource.
    pub section: ResourceId,
    /// Die Art des Konflikts.
    pub kind: ConflictKind,
    /// Index der zuerst eingeplanten Fahrt.
    pub first_run: usize,
    /// Index der später eingeplanten Fahrt.
    pub second_run: usize,
    /// Sperrzeit der zuerst eingeplanten Fahrt.
    pub first: BlockingTime,
    /// Sperrzeit der später eingeplanten Fahrt.
    pub second: BlockingTime,
    /// Beginn der Überschneidung.
    pub overlap_start: SimTime,
    /// Ende der Überschneidung.
    pub overlap_end: SimTime,
}

impl OccupationConflict {
    /// Dauer der Überschneidung in Sekunden.
    pub const fn overlap_seconds(&self) -> i64 {
        self.overlap_end.seconds() - self.overlap_start.seconds()
    }

}

/// Prüft alle Sperrzeitentreppen gegeneinander.
///
/// Die Reihenfolge der Befunde ist festgelegt — erst nach Konfliktressource,
/// dann nach Beginn der Überschneidung. Ohne feste Reihenfolge wäre der
/// Prüfbericht nicht reproduzierbar, und damit auch der Zustands-Hash nicht.
pub fn conflicts(staircases: &[BlockingTimeStaircase]) -> Vec<OccupationConflict> {
    let mut belegungen: BTreeMap<ResourceId, Vec<(usize, BlockingTime)>> = BTreeMap::new();
    for (index, treppe) in staircases.iter().enumerate() {
        for stufe in &treppe.steps {
            belegungen
                .entry(stufe.section)
                .or_default()
                .push((index, *stufe));
        }
    }

    let mut befunde: Vec<OccupationConflict> = Vec::new();
    for (section, mut stufen) in belegungen {
        stufen.sort_by_key(|(index, stufe)| (stufe.start.seconds(), *index));
        for (position, (erster_lauf, erste)) in stufen.iter().copied().enumerate() {
            for (zweiter_lauf, zweite) in stufen.iter().copied().skip(position + 1) {
                if erster_lauf == zweiter_lauf {
                    // Derselbe Zug kann denselben Abschnitt mehrfach befahren;
                    // mit sich selbst gerät er dabei nicht in Konflikt.
                    continue;
                }
                if !erste.overlaps(&zweite) {
                    continue;
                }
                let kind = if erste.direction == zweite.direction {
                    ConflictKind::Headway
                } else {
                    ConflictKind::OpposingMove
                };
                befunde.push(OccupationConflict {
                    label: String::new(),
                    section,
                    kind,
                    first_run: erster_lauf,
                    second_run: zweiter_lauf,
                    first: erste,
                    second: zweite,
                    overlap_start: SimTime::from_seconds(
                        erste.start.seconds().max(zweite.start.seconds()),
                    ),
                    overlap_end: SimTime::from_seconds(
                        erste.end.seconds().min(zweite.end.seconds()),
                    ),
                });
            }
        }
    }

    befunde.sort_by_key(|befund| {
        (
            befund.overlap_start.seconds(),
            befund.section,
            befund.first_run,
            befund.second_run,
        )
    });
    for (nummer, befund) in befunde.iter_mut().enumerate() {
        befund.label = format!("K{}", nummer + 1);
    }
    befunde
}

/// Wie viele Sekunden eine Fahrt später liegen müsste, damit sie mit keiner
/// anderen mehr kollidiert.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShiftResult {
    /// Die Fahrt ist bereits konfliktfrei.
    None,
    /// So viele Sekunden später ist die Fahrt konfliktfrei.
    Later(i64),
    /// Durch Verschieben dieser einen Fahrt ist der Fahrplan nicht
    /// konfliktfrei zu bekommen.
    Impossible,
}

/// Obergrenze der Fixpunktiteration.
const MAX_ROUNDS: usize = 64;

/// Sucht die kleinste Verspätung der Fahrt `index`, nach der kein Konflikt mehr
/// an ihr hängt.
///
/// **Das ist ausdrücklich kein Planner.** Es verschiebt eine einzige Fahrt nach
/// hinten und wiederholt das, bis kein Konflikt mehr an ihr hängt. Ob das
/// betrieblich die richtige Lösung ist, weiß es nicht — bei einer Kreuzung auf
/// eingleisiger Strecke ist die richtige Antwort oft, den Zug **früher** fahren
/// zu lassen und in einer Betriebsstelle kreuzen zu lassen. Diese Wahl trifft
/// der Trassen-Planner aus M3.4.
pub fn earliest_conflict_free_shift(
    network: &Network,
    runs: &[crate::train::TrainRun],
    index: usize,
) -> ShiftResult {
    let mut verschiebung = 0_i64;

    for _ in 0..MAX_ROUNDS {
        let treppen: Vec<BlockingTimeStaircase> = runs
            .iter()
            .enumerate()
            .map(|(nummer, fahrt)| {
                let fahrt = if nummer == index {
                    fahrt.shifted(verschiebung)
                } else {
                    fahrt.clone()
                };
                crate::blocking::staircase(network, &fahrt)
            })
            .collect();

        let befunde = conflicts(&treppen);
        let eigene: Vec<&OccupationConflict> = befunde
            .iter()
            .filter(|befund| befund.first_run == index || befund.second_run == index)
            .collect();

        if eigene.is_empty() {
            return if verschiebung == 0 {
                ShiftResult::None
            } else {
                ShiftResult::Later(verschiebung)
            };
        }

        let schritt = eigene
            .iter()
            .map(|befund| {
                if befund.second_run == index {
                    befund.first.end.seconds() - befund.second.start.seconds()
                } else {
                    // Die eigene Fahrt liegt vorn: Sie muss hinter die andere
                    // rutschen, also über deren Sperrzeitende hinaus.
                    befund.second.end.seconds() - befund.first.start.seconds()
                }
            })
            .max()
            .unwrap_or(0);

        if schritt <= 0 {
            return ShiftResult::Impossible;
        }
        verschiebung += schritt;
    }

    ShiftResult::Impossible
}

#[cfg(test)]
mod tests {
    use zugfolge_determinism::SimTime;

    use super::{ConflictKind, ShiftResult, conflicts, earliest_conflict_free_shift};
    use crate::blocking::staircase;
    use crate::network::{Direction, Network};
    use crate::train::{REGIONAL_TRAIN, TrainRun};

    fn hinfahrt(netz: &Network, abfahrt: i64) -> TrainRun {
        TrainRun::new(
            "RB 26801",
            REGIONAL_TRAIN,
            netz.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]),
            SimTime::from_seconds(abfahrt),
            vec![0, 0, 0, 0, 60, 0, 0, 240],
        )
    }

    fn gegenfahrt(netz: &Network, abfahrt: i64) -> TrainRun {
        TrainRun::new(
            "RB 26802",
            REGIONAL_TRAIN,
            netz.itinerary(Direction::Inbound, &["Gleis 2", "Gleis 3", "Gleis 2"]),
            SimTime::from_seconds(abfahrt),
            vec![0, 0, 0, 0, 60, 0, 0, 240],
        )
    }

    fn nachfahrt(netz: &Network, abfahrt: i64) -> TrainRun {
        TrainRun::new(
            "RB 26803",
            REGIONAL_TRAIN,
            netz.itinerary(Direction::Outbound, &["Gleis 3", "Gleis 1", "Gleis 2"]),
            SimTime::from_seconds(abfahrt),
            vec![0, 0, 0, 0, 60, 0, 0, 240],
        )
    }

    fn pruefe(netz: &Network, fahrten: &[TrainRun]) -> Vec<super::OccupationConflict> {
        let treppen: Vec<_> = fahrten.iter().map(|f| staircase(netz, f)).collect();
        conflicts(&treppen)
    }

    #[test]
    fn eine_einzelne_fahrt_hat_keinen_konflikt() {
        let netz = Network::example();
        assert!(pruefe(&netz, &[hinfahrt(&netz, 28_800)]).is_empty());
    }

    #[test]
    fn gegenfahrt_auf_dem_eingleisigen_ast_wird_erkannt() {
        let netz = Network::example();
        let befunde = pruefe(&netz, &[hinfahrt(&netz, 28_800), gegenfahrt(&netz, 29_220)]);
        assert!(!befunde.is_empty(), "die Gegenfahrt bleibt unentdeckt");
        for befund in &befunde {
            assert_eq!(befund.kind, ConflictKind::OpposingMove);
            assert!(
                netz.section(befund.section).is_single_track(),
                "nur der eingleisige Ast kann eine Gegenfahrt tragen"
            );
            assert!(befund.overlap_seconds() > 0);
        }
    }

    #[test]
    fn zwei_zuege_derselben_richtung_geraten_in_den_zugfolgefall() {
        let netz = Network::example();
        let befunde = pruefe(&netz, &[hinfahrt(&netz, 28_800), nachfahrt(&netz, 28_920)]);
        assert!(!befunde.is_empty(), "zu dichte Zugfolge bleibt unentdeckt");
        for befund in &befunde {
            assert_eq!(befund.kind, ConflictKind::Headway);
        }
    }

    #[test]
    fn getrennte_richtungsgleise_erzeugen_keinen_konflikt() {
        // Beide Züge sind gleichzeitig auf der zweigleisigen Strecke, nur in
        // verschiedenen Richtungen. Meldete die Prüfung das, wäre sie unbrauchbar.
        let netz = Network::example();
        let befunde = pruefe(&netz, &[hinfahrt(&netz, 28_800), gegenfahrt(&netz, 28_860)]);
        for befund in &befunde {
            assert!(netz.section(befund.section).is_single_track());
        }
    }

    #[test]
    fn die_gemeldete_verschiebung_loest_den_konflikt_und_eine_sekunde_weniger_nicht() {
        // Das ist der schärfste Test des Prüfers: Der gemeldete Wert muss
        // stimmen, nicht nur grob in die richtige Richtung zeigen.
        let netz = Network::example();
        let fahrten = vec![hinfahrt(&netz, 28_800), gegenfahrt(&netz, 29_220)];
        let ShiftResult::Later(verschiebung) = earliest_conflict_free_shift(&netz, &fahrten, 1)
        else {
            panic!("keine auflösende Verschiebung gefunden");
        };

        let geloest = vec![fahrten[0].clone(), fahrten[1].shifted(verschiebung)];
        assert!(
            pruefe(&netz, &geloest).is_empty(),
            "Verschiebung reicht nicht"
        );

        let knapp = vec![fahrten[0].clone(), fahrten[1].shifted(verschiebung - 1)];
        assert!(
            !pruefe(&netz, &knapp).is_empty(),
            "eine Sekunde weniger ist bereits konfliktfrei — der Wert ist nicht der kleinste"
        );
    }

    #[test]
    fn eine_konfliktfreie_lage_meldet_keine_verschiebung() {
        let netz = Network::example();
        let fahrten = vec![hinfahrt(&netz, 28_800), gegenfahrt(&netz, 28_860)];
        assert_eq!(
            earliest_conflict_free_shift(&netz, &fahrten, 1),
            ShiftResult::None
        );
    }

    #[test]
    fn befunde_sind_durchnummeriert_und_stabil_sortiert() {
        let netz = Network::example();
        let fahrten = [hinfahrt(&netz, 28_800), nachfahrt(&netz, 28_920)];
        let erster = pruefe(&netz, &fahrten);
        let zweiter = pruefe(&netz, &fahrten);
        let kennungen: Vec<&str> = erster.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(kennungen[0], "K1");
        assert_eq!(
            kennungen,
            zweiter.iter().map(|b| b.label.as_str()).collect::<Vec<_>>()
        );
        for paar in erster.windows(2) {
            assert!(paar[0].overlap_start.seconds() <= paar[1].overlap_start.seconds());
        }
    }
}
