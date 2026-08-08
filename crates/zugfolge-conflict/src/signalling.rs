//! Die Parameter der Sperrzeit — je Betriebsstelle und Stellwerkstyp.
//!
//! Der Spike aus M0.3 hat die sechs Anteile der Sperrzeit mit **netzweit
//! konstanten** Zeiten gerechnet. Seine README benennt das als den Punkt, den
//! M3.1 abzulösen hat: Fahrstraßenbilde- und Fahrstraßenauflösezeit hängen am
//! **Stellwerk**, Signalsichtzeit, Vorsignalabstand und Durchrutschweg an der
//! **Betriebsstelle**. Ein mechanisches Stellwerk stellt einen Fahrweg nicht in
//! zwölf Sekunden, und ein elektronisches braucht keine sechzig.
//!
//! Deshalb steht hier ein zweistufiges Modell: [`SignallingParameters`]
//! beschreibt eine Betriebsstelle, [`SignallingModel`] hält die Ausnahmen und
//! einen Vorgabewert für alles Übrige. Das ist bewusst kein Import — welche
//! Betriebsstelle welches Stellwerk hat, steht in keiner freigegebenen Quelle
//! (`docs/rechte.md`). M3.1 liefert das Verfahren; die Werte kommen später aus
//! dem `InfraRelease`.

use core::fmt;
use std::collections::BTreeMap;

use zugfolge_infra::{Length, OperatingPointId};

use crate::error::ConflictError;

/// Die Bauart eines Stellwerks.
///
/// Sie entscheidet über zwei der sechs Anteile der Sperrzeit: wie lange das
/// Stellen und Festlegen eines Fahrwegs dauert und wie lange sein Auflösen.
/// Die Reihenfolge der Varianten ist die historische — von der Hebelbank zum
/// digitalen Stellwerk — und zugleich die absteigende Zeitdauer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum InterlockingKind {
    /// Mechanisches Stellwerk: Fahrweg über Drahtzug und Hebelbank.
    Mechanical,
    /// Elektromechanisches Stellwerk.
    ElectroMechanical,
    /// Relaisstellwerk.
    Relay,
    /// Elektronisches Stellwerk.
    Electronic,
    /// Digitales Stellwerk.
    Digital,
}

impl InterlockingKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Mechanical => "mechanical",
            Self::ElectroMechanical => "electro-mechanical",
            Self::Relay => "relay",
            Self::Electronic => "electronic",
            Self::Digital => "digital",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Mechanical => "mechanisches Stellwerk",
            Self::ElectroMechanical => "elektromechanisches Stellwerk",
            Self::Relay => "Relaisstellwerk",
            Self::Electronic => "elektronisches Stellwerk",
            Self::Digital => "digitales Stellwerk",
        }
    }

    /// Die Fahrstraßenbildezeit in Sekunden — Stellen und Festlegen des
    /// Fahrwegs, bevor das Signal Fahrt zeigen kann.
    pub const fn route_setting_time_s(self) -> i64 {
        match self {
            Self::Mechanical => 60,
            Self::ElectroMechanical => 40,
            Self::Relay => 20,
            Self::Electronic => 12,
            Self::Digital => 8,
        }
    }

    /// Die Fahrstraßenauflösezeit in Sekunden — das Auflösen des Fahrwegs,
    /// nachdem der Zug geräumt hat.
    pub const fn route_release_time_s(self) -> i64 {
        match self {
            Self::Mechanical => 30,
            Self::ElectroMechanical => 20,
            Self::Relay => 12,
            Self::Electronic => 6,
            Self::Digital => 4,
        }
    }
}

impl fmt::Display for InterlockingKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Die Sperrzeitparameter einer Betriebsstelle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignallingParameters {
    interlocking: InterlockingKind,
    signal_sighting_time_s: i64,
    approach_distance: Length,
    overlap_length: Length,
}

