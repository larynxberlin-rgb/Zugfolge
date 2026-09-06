//! Das Sperrzeitenmodell — **M3.1**.
//!
//! Eine **Sperrzeit** ist nicht die Zeit, die ein Zug im Abschnitt ist. Sie
//! beginnt, bevor er ihn erreicht, und endet, nachdem er ihn geräumt hat.
//! `docs/infrastruktur.md` 1 zählt sechs Anteile auf:
//!
//! | Anteil | Von wann bis wann | Woran er hängt |
//! |--------|-------------------|----------------|
//! | Fahrstraßenbildezeit | Stellen und Festlegen des Fahrwegs | Stellwerksbauart |
//! | Signalsichtzeit | Erkennen des Vorsignals bis zum Vorsignal | Betriebsstelle |
//! | Annäherungsfahrzeit | Vorsignal bis Hauptsignal | Vorsignalabstand und Fahrdynamik |
//! | Fahrzeit | Hauptsignal bis Abschnittsende, Haltezeit eingeschlossen | Fahrdynamik (M1.10) |
//! | Räumfahrzeit | bis der Zugschluss Abschnitt und Durchrutschweg geräumt hat | Zuglänge und Durchrutschweg |
//! | Fahrstraßenauflösezeit | Auflösen des Fahrwegs | Stellwerksbauart |
//!
//! Aufeinanderfolgende Abschnitte ergeben daraus die **Sperrzeitentreppe**. Die
//! Mindestzugfolgezeit folgt aus diesen Stufen und ist kein eigener Parameter —
//! sie steht deshalb nirgends in diesem Modul als Wert, sondern wird in
//! [`crate::conflict`] aus ihm errechnet.
//!
//! ## Drei Festlegungen
//!
//! - **Halboffenes Intervall `[start, end)`.** Zwei Sperrzeiten dürfen sich
//!   berühren, nicht überschneiden. Genau an dieser Grenze liegt die
//!   Mindestzugfolgezeit. (Befund des Spikes aus M0.3, hier übernommen.)
//! - **Die Sperrzeit beginnt nie vor der Abfahrt.** Ein Zug, der steht, nähert
//!   sich dem Ausfahrsignal nicht.
//! - **Relativ zuerst, absolut danach.** Was hier gerechnet wird, ist eine
//!   [`RelativeOccupation`] — Sekunden ab der Abfahrt. Erst
//!   [`RelativeOccupation::at`] macht daraus eine [`BlockingTime`] an einem
//!   Verkehrstag. Das ist die Grundlage von M3.2 und der Grund, warum der
//!   Planner (M3.4) eine Zeitlage verschieben kann, ohne neu zu rechnen.

use core::fmt;

use zugfolge_determinism::{SimTime, StateHasher};
use zugfolge_infra::{OperatingPointId, TravelDirection};

use crate::resource::ConflictResource;

/// Die sechs Anteile einer Sperrzeit, in zeitlicher Reihenfolge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
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
    /// Alle sechs Anteile in zeitlicher Reihenfolge.
    pub const ALL: [Self; 6] = [
        Self::RouteSetting,
        Self::SignalSighting,
        Self::Approach,
        Self::Running,
        Self::Clearing,
        Self::RouteRelease,
    ];

    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::RouteSetting => "route-setting",
            Self::SignalSighting => "signal-sighting",
            Self::Approach => "approach",
            Self::Running => "running",
            Self::Clearing => "clearing",
            Self::RouteRelease => "route-release",
        }
    }

    /// Deutsche Bezeichnung für Bericht und Bildfahrplan.
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

/// Die Sperrzeit einer Zugfahrt auf **einer** Konfliktressource, in Sekunden
/// ab der Abfahrt.
///
/// Negative Werte sind gewollt und richtig: Die Fahrstraße des ersten
/// Abschnitts wird gestellt, bevor der Zug abfährt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelativeOccupation {
    resource: ConflictResource,
    direction: TravelDirection,
    governing_point: OperatingPointId,
    start_s: i64,
    sighting_s: i64,
    approach_start_s: i64,
    entry_s: i64,
    travel_end_s: i64,
    exit_s: i64,
    cleared_s: i64,
    end_s: i64,
}

