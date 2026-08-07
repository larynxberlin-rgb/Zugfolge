//! Abdeckungsmessung — **M1.4**.
//!
//! `docs/daten.md` 5 nennt drei Qualitätsklassen: **A — validiert**, mit
//! fachlich geprüften Signalen, Fahrstraßen und Blöcken; **B — konservativ**,
//! mit virtuellen Blöcken und sicheren Annahmen, aber vollständig spielbar;
//! **C — unzureichend**, nur Kartendarstellung, keine Trassenbestellung. Die
//! ersten beiden Klassen zu erreichen ist Aufgabe der Blockableitung (M1.6)
//! und der Fahrstraßenableitung (M1.7) — beide fehlen noch. Was diese Stufe
//! liefert, ist die Messung, **auf der** jene Stufen aufsetzen können:
//! [`QualityClass::from_confidence`] bildet den Vertrauensgrad eines
//! Abschnitts (`Confidence`, M1.1) unmittelbar auf die Klasse ab, die er
//! höchstens tragen kann. Ein Abschnitt mit einem angenommenen Attribut kann
//! nicht Klasse A werden, ganz gleich, wie sorgfältig seine Blöcke und
//! Fahrstraßen später geprüft sind.
//!
//! **Je Attribut und Streckenabschnitt**, wie der Milestone verlangt:
//! [`AttributeCoverage`] summiert die Länge je Vertrauensgrad für ein
//! einzelnes Attribut — Vmax, Neigung, Elektrifizierung, Zugsicherung — über
//! ein Gleis oder den ganzen Graphen. [`TrackCoverage::achievable_sections`]
//! zerlegt ein einzelnes Gleis an jeder Bandgrenze eines seiner vier Profile
//! neu und nennt für jeden entstehenden Abschnitt die erreichbare Klasse: das
//! Minimum der vier Vertrauensgrade an dieser Stelle, denn ein Abschnitt ist
//! so belastbar wie sein schwächstes Attribut (dieselbe Regel wie
//! [`Track::confidence`](crate::Track::confidence) — hier nur ortsaufgelöst
//! statt gleisweit).
//!
//! Alle Anteile sind ganzzahlig in Promille (Invariante 3) — kein
//! Prozentwert mit Nachkommastelle.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::graph::OperatingGraph;
use crate::identity::TrackId;
use crate::provenance::Confidence;
use crate::track::Track;
use crate::units::Length;

/// Die drei Qualitätsklassen aus `docs/daten.md` 5, aufsteigend nach Güte —
/// wie `Confidence`, dessen Ordnung sie unmittelbar fortsetzt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum QualityClass {
    /// unzureichend — Darstellung auf der Karte, keine Trassenbestellung.
    C,
    /// konservativ — virtuelle Blöcke und sichere Annahmen, vollständig
    /// spielbar.
    B,
    /// validiert — vollständige Simulation. Setzt zusätzlich die geprüften
    /// Blöcke und Fahrstraßen aus M1.6/M1.7 voraus, die diese Stufe noch
    /// nicht kennt; hier ist es die datenseitige Obergrenze.
    A,
}

impl QualityClass {
    /// Die höchste Klasse, die ein Vertrauensgrad allein trägt.
    ///
    /// Die Abbildung ist absichtlich die einfachste, die sich aus
    /// `docs/daten.md` begründen lässt (E19): erfasst trägt A, abgeleitet
    /// trägt höchstens B, angenommen höchstens C. Eine feinere Regel bräuchte
    /// eine Entscheidung, die noch nicht getroffen ist — etwa welches
    /// Attribut wie stark wiegt.
    pub const fn from_confidence(confidence: Confidence) -> Self {
        match confidence {
            Confidence::Assumed => Self::C,
            Confidence::Derived => Self::B,
            Confidence::Surveyed => Self::A,
        }
    }

    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::C => "c",
            Self::B => "b",
            Self::A => "a",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::C => "unzureichend",
            Self::B => "konservativ",
            Self::A => "validiert",
        }
    }
}

impl fmt::Display for QualityClass {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({})",
            self.tag().to_uppercase(),
            self.label()
        )
    }
}

/// Die Länge je Vertrauensgrad für ein einzelnes Attribut.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributeCoverage {
    attribute: &'static str,
    assumed: Length,
    derived: Length,
    surveyed: Length,
}

