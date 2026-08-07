//! Betriebsstellen — die benannten Punkte des Netzes.
//!
//! „Betriebsstelle" ist nicht dasselbe wie „Bahnhof" (`docs/glossar.md`). Ein
//! Bahnhof hat Weichen und ist begrenzt durch Einfahrsignale; ein Haltepunkt
//! hat weder das eine noch das andere; eine Abzweigstelle hat Weichen, aber
//! keinen Bahnsteig. Für das Spiel ist der Unterschied kein Etikett, sondern
//! entscheidet über zwei Fragen: **Kann dort gekreuzt werden?** und **Kann
//! dort ein Fahrgast einsteigen?** Die erste Frage trägt die Auflösung von
//! Gegenfahrten (M3.4), die zweite jedes Halteschema.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;
use crate::identity::{OperatingPointCode, OperatingPointId};
use crate::provenance::Provenance;

/// Ein Punkt auf der Erde, in Zehnmillionstel Grad (WGS 84).
///
/// Zehnmillionstel Grad sind rund 1 cm — feiner, als jede Quelle liefert, und
/// ganzzahlig (Invariante 3). Die **Geometrie** der Kanten, also der Verlauf
/// zwischen den Punkten, gehört nicht hierher: Sie kommt mit dem Import
/// (M1.2) und wird für die Livemap gebraucht, nicht für den Betrieb.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Coordinate {
    latitude_e7: i32,
    longitude_e7: i32,
}

impl Coordinate {
    /// Ein Punkt aus Breite und Länge in Zehnmillionstel Grad.
    ///
    /// # Errors
    ///
    /// [`InfraError::Coordinate`], wenn der Punkt außerhalb des gültigen
    /// Bereichs liegt.
    pub fn new(latitude_e7: i32, longitude_e7: i32) -> Result<Self, InfraError> {
        if !(-900_000_000..=900_000_000).contains(&latitude_e7)
            || !(-1_800_000_000..=1_800_000_000).contains(&longitude_e7)
        {
            return Err(InfraError::Coordinate {
                latitude_e7,
                longitude_e7,
            });
        }
        Ok(Self {
            latitude_e7,
            longitude_e7,
        })
    }

    /// Geografische Breite in Zehnmillionstel Grad.
    pub const fn latitude_e7(self) -> i32 {
        self.latitude_e7
    }

    /// Geografische Länge in Zehnmillionstel Grad.
    pub const fn longitude_e7(self) -> i32 {
        self.longitude_e7
    }
}

impl fmt::Display for Coordinate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}.{:07} / {}.{:07}",
            self.latitude_e7 / 10_000_000,
            self.latitude_e7.unsigned_abs() % 10_000_000,
            self.longitude_e7 / 10_000_000,
            self.longitude_e7.unsigned_abs() % 10_000_000
        )
    }
}

impl Canonical for Coordinate {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, i64::from(self.latitude_e7));
        hasher.int(name, i64::from(self.longitude_e7));
    }
}

/// Die Art einer Betriebsstelle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum OperatingPointKind {
    /// Bahnhof — mit Weichen, begrenzt durch Einfahrsignale. Hier kann
    /// gekreuzt, überholt, begonnen und beendet werden.
    Station,
    /// Haltepunkt — Fahrgastwechsel ohne Weichen.
    Halt,
    /// Abzweigstelle — Übergang auf eine andere Strecke, ohne Bahnsteig.
    Junction,
    /// Überleitstelle — Wechsel zwischen den Gleisen derselben Strecke.
    Crossover,
    /// Blockstelle — Beginn eines Blockabschnitts, ohne Weichen.
    BlockPost,
    /// Deckungsstelle — sichert eine Gefahrenstelle.
    ProtectionPost,
    /// Anschlussstelle — Anschluss an ein nicht öffentliches Gleis, ohne
    /// Ausweichmöglichkeit.
    SidingJunction,
    /// Ausweichanschlussstelle — Anschlussstelle **mit** Ausweichgleis; ein
    /// Zug kann dort einen anderen kreuzen lassen.
    PassingSidingJunction,
}

impl OperatingPointKind {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Station => "station",
            Self::Halt => "halt",
            Self::Junction => "junction",
            Self::Crossover => "crossover",
            Self::BlockPost => "block-post",
            Self::ProtectionPost => "protection-post",
            Self::SidingJunction => "siding-junction",
            Self::PassingSidingJunction => "passing-siding-junction",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Station => "Bahnhof",
            Self::Halt => "Haltepunkt",
            Self::Junction => "Abzweigstelle",
            Self::Crossover => "Überleitstelle",
            Self::BlockPost => "Blockstelle",
            Self::ProtectionPost => "Deckungsstelle",
            Self::SidingJunction => "Anschlussstelle",
            Self::PassingSidingJunction => "Ausweichanschlussstelle",
        }
    }

    /// Ob zwei Züge sich hier begegnen oder überholen können.
    ///
    /// Das ist die betrieblich entscheidende Eigenschaft: Auf eingleisiger
    /// Strecke ist die Auflösung einer Gegenfahrt eine Kreuzung, und die geht
    /// nur dort, wo ein zweites Gleis liegt (M3.4).
    pub const fn allows_crossing(self) -> bool {
        matches!(self, Self::Station | Self::PassingSidingJunction)
    }

    /// Ob hier planmäßig Fahrgäste ein- und aussteigen können.
    pub const fn allows_passenger_stop(self) -> bool {
        matches!(self, Self::Station | Self::Halt)
    }

    /// Ob die Betriebsstelle Weichen hat und damit einen Bahnhofskopf, dessen
    /// Fahrstraßen abgeleitet werden müssen (M1.7).
    pub const fn has_switches(self) -> bool {
        matches!(
            self,
            Self::Station
                | Self::Junction
                | Self::Crossover
                | Self::SidingJunction
                | Self::PassingSidingJunction
        )
    }
}

