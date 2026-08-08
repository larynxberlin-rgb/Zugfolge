//! Der Trassenantrag und seine zulässigen Abweichungen — **M3.4**.
//!
//! `docs/infrastruktur.md` 2.1: „Ein `PathRequest` enthält Zugcharakteristik,
//! Verkehrstage, Halte, Wunschzeiten und zulässige Abweichungen."
//!
//! ## Warum die Abweichungen zum Antrag gehören
//!
//! Ein Antrag ohne Abweichungstoleranz kennt genau zwei Antworten: ja oder
//! nein. Genau das will die Trassenvergabe nicht — sie soll eine **Alternative
//! anbieten**, und zwar eine, die der Antragsteller vorher als brauchbar
//! erklärt hat. Deshalb sagt der Antrag selbst, wie weit er sich verschieben
//! lässt, wie viel Fahrzeitverlängerung er verträgt und wie viele
//! Betriebshalte zumutbar sind. Was außerhalb dieser Grenzen läge, ist keine
//! Alternative, sondern eine andere Trasse.
//!
//! ## Zugcharakteristik statt Fahrzeugliste
//!
//! Der Antrag nennt Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart
//! und Zugsicherung (M1.9) — keine Fahrzeuge. So arbeiten reale
//! Fahrplanrechner, und es entkoppelt die Trassenplanung vom Fahrzeugkatalog
//! (M5).

use core::fmt;

use zugfolge_conflict::{OperatingDays, TrainNumber};
use zugfolge_determinism::SimTime;
use zugfolge_infra::{OperatingPointId, TrainCharacteristics};

use crate::error::PlannerError;

/// Die Kennung eines Trassenantrags.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PathRequestId(u32);

impl PathRequestId {
    /// Kennung aus ihrer Nummer.
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Die Nummer.
    pub const fn value(self) -> u32 {
        self.0
    }
}

impl fmt::Display for PathRequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "TA{}", self.0)
    }
}

/// Ein beantragter Halt.
///
/// Ein Halt ist ein **Fahrgastwechsel**: Er verlangt einen Bahnsteig, der die
/// beantragte Zuglänge aufnimmt. Ein bloßes Warten ohne Bahnsteig ist kein
/// Halt, sondern ein Betriebshalt — den plant der Planner selbst, wenn er ihn
/// braucht.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestedStop {
    point: OperatingPointId,
    minimum_dwell_s: i64,
}

impl RequestedStop {
    /// Ein Halt mit einer Mindesthaltezeit.
    ///
    /// # Errors
    ///
    /// [`PlannerError::InvalidTolerance`], wenn die Haltezeit negativ ist.
    pub fn new(point: OperatingPointId, minimum_dwell_s: i64) -> Result<Self, PlannerError> {
        if minimum_dwell_s < 0 {
            return Err(PlannerError::InvalidTolerance {
                what: "Mindesthaltezeit",
                value: minimum_dwell_s,
            });
        }
        Ok(Self {
            point,
            minimum_dwell_s,
        })
    }

    /// Die Betriebsstelle.
    pub const fn point(&self) -> OperatingPointId {
        self.point
    }

    /// Die Mindesthaltezeit in Sekunden.
    pub const fn minimum_dwell_s(&self) -> i64 {
        self.minimum_dwell_s
    }
}

/// Die zulässigen Abweichungen eines Trassenantrags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathTolerances {
    earlier_s: i64,
    later_s: i64,
    step_s: i64,
    extra_running_time_s: i64,
    max_operational_stops: u32,
}

impl PathTolerances {
    /// Ein Antrag ohne jede Abweichung: die Wunschlage oder nichts.
    ///
    /// Das Raster bleibt bei einer Minute, damit die Ableitung `step_s > 0`
    /// überall gilt — es kommt bei einer Spanne von null ohnehin nicht zum
    /// Tragen.
    pub const EXACT: Self = Self {
        earlier_s: 0,
        later_s: 0,
        step_s: 60,
        extra_running_time_s: 0,
        max_operational_stops: 0,
    };

