//! Trassenkandidaten und ihre Bewertung — die zweite Hälfte von **M3.4**.
//!
//! ## Kein einzelner Optimierungswert (E11)
//!
//! Die naheliegende Lösung wäre eine Zielfunktion: Abweichung mal Gewicht plus
//! Fahrzeitverlängerung mal Gewicht, kleinster Wert gewinnt. E11 verbietet das,
//! und aus gutem Grund — ein solcher Wert behauptet eine Umrechnung zwischen
//! Minuten Verspätung und Minuten Fahrzeit, die es betrieblich nicht gibt, und
//! er verbirgt sie hinter einer Zahl.
//!
//! Stattdessen gilt eine **veröffentlichte Rangfolge**: Die Kriterien werden
//! der Reihe nach verglichen, und erst bei Gleichstand entscheidet das nächste.
//!
//! | Rang | Kriterium | Warum es vorn steht |
//! |------|-----------|---------------------|
//! | 1 | Betrag der Zeitlagenabweichung | Die Zeitlage ist das, was beantragt wurde |
//! | 2 | Fahrzeitverlängerung | Sie kostet Umlauf, Personal und Anschluss |
//! | 3 | Zahl der Betriebshalte | Jeder ist ein zusätzlicher Betriebsvorgang |
//! | 4 | Umweg | Zugkilometer kosten Trassen- und Energieentgelt |
//! | 5 | frühere vor späterer Lage | Puffer am Zielort |
//! | 6 | Gleisfolge des Laufwegs | Damit die Rangfolge vollständig bestimmt ist |
//!
//! Und: Der Planner liefert **alle** zulässigen Kandidaten, nicht nur den
//! ersten. Wer die Rangfolge anders sieht, sieht die Alternativen daneben —
//! genau das kann eine Zielfunktion nicht.

use core::cmp::Ordering;
use core::fmt;

use zugfolge_conflict::{Itinerary, OccupationProfile, ServicePattern};
use zugfolge_determinism::SimTime;
use zugfolge_infra::{Length, OperatingPointId, TrackId};

/// Wie weit ein Kandidat vom Antrag abweicht.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateDeviation {
    shift_s: i64,
    extra_running_time_s: i64,
    operational_stops: Vec<OperatingPointId>,
    detour: Length,
}

impl CandidateDeviation {
    /// Eine Abweichung aus ihren vier Anteilen.
    pub(crate) const fn new(
        shift_s: i64,
        extra_running_time_s: i64,
        operational_stops: Vec<OperatingPointId>,
        detour: Length,
    ) -> Self {
        Self {
            shift_s,
            extra_running_time_s,
            operational_stops,
            detour,
        }
    }

    /// Die Verschiebung der Zeitlage gegenüber der Wunschzeit, in Sekunden.
    /// Negativ heißt früher.
    pub const fn shift_s(&self) -> i64 {
        self.shift_s
    }

    /// Die Fahrzeitverlängerung gegenüber dem schnellsten Laufweg, in
    /// Sekunden.
    pub const fn extra_running_time_s(&self) -> i64 {
        self.extra_running_time_s
    }

    /// Die Betriebsstellen, an denen der Planner einen Betriebshalt eingelegt
    /// hat.
    pub fn operational_stops(&self) -> &[OperatingPointId] {
        &self.operational_stops
    }

    /// Der Umweg gegenüber dem kürzesten Laufweg.
    pub const fn detour(&self) -> Length {
        self.detour
    }

    /// Ob der Kandidat den Antrag unverändert erfüllt.
    pub fn is_exact(&self) -> bool {
        self.shift_s == 0
            && self.extra_running_time_s == 0
            && self.operational_stops.is_empty()
            && !self.detour.is_positive()
    }

    /// Die Rangfolge aus der Tabelle im Modulkopf, ohne den letzten Rang — der
    /// hängt am Laufweg und steht deshalb in
    /// [`PathCandidate::ranking_key`].
    fn ranking(&self) -> (i64, i64, usize, i64, i64) {
        (
            self.shift_s.saturating_abs(),
            self.extra_running_time_s,
            self.operational_stops.len(),
            self.detour.millimetres(),
            self.shift_s,
        )
    }
}

impl fmt::Display for CandidateDeviation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_exact() {
            return formatter.write_str("keine Abweichung");
        }
        let mut teile: Vec<String> = Vec::new();
        match self.shift_s.cmp(&0) {
            Ordering::Less => teile.push(format!("{} s früher", -self.shift_s)),
            Ordering::Greater => teile.push(format!("{} s später", self.shift_s)),
            Ordering::Equal => {}
        }
        if self.extra_running_time_s > 0 {
            teile.push(format!("{} s längere Fahrzeit", self.extra_running_time_s));
        }
        if !self.operational_stops.is_empty() {
            let namen: Vec<String> = self
                .operational_stops
                .iter()
                .map(ToString::to_string)
                .collect();
            teile.push(format!("Betriebshalt in {}", namen.join(", ")));
        }
        if self.detour.is_positive() {
            teile.push(format!("{} Umweg", self.detour));
        }
        formatter.write_str(&teile.join(", "))
    }
}

