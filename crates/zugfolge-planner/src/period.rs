//! Die Fahrplanperiode als Ablauf — **M3.6**.
//!
//! `docs/infrastruktur.md` 3: „Der Ablauf ist in jeder Welt derselbe, nur
//! gestaucht." Vier Anteile, deren Länge mit der Periodenlänge skaliert (E3,
//! E18) statt mit einer Konstanten:
//!
//! | Anteil | Phase |
//! |--------|-------|
//! | erstes Viertel | Anmeldefenster — `PathRequest` für die kommende Periode |
//! | zweites Achtel | Koordinierung — `PlanningRun`, Alternativangebote, Einspruchsfenster (M3.5) |
//! | drittes Achtel | Veröffentlichung Netzfahrplan, Annahmefrist, Rahmenvertragsabgleich (M3.8) |
//! | zweite Hälfte | Betrieb; parallel Ad-hoc-Trassen aus Restkapazität (M3.7) |
//!
//! ## Warum die Grenzen in Achteln liegen
//!
//! Ein Viertel und zwei Achtel und eine Hälfte ergeben zusammen genau ein
//! Ganzes — `2/8 + 1/8 + 1/8 + 4/8 = 8/8`. Jede Grenze wird deshalb
//! unabhängig als `Periodenlänge · Zähler / 8` berechnet, in Sekunden und
//! ganzzahlig (Invariante 3): Eine Periodenlänge, die nicht durch acht teilbar
//! ist — etwa drei Wochen, 21 Tage — verteilt den Rest nicht gleichmäßig über
//! die Anteile, sondern rundet jede Grenze für sich ab. Das ist kein Fehler,
//! sondern die einzige Rundung, die nicht driftet: Jede Grenze bliebe
//! dieselbe, würde sie ein zweites Mal berechnet.

use zugfolge_conflict::SECONDS_PER_DAY;
use zugfolge_determinism::SimTime;

use crate::error::PlannerError;

/// Kürzeste zulässige Fahrplanperiode: drei Wochen (E3).
pub const MIN_LENGTH_DAYS: i64 = 21;

/// Längste zulässige Fahrplanperiode: acht Wochen — der Wert der
/// unbefristeten Welt (E3).
pub const MAX_LENGTH_DAYS: i64 = 56;

/// Der Anteil einer Fahrplanperiode, in dem sich ein Zeitpunkt befindet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PeriodPhase {
    /// Erstes Viertel: `PathRequest` für die kommende Periode.
    Registration,
    /// Zweites Achtel: deterministischer `PlanningRun`, Einspruchsfenster
    /// (M3.5).
    Coordination,
    /// Drittes Achtel: Netzfahrplan veröffentlicht, Annahmefrist,
    /// Rahmenvertragsabgleich (M3.8).
    Publication,
    /// Zweite Hälfte: Betrieb, parallel Ad-hoc-Trassen (M3.7).
    Operation,
}

impl PeriodPhase {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Registration => "registration",
            Self::Coordination => "coordination",
            Self::Publication => "publication",
            Self::Operation => "operation",
        }
    }

    /// Deutsche Bezeichnung.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Registration => "Anmeldefenster",
            Self::Coordination => "Koordinierung",
            Self::Publication => "Veröffentlichung",
            Self::Operation => "Betrieb",
        }
    }

    /// Ob in dieser Phase ein neuer `PathRequest` angemeldet werden darf.
    pub const fn allows_registration(self) -> bool {
        matches!(self, Self::Registration)
    }

    /// Ob in dieser Phase ein `PlanningRun` koordinieren darf.
    pub const fn allows_coordination(self) -> bool {
        matches!(self, Self::Coordination)
    }

    /// Ob in dieser Phase der Rahmenvertragsabgleich (M3.8) stattfindet.
    pub const fn allows_framework_reconciliation(self) -> bool {
        matches!(self, Self::Publication)
    }

    /// Ob in dieser Phase Ad-hoc-Trassen (M3.7) beantragt werden dürfen.
    pub const fn allows_adhoc(self) -> bool {
        matches!(self, Self::Operation)
    }
}

