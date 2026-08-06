//! Das Sperrzeitenmodell — der eigentliche Gegenstand von M0.3.
//!
//! Eine **Sperrzeit** ist nicht die Zeit, die ein Zug im Abschnitt ist. Sie
//! beginnt, bevor der Zug ihn erreicht, und endet, nachdem er ihn verlassen
//! hat. Sechs Anteile, in dieser Reihenfolge:
//!
//! | Anteil | Von wann bis wann |
//! |--------|-------------------|
//! | Fahrstraßenbildezeit | Stellen des Fahrwegs, bevor das Signal Fahrt zeigt |
//! | Signalsichtzeit | Erkennen des Vorsignals bis zum Vorsignal |
//! | Annäherungsfahrzeit | Vorsignal bis Hauptsignal — der Annäherungsabschnitt |
//! | Fahrzeit | Hauptsignal bis Ende des Abschnitts, Haltezeit eingeschlossen |
//! | Räumfahrzeit | bis Zugschluss den Durchrutschweg geräumt hat |
//! | Fahrstraßenauflösezeit | Auflösen des Fahrwegs |
//!
//! Aufeinanderfolgende Abschnitte ergeben dadurch die **Sperrzeitentreppe**:
//! jede Stufe beginnt früher, als der Zug den Abschnitt betritt, und endet
//! später, als er ihn verlässt. Der Abstand zweier Züge — die
//! Mindestzugfolgezeit — folgt aus diesen Stufen, nicht aus der Fahrzeit.
//!
//! Zwei Festlegungen, ohne die das Modell nicht ganzzahlig bliebe:
//!
//! - **Jede Fahrzeit wird aufgerundet.** Aufrunden verlängert die Sperrzeit und
//!   liegt damit immer auf der sicheren Seite.
//! - **Die Sperrzeit beginnt nie, bevor der Zug losfährt.** Steht der Zug im
//!   vorherigen Abschnitt, gibt es keine Annäherungsfahrt; dann bleibt nur
//!   Fahrstraßenbildezeit und Signalsichtzeit vor der Abfahrt.

use zugfolge_determinism::SimTime;

use crate::network::{Direction, Network, ResourceId};
use crate::train::TrainRun;

/// Die Anteile einer Sperrzeit, in zeitlicher Reihenfolge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BlockingPhase {
    /// Fahrstraßenbildezeit.
    RouteSetting,
    /// Signalsichtzeit.
    SignalSighting,
    /// Annäherungsfahrzeit über den Annäherungsabschnitt.
    Approach,
    /// Fahrzeit im Abschnitt, Haltezeit eingeschlossen.
    Running,
    /// Räumfahrzeit über Durchrutschweg und Zuglänge.
    Clearing,
    /// Fahrstraßenauflösezeit.
    RouteRelease,
}

impl BlockingPhase {
    /// Deutscher Name für Bericht und Bildfahrplan.
    pub const fn label(self) -> &'static str {
        match self {
            Self::RouteSetting => "Fahrstraßenbildezeit",
            Self::SignalSighting => "Signalsichtzeit",
            Self::Approach => "Annäherungsfahrzeit",
            Self::Running => "Fahrzeit",
            Self::Clearing => "Räumfahrzeit",
            Self::RouteRelease => "Fahrstraßenauflösezeit",
        }
    }
}

/// Die Sperrzeit einer Zugfahrt auf **einer** Konfliktressource.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockingTime {
    /// Die gesperrte Konfliktressource.
    pub section: ResourceId,
    /// Fahrtrichtung des Zuges in diesem Abschnitt.
    pub direction: Direction,
    /// Beginn der Sperrzeit — Beginn der Fahrstraßenbildung.
    pub start: SimTime,
    /// Ende der Fahrstraßenbildung, Beginn der Signalsichtzeit.
    pub sighting: SimTime,
    /// Beginn der Annäherungsfahrt, also Vorbeifahrt am Vorsignal.
    pub approach_start: SimTime,
    /// Vorbeifahrt am Hauptsignal — Beginn der Fahrzeit im Abschnitt.
    pub entry: SimTime,
    /// Ende der reinen Fahrzeit. Danach folgt nur noch eine etwaige Haltezeit;
    /// der Bildfahrplan zeichnet ab hier die waagerechte Standlinie.
    pub travel_end: SimTime,
    /// Ende der Fahrzeit im Abschnitt, Haltezeit eingeschlossen.
    pub exit: SimTime,
    /// Zugschluss hat Abschnitt und Durchrutschweg geräumt.
    pub cleared: SimTime,
    /// Ende der Sperrzeit — nach der Fahrstraßenauflösung.
    pub end: SimTime,
}

