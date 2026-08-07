//! Das Anlagenkataster — **M1.11**.
//!
//! `docs/betrieb.md` 4 nennt den Satz wörtlich: **Anlagen sind
//! Konfliktressourcen wie Gleise.** Werkstätten, Behandlungs- und
//! Waschanlagen, Tankstellen, Entsorgungsanlagen und Abstellgleise haben
//! Kapazität, Öffnungszeiten, Nutzlänge und Baureihenkompetenz — erst dadurch
//! können zwei EVU tatsächlich um dieselbe Abstellanlage in derselben Nacht
//! konkurrieren, statt dass Versorgung eine unbegrenzte Ressource wäre.
//!
//! ## Was eine [`Facility`] trägt
//!
//! Jede Anlage liegt auf einem vorhandenen [`Track`](crate::Track) — nicht auf
//! einem durchgehenden Hauptgleis, auf dem Zugfahrten stattfinden, sondern auf
//! einem Neben-, Abstell- oder Anschlussgleis, wie es der Netzfilter aus M1.3
//! ausdrücklich erhält. Sie trägt eine [`FacilityKind`], eine Kapazität
//! (gleichzeitig behandelbare Fahrzeuge), eine [`OpeningHours`], eine
//! Nutzlänge und eine [`FleetCompetence`] — die Baureihen, die sie behandeln
//! kann. Das ist dieselbe Form, mit der `docs/betrieb.md` 4 sie beschreibt,
//! nur je Anlage statt in Prosa.
//!
//! ## Was hier bewusst nicht steht
//!
//! Die **Belegung** einer Anlage durch eine konkrete Zusatzfahrt ist Aufgabe
//! der Konfliktengine (M5.7) — dieselbe, die auch den Fahrweg vergibt. M1.11
//! liefert nur den Kataster: welche Anlagen es gibt und was sie leisten
//! können, nicht, wer sie wann belegt.
//!
//! Umsetzung: [`FacilityCatalog`], geprüft gegen einen fertigen
//! [`OperatingGraph`](crate::OperatingGraph) — genau wie ein [`Platform`](crate::Platform)
//! an ein vorhandenes Gleis gebunden ist, ist eine [`Facility`] an eines
//! gebunden.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::error::InfraError;
use crate::graph::OperatingGraph;
use crate::identity::{FacilityId, TrackId};
use crate::provenance::Provenance;
use crate::units::Length;

/// Eine Baureihenbezeichnung — faktisch, wie E6 es verlangt.
///
/// Kein Katalogeintrag: M1.9/M5.1 liefern erst den Fahrzeugkatalog. Hier steht
/// nur, dass eine Bezeichnung überhaupt eine sein kann — ein bis zehn Zeichen
/// aus Buchstaben, Ziffern, Punkt und Bindestrich, wie `423` oder `423.1-4`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FleetClass(String);

impl FleetClass {
    /// Kleinste zulässige Länge.
    pub const MIN_LENGTH: usize = 1;

    /// Größte zulässige Länge.
    pub const MAX_LENGTH: usize = 10;

    /// Prüft und übernimmt eine Baureihenbezeichnung.
    ///
    /// # Errors
    ///
    /// [`InfraError::FleetClass`], wenn die Bezeichnung diese Form nicht hat.
    pub fn new(designation: impl Into<String>) -> Result<Self, InfraError> {
        let designation = designation.into();
        let zulaessig = designation
            .chars()
            .all(|zeichen| zeichen.is_ascii_alphanumeric() || zeichen == '.' || zeichen == '-');
        let laenge = designation.chars().count();
        if !zulaessig || !(Self::MIN_LENGTH..=Self::MAX_LENGTH).contains(&laenge) {
            return Err(InfraError::FleetClass(designation));
        }
        Ok(Self(designation))
    }