impl RelativeOccupation {
    /// Baut eine relative Sperrzeit aus ihren acht Zeitpunkten.
    ///
    /// Die Zeitpunkte müssen aufsteigend sein; das prüft
    /// [`RelativeOccupation::is_ordered`], und die Ableitung in
    /// [`crate::profile`] stellt es sicher.
    #[expect(
        clippy::too_many_arguments,
        reason = "M3.1: Die Sperrzeit hat sechs Anteile und damit sieben Grenzen — \
                  sie in Hilfsstrukturen zu zerlegen verschöbe die Übersicht nur"
    )]
    pub(crate) const fn new(
        resource: ConflictResource,
        direction: TravelDirection,
        governing_point: OperatingPointId,
        start_s: i64,
        sighting_s: i64,
        approach_start_s: i64,
        entry_s: i64,
        travel_end_s: i64,
        exit_s: i64,
        cleared_s: i64,
        end_s: i64,
    ) -> Self {
        Self {
            resource,
            direction,
            governing_point,
            start_s,
            sighting_s,
            approach_start_s,
            entry_s,
            travel_end_s,
            exit_s,
            cleared_s,
            end_s,
        }
    }

    /// Die gesperrte Konfliktressource.
    pub const fn resource(&self) -> ConflictResource {
        self.resource
    }

    /// Die Fahrtrichtung in diesem Abschnitt.
    pub const fn direction(&self) -> TravelDirection {
        self.direction
    }

    /// Die Betriebsstelle, deren Stellwerk den Fahrweg stellt.
    pub const fn governing_point(&self) -> OperatingPointId {
        self.governing_point
    }

    /// Beginn der Sperrzeit, in Sekunden ab der Abfahrt.
    pub const fn start_s(&self) -> i64 {
        self.start_s
    }

    /// Beginn der Annäherungsfahrt, in Sekunden ab der Abfahrt.
    pub const fn approach_start_s(&self) -> i64 {
        self.approach_start_s
    }

    /// Vorbeifahrt am Hauptsignal — Beginn der Fahrzeit im Abschnitt.
    pub const fn entry_s(&self) -> i64 {
        self.entry_s
    }

    /// Ende der Fahrzeit im Abschnitt, Haltezeit eingeschlossen.
    pub const fn exit_s(&self) -> i64 {
        self.exit_s
    }

    /// Ende der Sperrzeit, in Sekunden ab der Abfahrt.
    pub const fn end_s(&self) -> i64 {
        self.end_s
    }

    /// Dauer der Sperrzeit in Sekunden.
    pub const fn duration_s(&self) -> i64 {
        self.end_s.saturating_sub(self.start_s)
    }

    /// Ob die acht Zeitpunkte aufsteigend sind — die Zusicherung des Modells.
    pub const fn is_ordered(&self) -> bool {
        self.start_s <= self.sighting_s
            && self.sighting_s <= self.approach_start_s
            && self.approach_start_s <= self.entry_s
            && self.entry_s <= self.travel_end_s
            && self.travel_end_s <= self.exit_s
            && self.exit_s <= self.cleared_s
            && self.cleared_s <= self.end_s
    }

    /// Die sechs Anteile mit ihren Grenzen, lückenlos von `start` bis `end`.
    pub const fn phases(&self) -> [(BlockingPhase, i64, i64); 6] {
        [
            (BlockingPhase::RouteSetting, self.start_s, self.sighting_s),
            (
                BlockingPhase::SignalSighting,
                self.sighting_s,
                self.approach_start_s,
            ),
            (BlockingPhase::Approach, self.approach_start_s, self.entry_s),
            (BlockingPhase::Running, self.entry_s, self.exit_s),
            (BlockingPhase::Clearing, self.exit_s, self.cleared_s),
            (BlockingPhase::RouteRelease, self.cleared_s, self.end_s),
        ]
    }

    /// Macht aus der relativen Sperrzeit die eines konkreten Verkehrstags.
    pub const fn at(&self, departure: SimTime) -> BlockingTime {
        BlockingTime {
            resource: self.resource,
            direction: self.direction,
            governing_point: self.governing_point,
            start: departure.plus_seconds(self.start_s),
            sighting: departure.plus_seconds(self.sighting_s),
            approach_start: departure.plus_seconds(self.approach_start_s),
            entry: departure.plus_seconds(self.entry_s),
            travel_end: departure.plus_seconds(self.travel_end_s),
            exit: departure.plus_seconds(self.exit_s),
            cleared: departure.plus_seconds(self.cleared_s),
            end: departure.plus_seconds(self.end_s),
        }
    }

    /// Schreibt die Belegung in den Zustands-Hash.
    pub(crate) fn write_canonical(&self, hasher: &mut StateHasher) {
        self.resource.write_canonical("resource", hasher);
        hasher.text("direction", self.direction.tag());
        hasher.uint("point", u64::from(self.governing_point.value()));
        for (phase, von, bis) in self.phases() {
            hasher.text("phase", phase.tag());
            hasher.int("from", von);
            hasher.int("to", bis);
        }
    }
}