impl AttributeCoverage {
    fn empty(attribute: &'static str) -> Self {
        Self {
            attribute,
            assumed: Length::ZERO,
            derived: Length::ZERO,
            surveyed: Length::ZERO,
        }
    }

    fn add(&mut self, confidence: Confidence, length: Length) {
        match confidence {
            Confidence::Assumed => self.assumed = self.assumed + length,
            Confidence::Derived => self.derived = self.derived + length,
            Confidence::Surveyed => self.surveyed = self.surveyed + length,
        }
    }

    fn merge(&mut self, other: &Self) {
        self.assumed = self.assumed + other.assumed;
        self.derived = self.derived + other.derived;
        self.surveyed = self.surveyed + other.surveyed;
    }

    /// Das gemessene Attribut, etwa `"vmax"`.
    pub const fn attribute(&self) -> &'static str {
        self.attribute
    }

    /// Die Länge mit diesem Vertrauensgrad.
    pub const fn length_at(&self, confidence: Confidence) -> Length {
        match confidence {
            Confidence::Assumed => self.assumed,
            Confidence::Derived => self.derived,
            Confidence::Surveyed => self.surveyed,
        }
    }

    /// Die gemessene Gesamtlänge über alle Vertrauensgrade.
    pub fn total(&self) -> Length {
        self.assumed + self.derived + self.surveyed
    }

    /// Der Anteil eines Vertrauensgrads an der Gesamtlänge, in Promille
    /// (Tausendstel) — ganzzahlig, kein Prozentwert mit Nachkommastelle
    /// (Invariante 3). Null, wenn nichts gemessen wurde.
    pub fn per_mille(&self, confidence: Confidence) -> i64 {
        let total = self.total().millimetres();
        if total == 0 {
            return 0;
        }
        self.length_at(confidence)
            .millimetres()
            .saturating_mul(1_000)
            / total
    }
}

/// Ein Abschnitt eines Gleises mit einer erreichbaren Qualitätsklasse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AchievableSection {
    start: Length,
    end: Length,
    class: QualityClass,
}

impl AchievableSection {
    /// Anfang des Abschnitts, ab dem Gleisanfang gezählt.
    pub const fn start(&self) -> Length {
        self.start
    }

    /// Ende des Abschnitts.
    pub const fn end(&self) -> Length {
        self.end
    }

    /// Ausdehnung des Abschnitts.
    pub fn length(&self) -> Length {
        self.end - self.start
    }

    /// Die höchste Klasse, die dieser Abschnitt datenseitig erreichen kann.
    pub const fn class(&self) -> QualityClass {
        self.class
    }
}

/// Der Abdeckungsbericht eines einzelnen Gleises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackCoverage {
    track: TrackId,
    speed: AttributeCoverage,
    gradient: AttributeCoverage,
    electrification: AttributeCoverage,
    protection: AttributeCoverage,
    achievable: Vec<AchievableSection>,
}

impl TrackCoverage {
    fn measure(track: &Track) -> Self {
        let mut speed = AttributeCoverage::empty("vmax");
        for band in track.speed().bands() {
            speed.add(band.confidence(), band.length());
        }
        let mut gradient = AttributeCoverage::empty("neigung");
        for band in track.gradient().bands() {
            gradient.add(band.confidence(), band.length());
        }
        let mut electrification = AttributeCoverage::empty("elektrifizierung");
        for band in track.electrification().bands() {
            electrification.add(band.confidence(), band.length());
        }
        let mut protection = AttributeCoverage::empty("zugsicherung");
        for band in track.protection().bands() {
            protection.add(band.confidence(), band.length());
        }

        let achievable = achievable_sections(track);

        Self {
            track: track.id(),
            speed,
            gradient,
            electrification,
            protection,
            achievable,
        }
    }

    /// Das gemessene Gleis.
    pub const fn track(&self) -> TrackId {
        self.track
    }

    /// Die Abdeckung des Vmax-Profils.
    pub const fn speed(&self) -> &AttributeCoverage {
        &self.speed
    }

    /// Die Abdeckung des Neigungsprofils.
    pub const fn gradient(&self) -> &AttributeCoverage {
        &self.gradient
    }

    /// Die Abdeckung des Elektrifizierungsprofils.
    pub const fn electrification(&self) -> &AttributeCoverage {
        &self.electrification
    }

    /// Die Abdeckung des Zugsicherungsprofils.
    pub const fn protection(&self) -> &AttributeCoverage {
        &self.protection
    }

