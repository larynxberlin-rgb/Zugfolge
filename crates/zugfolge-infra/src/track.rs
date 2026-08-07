//! Gleise — das, worauf gefahren wird.
//!
//! Ein Gleis liegt entweder auf einer Kante (freie Strecke) oder in einer
//! Betriebsstelle. Es trägt die vier Attribute, die sich entlang seiner Länge
//! ändern können — Vmax, Neigung, Elektrifizierung und Zugsicherung — jeweils
//! als Bandprofil, und die drei, die für das ganze Gleis gelten: Art,
//! Richtungsbindung und Spurweite.
//!
//! **Was hier bewusst noch nicht steht.** Blockabschnitte sind keine Gleise;
//! sie werden aus Signalstandort, Zugbeeinflussung und Topologie abgeleitet
//! (M1.6). Weichen und Fahrstraßen ebenfalls nicht: Der Bahnhofskopf braucht
//! Ausschlussmengen statt einzelner Ressourcen, und die entstehen erst mit der
//! Fahrstraßenableitung (M1.7). Beides hängt an diesem Modell, ist aber nicht
//! dieses Modell.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::bands::BandProfile;
use crate::canonical::Canonical;
use crate::edge::TravelDirection;
use crate::electrification::Electrification;
use crate::error::InfraError;
use crate::identity::{OperatingPointId, TrackEdgeId, TrackId};
use crate::protection::TrainProtection;
use crate::provenance::Confidence;
use crate::speed::SpeedLimit;
use crate::units::{Gradient, Length, Speed};

/// Wo ein Gleis liegt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TrackOwner {
    /// Auf der freien Strecke, also auf einer Kante.
    Edge(TrackEdgeId),
    /// In einer Betriebsstelle.
    OperatingPoint(OperatingPointId),
}

impl TrackOwner {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Edge(_) => "edge",
            Self::OperatingPoint(_) => "operating-point",
        }
    }

    /// Die Kante, falls das Gleis auf freier Strecke liegt.
    pub const fn edge(self) -> Option<TrackEdgeId> {
        match self {
            Self::Edge(id) => Some(id),
            Self::OperatingPoint(_) => None,
        }
    }

    /// Die Betriebsstelle, falls das Gleis in einer liegt.
    pub const fn operating_point(self) -> Option<OperatingPointId> {
        match self {
            Self::OperatingPoint(id) => Some(id),
            Self::Edge(_) => None,
        }
    }
}

impl fmt::Display for TrackOwner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Edge(id) => write!(formatter, "{id}"),
            Self::OperatingPoint(id) => write!(formatter, "{id}"),
        }
    }
}

impl Canonical for TrackOwner {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
        match self {
            Self::Edge(id) => id.write_canonical(name, hasher),
            Self::OperatingPoint(id) => id.write_canonical(name, hasher),
        }
    }
}

/// Die betriebliche Art eines Gleises.
///
/// Der Netzfilter aus M1.3 behält Betriebs-, Abstell- und Anschlussgleise
/// ausdrücklich — sie sind Konfliktressourcen wie jedes andere Gleis und
/// tragen Zusatzfahrten, Abstellung und Versorgung (M5). Verworfen wird nur,
/// was gar nicht zur EBO gehört (E14), und das entscheidet nicht die Art,
/// sondern Spurweite und Bauart der Elektrifizierung.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TrackKind {
    /// Durchgehendes Hauptgleis — die Fortsetzung der freien Strecke durch die
    /// Betriebsstelle.
    ThroughMainTrack,
    /// Hauptgleis — von Zügen befahrbar, aber nicht durchgehend.
    MainTrack,
    /// Nebengleis — nur Rangierfahrten.
    SecondaryTrack,
    /// Abstellgleis für nicht eingesetzte Fahrzeuge.
    StablingTrack,
    /// Anschlussgleis zu einem nicht öffentlichen Anschluss.
    SidingTrack,
}

