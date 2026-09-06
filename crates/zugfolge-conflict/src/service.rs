//! Wiederkehrender Verkehr — **M3.2**.
//!
//! `docs/infrastruktur.md` 5: „Wiederkehrender Verkehr wird als
//! `ServicePattern` plus relativem `OccupationProfile` gespeichert." Ein
//! Verkehrsangebot ist damit **eine** Zeile — Zugnummer, Zugcharakteristik,
//! Laufweg, Abfahrtszeit, Verkehrstage — und nicht eine Zeile je Tag. Die
//! einzelne [`TrainRun`] entsteht daraus durch Materialisierung; sie ist die
//! Fahrt eines Verkehrstags, mit ihrer Sperrzeitentreppe.
//!
//! ## Die Zugnummernsystematik
//!
//! Eine Zugnummer ist keine laufende Nummer, sondern eine Aussage: Sie nennt
//! die Zuggattung und die Richtung. Beides braucht der Betrieb, und beides
//! steht deshalb im Typ statt in einer Namenskonvention.
//!
//! | Zuggattung | Nummernbereich | Kürzel |
//! |------------|----------------|--------|
//! | Fernverkehr | 1–9 999 | FV |
//! | S-Bahn | 10 000–19 999 | S |
//! | Regionalverkehr | 20 000–39 999 | RV |
//! | Güterverkehr | 40 000–79 999 | GZ |
//! | Dienstzug, Zusatzfahrt | 80 000–99 999 | DZ |
//!
//! **Gerade Nummern fahren mit der Kilometrierung, ungerade gegen sie.** Das
//! ist im deutschen Netz so üblich und hier eine geprüfte Zusicherung: Wer eine
//! Zugnummer sieht, weiß, in welche Richtung der Zug fährt. Die Kürzel sind
//! generische Betriebsbegriffe, keine Produktmarken (E6).
//!
//! ## Die Weltepoche ist ein Montag
//!
//! Verkehrstage sind Wochentage, und Wochentage brauchen einen Nullpunkt. Die
//! Weltepoche (`SimTime::EPOCH`) ist **Montag, 00:00 Uhr**. Das ist eine
//! Festlegung, keine Ableitung — sie steht hier, damit sie nicht an drei
//! Stellen verschieden getroffen wird.

use core::fmt;

use zugfolge_determinism::{SimTime, StateHasher};
use zugfolge_infra::{TrainCharacteristicsId, TravelDirection};

use crate::blocking::BlockingTimeStaircase;
use crate::error::ConflictError;
use crate::itinerary::Itinerary;
use crate::profile::OccupationProfile;

/// Sekunden eines Tages.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Die Zuggattung.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TrainCategory {
    /// Fernverkehr.
    LongDistance,
    /// S-Bahn.
    Suburban,
    /// Regionalverkehr — das erste vollständig spielbare Geschäftsfeld (E1).
    Regional,
    /// Güterverkehr.
    Freight,
    /// Dienstzug oder Zusatzfahrt (`docs/betrieb.md` 4).
    Supplementary,
}

impl TrainCategory {
    /// Alle Zuggattungen in fester Reihenfolge.
    pub const ALL: [Self; 5] = [
        Self::LongDistance,
        Self::Suburban,
        Self::Regional,
        Self::Freight,
        Self::Supplementary,
    ];

    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::LongDistance => "long-distance",
            Self::Suburban => "suburban",
            Self::Regional => "regional",
            Self::Freight => "freight",
            Self::Supplementary => "supplementary",
        }
    }

    /// Das Kürzel, das vor der Zugnummer steht.
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::LongDistance => "FV",
            Self::Suburban => "S",
            Self::Regional => "RV",
            Self::Freight => "GZ",
            Self::Supplementary => "DZ",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::LongDistance => "Fernverkehr",
            Self::Suburban => "S-Bahn",
            Self::Regional => "Regionalverkehr",
            Self::Freight => "Güterverkehr",
            Self::Supplementary => "Dienstzug",
        }
    }

    /// Der Nummernbereich dieser Zuggattung, beide Grenzen eingeschlossen.
    pub const fn range(self) -> (u32, u32) {
        match self {
            Self::LongDistance => (1, 9_999),
            Self::Suburban => (10_000, 19_999),
            Self::Regional => (20_000, 39_999),
            Self::Freight => (40_000, 79_999),
            Self::Supplementary => (80_000, 99_999),
        }
    }

    /// Die Zuggattung, in deren Bereich eine Nummer fällt.
    pub fn of_number(number: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|category| {
            let (von, bis) = category.range();
            (von..=bis).contains(&number)
        })
    }
}