    /// Die erreichbare Qualitätsklasse je Abschnitt, an jeder Bandgrenze
    /// eines der vier Profile neu geteilt.
    pub fn achievable_sections(&self) -> &[AchievableSection] {
        &self.achievable
    }

    /// Die schwächste erreichbare Qualitätsklasse dieses Gleises — die Klasse,
    /// mit der es insgesamt geführt werden müsste.
    pub fn worst_achievable_class(&self) -> QualityClass {
        self.achievable
            .iter()
            .map(AchievableSection::class)
            .min()
            .unwrap_or(QualityClass::A)
    }
}

/// Zerlegt ein Gleis an jeder Bandgrenze seiner vier Profile und bewertet
/// jeden entstehenden Abschnitt mit dem schwächsten der vier Vertrauensgrade
/// an dieser Stelle.
fn achievable_sections(track: &Track) -> Vec<AchievableSection> {
    let mut boundaries: BTreeSet<Length> = BTreeSet::new();
    boundaries.insert(Length::ZERO);
    boundaries.insert(track.length());
    for band in track.speed().bands() {
        boundaries.insert(band.start());
        boundaries.insert(band.end());
    }
    for band in track.gradient().bands() {
        boundaries.insert(band.start());
        boundaries.insert(band.end());
    }
    for band in track.electrification().bands() {
        boundaries.insert(band.start());
        boundaries.insert(band.end());
    }
    for band in track.protection().bands() {
        boundaries.insert(band.start());
        boundaries.insert(band.end());
    }

    let points: Vec<Length> = boundaries.into_iter().collect();
    let mut sections = Vec::with_capacity(points.len().saturating_sub(1));
    for fenster in points.windows(2) {
        let [start, end] = fenster else { continue };
        let confidence = [
            track.speed().band_at(*start).map(|band| band.confidence()),
            track
                .gradient()
                .band_at(*start)
                .map(|band| band.confidence()),
            track
                .electrification()
                .band_at(*start)
                .map(|band| band.confidence()),
            track
                .protection()
                .band_at(*start)
                .map(|band| band.confidence()),
        ]
        .into_iter()
        .flatten()
        .fold(Confidence::Surveyed, Confidence::weakest);

        sections.push(AchievableSection {
            start: *start,
            end: *end,
            class: QualityClass::from_confidence(confidence),
        });
    }
    sections
}

/// Der Abdeckungsbericht eines ganzen Betriebsgraphen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoverageReport {
    tracks: BTreeMap<TrackId, TrackCoverage>,
    speed_totals: AttributeCoverage,
    gradient_totals: AttributeCoverage,
    electrification_totals: AttributeCoverage,
    protection_totals: AttributeCoverage,
}

impl CoverageReport {
    /// Misst die Abdeckung jedes Gleises eines Betriebsgraphen.
    pub fn measure(graph: &OperatingGraph) -> Self {
        let mut tracks = BTreeMap::new();
        let mut speed_totals = AttributeCoverage::empty("vmax");
        let mut gradient_totals = AttributeCoverage::empty("neigung");
        let mut electrification_totals = AttributeCoverage::empty("elektrifizierung");
        let mut protection_totals = AttributeCoverage::empty("zugsicherung");

        for track in graph.tracks() {
            let coverage = TrackCoverage::measure(track);
            speed_totals.merge(&coverage.speed);
            gradient_totals.merge(&coverage.gradient);
            electrification_totals.merge(&coverage.electrification);
            protection_totals.merge(&coverage.protection);
            tracks.insert(coverage.track, coverage);
        }

        Self {
            tracks,
            speed_totals,
            gradient_totals,
            electrification_totals,
            protection_totals,
        }
    }

    /// Der Abdeckungsbericht eines einzelnen Gleises.
    pub fn track(&self, id: TrackId) -> Option<&TrackCoverage> {
        self.tracks.get(&id)
    }

    /// Alle Gleisberichte, nach Kennung geordnet.
    pub fn tracks(&self) -> impl Iterator<Item = &TrackCoverage> {
        self.tracks.values()
    }

    /// Die Vmax-Abdeckung über den ganzen Graphen.
    pub const fn speed_totals(&self) -> &AttributeCoverage {
        &self.speed_totals
    }

    /// Die Neigungsabdeckung über den ganzen Graphen.
    pub const fn gradient_totals(&self) -> &AttributeCoverage {
        &self.gradient_totals
    }

    /// Die Elektrifizierungsabdeckung über den ganzen Graphen.
    pub const fn electrification_totals(&self) -> &AttributeCoverage {
        &self.electrification_totals
    }

