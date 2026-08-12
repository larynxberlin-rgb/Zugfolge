//! Die Zugcharakteristik — **M1.9**.
//!
//! `docs/infrastruktur.md` 2 nennt den Satz wörtlich: **„Zugcharakteristik
//! statt Fahrzeugliste."** Der Trassen-Planner (M3.4) und die Fahrzeitrechnung
//! (M1.10) rechnen mit Masse, Länge, Vmax, Anfahr- und Bremsvermögen,
//! Antriebsart und Zugsicherung — nicht mit konkreten Fahrzeugen. Erst
//! `docs/betrieb.md` 1 bildet echte Formationen auf eine [`TrainCharacteristics`]
//! ab (M5.2). So arbeiten reale Fahrplanrechner auch, und es entkoppelt die
//! Trassenplanung vom Fahrzeugkatalog, der zwei Milestones später entsteht.
//!
//! ## Warum diese Angaben
//!
//! Die effektiven Werte Masse, Länge, Vmax, Anfahr- und Bremsvermögen,
//! Antriebsart sowie Zugsicherung sind exakt die Eingabe, die die
//! Fahrzeitrechnung und Infrastrukturprüfung brauchen. **Masse** geht in
//! keine Rechnung dieses Crates unmittelbar ein — Anfahr- und Bremsvermögen
//! sind bereits Beschleunigungswerte, in denen die Masse aufgeht, wie es das
//! reale Betriebsprogramm auch hält (`units.rs`). Sie wird trotzdem geführt,
//! weil M5.6 (Bedarfsmodell) und M11.5 (Bremshundertstel) sie brauchen.
//! **Länge** und **Vmax** begrenzen zusammen mit der Infrastruktur, was ein
//! Zug befahren darf. **Anfahr- und Bremsvermögen** sind die zwei Kennwerte,
//! die M1.10 in Bewegung setzt.
//! **Antriebsart** ([`TractionType`]) entscheidet, welche Elektrifizierung
//! nutzbar ist — dieselbe Frage, die `electrification.rs` streckenseitig
//! stellt. Und **Zugsicherung** ist [`TrainProtection`] — derselbe Typ wie auf
//! der Streckenseite, denn `protection.rs` sagt es bereits: „Fahrzeugseitig
//! gilt dasselbe."
//!
//! Der Fahrzeugkatalog führt zusätzlich die Rohwerte kontinuierliche
//! Leistung, Anfahrzugkraft und Bremsgewicht. Sie werden nicht aus Masse oder
//! einer pauschalen Formel erfunden. Das skalare Bremsgewicht ist bis zur
//! strukturierten Bremsrechnung ein referenzierter Authority-Wert; die
//! vollständige R/P/G/R+Mg-Aufschlüsselung bleibt als Katalogfakt erhalten.
//!
//! ## Was hier bewusst nicht steht
//!
//! Kein Fahrzeugkatalog, keine Formation, kein Zulassungsdatum, keine
//! Eigentumsfrage — das liefert `docs/betrieb.md` 1 erst mit M5.1.
//! [`TrainCharacteristics`] ist die abstrakte Fahrzeitrechnungs-Sicht auf
//! einen Zug, keine Zusicherung über ein reales Fahrzeug.

use core::fmt;
use std::collections::BTreeSet;

use crate::electrification::{Electrification, PowerSystem};
use crate::error::InfraError;
use crate::identity::TrainCharacteristicsId;
use crate::protection::TrainProtection;
use crate::speed::{SpeedCategory, SpeedLimit};
use crate::units::{Acceleration, Force, Length, Mass, Power, Speed};

/// Die Bahnstromsysteme, unter denen ein elektrischer Antrieb fahren kann.
///
/// Nie leer: Ein elektrischer Antrieb ohne ein einziges beherrschtes System
/// wäre keiner. Mehrsystemfahrzeuge — etwa ein Vectron MS — tragen hier mehr
/// als ein System; die Menge ist geordnet (`BTreeSet`), aus demselben Grund
/// wie bei [`TrainProtection`]: Ein Fingerabdruck darf nicht an der
/// Einfügereihenfolge hängen.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ElectricSystems {
    systems: BTreeSet<PowerSystem>,
}

impl ElectricSystems {
    /// Systeme aus einer Aufzählung.
    ///
    /// # Errors
    ///
    /// [`InfraError::EmptyElectricSystems`], wenn keine einzige Angabe folgt.
    pub fn from_systems(
        systems: impl IntoIterator<Item = PowerSystem>,
    ) -> Result<Self, InfraError> {
        let systems: BTreeSet<PowerSystem> = systems.into_iter().collect();
        if systems.is_empty() {
            return Err(InfraError::EmptyElectricSystems);
        }
        Ok(Self { systems })
    }

