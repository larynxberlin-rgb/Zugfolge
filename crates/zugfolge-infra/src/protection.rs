//! Zugsicherung: die streckenseitig verfügbare Zugbeeinflussung.
//!
//! Ein Abschnitt trägt nicht *ein* System, sondern eine **Menge**. PZB und LZB
//! liegen übereinander, ETCS wird über beide gelegt und jahrelang parallel
//! betrieben. Genau diese Überlagerung ist der Grund für die Mengenform: Ein
//! einzelnes Feld erzwänge die Frage „welches denn nun", die betrieblich keine
//! Antwort hat.
//!
//! Fahrzeugseitig gilt dasselbe (M1.9, `TrainCharacteristics`). Ob ein Zug
//! einen Abschnitt befahren darf, ist damit eine Schnittmengenfrage: Beide
//! Seiten müssen mindestens ein gemeinsames System haben.

use core::fmt;
use std::collections::BTreeSet;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;

/// Ein einzelnes Zugbeeinflussungssystem.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProtectionSystem {
    /// Punktförmige Zugbeeinflussung.
    Pzb,
    /// Linienzugbeeinflussung — durchgehende Überwachung, führerraumsignalisiert.
    Lzb,
    /// ETCS Level 1 — punktförmige Übertragung über Balisen.
    EtcsLevel1,
    /// ETCS Level 2 — durchgehende Übertragung, führerraumsignalisiert.
    EtcsLevel2,
}

impl ProtectionSystem {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Pzb => "pzb",
            Self::Lzb => "lzb",
            Self::EtcsLevel1 => "etcs-l1",
            Self::EtcsLevel2 => "etcs-l2",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Pzb => "PZB",
            Self::Lzb => "LZB",
            Self::EtcsLevel1 => "ETCS L1",
            Self::EtcsLevel2 => "ETCS L2",
        }
    }

    /// Ob das System durchgehend überwacht und damit die Führerraumsignalisierung
    /// trägt.
    ///
    /// Das ist die Eigenschaft, an der die zulässige Höchstgeschwindigkeit
    /// hängt: Über 160 km/h ist ohne durchgehende Überwachung nicht zulässig.
    /// Die Regel selbst gehört in die Fahrzeitrechnung (M1.10) — hier steht
    /// nur die Eigenschaft, auf die sie sich stützt.
    pub const fn is_continuous(self) -> bool {
        matches!(self, Self::Lzb | Self::EtcsLevel2)
    }
}

impl fmt::Display for ProtectionSystem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl Canonical for ProtectionSystem {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Die auf einem Abschnitt verfügbare Zugsicherung.
///
/// Die Menge ist geordnet (`BTreeSet`), weil ihre Iterationsreihenfolge in den
/// Zustands-Hash eingeht. Mit einer ungeordneten Menge wäre der Fingerabdruck
/// eines Infrastruktur-Release von der Einfügereihenfolge abhängig — und damit
/// wertlos.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrainProtection {
    systems: BTreeSet<ProtectionSystem>,
}

impl TrainProtection {
    /// Ein Abschnitt ohne streckenseitige Zugbeeinflussung.
    ///
    /// Das ist kein Fehlerfall: Nebengleise und Anschlussgleise sind
    /// regelmäßig ungesichert. Auf ihnen wird rangiert, nicht gefahren.
    pub fn unprotected() -> Self {
        Self {
            systems: BTreeSet::new(),
        }
    }

    /// Zugsicherung aus einer Aufzählung von Systemen.
    pub fn from_systems(systems: impl IntoIterator<Item = ProtectionSystem>) -> Self {
        Self {
            systems: systems.into_iter().collect(),
        }
    }

    /// Zugsicherung aus genau einem System.
    pub fn single(system: ProtectionSystem) -> Self {
        Self::from_systems([system])
    }