impl fmt::Display for OperatingPointKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl Canonical for OperatingPointKind {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Eine Betriebsstelle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatingPoint {
    id: OperatingPointId,
    code: OperatingPointCode,
    name: String,
    kind: OperatingPointKind,
    position: Coordinate,
    provenance: Provenance,
}

impl OperatingPoint {
    /// Eine Betriebsstelle mit Kürzel, Namen, Art, Lage und Herkunft.
    ///
    /// # Errors
    ///
    /// [`InfraError::EmptyName`], wenn der Name leer ist. Eine namenlose
    /// Betriebsstelle wäre in jeder Meldung und auf jedem Bildfahrplan eine
    /// Lücke.
    pub fn new(
        id: OperatingPointId,
        code: OperatingPointCode,
        name: impl Into<String>,
        kind: OperatingPointKind,
        position: Coordinate,
        provenance: Provenance,
    ) -> Result<Self, InfraError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InfraError::EmptyName {
                what: "Betriebsstelle",
            });
        }
        Ok(Self {
            id,
            code,
            name,
            kind,
            position,
            provenance,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> OperatingPointId {
        self.id
    }

    /// Das Betriebsstellenkürzel.
    pub const fn code(&self) -> &OperatingPointCode {
        &self.code
    }

    /// Der ausgeschriebene Name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Die Art der Betriebsstelle.
    pub const fn kind(&self) -> OperatingPointKind {
        self.kind
    }

    /// Die Lage.
    pub const fn position(&self) -> Coordinate {
        self.position
    }

    /// Die Herkunft der Angaben.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }
}

impl fmt::Display for OperatingPoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.name, self.code)
    }
}

impl Canonical for OperatingPoint {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.id.write_canonical(name, hasher);
        self.code.write_canonical(name, hasher);
        hasher.text(name, &self.name);
        self.kind.write_canonical(name, hasher);
        self.position.write_canonical(name, hasher);
        self.provenance.write_canonical(name, hasher);
    }
}

#[cfg(test)]
mod tests {
    use super::{Coordinate, OperatingPoint, OperatingPointKind};
    use crate::error::InfraError;
    use crate::identity::{OperatingPointCode, OperatingPointId};
    use crate::provenance::{Confidence, Provenance, SourceId};

    fn herkunft() -> Provenance {
        Provenance::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            Confidence::Surveyed,
        )
    }

    fn lage() -> Coordinate {
        Coordinate::new(513_400_000, 123_800_000).expect("Punkt liegt auf der Erde")
    }

    #[test]
    fn koordinaten_bleiben_auf_der_erde() {
        assert!(Coordinate::new(0, 0).is_ok());
        assert!(matches!(
            Coordinate::new(900_000_001, 0),
            Err(InfraError::Coordinate { .. })
        ));
        assert!(matches!(
            Coordinate::new(0, -1_800_000_001),
            Err(InfraError::Coordinate { .. })
        ));
    }

    #[test]
    fn nur_wo_ein_zweites_gleis_liegt_wird_gekreuzt() {
        assert!(OperatingPointKind::Station.allows_crossing());
        assert!(OperatingPointKind::PassingSidingJunction.allows_crossing());
        // Ein Haltepunkt hat kein zweites Gleis — dort löst sich keine
        // Gegenfahrt auf.
        assert!(!OperatingPointKind::Halt.allows_crossing());
        assert!(!OperatingPointKind::BlockPost.allows_crossing());
        assert!(!OperatingPointKind::SidingJunction.allows_crossing());
    }

    #[test]
    fn haltepunkt_und_bahnhof_tragen_fahrgaeste() {
        assert!(OperatingPointKind::Halt.allows_passenger_stop());
        assert!(OperatingPointKind::Station.allows_passenger_stop());
        assert!(!OperatingPointKind::Junction.allows_passenger_stop());
    }

    #[test]
    fn ein_bahnhofskopf_entsteht_nur_mit_weichen() {
        assert!(OperatingPointKind::Station.has_switches());
        assert!(!OperatingPointKind::Halt.has_switches());
        assert!(!OperatingPointKind::BlockPost.has_switches());
    }

    #[test]
    fn eine_betriebsstelle_ohne_namen_faellt_auf() {
        let fehler = OperatingPoint::new(
            OperatingPointId::new(1),
            OperatingPointCode::new("XX").expect("gültiges Kürzel"),
            "   ",
            OperatingPointKind::Station,
            lage(),
            herkunft(),
        )
        .expect_err("ein leerer Name ist kein Name");
        assert!(matches!(fehler, InfraError::EmptyName { .. }));
    }

    #[test]
    fn eine_betriebsstelle_nennt_sich_lesbar() {
        let bahnhof = OperatingPoint::new(
            OperatingPointId::new(1),
            OperatingPointCode::new("NST").expect("gültiges Kürzel"),
            "Nordstadt",
            OperatingPointKind::Station,
            lage(),
            herkunft(),
        )
        .expect("gültige Betriebsstelle");
        assert_eq!(bahnhof.to_string(), "Nordstadt (NST)");
        assert_eq!(bahnhof.name(), "Nordstadt");
        assert_eq!(bahnhof.kind(), OperatingPointKind::Station);
    }
}