impl TrackKind {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::ThroughMainTrack => "through-main-track",
            Self::MainTrack => "main-track",
            Self::SecondaryTrack => "secondary-track",
            Self::StablingTrack => "stabling-track",
            Self::SidingTrack => "siding-track",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::ThroughMainTrack => "durchgehendes Hauptgleis",
            Self::MainTrack => "Hauptgleis",
            Self::SecondaryTrack => "Nebengleis",
            Self::StablingTrack => "Abstellgleis",
            Self::SidingTrack => "Anschlussgleis",
        }
    }

    /// Ob auf diesem Gleis Zugfahrten stattfinden dürfen.
    ///
    /// Auf allem anderen wird ausschließlich rangiert — automatisiert und nie
    /// vom Spieler gesteuert (E12).
    pub const fn carries_train_runs(self) -> bool {
        matches!(self, Self::ThroughMainTrack | Self::MainTrack)
    }

    /// Ob auf diesem Gleis Fahrzeuge abgestellt werden können.
    pub const fn allows_stabling(self) -> bool {
        matches!(self, Self::StablingTrack | Self::SecondaryTrack)
    }
}

impl fmt::Display for TrackKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl Canonical for TrackKind {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Ob ein Gleis an eine Fahrtrichtung gebunden ist.
///
/// Das ist die Eigenschaft, aus der die beiden Konfliktarten entstehen: Auf
/// einem Richtungsgleis können sich nur Züge derselben Richtung in die Quere
/// kommen — ein Zugfolgefall. Auf einem beidseitig befahrbaren Gleis können es
/// auch entgegengesetzte sein — eine Gegenfahrt. Es braucht dafür keine zweite
/// Regel, nur diese Angabe (Befund des Spikes aus M0.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TrackDirection {
    /// In beiden Richtungen befahrbar — eingleisige Strecke, Bahnhofsgleis.
    Bidirectional,
    /// Richtungsgleis in Richtung wachsender Kilometrierung.
    WithChainage,
    /// Richtungsgleis gegen die Kilometrierung.
    AgainstChainage,
}

impl TrackDirection {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Bidirectional => "bidirectional",
            Self::WithChainage => "with-chainage",
            Self::AgainstChainage => "against-chainage",
        }
    }

    /// Ob ein Zug dieser Fahrtrichtung das Gleis regelmäßig befahren darf.
    pub const fn allows(self, direction: TravelDirection) -> bool {
        match self {
            Self::Bidirectional => true,
            Self::WithChainage => matches!(direction, TravelDirection::WithChainage),
            Self::AgainstChainage => matches!(direction, TravelDirection::AgainstChainage),
        }
    }

    /// Ob beide Richtungen sich dieses Gleis teilen und damit eine Gegenfahrt
    /// möglich ist.
    pub const fn permits_opposing_moves(self) -> bool {
        matches!(self, Self::Bidirectional)
    }
}

impl Canonical for TrackDirection {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Die Spurweite eines Gleises, in Millimetern.
///
/// E14 grenzt das Spielnetz auf die EBO ab, M1.3 filtert entsprechend auf
/// 1435 mm. Damit der Filter etwas zu filtern hat, kann das Modell auch andere
/// Spurweiten beschreiben.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrackGauge(i32);

impl TrackGauge {
    /// Regelspur, 1435 mm.
    pub const STANDARD: Self = Self(1_435);

    /// Spurweite aus Millimetern.
    ///
    /// # Errors
    ///
    /// [`InfraError::NonPositiveLength`], wenn die Spurweite nicht positiv ist.
    pub fn from_millimetres(millimetres: i32) -> Result<Self, InfraError> {
        if millimetres <= 0 {
            return Err(InfraError::NonPositiveLength {
                what: "Spurweite",
                value: Length::from_millimetres(i64::from(millimetres)),
            });
        }
        Ok(Self(millimetres))
    }

    /// Die Spurweite in Millimetern.
    pub const fn millimetres(self) -> i32 {
        self.0
    }

    /// Ob es sich um Regelspur handelt.
    pub const fn is_standard(self) -> bool {
        self.0 == Self::STANDARD.0
    }
}

impl fmt::Display for TrackGauge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} mm", self.0)
    }
}

impl Canonical for TrackGauge {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, i64::from(self.0));
    }
}

/// Ein Gleis mit allen Attributen, die M1.1 verlangt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    id: TrackId,
    owner: TrackOwner,
    designation: String,
    kind: TrackKind,
    direction: TrackDirection,
    gauge: TrackGauge,
    length: Length,
    usable_length: Length,
    speed: BandProfile<SpeedLimit>,
    gradient: BandProfile<Gradient>,
    electrification: BandProfile<Electrification>,
    protection: BandProfile<TrainProtection>,
}