    /// Die Zugsicherungsabdeckung über den ganzen Graphen.
    pub const fn protection_totals(&self) -> &AttributeCoverage {
        &self.protection_totals
    }

    /// Die Gesamtlänge je erreichbarer Qualitätsklasse über den ganzen
    /// Graphen — die Zahl, die vor dem Bau entscheidet, welcher Anteil des
    /// Netzes Klasse A überhaupt erreichen kann.
    pub fn class_totals(&self) -> BTreeMap<QualityClass, Length> {
        let mut totals: BTreeMap<QualityClass, Length> = BTreeMap::new();
        for coverage in self.tracks.values() {
            for section in &coverage.achievable {
                let eintrag = totals.entry(section.class).or_insert(Length::ZERO);
                *eintrag = *eintrag + section.length();
            }
        }
        totals
    }
}

#[cfg(test)]
mod tests {
    use super::{CoverageReport, QualityClass};
    use crate::bands::{Band, BandProfile};
    use crate::electrification::{Electrification, PowerSystem};
    use crate::example::reference_network;
    use crate::graph::OperatingGraph;
    use crate::identity::{OperatingPointCode, OperatingPointId, TrackEdgeId, TrackId};
    use crate::operating_point::{Coordinate, OperatingPoint, OperatingPointKind};
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::speed::SpeedLimit;
    use crate::track::{Track, TrackDirection, TrackKind, TrackOwner};
    use crate::units::{Gradient, Length, Speed};

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            confidence,
        )
    }

    /// Ein Netz mit genau einem Gleis, dessen Neigungsprofil zur Hälfte
    /// erfasst und zur Hälfte angenommen ist — genug, um Anteile und
    /// erreichbare Klassen an einer festen Grenze zu prüfen.
    fn netz_mit_geteiltem_vertrauen() -> OperatingGraph {
        let laenge = Length::from_metres(2_000);
        let punkt = |id: u32, code: &str| {
            OperatingPoint::new(
                OperatingPointId::new(id),
                OperatingPointCode::new(code).expect("gültiges Kürzel"),
                format!("Punkt {id}"),
                OperatingPointKind::Station,
                Coordinate::new(510_000_000, 120_000_000).expect("Punkt liegt auf der Erde"),
                herkunft(Confidence::Surveyed),
            )
            .expect("gültige Betriebsstelle")
        };

        let gleis = Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Streckengleis",
            laenge,
        )
        .kind(TrackKind::ThroughMainTrack)
        .direction(TrackDirection::Bidirectional)
        .speed(
            BandProfile::uniform(
                "vmax",
                laenge,
                SpeedLimit::uniform(Speed::from_km_h(120)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::new(
                "neigung",
                laenge,
                vec![
                    Band::new(
                        Length::ZERO,
                        Length::from_metres(1_000),
                        Gradient::LEVEL,
                        herkunft(Confidence::Surveyed),
                    ),
                    Band::new(
                        Length::from_metres(1_000),
                        laenge,
                        Gradient::from_per_mille(2),
                        herkunft(Confidence::Assumed),
                    ),
                ],
            )
            .expect("Profil ist lückenlos"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                laenge,
                Electrification::Overhead(PowerSystem::Ac15kV),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(
            BandProfile::uniform(
                "zugsicherung",
                laenge,
                TrainProtection::single(ProtectionSystem::Pzb),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis");

        let bahnhofsgleis = |id: u32, owner: OperatingPointId| {
            let kurz = Length::from_metres(200);
            Track::builder(
                TrackId::new(id),
                TrackOwner::OperatingPoint(owner),
                "Gleis 1",
                kurz,
            )
            .kind(TrackKind::ThroughMainTrack)
            .direction(TrackDirection::Bidirectional)
            .speed(
                BandProfile::uniform(
                    "vmax",
                    kurz,
                    SpeedLimit::uniform(Speed::from_km_h(60)).expect("positiv"),
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .gradient(
                BandProfile::uniform(
                    "neigung",
                    kurz,
                    Gradient::LEVEL,
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .electrification(
                BandProfile::uniform(
                    "elektrifizierung",
                    kurz,
                    Electrification::Overhead(PowerSystem::Ac15kV),
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .protection(
                BandProfile::uniform(
                    "zugsicherung",
                    kurz,
                    TrainProtection::single(ProtectionSystem::Pzb),
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .build()
            .expect("gültiges Gleis")
        };

        OperatingGraph::builder()
            .operating_point(punkt(1, "AA"))
            .operating_point(punkt(2, "BB"))
            .edge(
                crate::edge::TrackEdge::new(
                    TrackEdgeId::new(1),
                    OperatingPointId::new(1),
                    OperatingPointId::new(2),
                    "AA – BB",
                    laenge,
                    herkunft(Confidence::Surveyed),
                )
                .expect("gültige Kante"),
            )
            .track(gleis)
            .track(bahnhofsgleis(101, OperatingPointId::new(1)))
            .track(bahnhofsgleis(201, OperatingPointId::new(2)))
            .build()
            .expect("gültiges Netz")
    }

    #[test]
    fn die_abdeckung_zaehlt_laenge_je_vertrauensgrad() {
        let report = CoverageReport::measure(&netz_mit_geteiltem_vertrauen());
        let gradient = report.track(TrackId::new(1)).expect("Gleis 1").gradient();

        assert_eq!(
            gradient.length_at(Confidence::Surveyed),
            Length::from_metres(1_000)
        );
        assert_eq!(
            gradient.length_at(Confidence::Assumed),
            Length::from_metres(1_000)
        );
        assert_eq!(gradient.total(), Length::from_metres(2_000));
        assert_eq!(gradient.per_mille(Confidence::Surveyed), 500);
        assert_eq!(gradient.per_mille(Confidence::Assumed), 500);

        // Vmax, Elektrifizierung und Zugsicherung sind vollständig erfasst.
        let speed = report.track(TrackId::new(1)).expect("Gleis 1").speed();
        assert_eq!(speed.per_mille(Confidence::Surveyed), 1_000);
    }

    #[test]
    fn die_erreichbare_klasse_teilt_sich_an_der_bandgrenze() {
        let report = CoverageReport::measure(&netz_mit_geteiltem_vertrauen());
        let gleis = report.track(TrackId::new(1)).expect("Gleis 1");
        let abschnitte = gleis.achievable_sections();

        assert_eq!(abschnitte.len(), 2);
        assert_eq!(abschnitte[0].start(), Length::ZERO);
        assert_eq!(abschnitte[0].end(), Length::from_metres(1_000));
        assert_eq!(abschnitte[0].class(), QualityClass::A);

        assert_eq!(abschnitte[1].start(), Length::from_metres(1_000));
        assert_eq!(abschnitte[1].end(), Length::from_metres(2_000));
        assert_eq!(abschnitte[1].class(), QualityClass::C);

        assert_eq!(gleis.worst_achievable_class(), QualityClass::C);
    }

    #[test]
    fn die_klassensumme_deckt_die_ganze_laenge_ab() {
        let report = CoverageReport::measure(&netz_mit_geteiltem_vertrauen());
        let summen = report.class_totals();

        // Klasse A: die erste Hälfte des Streckengleises plus die beiden
        // vollständig erfassten Bahnhofsgleise (je 200 m).
        assert_eq!(
            summen.get(&QualityClass::A),
            Some(&Length::from_metres(1_400))
        );
        assert_eq!(
            summen.get(&QualityClass::C),
            Some(&Length::from_metres(1_000))
        );
        assert_eq!(summen.get(&QualityClass::B), None);
    }

    #[test]
    fn quality_class_ist_aufsteigend_geordnet() {
        assert!(QualityClass::C < QualityClass::B);
        assert!(QualityClass::B < QualityClass::A);
        assert_eq!(
            QualityClass::from_confidence(Confidence::Assumed),
            QualityClass::C
        );
        assert_eq!(
            QualityClass::from_confidence(Confidence::Derived),
            QualityClass::B
        );
        assert_eq!(
            QualityClass::from_confidence(Confidence::Surveyed),
            QualityClass::A
        );
    }

    #[test]
    fn das_beispielnetz_traegt_ueberall_hoechstens_klasse_b() {
        // Jedes Neigungsband des Beispielnetzes ist 'abgeleitet' (M1.5) — kein
        // Gleis kann deshalb Klasse A erreichen, siehe example.rs.
        let report = CoverageReport::measure(&reference_network());
        for gleis in report.tracks() {
            assert!(
                gleis.worst_achievable_class() <= QualityClass::B,
                "Gleis {} sollte höchstens B erreichen",
                gleis.track()
            );
        }
        let summen = report.class_totals();
        assert_eq!(summen.get(&QualityClass::A), None);
    }
}