    /// Die Bezeichnung als Zeichenkette.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FleetClass {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Die Baureihen, die eine Anlage behandeln kann.
///
/// Eine Menge, keine Aufzählung nach Größe: Eine Werkstatt für
/// Elektrotriebwagen behandelt regelmäßig mehrere Baureihen, aber nicht jede.
/// Die Reihenfolge ist geordnet (`BTreeSet`), aus demselben Grund wie bei
/// [`TrainProtection`](crate::TrainProtection): Ein Fingerabdruck darf nicht
/// an der Einfügereihenfolge hängen.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FleetCompetence {
    classes: BTreeSet<FleetClass>,
}

impl FleetCompetence {
    /// Kompetenz aus einer Aufzählung von Baureihen.
    pub fn from_classes(classes: impl IntoIterator<Item = FleetClass>) -> Self {
        Self {
            classes: classes.into_iter().collect(),
        }
    }

    /// Kompetenz für genau eine Baureihe.
    pub fn single(class: FleetClass) -> Self {
        Self::from_classes([class])
    }

    /// Die Baureihen in fester Reihenfolge.
    pub fn classes(&self) -> impl Iterator<Item = &FleetClass> {
        self.classes.iter()
    }

    /// Anzahl der Baureihen.
    pub fn count(&self) -> usize {
        self.classes.len()
    }

    /// Ob eine Baureihe zur Kompetenz gehört.
    pub fn contains(&self, class: &FleetClass) -> bool {
        self.classes.contains(class)
    }

    /// Ob die Kompetenz keine einzige Baureihe nennt.
    pub fn is_empty(&self) -> bool {
        self.classes.is_empty()
    }
}

/// Eine Uhrzeit innerhalb eines Tages, in Sekunden seit Mitternacht.
///
/// Kein Datum, keine Zeitzone — eine Öffnungszeit ist eine wiederkehrende
/// Tageseigenschaft der Anlage, keine Simulationszeit (Invariante 2: kein
/// `now()`, [`SimTime`](zugfolge_determinism::SimTime) bleibt allein dem
/// Simulationskern vorbehalten).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimeOfDay(u32);

impl TimeOfDay {
    /// Mitternacht — der Beginn des Tages.
    pub const MIDNIGHT: Self = Self(0);

    /// Sekunden je Tag, zugleich die erste unzulässige Sekundenzahl.
    pub const SECONDS_PER_DAY: u32 = 86_400;

    /// Uhrzeit aus Sekunden seit Mitternacht.
    ///
    /// # Errors
    ///
    /// [`InfraError::TimeOfDay`], wenn die Sekundenzahl außerhalb eines Tages
    /// liegt.
    pub const fn from_seconds(seconds: u32) -> Result<Self, InfraError> {
        if seconds >= Self::SECONDS_PER_DAY {
            return Err(InfraError::TimeOfDay(seconds));
        }
        Ok(Self(seconds))
    }

    /// Uhrzeit aus Stunde, Minute und Sekunde.
    ///
    /// # Errors
    ///
    /// [`InfraError::TimeOfDay`], wenn die Angaben keine Uhrzeit innerhalb
    /// eines Tages ergeben.
    pub fn from_hms(hour: u32, minute: u32, second: u32) -> Result<Self, InfraError> {
        if hour >= 24 || minute >= 60 || second >= 60 {
            let sekunden = hour
                .saturating_mul(3_600)
                .saturating_add(minute.saturating_mul(60))
                .saturating_add(second);
            return Err(InfraError::TimeOfDay(sekunden));
        }
        Self::from_seconds(hour * 3_600 + minute * 60 + second)
    }

    /// Die Uhrzeit in Sekunden seit Mitternacht.
    pub const fn seconds_since_midnight(self) -> u32 {
        self.0
    }
}

impl fmt::Display for TimeOfDay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:02}:{:02}", self.0 / 3_600, (self.0 / 60) % 60)
    }
}