impl Track {
    /// Beginnt den Bau eines Gleises.
    ///
    /// Der Bau geht über einen Erbauer statt über einen Konstruktor, weil ein
    /// Gleis zwölf Angaben trägt. Eine Funktion mit zwölf Argumenten wäre an
    /// der Aufrufstelle nicht mehr lesbar — und ein vertauschtes Paar fiele
    /// niemandem auf.
    pub fn builder(
        id: TrackId,
        owner: TrackOwner,
        designation: impl Into<String>,
        length: Length,
    ) -> TrackBuilder {
        TrackBuilder {
            id,
            owner,
            designation: designation.into(),
            kind: TrackKind::MainTrack,
            direction: TrackDirection::Bidirectional,
            gauge: TrackGauge::STANDARD,
            length,
            usable_length: None,
            speed: None,
            gradient: None,
            electrification: None,
            protection: None,
        }
    }

    /// Die Kennung.
    pub const fn id(&self) -> TrackId {
        self.id
    }

    /// Wo das Gleis liegt.
    pub const fn owner(&self) -> TrackOwner {
        self.owner
    }

    /// Die Gleisbezeichnung, etwa `Gleis 2` oder `Gleis A`.
    pub fn designation(&self) -> &str {
        &self.designation
    }

    /// Die Art des Gleises.
    pub const fn kind(&self) -> TrackKind {
        self.kind
    }

    /// Die Richtungsbindung.
    pub const fn direction(&self) -> TrackDirection {
        self.direction
    }

    /// Die Spurweite.
    pub const fn gauge(&self) -> TrackGauge {
        self.gauge
    }

    /// Die Länge des Gleises.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die Nutzlänge — der Teil, auf dem Fahrzeuge stehen dürfen.
    pub const fn usable_length(&self) -> Length {
        self.usable_length
    }

    /// Das Vmax-Profil.
    pub const fn speed(&self) -> &BandProfile<SpeedLimit> {
        &self.speed
    }

    /// Das Neigungsprofil.
    pub const fn gradient(&self) -> &BandProfile<Gradient> {
        &self.gradient
    }

    /// Das Elektrifizierungsprofil.
    pub const fn electrification(&self) -> &BandProfile<Electrification> {
        &self.electrification
    }

    /// Das Zugsicherungsprofil.
    pub const fn protection(&self) -> &BandProfile<TrainProtection> {
        &self.protection
    }

    /// Die zulässige Geschwindigkeit an einer Position.
    pub fn speed_at(&self, position: Length) -> Option<&SpeedLimit> {
        self.speed.value_at(position)
    }

    /// Die Längsneigung an einer Position, bezogen auf die Kilometrierung.
    pub fn gradient_at(&self, position: Length) -> Option<Gradient> {
        self.gradient.value_at(position).copied()
    }

    /// Die Längsneigung an einer Position, aus Sicht einer Fahrtrichtung.
    ///
    /// Gegen die Kilometrierung wird aus jeder Steigung ein Gefälle. Ohne diese
    /// Umkehr rechnete die Fahrdynamik (M1.10) den halben Netzverkehr bergauf,
    /// der bergab fährt.
    pub fn gradient_for(&self, position: Length, direction: TravelDirection) -> Option<Gradient> {
        self.gradient_at(position).map(|neigung| match direction {
            TravelDirection::WithChainage => neigung,
            TravelDirection::AgainstChainage => neigung.reversed(),
        })
    }

    /// Die Elektrifizierung an einer Position.
    pub fn electrification_at(&self, position: Length) -> Option<Electrification> {
        self.electrification.value_at(position).copied()
    }

    /// Die Zugsicherung an einer Position.
    pub fn protection_at(&self, position: Length) -> Option<&TrainProtection> {
        self.protection.value_at(position)
    }

    /// Ob das Gleis über seine volle Länge elektrifiziert ist.
    pub fn is_fully_electrified(&self) -> bool {
        self.electrification
            .bands()
            .iter()
            .all(|band| band.value().is_electrified())
    }

    /// Ob das Gleis über seine volle Länge durchgehend überwacht ist.
    pub fn has_continuous_supervision(&self) -> bool {
        self.protection
            .bands()
            .iter()
            .all(|band| band.value().has_continuous_supervision())
    }

    /// Die höchste zulässige Geschwindigkeit über alle Bänder und Kategorien.
    pub fn maximum_speed(&self) -> Speed {
        self.speed
            .bands()
            .iter()
            .map(|band| band.value().maximum())
            .max()
            .unwrap_or(Speed::ZERO)
    }