    /// Genau ein System.
    pub fn single(system: PowerSystem) -> Self {
        Self {
            systems: BTreeSet::from([system]),
        }
    }

    /// Die Systeme in fester Reihenfolge.
    pub fn systems(&self) -> impl Iterator<Item = PowerSystem> + '_ {
        self.systems.iter().copied()
    }

    /// Anzahl der Systeme.
    pub fn count(&self) -> usize {
        self.systems.len()
    }

    /// Ob ein bestimmtes System dazugehört.
    pub fn contains(&self, system: PowerSystem) -> bool {
        self.systems.contains(&system)
    }
}

impl fmt::Display for ElectricSystems {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut erstes = true;
        for system in &self.systems {
            if !erstes {
                formatter.write_str(", ")?;
            }
            write!(formatter, "{system}")?;
            erstes = false;
        }
        Ok(())
    }
}

/// Die Antriebsart eines Zuges — entscheidet, welche Elektrifizierung nutzbar
/// ist.
///
/// Dieselbe Schnittmengenfrage wie bei der Zugsicherung
/// (`protection.rs`): Ob ein Zug einen Abschnitt elektrisch befahren kann, ist
/// keine Gleichheitsprüfung, sondern eine Frage der beherrschten Systeme.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TractionType {
    /// Nicht angetriebenes Fahrzeug, etwa ein Reisezug- oder Steuerwagen.
    ///
    /// Ein solches Fahrzeug darf Bestandteil eines Wagenparks sein, erzeugt
    /// aber keine eigene Zugfahrt. Die Formation muss für eine Fahrt mindestens
    /// ein angetriebenes Fahrzeug enthalten.
    Unpowered,
    /// Verbrennungsantrieb — unabhängig vom Fahrdraht, fährt auf jedem
    /// Abschnitt.
    Diesel,
    /// Akkubetrieb — ebenfalls unabhängig vom Fahrdraht. Ohne
    /// Reichweitenmodell: Das gehört zum Bedarfsmodell (M5.6), nicht zur
    /// Zugcharakteristik.
    BatteryElectric,
    /// Elektrischer Antrieb unter einem oder mehreren Bahnstromsystemen.
    Electric(ElectricSystems),
}

impl TractionType {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(&self) -> &'static str {
        match self {
            Self::Unpowered => "unpowered",
            Self::Diesel => "diesel",
            Self::BatteryElectric => "battery-electric",
            Self::Electric(_) => "electric",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(&self) -> &'static str {
        match self {
            Self::Unpowered => "nicht angetrieben",
            Self::Diesel => "Diesel",
            Self::BatteryElectric => "Akku",
            Self::Electric(_) => "elektrisch",
        }
    }

    /// Ob ein Fahrzeug dieser Antriebsart einen Abschnitt mit dieser
    /// Elektrifizierung befahren kann.
    ///
    /// Diesel- und Akkubetrieb sind vom Fahrdraht unabhängig — sie fahren
    /// überall, elektrifiziert oder nicht. Ein elektrischer Antrieb braucht
    /// ein gemeinsames System mit dem Abschnitt.
    pub fn can_use(&self, electrification: Electrification) -> bool {
        match self {
            Self::Unpowered => false,
            Self::Diesel | Self::BatteryElectric => true,
            Self::Electric(systems) => electrification
                .system()
                .is_some_and(|system| systems.contains(system)),
        }
    }
}

impl fmt::Display for TractionType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unpowered => formatter.write_str(self.label()),
            Self::Diesel | Self::BatteryElectric => formatter.write_str(self.label()),
            Self::Electric(systems) => write!(formatter, "elektrisch ({systems})"),
        }
    }
}

/// Eine Zugcharakteristik: Masse, Länge, Vmax, Anfahr- und Bremsvermögen,
/// Antriebsart, Zugsicherung sowie die versionierten Rohwerte Leistung,
/// Anfahrzugkraft und Bremsgewicht (`docs/infrastruktur.md` 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrainCharacteristics {
    id: TrainCharacteristicsId,
    name: String,
    mass: Mass,
    length: Length,
    max_speed: Speed,
    speed_category: SpeedCategory,
    acceleration: Acceleration,
    deceleration: Acceleration,
    traction: TractionType,
    protection: TrainProtection,
    continuous_power: Power,
    starting_tractive_effort: Force,
    brake_weight: Mass,
}

