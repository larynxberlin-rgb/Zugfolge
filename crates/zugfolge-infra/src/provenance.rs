//! Herkunft und Vertrauensgrad je Attribut.
//!
//! `docs/daten.md` 2 verlangt es wörtlich: **Jedes importierte Attribut trägt
//! Quelle, Lizenz, Gültigkeit, Checksumme und Confidence.** Lizenz, Gültigkeit
//! und Checksumme hängen an der Quelle, nicht am einzelnen Wert — sie stehen im
//! Quellenregister (`tools/guards/quellenregister.json`, M0.4) und werden mit
//! dem `InfraRelease` festgeschrieben (M1.12). Am einzelnen Attribut bleiben
//! damit zwei Angaben: **welche Quelle** und **wie belastbar**.
//!
//! Der Vertrauensgrad ist keine Verzierung. Er entscheidet in M1.4, welcher
//! Streckenabschnitt Qualitätsklasse A erreichen kann und welcher konservativ
//! als B geführt wird — und er ist die einzige Stelle, an der sichtbar bleibt,
//! dass eine Neigung aus einem Höhenmodell abgeleitet und nicht gemessen wurde.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;

/// Die Kennung einer Datenquelle aus dem Quellenregister.
///
/// Die Form ist die des Registers: Kleinbuchstaben, Ziffern, Bindestriche —
/// etwa `osm-pbf-lhe`. Dass die genannte Quelle dort auch **freigegeben** ist,
/// prüft nicht dieses Crate, sondern der Wächter `rights-gate` gegen den
/// Herkunftsmarker des Imports (Invariante 8). Hier steht nur, dass die
/// Kennung überhaupt eine sein kann.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceId(String);

impl SourceId {
    /// Prüft und übernimmt eine Quellenkennung.
    ///
    /// # Errors
    ///
    /// [`InfraError::SourceId`], wenn die Kennung leer ist, andere Zeichen als
    /// `a`–`z`, `0`–`9` und `-` enthält oder mit einem Bindestrich beginnt oder
    /// endet.
    pub fn new(id: impl Into<String>) -> Result<Self, InfraError> {
        let id = id.into();
        let zulaessig = id.chars().all(|zeichen| {
            zeichen.is_ascii_lowercase() || zeichen.is_ascii_digit() || zeichen == '-'
        });
        if id.is_empty() || !zulaessig || id.starts_with('-') || id.ends_with('-') {
            return Err(InfraError::SourceId(id));
        }
        Ok(Self(id))
    }

    /// Die Kennung als Zeichenkette.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Canonical for SourceId {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, &self.0);
    }
}

/// Wie belastbar ein Attributwert ist.
///
/// Die Reihenfolge ist aufsteigend nach Belastbarkeit. Dadurch ist der
/// schwächste Wert einer Menge schlicht ihr Minimum — und genau so wird der
/// Vertrauensgrad zusammengefasst: Ein Gleis ist so belastbar wie sein
/// schwächstes Attribut, nicht so belastbar wie sein bestes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Confidence {
    /// Konservativ angenommen, weil die Quelle schweigt. Trägt eine
    /// Qualitätsklasse nicht über B hinaus.
    Assumed,
    /// Aus vorhandenen Daten abgeleitet — etwa die Neigung aus einem
    /// Höhenmodell (M1.5) oder ein Block aus Signalstandorten (M1.6).
    Derived,
    /// In der Quelle ausdrücklich erfasst.
    Surveyed,
}

impl Confidence {
    /// Stabile Kennung für den Zustands-Hash.
    ///
    /// Sie ist ein **Datenformat**: Wer sie ändert, ändert jeden bereits
    /// erzeugten Fingerabdruck.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Assumed => "assumed",
            Self::Derived => "derived",
            Self::Surveyed => "surveyed",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Assumed => "angenommen",
            Self::Derived => "abgeleitet",
            Self::Surveyed => "erfasst",
        }
    }

    /// Der schwächere der beiden Vertrauensgrade.
    pub const fn weakest(self, other: Self) -> Self {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Assumed => 0,
            Self::Derived => 1,
            Self::Surveyed => 2,
        }
    }
}