    /// Der schwächste Vertrauensgrad aller Attribute dieses Gleises.
    ///
    /// Das ist die Zahl, auf der die Abdeckungsmessung aus M1.4 aufsetzt: Ein
    /// Gleis ist so belastbar wie sein schwächstes Attribut.
    pub fn confidence(&self) -> Confidence {
        [
            self.speed.confidence(),
            self.gradient.confidence(),
            self.electrification.confidence(),
            self.protection.confidence(),
        ]
        .into_iter()
        .fold(Confidence::Surveyed, Confidence::weakest)
    }
}

impl fmt::Display for Track {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.designation, self.kind)
    }
}

impl Canonical for Track {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.id.write_canonical(name, hasher);
        self.owner.write_canonical(name, hasher);
        hasher.text(name, &self.designation);
        self.kind.write_canonical(name, hasher);
        self.direction.write_canonical(name, hasher);
        self.gauge.write_canonical(name, hasher);
        self.length.write_canonical(name, hasher);
        self.usable_length.write_canonical(name, hasher);
        self.speed.write_canonical("vmax", hasher);
        self.gradient.write_canonical("neigung", hasher);
        self.electrification
            .write_canonical("elektrifizierung", hasher);
        self.protection.write_canonical("zugsicherung", hasher);
    }
}

/// Der Erbauer eines [`Track`].
///
/// Art, Richtungsbindung, Spurweite und Nutzlänge haben brauchbare Vorgaben —
/// Hauptgleis, beidseitig befahrbar, Regelspur, Nutzlänge gleich Gleislänge.
/// Die vier Bandprofile haben **keine**: Ein stillschweigend angenommenes
/// Vmax-Profil wäre eine erfundene Geschwindigkeit ohne Quelle, und genau das
/// verbietet `docs/daten.md` 2.
#[derive(Clone, Debug)]
pub struct TrackBuilder {
    id: TrackId,
    owner: TrackOwner,
    designation: String,
    kind: TrackKind,
    direction: TrackDirection,
    gauge: TrackGauge,
    length: Length,
    usable_length: Option<Length>,
    speed: Option<BandProfile<SpeedLimit>>,
    gradient: Option<BandProfile<Gradient>>,
    electrification: Option<BandProfile<Electrification>>,
    protection: Option<BandProfile<TrainProtection>>,
}

impl TrackBuilder {
    /// Setzt die Art des Gleises.
    #[must_use]
    pub fn kind(mut self, kind: TrackKind) -> Self {
        self.kind = kind;
        self
    }

    /// Setzt die Richtungsbindung.
    #[must_use]
    pub fn direction(mut self, direction: TrackDirection) -> Self {
        self.direction = direction;
        self
    }

    /// Setzt die Spurweite.
    #[must_use]
    pub fn gauge(mut self, gauge: TrackGauge) -> Self {
        self.gauge = gauge;
        self
    }

    /// Setzt die Nutzlänge.
    #[must_use]
    pub fn usable_length(mut self, usable_length: Length) -> Self {
        self.usable_length = Some(usable_length);
        self
    }

    /// Setzt das Vmax-Profil.
    #[must_use]
    pub fn speed(mut self, speed: BandProfile<SpeedLimit>) -> Self {
        self.speed = Some(speed);
        self
    }

    /// Setzt das Neigungsprofil.
    #[must_use]
    pub fn gradient(mut self, gradient: BandProfile<Gradient>) -> Self {
        self.gradient = Some(gradient);
        self
    }

    /// Setzt das Elektrifizierungsprofil.
    #[must_use]
    pub fn electrification(mut self, electrification: BandProfile<Electrification>) -> Self {
        self.electrification = Some(electrification);
        self
    }

    /// Setzt das Zugsicherungsprofil.
    #[must_use]
    pub fn protection(mut self, protection: BandProfile<TrainProtection>) -> Self {
        self.protection = Some(protection);
        self
    }