impl fmt::Display for TrainCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Eine Zugnummer nach der Zugnummernsystematik.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrainNumber(u32);

impl TrainNumber {
    /// Prüft eine Nummer gegen den Bereich ihrer Zuggattung.
    ///
    /// # Errors
    ///
    /// [`ConflictError::TrainNumberOutOfRange`], wenn die Nummer außerhalb des
    /// Bereichs der Zuggattung liegt.
    pub fn new(category: TrainCategory, number: u32) -> Result<Self, ConflictError> {
        let (von, bis) = category.range();
        if !(von..=bis).contains(&number) {
            return Err(ConflictError::TrainNumberOutOfRange {
                category: category.tag(),
                number,
            });
        }
        Ok(Self(number))
    }

    /// Die nackte Nummer.
    pub const fn value(self) -> u32 {
        self.0
    }

    /// Die Zuggattung, in deren Bereich die Nummer liegt.
    ///
    /// # Panics
    ///
    /// Nie — eine geprüfte Zugnummer liegt in genau einem Bereich.
    pub fn category(self) -> TrainCategory {
        TrainCategory::of_number(self.0).expect("geprüfte Zugnummer")
    }

    /// Die Richtung, die die Nummer ansagt: gerade mit, ungerade gegen die
    /// Kilometrierung.
    pub const fn nominal_direction(self) -> TravelDirection {
        if self.0 % 2 == 0 {
            TravelDirection::WithChainage
        } else {
            TravelDirection::AgainstChainage
        }
    }
}

impl fmt::Display for TrainNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.category().prefix(), self.0)
    }
}

/// Ein Wochentag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Weekday {
    /// Montag.
    Monday,
    /// Dienstag.
    Tuesday,
    /// Mittwoch.
    Wednesday,
    /// Donnerstag.
    Thursday,
    /// Freitag.
    Friday,
    /// Samstag.
    Saturday,
    /// Sonntag.
    Sunday,
}

impl Weekday {
    /// Alle Wochentage, beginnend mit Montag.
    pub const ALL: [Self; 7] = [
        Self::Monday,
        Self::Tuesday,
        Self::Wednesday,
        Self::Thursday,
        Self::Friday,
        Self::Saturday,
        Self::Sunday,
    ];

    /// Der Wochentag zu einem Tagesindex ab der Weltepoche.
    pub const fn of_day(day: i64) -> Self {
        match day.rem_euclid(7) {
            0 => Self::Monday,
            1 => Self::Tuesday,
            2 => Self::Wednesday,
            3 => Self::Thursday,
            4 => Self::Friday,
            5 => Self::Saturday,
            _ => Self::Sunday,
        }
    }

    /// Der Wochentag zu einem Zeitpunkt.
    pub const fn of(at: SimTime) -> Self {
        Self::of_day(at.seconds().div_euclid(SECONDS_PER_DAY))
    }

    /// Deutsche Bezeichnung.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Monday => "Montag",
            Self::Tuesday => "Dienstag",
            Self::Wednesday => "Mittwoch",
            Self::Thursday => "Donnerstag",
            Self::Friday => "Freitag",
            Self::Saturday => "Samstag",
            Self::Sunday => "Sonntag",
        }
    }

    /// Die Stelle im Bitmuster der Verkehrstage.
    const fn bit(self) -> u8 {
        match self {
            Self::Monday => 1,
            Self::Tuesday => 2,
            Self::Wednesday => 4,
            Self::Thursday => 8,
            Self::Friday => 16,
            Self::Saturday => 32,
            Self::Sunday => 64,
        }
    }
}