/// Die Öffnungszeit einer Anlage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OpeningHours {
    /// Durchgehend geöffnet — viele Werkstätten arbeiten in mehreren
    /// Schichten rund um die Uhr.
    Continuous,
    /// Ein tägliches Fenster. `closes` vor `opens` bedeutet ein Fenster über
    /// Mitternacht hinweg, wie es Nachtschichten regelmäßig sind.
    Daily {
        /// Beginn des täglichen Fensters.
        opens: TimeOfDay,
        /// Ende des täglichen Fensters.
        closes: TimeOfDay,
    },
}

impl OpeningHours {
    /// Ein tägliches Fenster von `opens` bis `closes`.
    ///
    /// # Errors
    ///
    /// [`InfraError::EmptyOpeningWindow`], wenn Beginn und Ende gleich sind —
    /// das wäre weder durchgehend geöffnet noch ein Tagesfenster.
    pub fn daily(opens: TimeOfDay, closes: TimeOfDay) -> Result<Self, InfraError> {
        if opens == closes {
            return Err(InfraError::EmptyOpeningWindow);
        }
        Ok(Self::Daily { opens, closes })
    }

    /// Ob die Anlage zu einer gegebenen Uhrzeit geöffnet ist.
    pub fn is_open_at(self, time: TimeOfDay) -> bool {
        match self {
            Self::Continuous => true,
            Self::Daily { opens, closes } if opens < closes => time >= opens && time < closes,
            // Das Fenster reicht über Mitternacht: offen ist alles ab dem
            // Beginn bis Tagesende und wieder ab Mitternacht bis zum Ende.
            Self::Daily { opens, closes } => time >= opens || time < closes,
        }
    }
}

impl fmt::Display for OpeningHours {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Continuous => formatter.write_str("durchgehend geöffnet"),
            Self::Daily { opens, closes } => write!(formatter, "{opens}–{closes} Uhr"),
        }
    }
}

/// Die Art einer Anlage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FacilityKind {
    /// Werkstatt — Fristenarbeiten, Reparatur, Umbau der Fahrzeugkonfiguration.
    Workshop,
    /// Behandlungsanlage — Ver- und Entsorgung: Energie, Sand, Frischwasser,
    /// Fäkalienentsorgung.
    TreatmentPlant,
    /// Waschanlage — Außenreinigung.
    WashPlant,
    /// Tankstelle — Betankung nicht elektrischer Triebfahrzeuge.
    FuelStation,
    /// Entsorgungsanlage — eigenständige Fäkalien- und Abfallentsorgung, wo
    /// sie nicht Teil einer Behandlungsanlage ist.
    DisposalFacility,
    /// Abstellgleis, als Anlage geführt — mit Kapazität, Öffnungszeit und
    /// Baureihenkompetenz, statt nur als [`TrackKind::StablingTrack`](crate::TrackKind::StablingTrack)
    /// im Betriebsgraphen.
    StablingTrack,
}

impl FacilityKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Workshop => "workshop",
            Self::TreatmentPlant => "treatment-plant",
            Self::WashPlant => "wash-plant",
            Self::FuelStation => "fuel-station",
            Self::DisposalFacility => "disposal-facility",
            Self::StablingTrack => "stabling-track",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Workshop => "Werkstatt",
            Self::TreatmentPlant => "Behandlungsanlage",
            Self::WashPlant => "Waschanlage",
            Self::FuelStation => "Tankstelle",
            Self::DisposalFacility => "Entsorgungsanlage",
            Self::StablingTrack => "Abstellgleis",
        }
    }
}

