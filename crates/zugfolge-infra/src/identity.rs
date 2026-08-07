//! Kennungen der Bausteine des Betriebsgraphen.
//!
//! Die Kennungen sind dichte Zahlen, keine Zeichenketten. Ein
//! `InfraRelease` ist ein unveränderliches Artefakt (M1.12): Seine Kennungen
//! werden einmal vergeben und danach von Trassen, Belegungen und Ereignissen
//! über Jahre zitiert. Zahlen sind dafür kleiner, schneller vergleichbar und
//! im Zustands-Hash eindeutig.
//!
//! Die **Herkunft** eines Objekts — die OSM-Kennung, aus der es entstand —
//! gehört nicht hierher, sondern in die Herkunftsangabe des Imports (M1.2).
//! Sonst wäre die Kennung des Spiels an die Kennung einer fremden Datenbank
//! gebunden, und ein Neuimport verschöbe jede bestehende Trasse.

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;

macro_rules! kennung {
    (
        $(#[$doku:meta])*
        $name:ident, $praefix:literal
    ) => {
        $(#[$doku])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(u32);

        impl $name {
            /// Kennung aus ihrer Nummer.
            pub const fn new(value: u32) -> Self {
                Self(value)
            }

            /// Die Nummer — so geht die Kennung in den Zustands-Hash ein.
            pub const fn value(self) -> u32 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}{}", $praefix, self.0)
            }
        }

        impl Canonical for $name {
            fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
                hasher.uint(name, u64::from(self.0));
            }
        }
    };
}

kennung!(
    /// Kennung einer Betriebsstelle.
    OperatingPointId,
    "Bst"
);

kennung!(
    /// Kennung einer Kante zwischen zwei Betriebsstellen.
    TrackEdgeId,
    "K"
);

kennung!(
    /// Kennung eines Gleises.
    TrackId,
    "G"
);

kennung!(
    /// Kennung eines Bahnsteigs.
    PlatformId,
    "Bs"
);

kennung!(
    /// Kennung einer Weiche im Bahnhofskopf (M1.7).
    SwitchId,
    "W"
);

kennung!(
    /// Kennung eines Knotens im Bahnhofskopf — ein Verbindungspunkt zwischen
    /// Fahrwegelementen, an dem eine Weiche, ein Endpunkt oder ein bloßer
    /// Stoß liegt (M1.7).
    HeadNodeId,
    "Kn"
);

kennung!(
    /// Kennung eines Fahrwegelements im Bahnhofskopf — das kleinste belegbare
    /// Stück Gleis zwischen zwei Knoten (M1.7).
    HeadElementId,
    "El"
);

kennung!(
    /// Kennung eines Signals im Bahnhofskopf (M1.7).
    HeadSignalId,
    "Sig"
);

kennung!(
    /// Kennung einer Fahrstraße durch einen Bahnhofskopf (M1.7).
    InterlockingRouteId,
    "Fs"
);

kennung!(
    /// Kennung einer Anlage im Anlagenkataster — Werkstatt, Behandlungs- oder
    /// Waschanlage, Tankstelle, Entsorgungsanlage oder Abstellgleis (M1.11).
    FacilityId,
    "Anl"
);

/// Das Betriebsstellenkürzel — im deutschen Netz die Abkürzung nach Ril 100.
///
/// Es ist die Kennung, mit der Menschen arbeiten: Sie steht im Fahrplan, in
/// der Meldung und auf dem Bildfahrplan. Deshalb ist sie ein eigener,
/// geprüfter Typ und keine freie Zeichenkette — ein leeres oder ein doppelt
/// vergebenes Kürzel macht jede Meldung mehrdeutig.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OperatingPointCode(String);

impl OperatingPointCode {
    /// Kleinste zulässige Länge.
    pub const MIN_LENGTH: usize = 2;

    /// Größte zulässige Länge.
    pub const MAX_LENGTH: usize = 8;

    /// Prüft und übernimmt ein Kürzel.
    ///
    /// Zulässig sind Buchstaben, Ziffern und einzelne Leerzeichen im Inneren,
    /// zwei bis acht Zeichen lang.
    ///
    /// # Errors
    ///
    /// [`InfraError::OperatingPointCode`], wenn das Kürzel diese Form nicht
    /// hat.
    pub fn new(code: impl Into<String>) -> Result<Self, InfraError> {
        let code = code.into();
        let zulaessig = code
            .chars()
            .all(|zeichen| zeichen.is_ascii_alphanumeric() || zeichen == ' ');
        let laenge = code.chars().count();
        if !zulaessig
            || !(Self::MIN_LENGTH..=Self::MAX_LENGTH).contains(&laenge)
            || code.starts_with(' ')
            || code.ends_with(' ')
        {
            return Err(InfraError::OperatingPointCode(code));
        }
        Ok(Self(code))
    }

    /// Das Kürzel als Zeichenkette.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for OperatingPointCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Canonical for OperatingPointCode {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, &self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{FacilityId, OperatingPointCode, OperatingPointId, TrackId};
    use crate::error::InfraError;

    #[test]
    fn kennungen_sind_unterscheidbar_und_lesbar() {
        assert_eq!(OperatingPointId::new(7).value(), 7);
        assert_eq!(OperatingPointId::new(7).to_string(), "Bst7");
        assert_eq!(TrackId::new(7).to_string(), "G7");
        assert_eq!(FacilityId::new(7).to_string(), "Anl7");
        assert!(OperatingPointId::new(1) < OperatingPointId::new(2));
    }

    #[test]
    fn kuerzel_nimmt_gebraeuchliche_formen_an() {
        for kuerzel in ["LL", "LLG", "UE", "NN 1", "AB12"] {
            assert!(
                OperatingPointCode::new(kuerzel).is_ok(),
                "{kuerzel} sollte zulässig sein"
            );
        }
    }

    #[test]
    fn kuerzel_weist_unbrauchbares_zurueck() {
        for kuerzel in ["", "L", "VIELZULANGESKUERZEL", " LL", "LL ", "L-L", "Lä"] {
            assert!(
                matches!(
                    OperatingPointCode::new(kuerzel),
                    Err(InfraError::OperatingPointCode(_))
                ),
                "{kuerzel} sollte unzulässig sein"
            );
        }
    }
}