impl fmt::Display for Weekday {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Die Tage, an denen ein Verkehrsangebot tatsächlich fährt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OperatingDays(u8);

impl OperatingDays {
    /// Täglich.
    pub const DAILY: Self = Self(0b0111_1111);

    /// Montag bis Freitag.
    pub const WORKDAYS: Self = Self(0b0001_1111);

    /// Samstag und Sonntag.
    pub const WEEKEND: Self = Self(0b0110_0000);

    /// Verkehrstage aus einer Aufzählung von Wochentagen.
    ///
    /// # Errors
    ///
    /// [`ConflictError::NoOperatingDays`], wenn kein einziger Tag genannt ist —
    /// ein Angebot ohne Verkehrstag fährt nie und wäre eine stille Attrappe.
    pub fn from_days(days: impl IntoIterator<Item = Weekday>) -> Result<Self, ConflictError> {
        let muster = days
            .into_iter()
            .fold(0_u8, |muster, tag| muster | tag.bit());
        if muster == 0 {
            return Err(ConflictError::NoOperatingDays);
        }
        Ok(Self(muster))
    }

    /// Ob an diesem Wochentag gefahren wird.
    pub const fn contains(self, day: Weekday) -> bool {
        self.0 & day.bit() != 0
    }

    /// Ob am Tag mit diesem Index ab der Weltepoche gefahren wird.
    pub const fn contains_day(self, day: i64) -> bool {
        self.contains(Weekday::of_day(day))
    }

    /// Wie viele Tage der Woche befahren werden.
    pub const fn count(self) -> u32 {
        self.0.count_ones()
    }

    /// Die Verkehrstage, von Montag an.
    pub fn days(self) -> impl Iterator<Item = Weekday> {
        Weekday::ALL
            .into_iter()
            .filter(move |tag| self.contains(*tag))
    }
}

impl fmt::Display for OperatingDays {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if *self == Self::DAILY {
            return formatter.write_str("täglich");
        }
        let namen: Vec<&str> = self.days().map(Weekday::label).collect();
        formatter.write_str(&namen.join(", "))
    }
}

/// Absolutes, halboffenes Abfahrtsfenster seit Weltepoche.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServiceWindow {
    valid_from: SimTime,
    valid_until: SimTime,
}

impl ServiceWindow {
    /// Validiert eine nichtnegative, nichtleere Abfahrtsgültigkeit.
    ///
    /// # Errors
    /// Ein leeres, negatives oder rückläufiges Fenster ist ungültig.
    pub fn new(valid_from: SimTime, valid_until: SimTime) -> Result<Self, ConflictError> {
        if valid_from.seconds() < 0 || valid_until <= valid_from {
            return Err(ConflictError::NegativeDuration {
                what: "absolutes Abfahrtsfenster",
                seconds: valid_until.seconds().saturating_sub(valid_from.seconds()),
            });
        }
        Ok(Self {
            valid_from,
            valid_until,
        })
    }

    /// Erste zulässige Weltsekunde einschließlich.
    pub const fn valid_from(self) -> SimTime {
        self.valid_from
    }
    /// Erste nicht mehr zulässige Weltsekunde.
    pub const fn valid_until(self) -> SimTime {
        self.valid_until
    }
    /// Prüft die absolute Abfahrt ohne Tagesmodulo.
    pub const fn contains(self, departure: SimTime) -> bool {
        departure.seconds() >= self.valid_from.seconds()
            && departure.seconds() < self.valid_until.seconds()
    }
}

