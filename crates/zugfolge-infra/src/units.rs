//! Ganzzahlige Maßeinheiten des Betriebsgraphen.
//!
//! Invariante 3 aus `CLAUDE.md`: keine Gleitkommazahlen im zustandsrelevanten
//! Pfad. Längen sind Millimeter, Geschwindigkeiten Millimeter je Sekunde,
//! Neigungen Zehntel Promille. Die Fahrdynamik darf später **einmalig** in der
//! Pipeline mit Gleitkomma rechnen (M1.10) — was sie ausgibt, kommt als
//! Ganzzahl hier an.
//!
//! Die drei Typen sind Wrapper und keine nackten `i64`, weil sich Länge,
//! Geschwindigkeit und Neigung sonst gegenseitig zuweisen ließen. Das ist der
//! Fehler, den ein Domänenmodell als Erstes verhindern soll.

use core::fmt;
use core::ops::{Add, Sub};

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;

/// Eine Länge oder eine Position entlang eines Gleises, in Millimetern.
///
/// Positionen werden ab dem Anfang des Gleises gezählt, also in Richtung
/// wachsender Kilometrierung.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Length(i64);

impl Length {
    /// Die Länge null — zugleich der Anfang eines Gleises.
    pub const ZERO: Self = Self(0);

    /// Länge aus Millimetern.
    pub const fn from_millimetres(millimetres: i64) -> Self {
        Self(millimetres)
    }

    /// Länge aus vollen Metern.
    pub const fn from_metres(metres: i64) -> Self {
        Self(metres.saturating_mul(1_000))
    }

    /// Länge in Millimetern — so geht sie in den Zustands-Hash ein.
    pub const fn millimetres(self) -> i64 {
        self.0
    }

    /// Ob die Länge größer als null ist.
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }

    /// Ob die Länge negativ ist.
    pub const fn is_negative(self) -> bool {
        self.0 < 0
    }
}

impl Add for Length {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self(self.0.saturating_add(other.0))
    }
}

impl Sub for Length {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        Self(self.0.saturating_sub(other.0))
    }
}

impl fmt::Display for Length {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} mm", self.0)
    }
}

impl Canonical for Length {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, self.0);
    }
}

/// Eine Geschwindigkeit in Millimetern je Sekunde.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Speed(i64);

impl Speed {
    /// Stillstand.
    pub const ZERO: Self = Self(0);

    /// Geschwindigkeit aus Millimetern je Sekunde.
    pub const fn from_millimetres_per_second(value: i64) -> Self {
        Self(value)
    }

    /// Geschwindigkeit aus km/h, **aufgerundet**.
    ///
    /// Aufgerundet, damit aus der Umrechnung keine unbeabsichtigt strengere
    /// Fahrzeit entsteht: Eine abgerundete Vmax wäre eine stille
    /// Streckenverlangsamung, die niemand angeordnet hat.
    pub const fn from_km_h(value: i64) -> Self {
        // 1 km/h = 1_000_000 mm / 3600 s
        Self((value.saturating_mul(1_000_000).saturating_add(3_599)) / 3_600)
    }

    /// Geschwindigkeit in Millimetern je Sekunde.
    pub const fn millimetres_per_second(self) -> i64 {
        self.0
    }

    /// Geschwindigkeit in vollen km/h, abgerundet — für Anzeige und Meldungen.
    pub const fn km_h(self) -> i64 {
        self.0.saturating_mul(3_600) / 1_000_000
    }

    /// Ob die Geschwindigkeit größer als null ist.
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }
}

impl fmt::Display for Speed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} km/h", self.km_h())
    }
}

impl Canonical for Speed {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, self.0);
    }
}

/// Die Längsneigung eines Gleisabschnitts, in **Zehntel Promille**.
///
/// Positiv ist eine Steigung in Richtung wachsender Kilometrierung, negativ
/// ein Gefälle. Die Auflösung von 0,1 ‰ ist die im Betrieb gebräuchliche; sie
/// entspricht 1 mm Höhe auf 10 m Weg und liegt damit unter der Genauigkeit
/// jedes Höhenmodells, aus dem das Profil später abgeleitet wird (M1.5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Gradient(i32);

impl Gradient {
    /// Die Ebene.
    pub const LEVEL: Self = Self(0);

    /// Neigung aus Zehntel Promille.
    pub const fn from_per_mille_tenths(tenths: i32) -> Self {
        Self(tenths)
    }

    /// Neigung aus vollen Promille.
    pub const fn from_per_mille(per_mille: i32) -> Self {
        Self(per_mille.saturating_mul(10))
    }

    /// Neigung in Zehntel Promille.
    pub const fn per_mille_tenths(self) -> i32 {
        self.0
    }

    /// Ob es sich um eine Steigung handelt.
    pub const fn is_rising(self) -> bool {
        self.0 > 0
    }

    /// Ob es sich um ein Gefälle handelt.
    pub const fn is_falling(self) -> bool {
        self.0 < 0
    }

    /// Die Neigung in der Gegenrichtung.
    pub const fn reversed(self) -> Self {
        Self(self.0.saturating_neg())
    }

    /// Der Höhenunterschied über eine Strecke, zur Null hin abgerundet.
    ///
    /// 1 ‰ sind 10 Zehntel Promille, also 1 mm Höhe je 1000 mm Weg — daher der
    /// Teiler 10 000.
    pub fn rise_over(self, length: Length) -> Length {
        Length(
            length
                .millimetres()
                .saturating_mul(i64::from(self.0))
                .saturating_div(10_000),
        )
    }
}

impl fmt::Display for Gradient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let vorzeichen = if self.0 < 0 { "-" } else { "" };
        let betrag = self.0.unsigned_abs();
        write!(formatter, "{vorzeichen}{},{} ‰", betrag / 10, betrag % 10)
    }
}