/// Die Sperrzeit einer Zugfahrt auf einer Konfliktressource, an einem
/// konkreten Verkehrstag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockingTime {
    resource: ConflictResource,
    direction: TravelDirection,
    governing_point: OperatingPointId,
    start: SimTime,
    sighting: SimTime,
    approach_start: SimTime,
    entry: SimTime,
    travel_end: SimTime,
    exit: SimTime,
    cleared: SimTime,
    end: SimTime,
}

impl BlockingTime {
    /// Rekonstruiert eine bestätigte Gesamtbelegung für die Konfliktprüfung.
    /// Die ursprünglichen sechs Phasen bleiben separat im Projektionsbeleg;
    /// für die Reservierung zählt das exakte halboffene Gesamtintervall.
    pub const fn reserved_interval(
        resource: ConflictResource,
        direction: TravelDirection,
        governing_point: OperatingPointId,
        start: SimTime,
        end: SimTime,
    ) -> Option<Self> {
        if start.seconds() < 0 || end.seconds() <= start.seconds() {
            return None;
        }
        Some(Self {
            resource,
            direction,
            governing_point,
            start,
            sighting: start,
            approach_start: start,
            entry: start,
            travel_end: end,
            exit: end,
            cleared: end,
            end,
        })
    }
    /// Die gesperrte Konfliktressource.
    pub const fn resource(&self) -> ConflictResource {
        self.resource
    }

    /// Die Fahrtrichtung in diesem Abschnitt.
    pub const fn direction(&self) -> TravelDirection {
        self.direction
    }

    /// Die Betriebsstelle, deren Stellwerk den Fahrweg stellt.
    pub const fn governing_point(&self) -> OperatingPointId {
        self.governing_point
    }

    /// Beginn der Sperrzeit — Beginn der Fahrstraßenbildung.
    pub const fn start(&self) -> SimTime {
        self.start
    }

    /// Vorbeifahrt am Hauptsignal — Beginn der Fahrzeit im Abschnitt.
    pub const fn entry(&self) -> SimTime {
        self.entry
    }

    /// Ende der reinen Fahrzeit, vor einer etwaigen Haltezeit.
    pub const fn travel_end(&self) -> SimTime {
        self.travel_end
    }

    /// Ende der Fahrzeit im Abschnitt, Haltezeit eingeschlossen.
    pub const fn exit(&self) -> SimTime {
        self.exit
    }

    /// Zugschluss hat Abschnitt und Durchrutschweg geräumt.
    pub const fn cleared(&self) -> SimTime {
        self.cleared
    }