impl fmt::Display for FacilityKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Eine Anlage — Konfliktressource wie ein Gleis (`docs/betrieb.md` 4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facility {
    id: FacilityId,
    track: TrackId,
    name: String,
    kind: FacilityKind,
    capacity: u32,
    opening_hours: OpeningHours,
    usable_length: Length,
    competence: FleetCompetence,
    provenance: Provenance,
}

impl Facility {
    /// Eine Anlage mit allen Angaben aus `docs/betrieb.md` 4.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn der Name leer ist.
    /// - [`InfraError::NonPositiveCapacity`], wenn die Kapazität null ist.
    /// - [`InfraError::NonPositiveLength`], wenn die Nutzlänge nicht positiv
    ///   ist.
    /// - [`InfraError::EmptyFleetCompetence`], wenn keine einzige Baureihe
    ///   genannt ist.
    #[allow(
        clippy::too_many_arguments,
        reason = "jedes Argument hat einen eigenen, unverwechselbaren Typ (docs/betrieb.md 4 nennt genau diese neun Angaben) — ein Erbauer verschöbe nur die Stelle, an der sie zusammenkommen müssen"
    )]
    pub fn new(
        id: FacilityId,
        track: TrackId,
        name: impl Into<String>,
        kind: FacilityKind,
        capacity: u32,
        opening_hours: OpeningHours,
        usable_length: Length,
        competence: FleetCompetence,
        provenance: Provenance,
    ) -> Result<Self, InfraError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InfraError::EmptyName { what: "Anlage" });
        }
        if capacity == 0 {
            return Err(InfraError::NonPositiveCapacity {
                what: "Anlagenkapazität",
                value: capacity,
            });
        }
        if !usable_length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Anlagen-Nutzlänge",
                value: usable_length,
            });
        }
        if competence.is_empty() {
            return Err(InfraError::EmptyFleetCompetence(id));
        }
        Ok(Self {
            id,
            track,
            name,
            kind,
            capacity,
            opening_hours,
            usable_length,
            competence,
            provenance,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> FacilityId {
        self.id
    }

    /// Das Gleis, auf dem die Anlage liegt.
    pub const fn track(&self) -> TrackId {
        self.track
    }

    /// Die Bezeichnung, etwa `Bw Erfurt`.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Die Art der Anlage.
    pub const fn kind(&self) -> FacilityKind {
        self.kind
    }

    /// Wie viele Fahrzeuge die Anlage gleichzeitig behandeln kann.
    pub const fn capacity(&self) -> u32 {
        self.capacity
    }

    /// Die Öffnungszeit.
    pub const fn opening_hours(&self) -> OpeningHours {
        self.opening_hours
    }

    /// Die Nutzlänge — die größte Fahrzeuglänge, die je Behandlungsplatz
    /// hineinpasst.
    pub const fn usable_length(&self) -> Length {
        self.usable_length
    }

    /// Die Baureihenkompetenz.
    pub const fn competence(&self) -> &FleetCompetence {
        &self.competence
    }

    /// Die Herkunft der Angaben.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Ob die Anlage zu einer gegebenen Uhrzeit geöffnet ist.
    pub fn is_open_at(&self, time: TimeOfDay) -> bool {
        self.opening_hours.is_open_at(time)
    }

    /// Ob die Anlage ein Fahrzeug einer Baureihe und Länge behandeln kann.
    pub fn accommodates(&self, class: &FleetClass, length: Length) -> bool {
        self.competence.contains(class) && length.is_positive() && length <= self.usable_length
    }
}

impl fmt::Display for Facility {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.name, self.kind)
    }
}

/// Der geprüfte Anlagenkataster einer Welt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FacilityCatalog {
    facilities: BTreeMap<FacilityId, Facility>,
    facilities_by_track: BTreeMap<TrackId, Vec<FacilityId>>,
}

impl FacilityCatalog {
    /// Beginnt den Bau eines Anlagenkatasters.
    pub fn builder() -> FacilityCatalogBuilder {
        FacilityCatalogBuilder::default()
    }

    /// Alle Anlagen, nach Kennung geordnet.
    pub fn facilities(&self) -> impl Iterator<Item = &Facility> {
        self.facilities.values()
    }

    /// Eine Anlage zu ihrer Kennung.
    pub fn facility(&self, id: FacilityId) -> Option<&Facility> {
        self.facilities.get(&id)
    }