impl Canonical for Gradient {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, i64::from(self.0));
    }
}

/// Eine Masse in Kilogramm.
///
/// Sie geht in keine Rechnung dieses Crates unmittelbar ein: Anfahr- und
/// Bremsvermögen (`TrainCharacteristics`, M1.9) sind bereits Beschleunigungen
/// — die Masse ist in ihnen herausgekürzt, wie es das reale Betriebsprogramm
/// mit diesen Kennwerten auch hält. Sie wird trotzdem geführt, weil M5.6
/// (Bedarfsmodell) und M11.5 (Bremshundertstel) sie brauchen werden.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Mass(i64);

impl Mass {
    /// Masse aus Kilogramm.
    pub const fn from_kilograms(kilograms: i64) -> Self {
        Self(kilograms)
    }

    /// Masse aus vollen Tonnen.
    pub const fn from_tonnes(tonnes: i64) -> Self {
        Self(tonnes.saturating_mul(1_000))
    }

    /// Masse in Kilogramm.
    pub const fn kilograms(self) -> i64 {
        self.0
    }

    /// Ob die Masse größer als null ist.
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }
}

impl fmt::Display for Mass {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} kg", self.0)
    }
}

impl Canonical for Mass {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, self.0);
    }
}

/// Ein Beschleunigungsvermögen, in Millimetern je Sekunde zum Quadrat.
///
/// Der Typ trägt keine Richtung — er beschreibt eine **Fähigkeit** (wie
/// schnell ein Zug an- oder abbremsen kann), nicht eine gerichtete
/// Momentanbeschleunigung. Anfahr- und Bremsvermögen einer
/// `TrainCharacteristics` (M1.9) sind deshalb beide als dieser eine Typ
/// geführt; die Fahrdynamik (M1.10) entscheidet, wann welches gilt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Acceleration(i64);

impl Acceleration {
    /// Beschleunigungsvermögen aus Millimetern je Sekunde zum Quadrat.
    pub const fn from_millimetres_per_second_squared(value: i64) -> Self {
        Self(value)
    }

    /// Beschleunigungsvermögen in Millimetern je Sekunde zum Quadrat.
    pub const fn millimetres_per_second_squared(self) -> i64 {
        self.0
    }

    /// Ob das Beschleunigungsvermögen größer als null ist.
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }
}

impl fmt::Display for Acceleration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} mm/s²", self.0)
    }
}

impl Canonical for Acceleration {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.int(name, self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{Acceleration, Gradient, Length, Mass, Speed};

    #[test]
    fn laenge_rechnet_in_millimetern() {
        assert_eq!(Length::from_metres(12).millimetres(), 12_000);
        assert_eq!(
            Length::from_metres(1) + Length::from_millimetres(5),
            Length::from_millimetres(1_005)
        );
        assert_eq!(
            Length::from_metres(1) - Length::from_metres(2),
            Length::from_millimetres(-1_000)
        );
        assert!(Length::from_metres(1).is_positive());
        assert!(!Length::ZERO.is_positive());
    }

    #[test]
    fn geschwindigkeit_rundet_auf_und_kommt_zurueck() {
        // 160 km/h sind 44444,44… mm/s — aufgerundet 44445, damit die
        // Umrechnung die Strecke nicht heimlich verlangsamt.
        assert_eq!(Speed::from_km_h(160).millimetres_per_second(), 44_445);
        for kmh in [10, 40, 60, 80, 100, 120, 140, 160, 200, 230, 300] {
            assert_eq!(Speed::from_km_h(kmh).km_h(), kmh, "{kmh} km/h");
        }
    }

    #[test]
    fn neigung_kennt_ihr_vorzeichen() {
        let steigung = Gradient::from_per_mille(12);
        assert!(steigung.is_rising());
        assert!(!steigung.is_falling());
        assert!(steigung.reversed().is_falling());
        assert_eq!(Gradient::LEVEL.reversed(), Gradient::LEVEL);
        assert_eq!(steigung.per_mille_tenths(), 120);
    }

    #[test]
    fn neigung_ergibt_hoehenunterschied() {
        // 12,5 ‰ über 4 km sind 50 m.
        let neigung = Gradient::from_per_mille_tenths(125);
        assert_eq!(
            neigung.rise_over(Length::from_metres(4_000)),
            Length::from_metres(50)
        );
        assert_eq!(
            neigung.reversed().rise_over(Length::from_metres(4_000)),
            Length::from_metres(-50)
        );
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(Gradient::from_per_mille_tenths(125).to_string(), "12,5 ‰");
        assert_eq!(Gradient::from_per_mille_tenths(-5).to_string(), "-0,5 ‰");
        assert_eq!(Speed::from_km_h(160).to_string(), "160 km/h");
        assert_eq!(Length::from_metres(2).to_string(), "2000 mm");
    }

    #[test]
    fn masse_rechnet_in_kilogramm() {
        assert_eq!(Mass::from_tonnes(80).kilograms(), 80_000);
        assert!(Mass::from_kilograms(1).is_positive());
        assert!(!Mass::default().is_positive());
        assert_eq!(Mass::from_tonnes(80).to_string(), "80000 kg");
    }

    #[test]
    fn beschleunigungsvermoegen_kennt_seine_einheit() {
        let anfahrvermoegen = Acceleration::from_millimetres_per_second_squared(600);
        assert_eq!(anfahrvermoegen.millimetres_per_second_squared(), 600);
        assert!(anfahrvermoegen.is_positive());
        assert!(!Acceleration::default().is_positive());
        assert_eq!(anfahrvermoegen.to_string(), "600 mm/s²");
    }
}
