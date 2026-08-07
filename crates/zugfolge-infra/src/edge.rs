//! Kanten — die Streckenabschnitte zwischen zwei Betriebsstellen.
//!
//! Eine Kante ist die freie Strecke von einer Betriebsstelle zur nächsten. Sie
//! trägt selbst keine Fahrt: Gefahren wird auf ihren **Gleisen**. Eine
//! zweigleisige Strecke ist eine Kante mit zwei Gleisen, ein eingleisiger Ast
//! eine Kante mit einem — und genau aus diesem Unterschied entsteht später der
//! Unterschied zwischen Zugfolgefall und Gegenfahrt. Der Spike aus M0.3 hat das
//! gezeigt: Ein Ressourcenmodell trägt beide Konfliktarten, wenn die
//! Infrastruktur die Richtungsbindung kennt.
//!
//! Die **Kilometrierung** der Kante läuft von [`TrackEdge::from`] nach
//! [`TrackEdge::to`]. Jede Position auf einem Gleis dieser Kante wird ab dort
//! gezählt, jede Neigung bezieht ihr Vorzeichen darauf.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;
use crate::identity::{OperatingPointId, TrackEdgeId};
use crate::provenance::Provenance;
use crate::units::Length;

/// Die Fahrtrichtung entlang einer Kante.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TravelDirection {
    /// In Richtung wachsender Kilometrierung, also von `from` nach `to`.
    WithChainage,
    /// Gegen die Kilometrierung, also von `to` nach `from`.
    AgainstChainage,
}

impl TravelDirection {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::WithChainage => "with-chainage",
            Self::AgainstChainage => "against-chainage",
        }
    }

    /// Die Gegenrichtung.
    pub const fn opposite(self) -> Self {
        match self {
            Self::WithChainage => Self::AgainstChainage,
            Self::AgainstChainage => Self::WithChainage,
        }
    }
}

impl Canonical for TravelDirection {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Eine Kante zwischen zwei Betriebsstellen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackEdge {
    id: TrackEdgeId,
    from: OperatingPointId,
    to: OperatingPointId,
    name: String,
    length: Length,
    provenance: Provenance,
}

impl TrackEdge {
    /// Eine Kante von `from` nach `to`.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn der Name leer ist.
    /// - [`InfraError::NonPositiveLength`], wenn die Länge nicht positiv ist.
    ///   Eine Kante der Länge null wäre keine Strecke, sondern zwei
    ///   Betriebsstellen, die dieselbe sind.
    pub fn new(
        id: TrackEdgeId,
        from: OperatingPointId,
        to: OperatingPointId,
        name: impl Into<String>,
        length: Length,
        provenance: Provenance,
    ) -> Result<Self, InfraError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InfraError::EmptyName { what: "Kante" });
        }
        if !length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Kantenlänge",
                value: length,
            });
        }
        Ok(Self {
            id,
            from,
            to,
            name,
            length,
            provenance,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> TrackEdgeId {
        self.id
    }

    /// Die Betriebsstelle am Anfang der Kilometrierung.
    pub const fn from(&self) -> OperatingPointId {
        self.from
    }

    /// Die Betriebsstelle am Ende der Kilometrierung.
    pub const fn to(&self) -> OperatingPointId {
        self.to
    }

    /// Der Name des Streckenabschnitts.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Die Länge der Kante.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die Herkunft der Angaben.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Ob die Kante die beiden Betriebsstellen verbindet — in beliebiger
    /// Reihenfolge.
    pub fn connects(&self, first: OperatingPointId, second: OperatingPointId) -> bool {
        (self.from == first && self.to == second) || (self.from == second && self.to == first)
    }

    /// Die Betriebsstelle am anderen Ende, wenn `point` eine der beiden ist.
    pub fn other_end(&self, point: OperatingPointId) -> Option<OperatingPointId> {
        if point == self.from {
            Some(self.to)
        } else if point == self.to {
            Some(self.from)
        } else {
            None
        }
    }

    /// Die Betriebsstelle, an der eine Fahrt in dieser Richtung endet.
    pub const fn end_of(&self, direction: TravelDirection) -> OperatingPointId {
        match direction {
            TravelDirection::WithChainage => self.to,
            TravelDirection::AgainstChainage => self.from,
        }
    }
}

impl fmt::Display for TrackEdge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.name)
    }
}

impl Canonical for TrackEdge {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.id.write_canonical(name, hasher);
        self.from.write_canonical(name, hasher);
        self.to.write_canonical(name, hasher);
        hasher.text(name, &self.name);
        self.length.write_canonical(name, hasher);
        self.provenance.write_canonical(name, hasher);
    }
}

#[cfg(test)]
mod tests {
    use super::{TrackEdge, TravelDirection};
    use crate::error::InfraError;
    use crate::identity::{OperatingPointId, TrackEdgeId};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::units::Length;

    fn herkunft() -> Provenance {
        Provenance::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            Confidence::Surveyed,
        )
    }

    fn kante() -> TrackEdge {
        TrackEdge::new(
            TrackEdgeId::new(1),
            OperatingPointId::new(10),
            OperatingPointId::new(20),
            "Nordstadt – Sandberg",
            Length::from_metres(12_000),
            herkunft(),
        )
        .expect("gültige Kante")
    }

    #[test]
    fn eine_kante_kennt_ihre_enden() {
        let kante = kante();
        assert!(kante.connects(OperatingPointId::new(10), OperatingPointId::new(20)));
        assert!(kante.connects(OperatingPointId::new(20), OperatingPointId::new(10)));
        assert!(!kante.connects(OperatingPointId::new(10), OperatingPointId::new(30)));
        assert_eq!(
            kante.other_end(OperatingPointId::new(10)),
            Some(OperatingPointId::new(20))
        );
        assert_eq!(kante.other_end(OperatingPointId::new(30)), None);
    }

    #[test]
    fn die_richtung_bestimmt_das_fahrtziel() {
        let kante = kante();
        assert_eq!(
            kante.end_of(TravelDirection::WithChainage),
            OperatingPointId::new(20)
        );
        assert_eq!(
            kante.end_of(TravelDirection::AgainstChainage),
            OperatingPointId::new(10)
        );
        assert_eq!(
            TravelDirection::WithChainage.opposite(),
            TravelDirection::AgainstChainage
        );
    }

    #[test]
    fn eine_kante_ohne_laenge_ist_keine_strecke() {
        let fehler = TrackEdge::new(
            TrackEdgeId::new(1),
            OperatingPointId::new(10),
            OperatingPointId::new(20),
            "Nirgends – Nirgends",
            Length::ZERO,
            herkunft(),
        )
        .expect_err("eine Kante der Länge null ist keine Strecke");
        assert!(matches!(fehler, InfraError::NonPositiveLength { .. }));
    }

    #[test]
    fn eine_kante_ohne_namen_faellt_auf() {
        let fehler = TrackEdge::new(
            TrackEdgeId::new(1),
            OperatingPointId::new(10),
            OperatingPointId::new(20),
            "",
            Length::from_metres(1_000),
            herkunft(),
        )
        .expect_err("ein leerer Name ist kein Name");
        assert!(matches!(fehler, InfraError::EmptyName { .. }));
    }
}