    /// Die Anlagen auf einem Gleis, nach Kennung geordnet.
    pub fn facilities_at(&self, track: TrackId) -> impl Iterator<Item = &Facility> {
        self.facilities_by_track
            .get(&track)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|id| self.facilities.get(id))
    }

    /// Alle Anlagen einer Art, nach Kennung geordnet.
    pub fn facilities_of_kind(&self, kind: FacilityKind) -> impl Iterator<Item = &Facility> {
        self.facilities
            .values()
            .filter(move |anlage| anlage.kind() == kind)
    }

    /// Anzahl der Anlagen.
    pub fn len(&self) -> usize {
        self.facilities.len()
    }

    /// Ob der Kataster keine einzige Anlage enthält.
    pub fn is_empty(&self) -> bool {
        self.facilities.is_empty()
    }
}

/// Der Erbauer eines [`FacilityCatalog`].
#[derive(Clone, Debug, Default)]
pub struct FacilityCatalogBuilder {
    facilities: Vec<Facility>,
}

impl FacilityCatalogBuilder {
    /// Ein leerer Erbauer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Nimmt eine Anlage auf.
    #[must_use]
    pub fn facility(mut self, facility: Facility) -> Self {
        self.facilities.push(facility);
        self
    }

    /// Prüft alle Anlagen gegen einen fertigen Betriebsgraphen und baut den
    /// Kataster.
    ///
    /// # Errors
    ///
    /// - [`InfraError::DuplicateFacility`], wenn eine Kennung doppelt vergeben
    ///   ist.
    /// - [`InfraError::UnknownFacilityTrack`], wenn eine Anlage ein Gleis
    ///   nennt, das es im Graphen nicht gibt.
    /// - [`InfraError::FacilityOnMainTrack`], wenn eine Anlage auf einem Gleis
    ///   liegt, auf dem Zugfahrten stattfinden.
    pub fn build(self, graph: &OperatingGraph) -> Result<FacilityCatalog, InfraError> {
        let mut facilities: BTreeMap<FacilityId, Facility> = BTreeMap::new();
        for facility in self.facilities {
            let id = facility.id();
            if facilities.insert(id, facility).is_some() {
                return Err(InfraError::DuplicateFacility(id));
            }
        }

        let mut facilities_by_track: BTreeMap<TrackId, Vec<FacilityId>> = BTreeMap::new();
        for facility in facilities.values() {
            let Some(track) = graph.track(facility.track()) else {
                return Err(InfraError::UnknownFacilityTrack {
                    facility: facility.id(),
                    track: facility.track(),
                });
            };
            if track.kind().carries_train_runs() {
                return Err(InfraError::FacilityOnMainTrack {
                    facility: facility.id(),
                    track: track.id(),
                });
            }
            facilities_by_track
                .entry(facility.track())
                .or_default()
                .push(facility.id());
        }

        Ok(FacilityCatalog {
            facilities,
            facilities_by_track,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Facility, FacilityCatalog, FacilityKind, FleetClass, FleetCompetence, OpeningHours,
        TimeOfDay,
    };
    use crate::error::InfraError;
    use crate::example::reference_network;
    use crate::identity::{FacilityId, TrackId};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::units::Length;

    fn herkunft() -> Provenance {
        Provenance::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            Confidence::Assumed,
        )
    }

    fn baureihe(bezeichnung: &str) -> FleetClass {
        FleetClass::new(bezeichnung).expect("gültige Baureihenbezeichnung")
    }

    fn werkstatt() -> Facility {
        Facility::new(
            FacilityId::new(1),
            TrackId::new(311),
            "Bw Sandberg",
            FacilityKind::Workshop,
            2,
            OpeningHours::Continuous,
            Length::from_metres(120),
            FleetCompetence::from_classes([baureihe("423"), baureihe("143")]),
            herkunft(),
        )
        .expect("gültige Anlage")
    }

    #[test]
    fn baureihenbezeichnungen_folgen_e6() {
        assert!(FleetClass::new("423").is_ok());
        assert!(FleetClass::new("423.1-4").is_ok());
        assert!(matches!(
            FleetClass::new(""),
            Err(InfraError::FleetClass(_))
        ));
        assert!(matches!(
            FleetClass::new("zu-lang-fuer-eine-baureihe"),
            Err(InfraError::FleetClass(_))
        ));
    }

    #[test]
    fn die_kompetenz_ist_eine_menge() {
        let kompetenz = FleetCompetence::from_classes([baureihe("423"), baureihe("143")]);
        assert_eq!(kompetenz.count(), 2);
        assert!(kompetenz.contains(&baureihe("423")));
        assert!(!kompetenz.contains(&baureihe("245")));
        assert!(!kompetenz.is_empty());
        assert!(FleetCompetence::default().is_empty());
    }

    #[test]
    fn eine_uhrzeit_bleibt_innerhalb_eines_tages() {
        assert_eq!(
            TimeOfDay::from_hms(6, 30, 0)
                .expect("gültige Uhrzeit")
                .seconds_since_midnight(),
            6 * 3_600 + 30 * 60
        );
        assert!(matches!(
            TimeOfDay::from_seconds(86_400),
            Err(InfraError::TimeOfDay(86_400))
        ));
        assert!(matches!(
            TimeOfDay::from_hms(24, 0, 0),
            Err(InfraError::TimeOfDay(_))
        ));
    }

    #[test]
    fn ein_tagesfenster_ueber_mitternacht_bleibt_geoeffnet() {
        let nachtschicht = OpeningHours::daily(
            TimeOfDay::from_hms(22, 0, 0).expect("gültige Uhrzeit"),
            TimeOfDay::from_hms(6, 0, 0).expect("gültige Uhrzeit"),
        )
        .expect("gültiges Fenster");

        assert!(nachtschicht.is_open_at(TimeOfDay::from_hms(23, 0, 0).expect("gültig")));
        assert!(nachtschicht.is_open_at(TimeOfDay::MIDNIGHT));
        assert!(nachtschicht.is_open_at(TimeOfDay::from_hms(5, 59, 0).expect("gültig")));
        assert!(!nachtschicht.is_open_at(TimeOfDay::from_hms(12, 0, 0).expect("gültig")));
    }

    #[test]
    fn ein_leeres_fenster_faellt_auf() {
        let mittag = TimeOfDay::from_hms(12, 0, 0).expect("gültige Uhrzeit");
        assert!(matches!(
            OpeningHours::daily(mittag, mittag),
            Err(InfraError::EmptyOpeningWindow)
        ));
    }

    #[test]
    fn durchgehend_ist_immer_geoeffnet() {
        assert!(OpeningHours::Continuous.is_open_at(TimeOfDay::MIDNIGHT));
        assert!(
            OpeningHours::Continuous.is_open_at(TimeOfDay::from_hms(15, 0, 0).expect("gültig"))
        );
    }

    #[test]
    fn eine_anlage_ohne_kompetenz_faellt_auf() {
        let fehler = Facility::new(
            FacilityId::new(1),
            TrackId::new(311),
            "Bw Sandberg",
            FacilityKind::Workshop,
            1,
            OpeningHours::Continuous,
            Length::from_metres(100),
            FleetCompetence::default(),
            herkunft(),
        )
        .expect_err("eine Anlage ohne Kompetenz könnte nie belegt werden");
        assert!(matches!(fehler, InfraError::EmptyFleetCompetence(_)));
    }

    #[test]
    fn eine_anlage_ohne_kapazitaet_faellt_auf() {
        let fehler = Facility::new(
            FacilityId::new(1),
            TrackId::new(311),
            "Bw Sandberg",
            FacilityKind::Workshop,
            0,
            OpeningHours::Continuous,
            Length::from_metres(100),
            FleetCompetence::single(baureihe("423")),
            herkunft(),
        )
        .expect_err("null Fahrzeuge gleichzeitig sind keine Kapazität");
        assert!(matches!(fehler, InfraError::NonPositiveCapacity { .. }));
    }

    #[test]
    fn eine_anlage_behandelt_nur_passende_fahrzeuge() {
        let werkstatt = werkstatt();
        assert!(werkstatt.accommodates(&baureihe("423"), Length::from_metres(100)));
        // Zu lang für die Nutzlänge von 120 m.
        assert!(!werkstatt.accommodates(&baureihe("423"), Length::from_metres(140)));
        // Baureihe 245 gehört nicht zur Kompetenz dieser Werkstatt.
        assert!(!werkstatt.accommodates(&baureihe("245"), Length::from_metres(100)));
    }

    #[test]
    fn der_kataster_haengt_am_abstellgleis_von_sandberg() {
        let netz = reference_network();
        let kataster = FacilityCatalog::builder()
            .facility(werkstatt())
            .build(&netz)
            .expect("die Anlage liegt auf dem Abstellgleis von Sandberg");

        assert_eq!(kataster.len(), 1);
        assert_eq!(kataster.facilities_at(TrackId::new(311)).count(), 1);
        assert_eq!(
            kataster.facilities_of_kind(FacilityKind::Workshop).count(),
            1
        );
        assert_eq!(
            kataster.facilities_of_kind(FacilityKind::WashPlant).count(),
            0
        );
    }

    #[test]
    fn eine_anlage_auf_unbekanntem_gleis_faellt_auf() {
        let netz = reference_network();
        let anlage = Facility::new(
            FacilityId::new(1),
            TrackId::new(99_999),
            "Anlage im Nirgendwo",
            FacilityKind::Workshop,
            1,
            OpeningHours::Continuous,
            Length::from_metres(100),
            FleetCompetence::single(baureihe("423")),
            herkunft(),
        )
        .expect("für sich gültige Anlage");

        let fehler = FacilityCatalog::builder()
            .facility(anlage)
            .build(&netz)
            .expect_err("das Gleis existiert nicht");
        assert!(matches!(fehler, InfraError::UnknownFacilityTrack { .. }));
    }

    #[test]
    fn eine_anlage_auf_dem_hauptgleis_faellt_auf() {
        let netz = reference_network();
        // Gleis 101 ist ein durchgehendes Hauptgleis in Nordstadt — dort
        // finden Zugfahrten statt, keine Anlagen.
        let anlage = Facility::new(
            FacilityId::new(1),
            TrackId::new(101),
            "Anlage auf dem Hauptgleis",
            FacilityKind::Workshop,
            1,
            OpeningHours::Continuous,
            Length::from_metres(100),
            FleetCompetence::single(baureihe("423")),
            herkunft(),
        )
        .expect("für sich gültige Anlage");

        let fehler = FacilityCatalog::builder()
            .facility(anlage)
            .build(&netz)
            .expect_err("auf einem Hauptgleis finden Zugfahrten statt, keine Anlagen");
        assert!(matches!(fehler, InfraError::FacilityOnMainTrack { .. }));
    }

    #[test]
    fn doppelt_vergebene_anlagenkennungen_fallen_auf() {
        let netz = reference_network();
        let fehler = FacilityCatalog::builder()
            .facility(werkstatt())
            .facility(werkstatt())
            .build(&netz)
            .expect_err("dieselbe Kennung zweimal");
        assert!(matches!(fehler, InfraError::DuplicateFacility(_)));
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(werkstatt().to_string(), "Bw Sandberg (Werkstatt)");
        assert_eq!(
            TimeOfDay::from_hms(6, 5, 0).expect("gültig").to_string(),
            "06:05"
        );
        assert_eq!(OpeningHours::Continuous.to_string(), "durchgehend geöffnet");
    }
}