/// Ein wiederkehrendes Verkehrsangebot.
///
/// Es trägt sein Belegungsprofil **relativ** — die Sperrzeiten sind an jedem
/// Verkehrstag dieselben, nur um die Zeitlage verschoben.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServicePattern {
    number: TrainNumber,
    train: TrainCharacteristicsId,
    itinerary: Itinerary,
    profile: OccupationProfile,
    departure_time_s: i64,
    operating_days: OperatingDays,
    service_window: Option<ServiceWindow>,
}

impl ServicePattern {
    /// Ein Verkehrsangebot.
    ///
    /// `departure_time_s` ist die Abfahrtszeit als Sekunde des Tages,
    /// 0 bis 86 399.
    ///
    /// # Errors
    ///
    /// [`ConflictError::NegativeDuration`], wenn die Abfahrtszeit außerhalb des
    /// Tages liegt.
    pub fn new(
        number: TrainNumber,
        train: TrainCharacteristicsId,
        itinerary: Itinerary,
        profile: OccupationProfile,
        departure_time_s: i64,
        operating_days: OperatingDays,
    ) -> Result<Self, ConflictError> {
        if !(0..SECONDS_PER_DAY).contains(&departure_time_s) {
            return Err(ConflictError::NegativeDuration {
                what: "Abfahrtszeit als Sekunde des Tages",
                seconds: departure_time_s,
            });
        }
        Ok(Self {
            number,
            train,
            itinerary,
            profile,
            departure_time_s,
            operating_days,
            service_window: None,
        })
    }

    /// Begrenzt die Wiederholung auf das autorisierte absolute Abfahrtsfenster.
    pub const fn with_service_window(mut self, window: ServiceWindow) -> Self {
        self.service_window = Some(window);
        self
    }

    /// Absolute Abfahrtsgültigkeit; Altangebote ohne Fenster bleiben unverändert.
    pub const fn service_window(&self) -> Option<ServiceWindow> {
        self.service_window
    }

    /// Die Zugnummer.
    pub const fn number(&self) -> TrainNumber {
        self.number
    }

    /// Die Zugcharakteristik, mit der gerechnet wurde.
    pub const fn train(&self) -> TrainCharacteristicsId {
        self.train
    }

    /// Der Laufweg.
    pub const fn itinerary(&self) -> &Itinerary {
        &self.itinerary
    }

    /// Das relative Belegungsprofil.
    pub const fn profile(&self) -> &OccupationProfile {
        &self.profile
    }

    /// Die Abfahrtszeit als Sekunde des Tages.
    pub const fn departure_time_s(&self) -> i64 {
        self.departure_time_s
    }

    /// Die Verkehrstage.
    pub const fn operating_days(&self) -> OperatingDays {
        self.operating_days
    }

    /// Ob am Tag mit diesem Index ab der Weltepoche gefahren wird.
    pub const fn runs_on(&self, day: i64) -> bool {
        self.operating_days.contains_day(day)
            && match self.service_window {
                None => true,
                Some(window) => window.contains(self.departure_on(day)),
            }
    }

    /// Die Abfahrt am Tag mit diesem Index — auch wenn dort nicht gefahren
    /// wird.
    pub const fn departure_on(&self, day: i64) -> SimTime {
        SimTime::from_seconds(
            day.saturating_mul(SECONDS_PER_DAY)
                .saturating_add(self.departure_time_s),
        )
    }

    /// Die Fahrt eines Verkehrstags — `None`, wenn an diesem Tag nicht
    /// gefahren wird.
    pub fn materialise(&self, day: i64) -> Option<TrainRun> {
        if !self.runs_on(day) {
            return None;
        }
        let departure = self.departure_on(day);
        Some(TrainRun {
            number: self.number,
            departure,
            staircase: self.profile.at(departure),
        })
    }