impl BlockingTime {
    /// Dauer der Sperrzeit in Sekunden.
    pub const fn duration_s(&self) -> i64 {
        self.end.seconds() - self.start.seconds()
    }

    /// Ob sich zwei Sperrzeiten zeitlich überschneiden.
    ///
    /// Halboffenes Intervall: Berührung ist **kein** Konflikt. Genau an dieser
    /// Grenze liegt die Mindestzugfolgezeit.
    pub const fn overlaps(&self, other: &Self) -> bool {
        self.start.seconds() < other.end.seconds() && other.start.seconds() < self.end.seconds()
    }

    /// Die sechs Anteile mit ihren Zeitpunkten, lückenlos von `start` bis `end`.
    pub const fn phases(&self) -> [(BlockingPhase, SimTime, SimTime); 6] {
        [
            (BlockingPhase::RouteSetting, self.start, self.sighting),
            (
                BlockingPhase::SignalSighting,
                self.sighting,
                self.approach_start,
            ),
            (BlockingPhase::Approach, self.approach_start, self.entry),
            (BlockingPhase::Running, self.entry, self.exit),
            (BlockingPhase::Clearing, self.exit, self.cleared),
            (BlockingPhase::RouteRelease, self.cleared, self.end),
        ]
    }
}

/// Die Sperrzeitentreppe einer Zugfahrt: alle Sperrzeiten des Laufwegs.
#[derive(Clone, Debug)]
pub struct BlockingTimeStaircase {
    /// Zugnummer der zugehörigen Fahrt.
    pub number: &'static str,
    /// Fahrtrichtung.
    pub direction: Direction,
    /// Die Stufen in Fahrtreihenfolge.
    pub steps: Vec<BlockingTime>,
}

impl BlockingTimeStaircase {
    /// Erste belegte Sekunde des gesamten Laufwegs.
    ///
    /// # Panics
    ///
    /// Wenn die Treppe keine Stufe hat.
    pub fn first_second(&self) -> SimTime {
        self.steps.first().expect("Treppe ist nicht leer").start
    }

    /// Letzte belegte Sekunde des gesamten Laufwegs.
    ///
    /// # Panics
    ///
    /// Wenn die Treppe keine Stufe hat.
    pub fn last_second(&self) -> SimTime {
        self.steps
            .iter()
            .map(|stufe| stufe.end)
            .max()
            .expect("Treppe ist nicht leer")
    }

    /// Ankunftszeit am Ende des Laufwegs, ohne Räumen und Auflösen.
    ///
    /// # Panics
    ///
    /// Wenn die Treppe keine Stufe hat.
    pub fn arrival(&self) -> SimTime {
        self.steps.last().expect("Treppe ist nicht leer").exit
    }

    /// Die Anteile, aus denen sich jede Stufe dieser Treppe zusammensetzt.
    ///
    /// Sie sind für jede Stufe dieselben; die Legende des Bildfahrplans nennt
    /// sie, damit sie dort nicht ein zweites Mal von Hand stehen und
    /// auseinanderlaufen können.
    pub fn phase_labels(&self) -> Vec<&'static str> {
        self.steps.first().map_or_else(Vec::new, |stufe| {
            stufe
                .phases()
                .iter()
                .map(|(phase, _, _)| phase.label())
                .collect()
        })
    }
}