    /// Ende der Sperrzeit — nach der Fahrstraßenauflösung.
    pub const fn end(&self) -> SimTime {
        self.end
    }

    /// Dauer der Sperrzeit in Sekunden.
    pub const fn duration_s(&self) -> i64 {
        self.end.seconds().saturating_sub(self.start.seconds())
    }

    /// Die sechs Anteile mit ihren Grenzen.
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

    /// Ob sich zwei Sperrzeiten zeitlich überschneiden.
    ///
    /// Halboffenes Intervall `[start, end)`: Berührung ist **kein** Konflikt.
    /// Genau an dieser Grenze liegt die Mindestzugfolgezeit.
    pub const fn overlaps(&self, other: &Self) -> bool {
        self.start.seconds() < other.end.seconds() && other.start.seconds() < self.end.seconds()
    }

    /// Dieselbe Sperrzeit, um `seconds` verschoben.
    ///
    /// Eine Sperrzeit verschiebt sich **starr**: Alle sechs Anteile behalten
    /// ihre Dauer. Das ist die Eigenschaft, mit der der Planner (M3.4)
    /// Zeitlagen durchprobiert, ohne die Fahrdynamik neu zu rechnen.
    pub const fn shifted(&self, seconds: i64) -> Self {
        Self {
            resource: self.resource,
            direction: self.direction,
            governing_point: self.governing_point,
            start: self.start.plus_seconds(seconds),
            sighting: self.sighting.plus_seconds(seconds),
            approach_start: self.approach_start.plus_seconds(seconds),
            entry: self.entry.plus_seconds(seconds),
            travel_end: self.travel_end.plus_seconds(seconds),
            exit: self.exit.plus_seconds(seconds),
            cleared: self.cleared.plus_seconds(seconds),
            end: self.end.plus_seconds(seconds),
        }
    }

    /// Beginn der Überschneidung zweier Sperrzeiten — auch ohne Prüfung, ob es
    /// eine gibt.
    pub const fn overlap_start(&self, other: &Self) -> SimTime {
        if self.start.seconds() >= other.start.seconds() {
            self.start
        } else {
            other.start
        }
    }

    /// Ende der Überschneidung zweier Sperrzeiten.
    pub const fn overlap_end(&self, other: &Self) -> SimTime {
        if self.end.seconds() <= other.end.seconds() {
            self.end
        } else {
            other.end
        }
    }
}

impl fmt::Display for BlockingTime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} {}–{} s",
            self.resource,
            self.start.seconds(),
            self.end.seconds()
        )
    }
}

/// Die Sperrzeitentreppe einer Zugfahrt: alle Sperrzeiten ihres Laufwegs an
/// einem Verkehrstag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockingTimeStaircase {
    departure: SimTime,
    steps: Vec<BlockingTime>,
}

impl BlockingTimeStaircase {
    /// Baut die Treppe aus den Stufen einer Fahrt.
    pub(crate) const fn new(departure: SimTime, steps: Vec<BlockingTime>) -> Self {
        Self { departure, steps }
    }

    /// Die Abfahrtszeit, auf die die Treppe bezogen ist.
    pub const fn departure(&self) -> SimTime {
        self.departure
    }

    /// Die Stufen in Fahrtreihenfolge.
    pub fn steps(&self) -> &[BlockingTime] {
        &self.steps
    }

    /// Die erste gesperrte Sekunde des gesamten Laufwegs.
    pub fn first_second(&self) -> SimTime {
        self.steps
            .iter()
            .map(BlockingTime::start)
            .min()
            .unwrap_or(self.departure)
    }

    /// Die letzte gesperrte Sekunde des gesamten Laufwegs.
    pub fn last_second(&self) -> SimTime {
        self.steps
            .iter()
            .map(BlockingTime::end)
            .max()
            .unwrap_or(self.departure)
    }