/// Ein geprüfter Trassenkandidat: ein Verkehrsangebot samt seiner Abweichung
/// vom Antrag.
///
/// Er ist **konfliktfrei** gegen das Belegungsbuch, gegen das er geprüft
/// wurde — an jedem Verkehrstag des Prüfhorizonts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathCandidate {
    pattern: ServicePattern,
    deviation: CandidateDeviation,
    first_departure: SimTime,
}

impl PathCandidate {
    /// Ein Kandidat aus Verkehrsangebot und Abweichung.
    pub(crate) const fn new(
        pattern: ServicePattern,
        deviation: CandidateDeviation,
        first_departure: SimTime,
    ) -> Self {
        Self {
            pattern,
            deviation,
            first_departure,
        }
    }

    /// Das Verkehrsangebot — genau die Form, die ein Netzfahrplan aufnimmt.
    pub const fn pattern(&self) -> &ServicePattern {
        &self.pattern
    }

    /// Der Laufweg.
    pub const fn itinerary(&self) -> &Itinerary {
        self.pattern.itinerary()
    }

    /// Das relative Belegungsprofil.
    pub const fn profile(&self) -> &OccupationProfile {
        self.pattern.profile()
    }

    /// Die Abweichung vom Antrag.
    pub const fn deviation(&self) -> &CandidateDeviation {
        &self.deviation
    }

    /// Die erste Abfahrt im Prüfhorizont.
    pub const fn first_departure(&self) -> SimTime {
        self.first_departure
    }

    /// Die Gleisfolge des Laufwegs — der letzte Rang der Bewertung.
    fn tracks(&self) -> Vec<TrackId> {
        self.itinerary()
            .legs()
            .iter()
            .map(zugfolge_conflict::CheckedLeg::track)
            .collect()
    }

    /// Der vollständige Schlüssel der Rangfolge.
    pub(crate) fn ranking_key(&self) -> ((i64, i64, usize, i64, i64), Vec<TrackId>) {
        (self.deviation.ranking(), self.tracks())
    }

    /// Der Kandidat als deutscher Satz.
    pub fn explain(&self) -> String {
        format!(
            "{nummer} ab {abfahrt} s über {laufweg} ({gleise} Abschnitte, {laenge}): {abweichung}.",
            nummer = self.pattern.number(),
            abfahrt = self.pattern.departure_time_s(),
            laufweg = self.itinerary(),
            gleise = self.itinerary().legs().len(),
            laenge = self.itinerary().length(),
            abweichung = self.deviation,
        )
    }
}

/// Ordnet Kandidaten nach der veröffentlichten Rangfolge.
pub(crate) fn rank(candidates: &mut [PathCandidate]) {
    candidates.sort_by_key(PathCandidate::ranking_key);
}

#[cfg(test)]
mod tests {
    use super::CandidateDeviation;
    use zugfolge_infra::{Length, OperatingPointId};

    fn abweichung(shift_s: i64, extra_s: i64, halte: &[u32], umweg_m: i64) -> CandidateDeviation {
        CandidateDeviation::new(
            shift_s,
            extra_s,
            halte.iter().map(|id| OperatingPointId::new(*id)).collect(),
            Length::from_metres(umweg_m),
        )
    }

    #[test]
    fn die_zeitlage_wiegt_schwerer_als_die_fahrzeit() {
        // Die Rangfolge ist der Ersatz für die verbotene Zielfunktion (E11):
        // Erst bei Gleichstand entscheidet das nächste Kriterium.
        let nah = abweichung(0, 600, &[3], 0);
        let fern = abweichung(300, 0, &[], 0);
        assert!(nah.ranking() < fern.ranking());
    }

    #[test]
    fn bei_gleichem_betrag_gewinnt_die_fruehere_lage() {
        assert!(abweichung(-300, 0, &[], 0).ranking() < abweichung(300, 0, &[], 0).ranking());
    }

    #[test]
    fn ein_betriebshalt_wiegt_schwerer_als_ein_umweg() {
        assert!(
            abweichung(0, 0, &[], 5_000).ranking() < abweichung(0, 0, &[3], 0).ranking(),
            "der Umweg darf nicht schwerer wiegen als der Betriebshalt"
        );
    }

    #[test]
    fn nur_die_wunschlage_ist_abweichungsfrei() {
        assert!(abweichung(0, 0, &[], 0).is_exact());
        assert!(!abweichung(60, 0, &[], 0).is_exact());
        assert!(!abweichung(0, 1, &[], 0).is_exact());
        assert!(!abweichung(0, 0, &[3], 0).is_exact());
        assert!(!abweichung(0, 0, &[], 1).is_exact());
    }

    #[test]
    fn die_abweichung_erklaert_sich_auf_deutsch() {
        assert_eq!(abweichung(0, 0, &[], 0).to_string(), "keine Abweichung");
        let satz = abweichung(-300, 120, &[3], 0).to_string();
        assert!(satz.contains("300 s früher"), "{satz}");
        assert!(satz.contains("120 s längere Fahrzeit"), "{satz}");
        assert!(satz.contains("Betriebshalt in Bst3"), "{satz}");
    }
}