impl fmt::Display for Confidence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl Canonical for Confidence {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Woher ein Attributwert stammt und wie belastbar er ist.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Provenance {
    source: SourceId,
    confidence: Confidence,
}

impl Provenance {
    /// Herkunft aus Quelle und Vertrauensgrad.
    pub const fn new(source: SourceId, confidence: Confidence) -> Self {
        Self { source, confidence }
    }

    /// Die Quelle.
    pub const fn source(&self) -> &SourceId {
        &self.source
    }

    /// Der Vertrauensgrad.
    pub const fn confidence(&self) -> Confidence {
        self.confidence
    }
}

impl fmt::Display for Provenance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.source, self.confidence)
    }
}

impl Canonical for Provenance {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.source.write_canonical(name, hasher);
        self.confidence.write_canonical(name, hasher);
    }
}

/// Ein Wert mit seiner Herkunft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attributed<T> {
    value: T,
    provenance: Provenance,
}

impl<T> Attributed<T> {
    /// Bindet einen Wert an seine Herkunft.
    pub const fn new(value: T, provenance: Provenance) -> Self {
        Self { value, provenance }
    }

    /// Der Wert.
    pub const fn value(&self) -> &T {
        &self.value
    }

    /// Der Wert ohne seine Herkunft.
    pub fn into_value(self) -> T {
        self.value
    }

    /// Die Herkunft.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Der Vertrauensgrad des Wertes.
    pub const fn confidence(&self) -> Confidence {
        self.provenance.confidence()
    }
}

impl<T: Canonical> Canonical for Attributed<T> {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.value.write_canonical(name, hasher);
        self.provenance.write_canonical(name, hasher);
    }
}

#[cfg(test)]
mod tests {
    use super::{Attributed, Confidence, Provenance, SourceId};
    use crate::error::InfraError;

    fn quelle() -> SourceId {
        SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung")
    }

    #[test]
    fn quellenkennung_folgt_dem_register() {
        assert_eq!(quelle().as_str(), "osm-pbf-lhe");
        assert!(SourceId::new("dem-hoehenmodell").is_ok());
    }

    #[test]
    fn quellenkennung_weist_unbrauchbares_zurueck() {
        for id in ["", "OSM", "osm_pbf", "-osm", "osm-", "osm pbf"] {
            assert!(
                matches!(SourceId::new(id), Err(InfraError::SourceId(_))),
                "'{id}' sollte unzulässig sein"
            );
        }
    }

    #[test]
    fn der_schwaechste_vertrauensgrad_gewinnt() {
        assert_eq!(
            Confidence::Surveyed.weakest(Confidence::Derived),
            Confidence::Derived
        );
        assert_eq!(
            Confidence::Derived.weakest(Confidence::Assumed),
            Confidence::Assumed
        );
        assert_eq!(
            Confidence::Assumed.weakest(Confidence::Assumed),
            Confidence::Assumed
        );
        // Als Ordnung ausgedrückt ist der schwächste Wert das Minimum.
        assert!(Confidence::Assumed < Confidence::Derived);
        assert!(Confidence::Derived < Confidence::Surveyed);
    }

    #[test]
    fn ein_wert_traegt_seine_herkunft() {
        let wert = Attributed::new(42_i64, Provenance::new(quelle(), Confidence::Derived));
        assert_eq!(*wert.value(), 42);
        assert_eq!(wert.confidence(), Confidence::Derived);
        assert_eq!(wert.provenance().source().as_str(), "osm-pbf-lhe");
        assert_eq!(wert.provenance().to_string(), "osm-pbf-lhe (abgeleitet)");
    }
}
