//! Elektrifizierung: Bauart der Bahnstromversorgung und ihr System.
//!
//! Zwei Angaben, die im Betrieb verschiedene Fragen beantworten. Das **System**
//! entscheidet, ob ein Triebfahrzeug den Strom überhaupt nutzen kann. Die
//! **Bauart** entscheidet, ob der Abschnitt zum Netz gehört: `docs/produkt.md`
//! und E14 grenzen das Spielnetz auf die EBO ab, und die Netzausschlussliste
//! aus M1.3 wirft Stromschienennetze heraus. Ohne die Unterscheidung zwischen
//! Oberleitung und Stromschiene könnte dieser Filter nicht greifen — deshalb
//! kann das Modell beides beschreiben, obwohl das Spiel nur eines fährt.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;

/// Ein Bahnstromsystem.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PowerSystem {
    /// 15 kV, 16,7 Hz — das System des deutschen Netzes.
    Ac15kV,
    /// 25 kV, 50 Hz — Neubaustrecken außerhalb Deutschlands und Grenzstrecken.
    Ac25kV,
    /// 750 V Gleichstrom — typisch Stromschiene.
    Dc750V,
    /// 1,5 kV Gleichstrom.
    Dc1500V,
    /// 3 kV Gleichstrom.
    Dc3000V,
}

impl PowerSystem {
    /// Stabile Kennung für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Ac15kV => "ac-15kv-16700mhz",
            Self::Ac25kV => "ac-25kv-50000mhz",
            Self::Dc750V => "dc-750v",
            Self::Dc1500V => "dc-1500v",
            Self::Dc3000V => "dc-3000v",
        }
    }

    /// Nennspannung in Volt.
    pub const fn voltage_volts(self) -> i32 {
        match self {
            Self::Ac15kV => 15_000,
            Self::Ac25kV => 25_000,
            Self::Dc750V => 750,
            Self::Dc1500V => 1_500,
            Self::Dc3000V => 3_000,
        }
    }

    /// Nennfrequenz in **Milli-Hertz**, null bei Gleichstrom.
    ///
    /// Milli-Hertz, weil 16,7 Hz sonst eine Gleitkommazahl wäre — und die hat
    /// im zustandsrelevanten Pfad nichts zu suchen (Invariante 3).
    pub const fn frequency_millihertz(self) -> i32 {
        match self {
            Self::Ac15kV => 16_700,
            Self::Ac25kV => 50_000,
            Self::Dc750V | Self::Dc1500V | Self::Dc3000V => 0,
        }
    }

    /// Ob es sich um ein Wechselstromsystem handelt.
    pub const fn is_alternating_current(self) -> bool {
        self.frequency_millihertz() != 0
    }
}

impl fmt::Display for PowerSystem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_alternating_current() {
            let millihertz = self.frequency_millihertz();
            write!(
                formatter,
                "{} V ~ {},{} Hz",
                self.voltage_volts(),
                millihertz / 1_000,
                (millihertz % 1_000) / 100
            )
        } else {
            write!(formatter, "{} V =", self.voltage_volts())
        }
    }
}

impl Canonical for PowerSystem {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
    }
}

/// Wie ein Gleisabschnitt mit Fahrstrom versorgt wird.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Electrification {
    /// Kein Fahrstrom — nur Verbrennungsantrieb oder Akkubetrieb.
    Unelectrified,
    /// Oberleitung.
    Overhead(PowerSystem),
    /// Stromschiene. Im Spielnetz ausgeschlossen (E14, Netzfilter M1.3),
    /// aber beschreibbar, damit der Filter etwas zum Aussortieren hat.
    ThirdRail(PowerSystem),
}

impl Electrification {
    /// Stabile Kennung der Bauart für den Zustands-Hash.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Unelectrified => "unelectrified",
            Self::Overhead(_) => "overhead",
            Self::ThirdRail(_) => "third-rail",
        }
    }

    /// Das Bahnstromsystem, falls der Abschnitt elektrifiziert ist.
    pub const fn system(self) -> Option<PowerSystem> {
        match self {
            Self::Unelectrified => None,
            Self::Overhead(system) | Self::ThirdRail(system) => Some(system),
        }
    }

    /// Ob der Abschnitt elektrifiziert ist.
    pub const fn is_electrified(self) -> bool {
        self.system().is_some()
    }

    /// Ob der Abschnitt über eine Stromschiene versorgt wird.
    pub const fn is_third_rail(self) -> bool {
        matches!(self, Self::ThirdRail(_))
    }

    /// Ob ein Fahrzeug, das dieses System beherrscht, hier elektrisch fahren
    /// kann.
    ///
    /// Ein nicht elektrifizierter Abschnitt liefert `false` — auch für ein
    /// Mehrsystemfahrzeug. Ob es dort mit Verbrennungs- oder Akkuantrieb
    /// weiterkommt, ist eine Frage des Fahrzeugs (M5.2), nicht des Gleises.
    pub fn supports(self, system: PowerSystem) -> bool {
        self.system() == Some(system)
    }
}

impl fmt::Display for Electrification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unelectrified => formatter.write_str("nicht elektrifiziert"),
            Self::Overhead(system) => write!(formatter, "Oberleitung {system}"),
            Self::ThirdRail(system) => write!(formatter, "Stromschiene {system}"),
        }
    }
}

impl Canonical for Electrification {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
        match self.system() {
            Some(system) => {
                hasher.flag(name, true);
                system.write_canonical(name, hasher);
            }
            None => {
                hasher.flag(name, false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Electrification, PowerSystem};

    #[test]
    fn das_deutsche_system_ist_ganzzahlig_beschrieben() {
        let system = PowerSystem::Ac15kV;
        assert_eq!(system.voltage_volts(), 15_000);
        assert_eq!(system.frequency_millihertz(), 16_700);
        assert!(system.is_alternating_current());
        assert_eq!(system.to_string(), "15000 V ~ 16,7 Hz");
    }

    #[test]
    fn gleichstrom_hat_keine_frequenz() {
        for system in [
            PowerSystem::Dc750V,
            PowerSystem::Dc1500V,
            PowerSystem::Dc3000V,
        ] {
            assert_eq!(system.frequency_millihertz(), 0);
            assert!(!system.is_alternating_current());
        }
    }

    #[test]
    fn die_bauart_traegt_den_netzfilter() {
        let oberleitung = Electrification::Overhead(PowerSystem::Ac15kV);
        let stromschiene = Electrification::ThirdRail(PowerSystem::Dc750V);

        assert!(oberleitung.is_electrified());
        assert!(!oberleitung.is_third_rail());
        // Genau diese Unterscheidung braucht die Netzausschlussliste aus M1.3.
        assert!(stromschiene.is_third_rail());
        assert!(stromschiene.is_electrified());
    }

    #[test]
    fn ohne_fahrdraht_traegt_kein_system() {
        let ohne = Electrification::Unelectrified;
        assert!(!ohne.is_electrified());
        assert_eq!(ohne.system(), None);
        assert!(!ohne.supports(PowerSystem::Ac15kV));
        assert_eq!(ohne.to_string(), "nicht elektrifiziert");
    }

    #[test]
    fn ein_fremdes_system_traegt_nicht() {
        let deutsch = Electrification::Overhead(PowerSystem::Ac15kV);
        assert!(deutsch.supports(PowerSystem::Ac15kV));
        assert!(!deutsch.supports(PowerSystem::Ac25kV));
    }
}