impl SignallingParameters {
    /// Die Vorgabewerte einer elektronisch gestellten Hauptstrecke:
    /// 5 s Signalsichtzeit, 1000 m Vorsignalabstand, 200 m Durchrutschweg.
    ///
    /// Sie stammen aus dem Spike (M0.3) und sind die im deutschen Netz
    /// gebräuchlichen Größenordnungen.
    pub fn electronic_main_line() -> Self {
        Self {
            interlocking: InterlockingKind::Electronic,
            signal_sighting_time_s: 5,
            approach_distance: Length::from_metres(1_000),
            overlap_length: Length::from_metres(200),
        }
    }

    /// Parameter einer Betriebsstelle.
    ///
    /// # Errors
    ///
    /// - [`ConflictError::NegativeDuration`], wenn die Signalsichtzeit negativ
    ///   ist.
    /// - [`ConflictError::NonPositiveLength`], wenn Vorsignalabstand oder
    ///   Durchrutschweg nicht positiv sind. Beide sind es im Betrieb immer: Ein
    ///   Vorsignalabstand von null hieße, dass ein Zug ohne Vorankündigung vor
    ///   dem Hauptsignal zum Stehen käme.
    pub fn new(
        interlocking: InterlockingKind,
        signal_sighting_time_s: i64,
        approach_distance: Length,
        overlap_length: Length,
    ) -> Result<Self, ConflictError> {
        if signal_sighting_time_s < 0 {
            return Err(ConflictError::NegativeDuration {
                what: "Signalsichtzeit",
                seconds: signal_sighting_time_s,
            });
        }
        if !approach_distance.is_positive() {
            return Err(ConflictError::NonPositiveLength {
                what: "Vorsignalabstand",
                value: approach_distance,
            });
        }
        if !overlap_length.is_positive() {
            return Err(ConflictError::NonPositiveLength {
                what: "Durchrutschweg",
                value: overlap_length,
            });
        }
        Ok(Self {
            interlocking,
            signal_sighting_time_s,
            approach_distance,
            overlap_length,
        })
    }

    /// Die Bauart des Stellwerks.
    pub const fn interlocking(self) -> InterlockingKind {
        self.interlocking
    }

    /// Die Signalsichtzeit in Sekunden.
    pub const fn signal_sighting_time_s(self) -> i64 {
        self.signal_sighting_time_s
    }

    /// Die Fahrstraßenbildezeit in Sekunden.
    pub const fn route_setting_time_s(self) -> i64 {
        self.interlocking.route_setting_time_s()
    }

    /// Die Fahrstraßenauflösezeit in Sekunden.
    pub const fn route_release_time_s(self) -> i64 {
        self.interlocking.route_release_time_s()
    }

    /// Der Vorsignalabstand — die Länge des Annäherungsabschnitts.
    pub const fn approach_distance(self) -> Length {
        self.approach_distance
    }

    /// Der Durchrutschweg hinter dem Zielsignal.
    pub const fn overlap_length(self) -> Length {
        self.overlap_length
    }
}

/// Die Sperrzeitparameter eines ganzen Netzes.
///
/// Ein Vorgabewert und die Ausnahmen — nicht jede Betriebsstelle einzeln.
/// Netze haben Tausende Betriebsstellen und eine Handvoll Stellwerksbauarten;
/// eine vollständige Tabelle wäre zu 99 Prozent Wiederholung und würde beim
/// ersten Import auseinanderlaufen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignallingModel {
    default: SignallingParameters,
    per_point: BTreeMap<OperatingPointId, SignallingParameters>,
}

impl SignallingModel {
    /// Ein Modell mit einem Vorgabewert für jede Betriebsstelle.
    pub fn new(default: SignallingParameters) -> Self {
        Self {
            default,
            per_point: BTreeMap::new(),
        }
    }

    /// Setzt abweichende Parameter für eine Betriebsstelle.
    #[must_use]
    pub fn with_point(mut self, point: OperatingPointId, parameters: SignallingParameters) -> Self {
        self.per_point.insert(point, parameters);
        self
    }

    /// Die Parameter einer Betriebsstelle — die Ausnahme, sonst der
    /// Vorgabewert.
    pub fn at(&self, point: OperatingPointId) -> SignallingParameters {
        self.per_point.get(&point).copied().unwrap_or(self.default)
    }