impl core::fmt::Display for PeriodPhase {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Eine Fahrplanperiode: Anmeldung, Koordinierung, Veröffentlichung, Betrieb.
///
/// Die Länge ist ein Weltparameter (E3, E18), keine Konstante — sie skaliert
/// mit der Weltlaufzeit. Alle Grenzen sind **halboffen**: `[start, ende)`, wie
/// jedes Zeitintervall in diesem Kern.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SchedulePeriod {
    number: u32,
    start: SimTime,
    length_days: i64,
}

impl SchedulePeriod {
    /// Eine Fahrplanperiode ab einem Startzeitpunkt.
    ///
    /// # Errors
    ///
    /// [`PlannerError::InvalidPeriodLength`], wenn die Länge außerhalb von
    /// drei bis acht Wochen liegt (E3).
    pub fn new(number: u32, start: SimTime, length_days: i64) -> Result<Self, PlannerError> {
        if !(MIN_LENGTH_DAYS..=MAX_LENGTH_DAYS).contains(&length_days) {
            return Err(PlannerError::InvalidPeriodLength(length_days));
        }
        Ok(Self {
            number,
            start,
            length_days,
        })
    }

    /// Die laufende Nummer der Periode, ab null.
    pub const fn number(self) -> u32 {
        self.number
    }

    /// Der Fahrplanstichtag: Beginn der Periode.
    pub const fn start(self) -> SimTime {
        self.start
    }

    /// Die Periodenlänge in Tagen.
    pub const fn length_days(self) -> i64 {
        self.length_days
    }

    /// Eine Periodengrenze als `Länge · Zähler / 8` Sekunden nach dem Start.
    const fn boundary(self, eighths: i64) -> SimTime {
        let offset = self
            .length_days
            .saturating_mul(SECONDS_PER_DAY)
            .saturating_mul(eighths)
            / 8;
        self.start.plus_seconds(offset)
    }

    /// Ende des Anmeldefensters, Beginn der Koordinierung.
    pub const fn registration_end(self) -> SimTime {
        self.boundary(2)
    }

    /// Ende der Koordinierung, Beginn der Veröffentlichung.
    pub const fn coordination_end(self) -> SimTime {
        self.boundary(3)
    }

    /// Ende der Veröffentlichung, Beginn des Betriebs.
    pub const fn publication_end(self) -> SimTime {
        self.boundary(4)
    }

    /// Ende der Periode — zugleich der Fahrplanstichtag der Folgeperiode.
    pub const fn end(self) -> SimTime {
        self.boundary(8)
    }

    /// Die Phase, in der ein Zeitpunkt liegt — `None`, wenn er außerhalb
    /// dieser Periode liegt.
    pub fn phase_at(self, at: SimTime) -> Option<PeriodPhase> {
        if at < self.start || at >= self.end() {
            return None;
        }
        Some(if at < self.registration_end() {
            PeriodPhase::Registration
        } else if at < self.coordination_end() {
            PeriodPhase::Coordination
        } else if at < self.publication_end() {
            PeriodPhase::Publication
        } else {
            PeriodPhase::Operation
        })
    }