/// Fahrzeit für eine Strecke bei einer Geschwindigkeit, **aufgerundet**.
///
/// # Panics
///
/// Wenn die Geschwindigkeit nicht positiv ist.
pub fn travel_seconds(distance_mm: i64, speed_mm_s: i64) -> i64 {
    assert!(speed_mm_s > 0, "Geschwindigkeit muss positiv sein");
    let ganze = distance_mm / speed_mm_s;
    if distance_mm % speed_mm_s == 0 {
        ganze
    } else {
        ganze + 1
    }
}

/// Berechnet die Sperrzeitentreppe einer Zugfahrt.
pub fn staircase(network: &Network, run: &TrainRun) -> BlockingTimeStaircase {
    let parameter = network.signalling();
    let mut steps: Vec<BlockingTime> = Vec::with_capacity(run.itinerary.sections.len());

    // Zeitpunkt, zu dem der Zug zuletzt aus dem Stand losgefahren ist. Vor
    // diesem Zeitpunkt gibt es keine Annäherungsfahrt.
    let mut motion_start = run.departure.seconds();
    let mut entry = run.departure.seconds();
    let mut previous_speed: Option<i64> = None;

    for (index, section_id) in run.itinerary.sections.iter().enumerate() {
        let section = network.section(*section_id);
        let speed = run.speed_in(network, *section_id);
        let dwell = run.dwell_s[index];
        let travel_end = entry + travel_seconds(section.length_mm(), speed);
        let exit = travel_end + dwell;

        let approach_speed = previous_speed.unwrap_or(speed);
        let approach_time = travel_seconds(parameter.approach.length_mm, approach_speed);
        let approach_start = (entry - approach_time).max(motion_start);
        let sighting = approach_start - parameter.signal_sighting_time_s;
        let start = sighting - parameter.route_setting_time_s;

        let clearing = travel_seconds(
            parameter.overlap.length_mm + run.characteristics.length_mm,
            speed,
        );
        let cleared = exit + clearing;
        let end = cleared + parameter.route_release_time_s;

        steps.push(BlockingTime {
            section: *section_id,
            direction: run.direction(),
            start: SimTime::from_seconds(start),
            sighting: SimTime::from_seconds(sighting),
            approach_start: SimTime::from_seconds(approach_start),
            entry: SimTime::from_seconds(entry),
            travel_end: SimTime::from_seconds(travel_end),
            exit: SimTime::from_seconds(exit),
            cleared: SimTime::from_seconds(cleared),
            end: SimTime::from_seconds(end),
        });

        if dwell > 0 {
            motion_start = exit;
        }
        previous_speed = Some(speed);
        entry = exit;
    }

    BlockingTimeStaircase {
        number: run.number,
        direction: run.direction(),
        steps,
    }
}

#[cfg(test)]
mod tests {
    use zugfolge_determinism::SimTime;

    use super::{BlockingPhase, staircase, travel_seconds};
    use crate::network::{Direction, Network};
    use crate::train::{REGIONAL_TRAIN, TrainRun};