    /// Der Vorgabewert.
    pub const fn default_parameters(&self) -> SignallingParameters {
        self.default
    }

    /// Wie viele Betriebsstellen eigene Parameter tragen.
    pub fn exception_count(&self) -> usize {
        self.per_point.len()
    }
}

impl Default for SignallingModel {
    fn default() -> Self {
        Self::new(SignallingParameters::electronic_main_line())
    }
}

#[cfg(test)]
mod tests {
    use super::{InterlockingKind, SignallingModel, SignallingParameters};
    use crate::error::ConflictError;
    use zugfolge_infra::{Length, OperatingPointId};

    #[test]
    fn aeltere_stellwerke_brauchen_laenger() {
        // Das ist der Grund, warum M3.1 die netzweite Konstante des Spikes
        // ablöst: Die Fahrstraßenbildezeit ist eine Eigenschaft des Stellwerks.
        let bauarten = [
            InterlockingKind::Mechanical,
            InterlockingKind::ElectroMechanical,
            InterlockingKind::Relay,
            InterlockingKind::Electronic,
            InterlockingKind::Digital,
        ];
        for paar in bauarten.windows(2) {
            let [aelter, neuer] = paar else { continue };
            assert!(
                aelter.route_setting_time_s() > neuer.route_setting_time_s(),
                "{aelter} gegen {neuer}"
            );
            assert!(
                aelter.route_release_time_s() > neuer.route_release_time_s(),
                "{aelter} gegen {neuer}"
            );
        }
    }

    #[test]
    fn der_spike_wert_bleibt_der_vorgabewert() {
        // 12 s Bilde-, 6 s Auflöse-, 5 s Signalsichtzeit, 1000 m
        // Vorsignalabstand, 200 m Durchrutschweg — die Werte, mit denen M0.3
        // gerechnet hat. Sie sind jetzt der Vorgabewert eines elektronischen
        // Stellwerks, nicht mehr eine netzweite Konstante.
        let vorgabe = SignallingParameters::electronic_main_line();
        assert_eq!(vorgabe.route_setting_time_s(), 12);
        assert_eq!(vorgabe.route_release_time_s(), 6);
        assert_eq!(vorgabe.signal_sighting_time_s(), 5);
        assert_eq!(vorgabe.approach_distance(), Length::from_metres(1_000));
        assert_eq!(vorgabe.overlap_length(), Length::from_metres(200));
    }

    #[test]
    fn eine_betriebsstelle_darf_abweichen() {
        let alt = SignallingParameters::new(
            InterlockingKind::Mechanical,
            8,
            Length::from_metres(700),
            Length::from_metres(50),
        )
        .expect("gültige Parameter");
        let modell = SignallingModel::default().with_point(OperatingPointId::new(4), alt);

        assert_eq!(modell.exception_count(), 1);
        assert_eq!(modell.at(OperatingPointId::new(4)), alt);
        assert_eq!(
            modell.at(OperatingPointId::new(1)),
            SignallingParameters::electronic_main_line()
        );
    }

    #[test]
    fn unbrauchbare_parameter_fallen_auf() {
        assert!(matches!(
            SignallingParameters::new(
                InterlockingKind::Relay,
                -1,
                Length::from_metres(1_000),
                Length::from_metres(200)
            ),
            Err(ConflictError::NegativeDuration { .. })
        ));
        assert!(matches!(
            SignallingParameters::new(
                InterlockingKind::Relay,
                5,
                Length::ZERO,
                Length::from_metres(200)
            ),
            Err(ConflictError::NonPositiveLength {
                what: "Vorsignalabstand",
                ..
            })
        ));
        assert!(matches!(
            SignallingParameters::new(
                InterlockingKind::Relay,
                5,
                Length::from_metres(1_000),
                Length::ZERO
            ),
            Err(ConflictError::NonPositiveLength {
                what: "Durchrutschweg",
                ..
            })
        ));
    }
}