impl TrainCharacteristics {
    /// Eine Zugcharakteristik mit den effektiven Fahrzeitwerten aus
    /// `docs/infrastruktur.md` 2. Die drei zusätzlichen technischen Rohwerte
    /// bleiben für Alt-Aufrufer null; echte Authority-Releases sollen
    /// [`Self::new_with_performance`] verwenden.
    ///
    /// `speed_category` legt fest, welche Vmax-Spalte des Streckenprofils
    /// (`SpeedLimit`, `speed.rs`) für diesen Zug gilt — genau die Frage, die
    /// dort als offen benannt ist.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn der Name leer ist.
    /// - [`InfraError::NonPositiveMass`], wenn die Masse nicht positiv ist.
    /// - [`InfraError::NonPositiveLength`], wenn die Länge nicht positiv ist.
    /// - [`InfraError::NonPositiveSpeed`], wenn Vmax nicht positiv ist.
    /// - [`InfraError::NonPositiveAcceleration`], wenn Anfahr- oder
    ///   Bremsvermögen nicht positiv sind.
    #[allow(
        clippy::too_many_arguments,
        reason = "jedes Argument hat einen eigenen, unverwechselbaren Typ (docs/infrastruktur.md 2 nennt genau diese Angaben) — ein Erbauer verschöbe nur die Stelle, an der sie zusammenkommen müssen"
    )]
    pub fn new(
        id: TrainCharacteristicsId,
        name: impl Into<String>,
        mass: Mass,
        length: Length,
        max_speed: Speed,
        speed_category: SpeedCategory,
        acceleration: Acceleration,
        deceleration: Acceleration,
        traction: TractionType,
        protection: TrainProtection,
    ) -> Result<Self, InfraError> {
        Self::new_with_performance(
            id,
            name,
            mass,
            length,
            max_speed,
            speed_category,
            acceleration,
            deceleration,
            traction,
            protection,
            Power::ZERO,
            Force::ZERO,
            Mass::default(),
        )
    }

    /// Baut eine Zugcharakteristik mit technischen Rohwerten für
    /// Zugkraft-, Brems- und Lastgrenzen.
    ///
    /// Die effektiven Beschleunigungswerte bleiben absichtlich getrennt von
    /// den Rohwerten: M1.10 rechnet mit ihnen, während Leistung, Zugkraft und
    /// Bremsgewicht für Last-, Brems- und Beschaffungslogik erhalten bleiben.
    #[allow(
        clippy::too_many_arguments,
        reason = "Fahrzeitwerte und Rohwerte sind getrennte, versionierte Fachwerte"
    )]
    pub fn new_with_performance(
        id: TrainCharacteristicsId,
        name: impl Into<String>,
        mass: Mass,
        length: Length,
        max_speed: Speed,
        speed_category: SpeedCategory,
        acceleration: Acceleration,
        deceleration: Acceleration,
        traction: TractionType,
        protection: TrainProtection,
        continuous_power: Power,
        starting_tractive_effort: Force,
        brake_weight: Mass,
    ) -> Result<Self, InfraError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InfraError::EmptyName {
                what: "Zugcharakteristik",
            });
        }
        if !mass.is_positive() {
            return Err(InfraError::NonPositiveMass {
                what: "Masse",
                value: mass,
            });
        }
        if !length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Zuglänge",
                value: length,
            });
        }
        if !max_speed.is_positive() {
            return Err(InfraError::NonPositiveSpeed {
                what: "Vmax",
                value: max_speed,
            });
        }
        if !acceleration.is_positive() {
            return Err(InfraError::NonPositiveAcceleration {
                what: "Anfahrvermögen",
                value: acceleration,
            });
        }
        if !deceleration.is_positive() {
            return Err(InfraError::NonPositiveAcceleration {
                what: "Bremsvermögen",
                value: deceleration,
            });
        }
        Ok(Self {
            id,
            name,
            mass,
            length,
            max_speed,
            speed_category,
            acceleration,
            deceleration,
            traction,
            protection,
            continuous_power,
            starting_tractive_effort,
            brake_weight,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> TrainCharacteristicsId {
        self.id
    }

    /// Die Bezeichnung, etwa `Elektrotriebwagen Regio`.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Die Masse.
    pub const fn mass(&self) -> Mass {
        self.mass
    }

    /// Die Zuglänge.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die zulässige Höchstgeschwindigkeit des Zuges.
    pub const fn max_speed(&self) -> Speed {
        self.max_speed
    }

    /// Welche Vmax-Spalte des Streckenprofils für diesen Zug gilt.
    pub const fn speed_category(&self) -> SpeedCategory {
        self.speed_category
    }

    /// Das Anfahrvermögen.
    pub const fn acceleration(&self) -> Acceleration {
        self.acceleration
    }

    /// Das Bremsvermögen.
    pub const fn deceleration(&self) -> Acceleration {
        self.deceleration
    }

    /// Die Antriebsart.
    pub const fn traction(&self) -> &TractionType {
        &self.traction
    }

    /// Die Zugsicherungsausrüstung.
    pub const fn protection(&self) -> &TrainProtection {
        &self.protection
    }

    /// Kontinuierliche Antriebsleistung des Zuges.
    pub const fn continuous_power(&self) -> Power {
        self.continuous_power
    }

    /// Anfahrzugkraft des Zuges.
    pub const fn starting_tractive_effort(&self) -> Force {
        self.starting_tractive_effort
    }

    /// Bremsgewicht des Zuges.
    pub const fn brake_weight(&self) -> Mass {
        self.brake_weight
    }

    /// Die für diesen Zug zulässige Geschwindigkeit eines Streckenabschnitts —
    /// das Minimum aus der eigenen Vmax und der für ihn geltenden Spalte des
    /// Streckenprofils.
    pub fn effective_speed_limit(&self, limit: SpeedLimit) -> Speed {
        self.max_speed.min(limit.for_category(self.speed_category))
    }

    /// Ob der Zug einen Abschnitt mit dieser streckenseitigen Zugsicherung
    /// befahren darf — beide Seiten müssen mindestens ein System teilen.
    pub fn is_compatible_with_protection(&self, infrastructure: &TrainProtection) -> bool {
        infrastructure.is_compatible_with(&self.protection)
    }

    /// Ob der Zug einen Abschnitt mit dieser Elektrifizierung befahren kann.
    pub fn is_compatible_with_electrification(&self, electrification: Electrification) -> bool {
        self.traction.can_use(electrification)
    }
}

impl fmt::Display for TrainCharacteristics {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({}, {})",
            self.name, self.traction, self.max_speed
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{ElectricSystems, TractionType, TrainCharacteristics};
    use crate::electrification::{Electrification, PowerSystem};
    use crate::error::InfraError;
    use crate::identity::TrainCharacteristicsId;
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::speed::{SpeedCategory, SpeedLimit};
    use crate::units::{Acceleration, Length, Mass, Speed};

    fn elektrotriebwagen() -> TrainCharacteristics {
        TrainCharacteristics::new(
            TrainCharacteristicsId::new(1),
            "Elektrotriebwagen Regio",
            Mass::from_tonnes(120),
            Length::from_metres(80),
            Speed::from_km_h(160),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(800),
            Acceleration::from_millimetres_per_second_squared(900),
            TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
            TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
        )
        .expect("gültige Zugcharakteristik")
    }

    #[test]
    fn eine_zugcharakteristik_traegt_alle_effektiven_und_rohwerte() {
        let zug = elektrotriebwagen();
        assert_eq!(zug.mass(), Mass::from_tonnes(120));
        assert_eq!(zug.length(), Length::from_metres(80));
        assert_eq!(zug.max_speed(), Speed::from_km_h(160));
        assert_eq!(
            zug.acceleration(),
            Acceleration::from_millimetres_per_second_squared(800)
        );
        assert_eq!(
            zug.deceleration(),
            Acceleration::from_millimetres_per_second_squared(900)
        );
        assert!(matches!(zug.traction(), TractionType::Electric(_)));
        assert!(zug.protection().contains(ProtectionSystem::Lzb));
    }

    #[test]
    fn elektrische_systeme_sind_nie_leer() {
        assert!(matches!(
            ElectricSystems::from_systems(core::iter::empty()),
            Err(InfraError::EmptyElectricSystems)
        ));
        let mehrsystem = ElectricSystems::from_systems([PowerSystem::Ac15kV, PowerSystem::Ac25kV])
            .expect("zwei Systeme sind nicht leer");
        assert_eq!(mehrsystem.count(), 2);
        assert!(mehrsystem.contains(PowerSystem::Ac25kV));
    }

    #[test]
    fn diesel_und_akku_fahren_ueberall() {
        assert!(TractionType::Diesel.can_use(Electrification::Unelectrified));
        assert!(TractionType::Diesel.can_use(Electrification::Overhead(PowerSystem::Ac15kV)));
        assert!(TractionType::BatteryElectric.can_use(Electrification::Unelectrified));
    }

    #[test]
    fn elektrischer_antrieb_braucht_ein_gemeinsames_system() {
        let deutsch = TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV));
        assert!(deutsch.can_use(Electrification::Overhead(PowerSystem::Ac15kV)));
        assert!(!deutsch.can_use(Electrification::Overhead(PowerSystem::Ac25kV)));
        assert!(!deutsch.can_use(Electrification::Unelectrified));
    }

    #[test]
    fn die_effektive_geschwindigkeit_ist_das_minimum() {
        let zug = elektrotriebwagen();
        let vmax_strecke = SpeedLimit::uniform(Speed::from_km_h(120)).expect("positiv");
        // Die Strecke erlaubt weniger als die Zugcharakteristik.
        assert_eq!(
            zug.effective_speed_limit(vmax_strecke),
            Speed::from_km_h(120)
        );

        let schnelle_strecke = SpeedLimit::uniform(Speed::from_km_h(300)).expect("positiv");
        // Die Zugcharakteristik begrenzt stärker als die Strecke.
        assert_eq!(
            zug.effective_speed_limit(schnelle_strecke),
            Speed::from_km_h(160)
        );
    }

    #[test]
    fn die_zugsicherung_ist_eine_schnittmenge() {
        let zug = elektrotriebwagen();
        let strecke_mit_lzb =
            TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]);
        let strecke_nur_etcs = TrainProtection::single(ProtectionSystem::EtcsLevel2);
        assert!(zug.is_compatible_with_protection(&strecke_mit_lzb));
        assert!(!zug.is_compatible_with_protection(&strecke_nur_etcs));
    }

    #[test]
    fn eine_leere_bezeichnung_faellt_auf() {
        let fehler = TrainCharacteristics::new(
            TrainCharacteristicsId::new(1),
            "  ",
            Mass::from_tonnes(80),
            Length::from_metres(50),
            Speed::from_km_h(120),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(500),
            Acceleration::from_millimetres_per_second_squared(500),
            TractionType::Diesel,
            TrainProtection::single(ProtectionSystem::Pzb),
        )
        .expect_err("ein leerer Name ist keine Bezeichnung");
        assert!(matches!(fehler, InfraError::EmptyName { .. }));
    }

    #[test]
    fn nicht_positive_kennwerte_fallen_auf() {
        let basis = |masse: Mass,
                     laenge: Length,
                     vmax: Speed,
                     anfahr: Acceleration,
                     brems: Acceleration| {
            TrainCharacteristics::new(
                TrainCharacteristicsId::new(1),
                "Testzug",
                masse,
                laenge,
                vmax,
                SpeedCategory::Standard,
                anfahr,
                brems,
                TractionType::Diesel,
                TrainProtection::single(ProtectionSystem::Pzb),
            )
        };

        assert!(matches!(
            basis(
                Mass::default(),
                Length::from_metres(50),
                Speed::from_km_h(100),
                Acceleration::from_millimetres_per_second_squared(500),
                Acceleration::from_millimetres_per_second_squared(500),
            ),
            Err(InfraError::NonPositiveMass { .. })
        ));
        assert!(matches!(
            basis(
                Mass::from_tonnes(80),
                Length::ZERO,
                Speed::from_km_h(100),
                Acceleration::from_millimetres_per_second_squared(500),
                Acceleration::from_millimetres_per_second_squared(500),
            ),
            Err(InfraError::NonPositiveLength { .. })
        ));
        assert!(matches!(
            basis(
                Mass::from_tonnes(80),
                Length::from_metres(50),
                Speed::ZERO,
                Acceleration::from_millimetres_per_second_squared(500),
                Acceleration::from_millimetres_per_second_squared(500),
            ),
            Err(InfraError::NonPositiveSpeed { .. })
        ));
        assert!(matches!(
            basis(
                Mass::from_tonnes(80),
                Length::from_metres(50),
                Speed::from_km_h(100),
                Acceleration::default(),
                Acceleration::from_millimetres_per_second_squared(500),
            ),
            Err(InfraError::NonPositiveAcceleration { .. })
        ));
        assert!(matches!(
            basis(
                Mass::from_tonnes(80),
                Length::from_metres(50),
                Speed::from_km_h(100),
                Acceleration::from_millimetres_per_second_squared(500),
                Acceleration::default(),
            ),
            Err(InfraError::NonPositiveAcceleration { .. })
        ));
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        let zug = elektrotriebwagen();
        assert_eq!(
            zug.to_string(),
            "Elektrotriebwagen Regio (elektrisch (15000 V ~ 16,7 Hz), 160 km/h)"
        );
    }
}