    /// Die Systeme in fester Reihenfolge.
    pub fn systems(&self) -> impl Iterator<Item = ProtectionSystem> + '_ {
        self.systems.iter().copied()
    }

    /// Anzahl der Systeme.
    pub fn count(&self) -> usize {
        self.systems.len()
    }

    /// Ob ein bestimmtes System verfügbar ist.
    pub fn contains(&self, system: ProtectionSystem) -> bool {
        self.systems.contains(&system)
    }

    /// Ob der Abschnitt ohne streckenseitige Zugbeeinflussung ist.
    pub fn is_unprotected(&self) -> bool {
        self.systems.is_empty()
    }

    /// Ob mindestens ein durchgehend überwachendes System verfügbar ist.
    pub fn has_continuous_supervision(&self) -> bool {
        self.systems
            .iter()
            .copied()
            .any(ProtectionSystem::is_continuous)
    }

    /// Ob eine Fahrzeugausrüstung zu diesem Abschnitt passt.
    ///
    /// Sie passt, wenn beide Seiten mindestens ein System teilen. Ein
    /// ungesicherter Abschnitt passt zu keiner Ausrüstung — dort finden keine
    /// Zugfahrten statt.
    pub fn is_compatible_with(&self, vehicle: &Self) -> bool {
        self.systems.intersection(&vehicle.systems).next().is_some()
    }
}

impl fmt::Display for TrainProtection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.systems.is_empty() {
            return formatter.write_str("ohne Zugbeeinflussung");
        }
        let mut erstes = true;
        for system in &self.systems {
            if !erstes {
                formatter.write_str(", ")?;
            }
            formatter.write_str(system.label())?;
            erstes = false;
        }
        Ok(())
    }
}

impl Canonical for TrainProtection {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.seq(name, self.systems.len());
        for system in &self.systems {
            system.write_canonical(name, hasher);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ProtectionSystem, TrainProtection};

    #[test]
    fn systeme_liegen_uebereinander() {
        let strecke = TrainProtection::from_systems([
            ProtectionSystem::Pzb,
            ProtectionSystem::Lzb,
            ProtectionSystem::EtcsLevel2,
        ]);
        assert_eq!(strecke.count(), 3);
        assert!(strecke.contains(ProtectionSystem::Lzb));
        assert!(!strecke.contains(ProtectionSystem::EtcsLevel1));
        assert!(!strecke.is_unprotected());
    }

    #[test]
    fn die_reihenfolge_ist_fest() {
        let einmal = TrainProtection::from_systems([ProtectionSystem::Lzb, ProtectionSystem::Pzb]);
        let andersherum =
            TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]);
        // Ohne feste Reihenfolge hinge der Fingerabdruck eines
        // Infrastruktur-Release an der Einfügereihenfolge.
        assert_eq!(einmal, andersherum);
        let gelesen: Vec<_> = einmal.systems().collect();
        assert_eq!(gelesen, vec![ProtectionSystem::Pzb, ProtectionSystem::Lzb]);
    }

    #[test]
    fn durchgehende_ueberwachung_wird_erkannt() {
        assert!(TrainProtection::single(ProtectionSystem::Lzb).has_continuous_supervision());
        assert!(TrainProtection::single(ProtectionSystem::EtcsLevel2).has_continuous_supervision());
        assert!(!TrainProtection::single(ProtectionSystem::Pzb).has_continuous_supervision());
        assert!(
            !TrainProtection::single(ProtectionSystem::EtcsLevel1).has_continuous_supervision()
        );
    }

    #[test]
    fn vertraeglichkeit_ist_eine_schnittmenge() {
        let strecke = TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]);
        let mit_pzb = TrainProtection::single(ProtectionSystem::Pzb);
        let nur_etcs = TrainProtection::single(ProtectionSystem::EtcsLevel2);

        assert!(strecke.is_compatible_with(&mit_pzb));
        assert!(!strecke.is_compatible_with(&nur_etcs));
        assert!(!TrainProtection::unprotected().is_compatible_with(&mit_pzb));
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(
            TrainProtection::unprotected().to_string(),
            "ohne Zugbeeinflussung"
        );
        assert_eq!(
            TrainProtection::from_systems([ProtectionSystem::Lzb, ProtectionSystem::Pzb])
                .to_string(),
            "PZB, LZB"
        );
    }
}