    /// Prüft und baut das Gleis.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn die Gleisbezeichnung leer ist.
    /// - [`InfraError::NonPositiveLength`], wenn Länge oder Nutzlänge nicht
    ///   positiv sind.
    /// - [`InfraError::UsableLengthExceedsLength`], wenn die Nutzlänge größer
    ///   als die Gleislänge ist.
    /// - [`InfraError::MissingProfile`], wenn eines der vier Bandprofile fehlt.
    /// - [`InfraError::ProfileLength`], wenn ein Profil eine andere Länge
    ///   abdeckt als das Gleis.
    pub fn build(self) -> Result<Track, InfraError> {
        if self.designation.trim().is_empty() {
            return Err(InfraError::EmptyName { what: "Gleis" });
        }
        if !self.length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Gleislänge",
                value: self.length,
            });
        }

        let usable_length = self.usable_length.unwrap_or(self.length);
        if !usable_length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Nutzlänge",
                value: usable_length,
            });
        }
        if usable_length > self.length {
            return Err(InfraError::UsableLengthExceedsLength {
                track: self.id,
                usable: usable_length,
                length: self.length,
            });
        }

        let speed = pflichtprofil(self.speed, "vmax", self.length)?;
        let gradient = pflichtprofil(self.gradient, "neigung", self.length)?;
        let electrification = pflichtprofil(self.electrification, "elektrifizierung", self.length)?;
        let protection = pflichtprofil(self.protection, "zugsicherung", self.length)?;

        Ok(Track {
            id: self.id,
            owner: self.owner,
            designation: self.designation,
            kind: self.kind,
            direction: self.direction,
            gauge: self.gauge,
            length: self.length,
            usable_length,
            speed,
            gradient,
            electrification,
            protection,
        })
    }
}

/// Stellt sicher, dass ein Pflichtprofil vorhanden ist und zum Gleis passt.
fn pflichtprofil<T>(
    profil: Option<BandProfile<T>>,
    attribute: &'static str,
    length: Length,
) -> Result<BandProfile<T>, InfraError> {
    let profil = profil.ok_or(InfraError::MissingProfile { attribute })?;
    if profil.length() != length {
        return Err(InfraError::ProfileLength {
            attribute,
            profile: profil.length(),
            track: length,
        });
    }
    Ok(profil)
}