    /// Alle Fahrten, deren Belegung in das Fenster `[from, to)` hineinreicht.
    ///
    /// Das ist die Materialisierung, die der Planner (M3.4) und später der
    /// Simulationskern (M4.2) brauchen: Nicht die ganze Fahrplanperiode wird zu
    /// Zugfahrten, sondern das Fenster, um das es gerade geht.
    pub fn runs_between(&self, from: SimTime, to: SimTime) -> Vec<TrainRun> {
        if from.seconds() >= to.seconds() {
            return Vec::new();
        }
        // Eine Fahrt reicht ins Fenster, wenn ihre Belegung es schneidet. Der
        // Rand ergibt sich aus dem Profil selbst, nicht aus einer geratenen
        // Reserve.
        let erster_tag = (from.seconds().saturating_sub(self.departure_time_s))
            .saturating_sub(self.profile.last_second_s())
            .div_euclid(SECONDS_PER_DAY);
        let letzter_tag = (to.seconds().saturating_sub(self.departure_time_s))
            .saturating_sub(self.profile.first_second_s())
            .div_euclid(SECONDS_PER_DAY);

        let mut fahrten = Vec::new();
        for tag in erster_tag..=letzter_tag {
            let Some(fahrt) = self.materialise(tag) else {
                continue;
            };
            if fahrt.staircase.last_second().seconds() > from.seconds()
                && fahrt.staircase.first_second().seconds() < to.seconds()
            {
                fahrten.push(fahrt);
            }
        }
        fahrten
    }

    /// Schreibt das Verkehrsangebot in den Zustands-Hash.
    pub(crate) fn write_canonical(&self, hasher: &mut StateHasher) {
        hasher.uint("number", u64::from(self.number.value()));
        hasher.uint("train", u64::from(self.train.value()));
        hasher.int("departure_time_s", self.departure_time_s);
        hasher.uint("operating_days", u64::from(self.operating_days.0));
        if let Some(window) = self.service_window {
            hasher.int("valid_from_s", window.valid_from().seconds());
            hasher.int("valid_until_s", window.valid_until().seconds());
        }
        self.profile.write_canonical(hasher);
    }
}

/// Die einzelne, materialisierte Fahrt eines Zuges an einem Verkehrstag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrainRun {
    number: TrainNumber,
    departure: SimTime,
    staircase: BlockingTimeStaircase,
}

impl TrainRun {
    /// Stellt bereits bestätigte absolute Ressourcenintervalle wieder her.
    /// Die Intervalle müssen aus dem autoritativen, weltgebundenen Zustand stammen.
    pub fn from_blocking_times(
        number: TrainNumber,
        departure: SimTime,
        steps: Vec<crate::blocking::BlockingTime>,
    ) -> Self {
        Self {
            number,
            departure,
            staircase: BlockingTimeStaircase::new(departure, steps),
        }
    }
    /// Eine Fahrt aus Nummer, Abfahrt und Profil.
    pub fn new(number: TrainNumber, departure: SimTime, profile: &OccupationProfile) -> Self {
        Self {
            number,
            departure,
            staircase: profile.at(departure),
        }
    }

    /// Die Zugnummer.
    pub const fn number(&self) -> TrainNumber {
        self.number
    }

    /// Die Abfahrtszeit.
    pub const fn departure(&self) -> SimTime {
        self.departure
    }

    /// Die Sperrzeitentreppe dieser Fahrt.
    pub const fn staircase(&self) -> &BlockingTimeStaircase {
        &self.staircase
    }

    /// Die Kennung dieser Fahrt im Belegungsbuch.
    pub const fn reference(&self) -> RunReference {
        RunReference {
            number: self.number,
            departure: self.departure,
        }
    }

    /// Dieselbe Fahrt, um `seconds` verschoben.
    pub fn shifted(&self, seconds: i64) -> Self {
        Self {
            number: self.number,
            departure: self.departure.plus_seconds(seconds),
            staircase: self.staircase.shifted(seconds),
        }
    }
}

/// Die Kennung einer Zugfahrt: Zugnummer und Abfahrtstag.
///
/// Zwei Fahrten desselben Verkehrsangebots an verschiedenen Tagen tragen
/// dieselbe Nummer — erst die Abfahrt macht sie eindeutig.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RunReference {
    number: TrainNumber,
    departure: SimTime,
}

