//! Vmax-Bänder: die zulässige Geschwindigkeit eines Gleisabschnitts.
//!
//! Ein Abschnitt hat nicht *eine* Höchstgeschwindigkeit. Der Buchfahrplan
//! führt für denselben Abschnitt mehrere Spalten: eine Regelgeschwindigkeit,
//! eine höhere für Züge mit Neigetechnik und häufig eine niedrigere für
//! Güterzüge. Alle drei sind Eigenschaften der Infrastruktur, nicht des
//! Fahrzeugs — das Gleis erlaubt sie oder erlaubt sie nicht.
//!
//! Welche Spalte für einen Zug gilt, entscheidet später seine Zugcharakteristik
//! (M1.9). Hier stehen nur die Spalten.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;
use crate::units::Speed;

/// Für welche Art Zug eine Geschwindigkeit gilt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpeedCategory {
    /// Die Regelgeschwindigkeit — gilt, solange keine eigene Spalte greift.
    Standard,
    /// Züge mit Neigetechnik und wirksamer Überwachung.
    Tilting,
    /// Güterzüge.
    Freight,
}

impl SpeedCategory {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Tilting => "tilting",
            Self::Freight => "freight",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Standard => "Regel",
            Self::Tilting => "Neigetechnik",
            Self::Freight => "Güterzug",
        }
    }
}

impl fmt::Display for SpeedCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl Canonical for SpeedCategory {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Die zulässigen Geschwindigkeiten eines Gleisabschnitts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SpeedLimit {
    standard: Speed,
    tilting: Option<Speed>,
    freight: Option<Speed>,
}

impl SpeedLimit {
    /// Ein Abschnitt mit einer einzigen zulässigen Geschwindigkeit.
    ///
    /// # Errors
    ///
    /// [`InfraError::NonPositiveSpeed`], wenn die Geschwindigkeit nicht positiv
    /// ist. Ein Abschnitt mit Vmax null wäre kein langsamer Abschnitt, sondern
    /// ein gesperrter — und eine Sperrung ist eine Betriebslage (M8), keine
    /// Eigenschaft des Gleises.
    pub fn uniform(standard: Speed) -> Result<Self, InfraError> {
        if !standard.is_positive() {
            return Err(InfraError::NonPositiveSpeed {
                what: "vmax",
                value: standard,
            });
        }
        Ok(Self {
            standard,
            tilting: None,
            freight: None,
        })
    }

    /// Ergänzt die Spalte für Züge mit Neigetechnik.
    ///
    /// # Errors
    ///
    /// [`InfraError::NonPositiveSpeed`], wenn die Geschwindigkeit nicht positiv
    /// ist.
    pub fn with_tilting(mut self, speed: Speed) -> Result<Self, InfraError> {
        if !speed.is_positive() {
            return Err(InfraError::NonPositiveSpeed {
                what: "vmax-neigetechnik",
                value: speed,
            });
        }
        self.tilting = Some(speed);
        Ok(self)
    }

    /// Ergänzt die Spalte für Güterzüge.
    ///
    /// # Errors
    ///
    /// [`InfraError::NonPositiveSpeed`], wenn die Geschwindigkeit nicht positiv
    /// ist.
    pub fn with_freight(mut self, speed: Speed) -> Result<Self, InfraError> {
        if !speed.is_positive() {
            return Err(InfraError::NonPositiveSpeed {
                what: "vmax-gueterzug",
                value: speed,
            });
        }
        self.freight = Some(speed);
        Ok(self)
    }

    /// Die Regelgeschwindigkeit.
    pub const fn standard(self) -> Speed {
        self.standard
    }

    /// Die Geschwindigkeit einer Kategorie.
    ///
    /// Fehlt die eigene Spalte, gilt die Regelgeschwindigkeit. Das ist die
    /// sichere Richtung: Ein Neigetechnikzug fährt dann wie jeder andere.
    pub fn for_category(self, category: SpeedCategory) -> Speed {
        match category {
            SpeedCategory::Standard => self.standard,
            SpeedCategory::Tilting => self.tilting.unwrap_or(self.standard),
            SpeedCategory::Freight => self.freight.unwrap_or(self.standard),
        }
    }

    /// Die höchste zulässige Geschwindigkeit über alle Kategorien.
    pub fn maximum(self) -> Speed {
        [
            self.standard,
            self.for_category(SpeedCategory::Tilting),
            self.for_category(SpeedCategory::Freight),
        ]
        .into_iter()
        .max()
        .unwrap_or(self.standard)
    }
}

impl fmt::Display for SpeedLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.standard)?;
        if let Some(neigetechnik) = self.tilting {
            write!(formatter, " / NT {neigetechnik}")?;
        }
        if let Some(gueterzug) = self.freight {
            write!(formatter, " / Gz {gueterzug}")?;
        }
        Ok(())
    }
}

impl Canonical for SpeedLimit {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.standard.write_canonical(name, hasher);
        self.tilting.write_canonical(name, hasher);
        self.freight.write_canonical(name, hasher);
    }
}

#[cfg(test)]
mod tests {
    use super::{SpeedCategory, SpeedLimit};
    use crate::error::InfraError;
    use crate::units::Speed;

    #[test]
    fn ohne_eigene_spalte_gilt_die_regelgeschwindigkeit() {
        let vmax = SpeedLimit::uniform(Speed::from_km_h(160)).expect("160 km/h ist positiv");
        for kategorie in [
            SpeedCategory::Standard,
            SpeedCategory::Tilting,
            SpeedCategory::Freight,
        ] {
            assert_eq!(vmax.for_category(kategorie), Speed::from_km_h(160));
        }
    }

    #[test]
    fn eigene_spalten_gelten_je_kategorie() {
        let vmax = SpeedLimit::uniform(Speed::from_km_h(160))
            .expect("positiv")
            .with_tilting(Speed::from_km_h(200))
            .expect("positiv")
            .with_freight(Speed::from_km_h(100))
            .expect("positiv");

        assert_eq!(
            vmax.for_category(SpeedCategory::Standard),
            Speed::from_km_h(160)
        );
        assert_eq!(
            vmax.for_category(SpeedCategory::Tilting),
            Speed::from_km_h(200)
        );
        assert_eq!(
            vmax.for_category(SpeedCategory::Freight),
            Speed::from_km_h(100)
        );
        assert_eq!(vmax.maximum(), Speed::from_km_h(200));
    }

    #[test]
    fn vmax_null_ist_keine_geschwindigkeit() {
        assert!(matches!(
            SpeedLimit::uniform(Speed::ZERO),
            Err(InfraError::NonPositiveSpeed { .. })
        ));
        assert!(matches!(
            SpeedLimit::uniform(Speed::from_km_h(100))
                .expect("positiv")
                .with_freight(Speed::ZERO),
            Err(InfraError::NonPositiveSpeed { .. })
        ));
    }

    #[test]
    fn anzeige_nennt_alle_spalten() {
        let vmax = SpeedLimit::uniform(Speed::from_km_h(160))
            .expect("positiv")
            .with_freight(Speed::from_km_h(100))
            .expect("positiv");
        assert_eq!(vmax.to_string(), "160 km/h / Gz 100 km/h");
    }
}