#[cfg(test)]
mod tests {
    use super::{Track, TrackDirection, TrackGauge, TrackKind, TrackOwner};
    use crate::bands::{Band, BandProfile};
    use crate::edge::TravelDirection;
    use crate::electrification::{Electrification, PowerSystem};
    use crate::error::InfraError;
    use crate::identity::{TrackEdgeId, TrackId};
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::speed::SpeedLimit;
    use crate::units::{Gradient, Length, Speed};

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            confidence,
        )
    }

    const LAENGE: Length = Length::from_metres(12_000);

    fn gleis() -> Track {
        vollstaendiges_gleis(LAENGE, Confidence::Surveyed)
    }

    fn vollstaendiges_gleis(laenge: Length, neigungsguete: Confidence) -> Track {
        Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Gleis A",
            laenge,
        )
        .kind(TrackKind::ThroughMainTrack)
        .direction(TrackDirection::WithChainage)
        .speed(
            BandProfile::uniform(
                "vmax",
                laenge,
                SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::uniform(
                "neigung",
                laenge,
                Gradient::from_per_mille(5),
                herkunft(neigungsguete),
            )
            .expect("Profil deckt das Gleis"),
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
                TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis")
    }

    #[test]
    fn ein_gleis_traegt_alle_attribute_aus_m1_1() {
        let gleis = gleis();
        assert_eq!(gleis.kind(), TrackKind::ThroughMainTrack);
        assert_eq!(gleis.gauge(), TrackGauge::STANDARD);
        assert!(gleis.gauge().is_standard());
        assert_eq!(gleis.usable_length(), LAENGE);
        assert_eq!(
            gleis
                .speed_at(Length::from_metres(6_000))
                .map(|v| v.standard()),
            Some(Speed::from_km_h(160))
        );
        assert!(gleis.is_fully_electrified());
        assert!(gleis.has_continuous_supervision());
        assert_eq!(gleis.maximum_speed(), Speed::from_km_h(160));
    }

    #[test]
    fn die_neigung_kehrt_sich_mit_der_fahrtrichtung() {
        let gleis = gleis();
        let position = Length::from_metres(1_000);
        assert_eq!(
            gleis.gradient_for(position, TravelDirection::WithChainage),
            Some(Gradient::from_per_mille(5))
        );
        // Wer bergauf gefahren ist, fährt zurück bergab.
        assert_eq!(
            gleis.gradient_for(position, TravelDirection::AgainstChainage),
            Some(Gradient::from_per_mille(-5))
        );
    }

    #[test]
    fn die_richtungsbindung_entscheidet_ueber_die_gegenfahrt() {
        assert!(TrackDirection::Bidirectional.permits_opposing_moves());
        assert!(!TrackDirection::WithChainage.permits_opposing_moves());
        assert!(TrackDirection::WithChainage.allows(TravelDirection::WithChainage));
        assert!(!TrackDirection::WithChainage.allows(TravelDirection::AgainstChainage));
        assert!(TrackDirection::Bidirectional.allows(TravelDirection::AgainstChainage));
    }

    #[test]
    fn der_schwaechste_vertrauensgrad_faerbt_das_gleis() {
        // Die Neigung stammt aus einem Höhenmodell (M1.5) und ist damit
        // abgeleitet — das Gleis kann nicht besser sein als sie.
        let abgeleitet = vollstaendiges_gleis(LAENGE, Confidence::Derived);
        assert_eq!(abgeleitet.confidence(), Confidence::Derived);
        assert_eq!(gleis().confidence(), Confidence::Surveyed);
    }

    #[test]
    fn ein_fehlendes_profil_faellt_auf() {
        let fehler = Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Gleis A",
            LAENGE,
        )
        .speed(
            BandProfile::uniform(
                "vmax",
                LAENGE,
                SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect_err("ohne Neigungsprofil ist das Gleis unvollständig");
        assert!(matches!(
            fehler,
            InfraError::MissingProfile {
                attribute: "neigung"
            }
        ));
    }

    #[test]
    fn ein_profil_fremder_laenge_faellt_auf() {
        let fehler = Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Gleis A",
            LAENGE,
        )
        .speed(
            BandProfile::uniform(
                "vmax",
                Length::from_metres(500),
                SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil ist für sich gültig"),
        )
        .build()
        .expect_err("ein Profil über 500 m beschreibt kein Gleis über 12 km");
        assert!(matches!(fehler, InfraError::ProfileLength { .. }));
    }

    #[test]
    fn die_nutzlaenge_passt_ins_gleis() {
        let fehler = Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Gleis A",
            Length::from_metres(400),
        )
        .usable_length(Length::from_metres(500))
        .build()
        .expect_err("die Nutzlänge kann nicht länger sein als das Gleis");
        assert!(matches!(
            fehler,
            InfraError::UsableLengthExceedsLength { .. }
        ));
    }

    #[test]
    fn die_spurweite_traegt_den_netzfilter() {
        assert!(TrackGauge::STANDARD.is_standard());
        let schmalspur = TrackGauge::from_millimetres(1_000).expect("positiv");
        assert!(!schmalspur.is_standard());
        assert!(matches!(
            TrackGauge::from_millimetres(0),
            Err(InfraError::NonPositiveLength { .. })
        ));
    }

    #[test]
    fn ein_geteiltes_vmax_profil_wird_stueckweise_gelesen() {
        let laenge = Length::from_metres(3_000);
        let gleis = Track::builder(
            TrackId::new(2),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Gleis B",
            laenge,
        )
        .speed(
            BandProfile::new(
                "vmax",
                laenge,
                vec![
                    Band::new(
                        Length::ZERO,
                        Length::from_metres(1_000),
                        SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                        herkunft(Confidence::Surveyed),
                    ),
                    Band::new(
                        Length::from_metres(1_000),
                        laenge,
                        SpeedLimit::uniform(Speed::from_km_h(100))
                            .expect("positiv")
                            .with_freight(Speed::from_km_h(80))
                            .expect("positiv"),
                        herkunft(Confidence::Surveyed),
                    ),
                ],
            )
            .expect("Profil ist lückenlos"),
        )
        .gradient(
            BandProfile::uniform(
                "neigung",
                laenge,
                Gradient::LEVEL,
                herkunft(Confidence::Derived),
            )
            .expect("Profil deckt das Gleis"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                laenge,
                Electrification::Unelectrified,
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

        assert_eq!(
            gleis.speed_at(Length::ZERO).map(|v| v.standard()),
            Some(Speed::from_km_h(160))
        );
        assert_eq!(
            gleis
                .speed_at(Length::from_metres(2_000))
                .map(|v| v.standard()),
            Some(Speed::from_km_h(100))
        );
        assert!(!gleis.is_fully_electrified());
        assert!(!gleis.has_continuous_supervision());
        assert_eq!(gleis.maximum_speed(), Speed::from_km_h(160));
    }
}