    /// Zulässige Abweichungen.
    ///
    /// `step_s` ist das Raster, in dem Zeitlagen geprüft werden — ein Fahrplan
    /// wird in Minuten veröffentlicht, nicht in Sekunden.
    ///
    /// # Errors
    ///
    /// [`PlannerError::InvalidTolerance`], wenn eine Spanne negativ oder das
    /// Raster nicht positiv ist.
    pub fn new(
        earlier_s: i64,
        later_s: i64,
        step_s: i64,
        extra_running_time_s: i64,
        max_operational_stops: u32,
    ) -> Result<Self, PlannerError> {
        for (what, value) in [
            ("zulässige frühere Lage", earlier_s),
            ("zulässige spätere Lage", later_s),
            ("zulässige Fahrzeitverlängerung", extra_running_time_s),
        ] {
            if value < 0 {
                return Err(PlannerError::InvalidTolerance { what, value });
            }
        }
        if step_s <= 0 {
            return Err(PlannerError::InvalidTolerance {
                what: "Raster der Zeitlagen",
                value: step_s,
            });
        }
        Ok(Self {
            earlier_s,
            later_s,
            step_s,
            extra_running_time_s,
            max_operational_stops,
        })
    }

    /// Wie viele Sekunden früher die Trasse liegen darf.
    pub const fn earlier_s(&self) -> i64 {
        self.earlier_s
    }

    /// Wie viele Sekunden später die Trasse liegen darf.
    pub const fn later_s(&self) -> i64 {
        self.later_s
    }

    /// Das Raster, in dem Zeitlagen geprüft werden.
    pub const fn step_s(&self) -> i64 {
        self.step_s
    }

    /// Wie viele Sekunden Fahrzeitverlängerung zumutbar sind.
    pub const fn extra_running_time_s(&self) -> i64 {
        self.extra_running_time_s
    }

    /// Wie viele zusätzliche Betriebshalte zumutbar sind.
    ///
    /// Der Planner aus M3.4 legt je Kandidat höchstens **einen** Betriebshalt
    /// ein; ein Wert über eins wirkt derzeit wie eins. Mehrere Kreuzungen auf
    /// einem Laufweg sind ein Fall für die Koordinierung aus M3.5, weil sie
    /// nicht mehr unabhängig voneinander zu wählen sind. Null verbietet den
    /// Betriebshalt.
    pub const fn max_operational_stops(&self) -> u32 {
        self.max_operational_stops
    }

    /// Ob eine Verschiebung der Zeitlage zulässig ist.
    pub const fn allows_shift(&self, shift_s: i64) -> bool {
        shift_s >= -self.earlier_s && shift_s <= self.later_s
    }

    /// Die zu prüfenden Verschiebungen, nach Betrag geordnet.
    ///
    /// Bei gleichem Betrag steht die **frühere** Lage vorn: Sie lässt dem Zug
    /// am Zielort mehr Puffer und ist damit die betrieblich robustere Wahl.
    /// Die Reihenfolge ist Teil der Bewertung und deshalb festgelegt, nicht
    /// beliebig.
    pub fn shifts(&self) -> Vec<i64> {
        let mut werte = vec![0_i64];
        let mut betrag = self.step_s;
        while betrag <= self.earlier_s.max(self.later_s) {
            if betrag <= self.earlier_s {
                werte.push(-betrag);
            }
            if betrag <= self.later_s {
                werte.push(betrag);
            }
            betrag = betrag.saturating_add(self.step_s);
        }
        werte
    }
}

/// Ein Trassenantrag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathRequest {
    id: PathRequestId,
    number: TrainNumber,
    train: TrainCharacteristics,
    origin: OperatingPointId,
    destination: OperatingPointId,
    stops: Vec<RequestedStop>,
    desired_departure: SimTime,
    operating_days: OperatingDays,
    tolerances: PathTolerances,
}