    /// Die Ankunft am Ende des Laufwegs, ohne Räumen und Auflösen.
    pub fn arrival(&self) -> SimTime {
        self.steps
            .last()
            .map_or(self.departure, BlockingTime::travel_end)
    }

    /// Dieselbe Treppe zu einer um `seconds` verschobenen Abfahrt.
    pub fn shifted(&self, seconds: i64) -> Self {
        Self {
            departure: self.departure.plus_seconds(seconds),
            steps: self
                .steps
                .iter()
                .map(|stufe| stufe.shifted(seconds))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BlockingPhase, RelativeOccupation};
    use crate::resource::ConflictResource;
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::{OperatingPointId, TrackId, TravelDirection};

    fn belegung(start: i64, ende: i64) -> RelativeOccupation {
        RelativeOccupation::new(
            ConflictResource::Block {
                track: TrackId::new(1001),
                ordinal: 0,
            },
            TravelDirection::WithChainage,
            OperatingPointId::new(1),
            start,
            start + 2,
            start + 4,
            start + 10,
            ende - 8,
            ende - 8,
            ende - 2,
            ende,
        )
    }

    #[test]
    fn die_anteile_sind_lueckenlos_und_in_reihenfolge() {
        let belegung = belegung(-17, 120);
        assert!(belegung.is_ordered());
        let anteile = belegung.phases();
        assert_eq!(anteile[0].1, belegung.start_s());
        assert_eq!(anteile[5].2, belegung.end_s());
        for paar in anteile.windows(2) {
            assert_eq!(paar[0].2, paar[1].1, "Lücke zwischen den Anteilen");
        }
        let summe: i64 = anteile.iter().map(|(_, von, bis)| bis - von).sum();
        assert_eq!(summe, belegung.duration_s());
        assert_eq!(
            anteile.map(|(phase, _, _)| phase).to_vec(),
            BlockingPhase::ALL.to_vec()
        );
    }

    #[test]
    fn eine_verschobene_zeitlage_verschiebt_die_sperrzeit_starr() {
        // Das ist die Eigenschaft, auf der M3.2 und der Planner aus M3.4
        // aufsetzen: Die relative Belegung wird gerechnet, die Zeitlage
        // aufgeschlagen.
        let belegung = belegung(-17, 120);
        let frueh = belegung.at(SimTime::from_seconds(28_800));
        let spaet = belegung.at(SimTime::from_seconds(29_100));
        assert_eq!(spaet.start().seconds() - frueh.start().seconds(), 300);
        assert_eq!(spaet.end().seconds() - frueh.end().seconds(), 300);
        assert_eq!(frueh.duration_s(), spaet.duration_s());
    }

    #[test]
    fn zwei_sperrzeiten_duerfen_sich_beruehren() {
        // Halboffenes Intervall: Genau an dieser Grenze liegt die
        // Mindestzugfolgezeit — sie fällt damit aus dem Modell heraus, statt
        // als Parameter darin zu stehen.
        let erste = belegung(0, 100).at(SimTime::EPOCH);
        let beruehrend = belegung(100, 200).at(SimTime::EPOCH);
        let ueberlappend = belegung(99, 199).at(SimTime::EPOCH);

        assert!(!erste.overlaps(&beruehrend));
        assert!(!beruehrend.overlaps(&erste));
        assert!(erste.overlaps(&ueberlappend));
        assert!(ueberlappend.overlaps(&erste));
        assert_eq!(
            erste.overlap_start(&ueberlappend),
            SimTime::from_seconds(99)
        );
        assert_eq!(erste.overlap_end(&ueberlappend), SimTime::from_seconds(100));
    }

    #[test]
    fn die_sperrzeit_beginnt_vor_der_abfahrt_und_endet_nach_der_ausfahrt() {
        let belegung = belegung(-17, 120).at(SimTime::from_seconds(28_800));
        assert!(belegung.start().seconds() < 28_800);
        assert!(belegung.end().seconds() > belegung.exit().seconds());
    }
}