    /// Die unmittelbar folgende Periode, mit derselben Länge.
    ///
    /// Ihr Start ist exakt das Ende dieser Periode — der Fahrplanstichtag
    /// (`docs/infrastruktur.md` 3), ohne Lücke und ohne Überlappung.
    pub const fn next(self) -> Self {
        Self {
            number: self.number.saturating_add(1),
            start: self.end(),
            length_days: self.length_days,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_LENGTH_DAYS, MIN_LENGTH_DAYS, PeriodPhase, SchedulePeriod};
    use crate::error::PlannerError;
    use zugfolge_conflict::SECONDS_PER_DAY;
    use zugfolge_determinism::SimTime;

    #[test]
    fn eine_zu_kurze_oder_zu_lange_periode_faellt_auf() {
        assert!(matches!(
            SchedulePeriod::new(0, SimTime::EPOCH, MIN_LENGTH_DAYS - 1),
            Err(PlannerError::InvalidPeriodLength(_))
        ));
        assert!(matches!(
            SchedulePeriod::new(0, SimTime::EPOCH, MAX_LENGTH_DAYS + 1),
            Err(PlannerError::InvalidPeriodLength(_))
        ));
        assert!(SchedulePeriod::new(0, SimTime::EPOCH, MIN_LENGTH_DAYS).is_ok());
        assert!(SchedulePeriod::new(0, SimTime::EPOCH, MAX_LENGTH_DAYS).is_ok());
    }

    #[test]
    fn die_anteile_der_achtwochenperiode_treffen_die_tabelle() {
        // docs/infrastruktur.md 3: erstes Viertel, zweites Achtel, drittes
        // Achtel, zweite Hälfte — am Beispiel der Achtwochenperiode.
        let periode = SchedulePeriod::new(0, SimTime::EPOCH, 56).expect("gültige Periode");
        let tage = |zeitpunkt: SimTime| {
            (zeitpunkt.seconds() - periode.start().seconds()) / SECONDS_PER_DAY
        };

        assert_eq!(
            tage(periode.registration_end()),
            14,
            "erstes Viertel von 56"
        );
        assert_eq!(tage(periode.coordination_end()), 21, "ein weiteres Achtel");
        assert_eq!(tage(periode.publication_end()), 28, "ein weiteres Achtel");
        assert_eq!(tage(periode.end()), 56, "zweite Hälfte bis zum Ende");
    }

    #[test]
    fn die_phasen_folgen_lueckenlos_und_halboffen() {
        let periode = SchedulePeriod::new(0, SimTime::EPOCH, 56).expect("gültige Periode");

        assert_eq!(
            periode.phase_at(periode.start()),
            Some(PeriodPhase::Registration)
        );
        assert_eq!(
            periode.phase_at(periode.registration_end()),
            Some(PeriodPhase::Coordination),
            "die Grenze selbst gehört schon zur nächsten Phase"
        );
        assert_eq!(
            periode.phase_at(periode.coordination_end()),
            Some(PeriodPhase::Publication)
        );
        assert_eq!(
            periode.phase_at(periode.publication_end()),
            Some(PeriodPhase::Operation)
        );
        assert_eq!(
            periode.phase_at(periode.end().plus_seconds(-1)),
            Some(PeriodPhase::Operation)
        );
    }

    #[test]
    fn ein_zeitpunkt_ausserhalb_der_periode_hat_keine_phase() {
        let periode =
            SchedulePeriod::new(0, SimTime::from_seconds(1_000), 21).expect("gültige Periode");
        assert_eq!(periode.phase_at(SimTime::from_seconds(999)), None);
        assert_eq!(periode.phase_at(periode.end()), None);
    }

    #[test]
    fn die_folgeperiode_schliesst_luckenlos_an() {
        let erste = SchedulePeriod::new(0, SimTime::EPOCH, 35).expect("gültige Periode");
        let zweite = erste.next();
        assert_eq!(zweite.number(), 1);
        assert_eq!(zweite.start(), erste.end());
        assert_eq!(zweite.length_days(), erste.length_days());
    }

    #[test]
    fn jede_phase_erlaubt_genau_ihre_eigene_handlung() {
        for phase in [
            PeriodPhase::Registration,
            PeriodPhase::Coordination,
            PeriodPhase::Publication,
            PeriodPhase::Operation,
        ] {
            let erlaubnisse = [
                phase.allows_registration(),
                phase.allows_coordination(),
                phase.allows_framework_reconciliation(),
                phase.allows_adhoc(),
            ];
            assert_eq!(
                erlaubnisse.iter().filter(|erlaubt| **erlaubt).count(),
                1,
                "{phase} erlaubt nicht genau eine Handlung"
            );
        }
    }
}