    fn fahrt(netz: &Network) -> TrainRun {
        let laufweg = netz.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]);
        let halte = vec![0, 0, 0, 0, 60, 0, 0, 240];
        TrainRun::new(
            "RB 26801",
            REGIONAL_TRAIN,
            laufweg,
            SimTime::from_seconds(28_800),
            halte,
        )
    }

    #[test]
    fn fahrzeit_wird_aufgerundet() {
        assert_eq!(travel_seconds(100, 10), 10);
        assert_eq!(travel_seconds(101, 10), 11, "angefangene Sekunde zählt");
        assert_eq!(travel_seconds(0, 10), 0);
    }

    #[test]
    fn die_sperrzeit_umschliesst_die_fahrzeit() {
        let netz = Network::example();
        let treppe = staircase(&netz, &fahrt(&netz));
        for stufe in &treppe.steps {
            assert!(
                stufe.start.seconds() < stufe.entry.seconds(),
                "Sperrzeit beginnt nicht vor der Einfahrt"
            );
            assert!(
                stufe.end.seconds() > stufe.exit.seconds(),
                "Sperrzeit endet nicht nach der Ausfahrt"
            );
            assert!(stufe.duration_s() > 0);
        }
    }

    #[test]
    fn die_stufen_bilden_eine_treppe() {
        // Das ist die Treppe: Jede Stufe beginnt später als die vorige und
        // endet später — sonst wäre die Darstellung im Bildfahrplan keine.
        let netz = Network::example();
        let treppe = staircase(&netz, &fahrt(&netz));
        for paar in treppe.steps.windows(2) {
            assert!(paar[0].start.seconds() <= paar[1].start.seconds());
            assert!(paar[0].end.seconds() < paar[1].end.seconds());
            assert_eq!(
                paar[0].exit, paar[1].entry,
                "die Fahrzeiten müssen lückenlos aneinander anschließen"
            );
        }
    }

    #[test]
    fn aufeinanderfolgende_stufen_ueberschneiden_sich() {
        // Genau diese Überschneidung ist der Grund, warum ein zweiter Zug nicht
        // beliebig dicht folgen darf.
        let netz = Network::example();
        let treppe = staircase(&netz, &fahrt(&netz));
        let ueberschneidungen = treppe
            .steps
            .windows(2)
            .filter(|paar| paar[0].overlaps(&paar[1]))
            .count();
        assert!(
            ueberschneidungen > 0,
            "keine einzige Stufe überschneidet ihre Nachfolgerin"
        );
    }

    #[test]
    fn die_anteile_sind_lueckenlos_und_in_reihenfolge() {
        let netz = Network::example();
        let treppe = staircase(&netz, &fahrt(&netz));
        for stufe in &treppe.steps {
            let anteile = stufe.phases();
            assert_eq!(anteile[0].1, stufe.start);
            assert_eq!(anteile[5].2, stufe.end);
            for paar in anteile.windows(2) {
                assert_eq!(paar[0].2, paar[1].1, "Lücke zwischen den Anteilen");
            }
            let summe: i64 = anteile
                .iter()
                .map(|(_, von, bis)| bis.seconds() - von.seconds())
                .sum();
            assert_eq!(summe, stufe.duration_s());
        }
    }

    #[test]
    fn die_sperrzeit_beginnt_nicht_vor_der_abfahrt() {
        // Ein Zug, der im Bahnhof steht, nähert sich dem Ausfahrsignal nicht.
        // Ohne diese Klammer begänne die Sperrzeit des ersten Abschnitts vor
        // der Abfahrt — und zwei aufeinanderfolgende Züge hätten scheinbar
        // Konflikte, die es nicht gibt.
        let netz = Network::example();
        let fahrt = fahrt(&netz);
        let treppe = staircase(&netz, &fahrt);
        let erste = treppe.steps[0];
        let parameter = netz.signalling();
        assert_eq!(
            erste.start.seconds(),
            fahrt.departure.seconds()
                - parameter.signal_sighting_time_s
                - parameter.route_setting_time_s
        );
        assert_eq!(erste.approach_start, fahrt.departure);
        let (phase, von, bis) = erste.phases()[2];
        assert_eq!(phase, BlockingPhase::Approach);
        assert_eq!(von, bis, "die Annäherungsfahrt hat die Länge null");
    }

    #[test]
    fn die_haltezeit_verlaengert_die_sperrzeit_des_bahnsteiggleises() {
        let netz = Network::example();
        let mit_halt = fahrt(&netz);
        let ohne_halt = TrainRun::new(
            mit_halt.number,
            mit_halt.characteristics,
            mit_halt.itinerary.clone(),
            mit_halt.departure,
            vec![0, 0, 0, 0, 0, 0, 0, 240],
        );
        let a = staircase(&netz, &mit_halt).steps[4];
        let b = staircase(&netz, &ohne_halt).steps[4];
        assert_eq!(a.duration_s() - b.duration_s(), 60);
    }

    #[test]
    fn eine_spaetere_abfahrt_verschiebt_die_treppe_starr() {
        let netz = Network::example();
        let treppe = staircase(&netz, &fahrt(&netz));
        let verschoben = staircase(&netz, &fahrt(&netz).shifted(300));
        for (a, b) in treppe.steps.iter().zip(verschoben.steps.iter()) {
            assert_eq!(b.start.seconds() - a.start.seconds(), 300);
            assert_eq!(b.end.seconds() - a.end.seconds(), 300);
        }
    }
}