impl RunReference {
    /// Die Zugnummer.
    pub const fn number(&self) -> TrainNumber {
        self.number
    }

    /// Die Abfahrtszeit.
    pub const fn departure(&self) -> SimTime {
        self.departure
    }
}

impl fmt::Display for RunReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({})",
            self.number,
            Weekday::of(self.departure)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OperatingDays, SECONDS_PER_DAY, ServicePattern, TrainCategory, TrainNumber, Weekday,
    };
    use crate::error::ConflictError;
    use crate::example::{nordstadt_bis_talheim, reference_infrastructure, regional_train};
    use crate::profile::derive_occupation_profile;
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::{TrainCharacteristicsId, TravelDirection};

    fn angebot(nummer: u32, abfahrt_s: i64, tage: OperatingDays) -> ServicePattern {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");
        ServicePattern::new(
            TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Nummer"),
            TrainCharacteristicsId::new(1),
            laufweg,
            profil,
            abfahrt_s,
            tage,
        )
        .expect("gültiges Verkehrsangebot")
    }

    #[test]
    fn absolutes_abfahrtsfenster_verhindert_unbeabsichtigte_tageswiederholung() {
        let departure = 7 * SECONDS_PER_DAY + 28_800;
        let window = super::ServiceWindow::new(
            SimTime::from_seconds(departure),
            SimTime::from_seconds(departure + 1),
        )
        .unwrap();
        let pattern = angebot(26802, 28_800, OperatingDays::DAILY).with_service_window(window);
        assert!(pattern.materialise(6).is_none());
        assert_eq!(
            pattern.materialise(7).unwrap().departure().seconds(),
            departure
        );
        assert!(pattern.materialise(8).is_none());
        assert_eq!(
            pattern
                .runs_between(
                    SimTime::from_seconds(0),
                    SimTime::from_seconds(14 * SECONDS_PER_DAY)
                )
                .len(),
            1
        );
        assert!(!window.contains(SimTime::from_seconds(departure + 1)));
    }

    #[test]
    fn leere_und_negative_abfahrtsfenster_sind_ungueltig() {
        assert!(
            super::ServiceWindow::new(SimTime::from_seconds(0), SimTime::from_seconds(0)).is_err()
        );
        assert!(
            super::ServiceWindow::new(SimTime::from_seconds(-1), SimTime::from_seconds(1)).is_err()
        );
    }

    #[test]
    fn eine_zugnummer_nennt_gattung_und_richtung() {
        let hin = TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer");
        let zurueck = TrainNumber::new(TrainCategory::Regional, 26_801).expect("gültige Nummer");

        assert_eq!(hin.category(), TrainCategory::Regional);
        assert_eq!(hin.nominal_direction(), TravelDirection::WithChainage);
        assert_eq!(
            zurueck.nominal_direction(),
            TravelDirection::AgainstChainage
        );
        assert_eq!(hin.to_string(), "RV 26802");
    }

    #[test]
    fn die_nummernbereiche_ueberschneiden_sich_nicht() {
        for erste in TrainCategory::ALL {
            for zweite in TrainCategory::ALL {
                if erste == zweite {
                    continue;
                }
                let (a0, a1) = erste.range();
                let (b0, b1) = zweite.range();
                assert!(
                    a1 < b0 || b1 < a0,
                    "{erste} und {zweite} überschneiden sich"
                );
            }
        }
        assert_eq!(
            TrainCategory::of_number(26_802),
            Some(TrainCategory::Regional)
        );
        assert_eq!(TrainCategory::of_number(0), None);
    }

    #[test]
    fn eine_nummer_ausserhalb_ihres_bereichs_faellt_auf() {
        assert!(matches!(
            TrainNumber::new(TrainCategory::Regional, 42),
            Err(ConflictError::TrainNumberOutOfRange { .. })
        ));
    }

    #[test]
    fn die_weltepoche_ist_ein_montag() {
        assert_eq!(Weekday::of(SimTime::EPOCH), Weekday::Monday);
        assert_eq!(Weekday::of_day(5), Weekday::Saturday);
        // Auch vor der Epoche bleibt die Woche eine Woche.
        assert_eq!(Weekday::of_day(-1), Weekday::Sunday);
    }

    #[test]
    fn verkehrstage_sind_eine_menge_von_wochentagen() {
        assert_eq!(OperatingDays::DAILY.count(), 7);
        assert_eq!(OperatingDays::WORKDAYS.count(), 5);
        assert!(OperatingDays::WORKDAYS.contains(Weekday::Friday));
        assert!(!OperatingDays::WORKDAYS.contains(Weekday::Saturday));
        assert!(OperatingDays::WEEKEND.contains(Weekday::Sunday));
        assert_eq!(OperatingDays::DAILY.to_string(), "täglich");
        assert_eq!(OperatingDays::WEEKEND.to_string(), "Samstag, Sonntag");
    }

    #[test]
    fn ein_angebot_ohne_verkehrstag_faellt_auf() {
        assert_eq!(
            OperatingDays::from_days([]),
            Err(ConflictError::NoOperatingDays)
        );
    }

    #[test]
    fn ein_angebot_materialisiert_nur_an_seinen_verkehrstagen() {
        let angebot = angebot(26_802, 28_800, OperatingDays::WORKDAYS);
        // Tag 0 ist Montag, Tag 5 ist Samstag.
        assert!(angebot.materialise(0).is_some());
        assert!(angebot.materialise(5).is_none());

        let montag = angebot.materialise(0).expect("Montag ist Verkehrstag");
        assert_eq!(montag.departure(), SimTime::from_seconds(28_800));
        let dienstag = angebot.materialise(1).expect("Dienstag ist Verkehrstag");
        assert_eq!(
            dienstag.departure().seconds() - montag.departure().seconds(),
            SECONDS_PER_DAY
        );
    }

    #[test]
    fn zwei_verkehrstage_haben_dieselbe_treppe_um_einen_tag_versetzt() {
        // Das ist der Kern von M3.2: einmal rechnen, oft verschieben.
        let angebot = angebot(26_802, 28_800, OperatingDays::DAILY);
        let montag = angebot.materialise(0).expect("Verkehrstag");
        let dienstag = angebot.materialise(1).expect("Verkehrstag");
        assert_eq!(
            montag.staircase().steps().len(),
            dienstag.staircase().steps().len()
        );
        for (a, b) in montag
            .staircase()
            .steps()
            .iter()
            .zip(dienstag.staircase().steps())
        {
            assert_eq!(a.resource(), b.resource());
            assert_eq!(
                b.start().seconds() - a.start().seconds(),
                SECONDS_PER_DAY,
                "die Treppe ist nicht bloß verschoben"
            );
        }
    }

    #[test]
    fn das_materialisierungsfenster_nimmt_die_ueberhaengende_fahrt_mit() {
        // Eine Fahrt, die vor dem Fenster abfährt, aber in es hineinragt, muss
        // dabei sein — sonst prüft der Planner gegen eine Lücke.
        let angebot = angebot(26_802, 28_800, OperatingDays::DAILY);
        let profil_ende = angebot.profile().last_second_s();
        assert!(profil_ende > 60, "das Profil ist zu kurz für diesen Test");

        let fenster_beginn = SimTime::from_seconds(28_800 + profil_ende - 60);
        let fahrten = angebot.runs_between(fenster_beginn, fenster_beginn.plus_seconds(3_600));
        assert!(
            fahrten
                .iter()
                .any(|fahrt| fahrt.departure() == SimTime::from_seconds(28_800)),
            "die überhängende Fahrt fehlt"
        );
    }

    #[test]
    fn ein_leeres_fenster_liefert_keine_fahrt() {
        let angebot = angebot(26_802, 28_800, OperatingDays::DAILY);
        assert!(
            angebot
                .runs_between(SimTime::from_seconds(100), SimTime::from_seconds(100))
                .is_empty()
        );
    }
}