impl PathRequest {
    /// Ein Trassenantrag.
    ///
    /// # Errors
    ///
    /// - [`PlannerError::TrivialRequest`], wenn Anfang und Ziel dieselbe
    ///   Betriebsstelle sind.
    /// - [`PlannerError::DuplicateStop`], wenn eine Betriebsstelle zweimal als
    ///   Halt genannt ist.
    #[expect(
        clippy::too_many_arguments,
        reason = "M3.4: docs/infrastruktur.md 2.1 zählt genau diese Angaben eines \
                  Trassenantrags auf, und jede hat einen eigenen Typ — ein Erbauer \
                  verschöbe nur die Stelle, an der sie zusammenkommen müssen"
    )]
    pub fn new(
        id: PathRequestId,
        number: TrainNumber,
        train: TrainCharacteristics,
        origin: OperatingPointId,
        destination: OperatingPointId,
        stops: Vec<RequestedStop>,
        desired_departure: SimTime,
        operating_days: OperatingDays,
        tolerances: PathTolerances,
    ) -> Result<Self, PlannerError> {
        if origin == destination {
            return Err(PlannerError::TrivialRequest(origin));
        }
        for (index, halt) in stops.iter().enumerate() {
            if stops
                .iter()
                .skip(index.saturating_add(1))
                .any(|andere| andere.point() == halt.point())
            {
                return Err(PlannerError::DuplicateStop(halt.point()));
            }
        }
        Ok(Self {
            id,
            number,
            train,
            origin,
            destination,
            stops,
            desired_departure,
            operating_days,
            tolerances,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> PathRequestId {
        self.id
    }

    /// Die beantragte Zugnummer.
    pub const fn number(&self) -> TrainNumber {
        self.number
    }

    /// Die Zugcharakteristik.
    pub const fn train(&self) -> &TrainCharacteristics {
        &self.train
    }

    /// Anfangsbetriebsstelle.
    pub const fn origin(&self) -> OperatingPointId {
        self.origin
    }

    /// Zielbetriebsstelle.
    pub const fn destination(&self) -> OperatingPointId {
        self.destination
    }

    /// Die beantragten Halte.
    pub fn stops(&self) -> &[RequestedStop] {
        &self.stops
    }

    /// Der beantragte Halt an einer Betriebsstelle, sofern es einen gibt.
    pub fn stop_at(&self, point: OperatingPointId) -> Option<&RequestedStop> {
        self.stops.iter().find(|halt| halt.point() == point)
    }

    /// Die Wunschabfahrtszeit.
    pub const fn desired_departure(&self) -> SimTime {
        self.desired_departure
    }

    /// Die Verkehrstage.
    pub const fn operating_days(&self) -> OperatingDays {
        self.operating_days
    }

    /// Die zulässigen Abweichungen.
    pub const fn tolerances(&self) -> PathTolerances {
        self.tolerances
    }
}

impl fmt::Display for PathRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({} {} → {})",
            self.id, self.number, self.origin, self.destination
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{PathRequest, PathRequestId, PathTolerances, RequestedStop};
    use crate::error::PlannerError;
    use zugfolge_conflict::example::regional_train;
    use zugfolge_conflict::{OperatingDays, TrainCategory, TrainNumber};
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::OperatingPointId;

    #[test]
    fn die_verschiebungen_stehen_nach_betrag_und_fruehe() {
        let toleranz = PathTolerances::new(600, 300, 300, 0, 0).expect("gültige Toleranz");
        assert_eq!(toleranz.shifts(), vec![0, -300, 300, -600]);
    }

    #[test]
    fn ein_antrag_ohne_abweichung_kennt_nur_die_wunschlage() {
        assert_eq!(PathTolerances::EXACT.shifts(), vec![0]);
        assert!(PathTolerances::EXACT.allows_shift(0));
        assert!(!PathTolerances::EXACT.allows_shift(1));
    }

    #[test]
    fn unbrauchbare_toleranzen_fallen_auf() {
        assert!(matches!(
            PathTolerances::new(-1, 0, 60, 0, 0),
            Err(PlannerError::InvalidTolerance { .. })
        ));
        assert!(matches!(
            PathTolerances::new(0, 0, 0, 0, 0),
            Err(PlannerError::InvalidTolerance {
                what: "Raster der Zeitlagen",
                ..
            })
        ));
        assert!(matches!(
            RequestedStop::new(OperatingPointId::new(1), -1),
            Err(PlannerError::InvalidTolerance { .. })
        ));
    }

    #[test]
    fn ein_antrag_von_a_nach_a_faellt_auf() {
        let ergebnis = PathRequest::new(
            PathRequestId::new(1),
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            regional_train(),
            OperatingPointId::new(1),
            OperatingPointId::new(1),
            Vec::new(),
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::EXACT,
        );
        assert!(matches!(ergebnis, Err(PlannerError::TrivialRequest(_))));
    }

    #[test]
    fn ein_doppelt_genannter_halt_faellt_auf() {
        let halt = RequestedStop::new(OperatingPointId::new(2), 30).expect("gültiger Halt");
        let ergebnis = PathRequest::new(
            PathRequestId::new(1),
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            regional_train(),
            OperatingPointId::new(1),
            OperatingPointId::new(4),
            vec![halt, halt],
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::EXACT,
        );
        assert!(matches!(ergebnis, Err(PlannerError::DuplicateStop(_))));
    }
}
