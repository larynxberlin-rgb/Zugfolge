//! Referenzkorpus und Abweichungsreport — **M1.13**.
//!
//! Der Beweis von M1 verlangt einen reproduzierbaren `InfraRelease`-Kandidaten
//! des Pilotkorridors, dessen berechnete Fahrzeiten innerhalb definierter
//! Toleranz zur technischen Referenz liegen (`docs/milestones.md`). Die davon
//! getrennte produktive Release-Qualifizierung und echte Signatur gehören zur
//! nachgelagerten M9-Betriebsreife. `CLAUDE.md` nennt als Arbeitsprinzip:
//! **Golden-Master-Tests gegen reale Fahrplanausschnitte der
//! Pilotregion mit definierter Toleranz.** M1.13 liefert das Verfahren dazu:
//! Ein [`ReferenceCorpus`] hält Referenzläufe — je ein Fahrweg mit seiner
//! **realen** Fahrzeit —, und ein [`DeviationReport`] stellt jeder Referenz die
//! aus dem Release (M1.10) **berechnete** Fahrzeit gegenüber und prüft sie
//! gegen eine [`Tolerance`].
//!
//! ## Freigegebener Offline-Import, keine Laufzeitabhängigkeit
//!
//! Reale Sollfahrzeiten werden offline aus der unter CC BY 4.0 freigegebenen
//! GTFS.DE-Regionalverkehrsfeed erfasst (`gtfs-de-rv`). Capture-Manifest,
//! Attribution, Feed-URL und ZIP-/Tabellen-Hashes machen den Import reproduzierbar; die
//! Zuordnung zu [`TrainCharacteristics`] ist explizite, geprüfte Konfiguration.
//! Der Trassenfinder bleibt eine Entwicklungsreferenz und wird nicht importiert.
//! Kein externer Dienst liegt im Laufzeitpfad des Spiels (E10).
//!
//! ## Warum eine Toleranz
//!
//! `docs/daten.md` 3 ist unmissverständlich: **keine Präzisionswahrheit.** Die
//! Fahrdynamik (M1.10) ist eine vereinfachte Rechnung ohne Halte-, Räum- und
//! Fahrstraßenbildezeiten; die Referenz enthält betriebliche Zuschläge, die das
//! Modell bewusst nicht kennt. Verglichen wird deshalb gegen eine **definierte
//! Toleranz** — ein Größenordnungsabgleich, kein Sekundenvergleich.

use core::fmt;

use crate::dynamics::{RunPath, RunningTime, derive_running_time_table};
use crate::error::InfraError;
use crate::train::TrainCharacteristics;
use crate::units::Speed;

/// Die zulässige Abweichung zwischen berechneter und referenzierter Fahrzeit.
///
/// Sie hat zwei Anteile, und der **größere** von beiden gilt: ein relativer
/// Anteil in Promille der Referenz und ein absoluter Sockel in Sekunden. Der
/// Sockel verhindert, dass ein kurzer Lauf an einem einzelnen aufgerundeten
/// Segment scheitert (`RunningTime` rundet auf, `dynamics.rs`); der relative
/// Anteil trägt die längeren Läufe. Beide Werte sind ganzzahlig (Invariante 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tolerance {
    seconds: i64,
    per_mille: i64,
}

impl Tolerance {
    /// Eine Toleranz aus absolutem Sockel **und** relativem Anteil; es gilt der
    /// größere der beiden.
    pub const fn of(seconds: i64, per_mille: i64) -> Self {
        Self { seconds, per_mille }
    }

    /// Eine rein absolute Toleranz in Sekunden.
    pub const fn seconds(seconds: i64) -> Self {
        Self {
            seconds,
            per_mille: 0,
        }
    }

    /// Eine rein relative Toleranz in Promille der Referenzfahrzeit.
    pub const fn per_mille(per_mille: i64) -> Self {
        Self {
            seconds: 0,
            per_mille,
        }
    }

    /// Die zugelassene absolute Abweichung für eine gegebene Referenzfahrzeit,
    /// in Sekunden — der größere der beiden Anteile, nie negativ.
    pub fn allowance(self, reference: RunningTime) -> i64 {
        let relative = reference
            .seconds()
            .saturating_mul(self.per_mille)
            .saturating_div(1_000);
        self.seconds.max(relative).max(0)
    }

    /// Ob eine berechnete Fahrzeit innerhalb der Toleranz zur Referenz liegt.
    pub fn permits(self, reference: RunningTime, computed: RunningTime) -> bool {
        let delta = computed.seconds().saturating_sub(reference.seconds());
        // `allowance` ist nie negativ, der Vergleich als u64 ist damit sicher.
        delta.unsigned_abs() <= self.allowance(reference).unsigned_abs()
    }
}

impl fmt::Display for Tolerance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "±{} s oder ±{} ‰, der größere",
            self.seconds, self.per_mille
        )
    }
}

/// Ein einzelner Referenzlauf: ein Fahrweg mit seiner realen Fahrzeit.
///
/// Der Fahrweg ist ein bereits aus dem Release aufgelöster [`RunPath`] (M1.10),
/// die Zugcharakteristik eine [`TrainCharacteristics`] (M1.9). `reference` ist
/// die **reale** Fahrzeit, gegen die verglichen wird — der Wert, den ein
/// Fahrplanausschnitt oder der Trassenfinder liefert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceRun {
    label: String,
    path: RunPath,
    train: TrainCharacteristics,
    entry_speed: Speed,
    reference: RunningTime,
    tolerance: Tolerance,
}

impl ReferenceRun {
    /// Ein Referenzlauf.
    ///
    /// # Errors
    ///
    /// [`InfraError::UnnamedReferenceRun`], wenn der Name leer ist — ein Lauf
    /// ohne Namen wäre im Report nicht zuzuordnen.
    pub fn new(
        label: impl Into<String>,
        path: RunPath,
        train: TrainCharacteristics,
        entry_speed: Speed,
        reference: RunningTime,
        tolerance: Tolerance,
    ) -> Result<Self, InfraError> {
        let label = label.into();
        if label.trim().is_empty() {
            return Err(InfraError::UnnamedReferenceRun);
        }
        Ok(Self {
            label,
            path,
            train,
            entry_speed,
            reference,
            tolerance,
        })
    }

    /// Der Name des Laufs, etwa `Nordstadt → Sandberg`.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Der Fahrweg.
    pub const fn path(&self) -> &RunPath {
        &self.path
    }

    /// Die Zugcharakteristik.
    pub const fn train(&self) -> &TrainCharacteristics {
        &self.train
    }

    /// Die Einstiegsgeschwindigkeit.
    pub const fn entry_speed(&self) -> Speed {
        self.entry_speed
    }

    /// Die reale Referenzfahrzeit.
    pub const fn reference(&self) -> RunningTime {
        self.reference
    }

    /// Die zulässige Toleranz.
    pub const fn tolerance(&self) -> Tolerance {
        self.tolerance
    }

    /// Die aus dem Release berechnete Fahrzeit über den Fahrweg (M1.10).
    ///
    /// # Errors
    ///
    /// Wie [`derive_running_time_table`] — etwa
    /// [`InfraError::InsufficientTraction`] bei einer zu steilen Steigung.
    pub fn computed(&self) -> Result<RunningTime, InfraError> {
        Ok(derive_running_time_table(&self.path, &self.train, self.entry_speed)?.total())
    }
}

/// Das Ergebnis eines einzelnen Referenzlaufs im Abweichungsreport.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunDeviation {
    label: String,
    reference: RunningTime,
    computed: RunningTime,
    allowance: i64,
    within_tolerance: bool,
}

impl RunDeviation {
    /// Der Name des Laufs.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Die reale Referenzfahrzeit.
    pub const fn reference(&self) -> RunningTime {
        self.reference
    }

    /// Die berechnete Fahrzeit.
    pub const fn computed(&self) -> RunningTime {
        self.computed
    }

    /// Die zugelassene Abweichung in Sekunden für diesen Lauf.
    pub const fn allowance(&self) -> i64 {
        self.allowance
    }

    /// Die tatsächliche Abweichung in Sekunden, mit Vorzeichen: positiv, wenn
    /// das Modell **langsamer** rechnet als die Referenz.
    pub const fn deviation_seconds(&self) -> i64 {
        self.computed
            .seconds()
            .saturating_sub(self.reference.seconds())
    }

    /// Ob dieser Lauf innerhalb der Toleranz liegt.
    pub const fn within_tolerance(&self) -> bool {
        self.within_tolerance
    }
}

impl fmt::Display for RunDeviation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let marke = if self.within_tolerance {
            "ok"
        } else {
            "ABWEICHUNG"
        };
        write!(
            formatter,
            "{}: berechnet {}, Referenz {} ({:+} s, zulässig ±{} s) — {marke}",
            self.label,
            self.computed,
            self.reference,
            self.deviation_seconds(),
            self.allowance,
        )
    }
}

/// Ein Korpus von Referenzläufen für eine Region.
///
/// Der Korpus gehört zu genau einem [`InfraRelease`](crate::InfraRelease): Seine
/// Fahrwege sind aus dessen Netz aufgelöst. Die Reihenfolge der Läufe ist die
/// Einfügereihenfolge und bleibt so im Report erhalten.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReferenceCorpus {
    region: String,
    runs: Vec<ReferenceRun>,
}

impl ReferenceCorpus {
    /// Ein leerer Korpus für eine Region.
    pub fn new(region: impl Into<String>) -> Self {
        Self {
            region: region.into(),
            runs: Vec::new(),
        }
    }

    /// Nimmt einen Referenzlauf auf.
    #[must_use]
    pub fn run(mut self, run: ReferenceRun) -> Self {
        self.runs.push(run);
        self
    }

    /// Die Region des Korpus.
    pub fn region(&self) -> &str {
        &self.region
    }

    /// Die Läufe in Einfügereihenfolge.
    pub fn runs(&self) -> &[ReferenceRun] {
        &self.runs
    }

    /// Anzahl der Läufe.
    pub fn len(&self) -> usize {
        self.runs.len()
    }

    /// Ob der Korpus keinen einzigen Lauf enthält.
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }
}

/// Der Abweichungsreport: berechnete gegen referenzierte Fahrzeit, je Lauf
/// geprüft gegen die Toleranz.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviationReport {
    deviations: Vec<RunDeviation>,
}

impl DeviationReport {
    /// Misst jeden Lauf eines Korpus und stellt Referenz und Rechnung
    /// gegenüber.
    ///
    /// # Errors
    ///
    /// Der erste Fehler aus [`ReferenceRun::computed`] — ein Fahrweg, den die
    /// Zugcharakteristik gar nicht befahren dürfte, bekommt keine Fahrzeit und
    /// damit keine Abweichung.
    pub fn measure(corpus: &ReferenceCorpus) -> Result<Self, InfraError> {
        let mut deviations = Vec::with_capacity(corpus.runs().len());
        for run in corpus.runs() {
            let computed = run.computed()?;
            let tolerance = run.tolerance();
            deviations.push(RunDeviation {
                label: run.label().to_owned(),
                reference: run.reference(),
                computed,
                allowance: tolerance.allowance(run.reference()),
                within_tolerance: tolerance.permits(run.reference(), computed),
            });
        }
        Ok(Self { deviations })
    }

    /// Die Einzelergebnisse in Reihenfolge des Korpus.
    pub fn deviations(&self) -> &[RunDeviation] {
        &self.deviations
    }

    /// Ob jeder Lauf innerhalb seiner Toleranz liegt — die Bedingung des
    /// M1-Beweises.
    pub fn all_within_tolerance(&self) -> bool {
        self.deviations.iter().all(RunDeviation::within_tolerance)
    }

    /// Die Läufe, die ihre Toleranz verletzen, in Reihenfolge.
    pub fn breaches(&self) -> impl Iterator<Item = &RunDeviation> {
        self.deviations
            .iter()
            .filter(|deviation| !deviation.within_tolerance())
    }

    /// Anzahl der Läufe im Report.
    pub fn len(&self) -> usize {
        self.deviations.len()
    }

    /// Ob der Report keinen einzigen Lauf enthält.
    pub fn is_empty(&self) -> bool {
        self.deviations.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::{DeviationReport, ReferenceCorpus, ReferenceRun, Tolerance};
    use crate::dynamics::{RunPath, RunningTime};
    use crate::edge::TravelDirection;
    use crate::error::InfraError;
    use crate::example::reference_network;
    use crate::identity::{TrackId, TrainCharacteristicsId};
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::speed::SpeedCategory;
    use crate::train::{TractionType, TrainCharacteristics};
    use crate::units::{Acceleration, Length, Mass, Speed};

    /// Ein Dieselregionaltriebwagen mit PZB — passt zum eingleisigen Ast.
    fn regionaltriebwagen() -> TrainCharacteristics {
        TrainCharacteristics::new(
            TrainCharacteristicsId::new(1),
            "Referenztriebwagen",
            Mass::from_tonnes(120),
            Length::from_metres(80),
            Speed::from_km_h(120),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(700),
            Acceleration::from_millimetres_per_second_squared(800),
            TractionType::Diesel,
            TrainProtection::from_systems([ProtectionSystem::Pzb]),
        )
        .expect("gültige Zugcharakteristik")
    }

    /// Der Fahrweg über den eingleisigen Ast Sandberg – Talheim (Gleis 3001).
    fn ast_fahrweg(train: &TrainCharacteristics) -> RunPath {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        let mut fahrweg = RunPath::new();
        fahrweg
            .push_track_range(
                train,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect("Diesel mit PZB passt zum Ast");
        fahrweg
    }

    #[test]
    fn die_toleranz_nimmt_den_groesseren_anteil() {
        // 300 s Referenz: 5 % sind 15 s, der Sockel 30 s — es gilt der Sockel.
        let toleranz = Tolerance::of(30, 50);
        assert_eq!(toleranz.allowance(RunningTime::from_seconds(300)), 30);
        // 1000 s Referenz: 5 % sind 50 s, größer als der Sockel.
        assert_eq!(toleranz.allowance(RunningTime::from_seconds(1_000)), 50);

        assert!(toleranz.permits(
            RunningTime::from_seconds(300),
            RunningTime::from_seconds(325)
        ));
        assert!(!toleranz.permits(
            RunningTime::from_seconds(300),
            RunningTime::from_seconds(340)
        ));
        // Die Abweichung zählt in beide Richtungen.
        assert!(toleranz.permits(
            RunningTime::from_seconds(300),
            RunningTime::from_seconds(275)
        ));
        assert!(!toleranz.permits(
            RunningTime::from_seconds(300),
            RunningTime::from_seconds(260)
        ));
    }

    #[test]
    fn ein_lauf_ohne_namen_faellt_auf() {
        let zug = regionaltriebwagen();
        let fehler = ReferenceRun::new(
            "   ",
            ast_fahrweg(&zug),
            zug.clone(),
            Speed::ZERO,
            RunningTime::from_seconds(300),
            Tolerance::per_mille(50),
        )
        .expect_err("ein Referenzlauf ohne Namen ist nicht zuzuordnen");
        assert!(matches!(fehler, InfraError::UnnamedReferenceRun));
    }

    #[test]
    fn ein_treffer_in_der_toleranz_gilt_als_bestanden() {
        let zug = regionaltriebwagen();
        let fahrweg = ast_fahrweg(&zug);
        // Die berechnete Fahrzeit als eigene Referenz — mit einer weiten
        // Toleranz liegt sie zwangsläufig darin.
        let berechnet = ReferenceRun::new(
            "Sandberg → Talheim",
            fahrweg.clone(),
            zug.clone(),
            Speed::ZERO,
            RunningTime::from_seconds(1),
            Tolerance::seconds(0),
        )
        .expect("gültig")
        .computed()
        .expect("gültige Fahrzeit");

        let korpus = ReferenceCorpus::new("Beispielnetz").run(
            ReferenceRun::new(
                "Sandberg → Talheim",
                fahrweg,
                zug,
                Speed::ZERO,
                berechnet,
                Tolerance::of(10, 30),
            )
            .expect("gültig"),
        );

        let report = DeviationReport::measure(&korpus).expect("gültiger Report");
        assert_eq!(report.len(), 1);
        assert!(report.all_within_tolerance());
        assert_eq!(report.breaches().count(), 0);

        let lauf = &report.deviations()[0];
        assert_eq!(lauf.deviation_seconds(), 0);
        assert!(lauf.within_tolerance());
        assert_eq!(lauf.computed(), berechnet);
    }

    #[test]
    fn eine_abweichung_ausserhalb_der_toleranz_wird_gemeldet() {
        let zug = regionaltriebwagen();
        let fahrweg = ast_fahrweg(&zug);
        let berechnet = ReferenceRun::new(
            "Sandberg → Talheim",
            fahrweg.clone(),
            zug.clone(),
            Speed::ZERO,
            RunningTime::from_seconds(1),
            Tolerance::seconds(0),
        )
        .expect("gültig")
        .computed()
        .expect("gültige Fahrzeit");

        // Eine Referenz weit unter der Rechnung, mit enger Toleranz: der Report
        // muss das melden.
        let unrealistisch = RunningTime::from_seconds(berechnet.seconds() / 2);
        let korpus = ReferenceCorpus::new("Beispielnetz").run(
            ReferenceRun::new(
                "Sandberg → Talheim",
                fahrweg,
                zug,
                Speed::ZERO,
                unrealistisch,
                Tolerance::seconds(5),
            )
            .expect("gültig"),
        );

        let report = DeviationReport::measure(&korpus).expect("gültiger Report");
        assert!(!report.all_within_tolerance());
        assert_eq!(report.breaches().count(), 1);
        assert!(report.deviations()[0].deviation_seconds() > 0);
    }

    #[test]
    fn ein_leerer_korpus_ist_ein_leerer_report() {
        let korpus = ReferenceCorpus::new("Beispielnetz");
        assert!(korpus.is_empty());
        let report = DeviationReport::measure(&korpus).expect("gültiger Report");
        assert!(report.is_empty());
        // Ein leerer Report verletzt keine Toleranz.
        assert!(report.all_within_tolerance());
    }

    #[test]
    fn ein_fahrweg_ohne_fahrzeit_gibt_keine_abweichung() {
        // Ein Fahrweg ohne Segmente hat keine Fahrzeit (M1.10). Der Report
        // meldet den Fehler weiter, statt eine erfundene Abweichung
        // auszuweisen — die Referenz bleibt ungeprüft, nicht stillschweigend
        // bestätigt.
        let zug = regionaltriebwagen();
        let korpus = ReferenceCorpus::new("Beispielnetz").run(
            ReferenceRun::new(
                "Fahrweg ohne Segmente",
                RunPath::new(),
                zug,
                Speed::ZERO,
                RunningTime::from_seconds(300),
                Tolerance::seconds(30),
            )
            .expect("gültig"),
        );

        let fehler =
            DeviationReport::measure(&korpus).expect_err("ein leerer Fahrweg hat keine Fahrzeit");
        assert!(matches!(fehler, InfraError::EmptyRunPath));
    }

    #[test]
    fn der_report_bleibt_wiederholbar() {
        let zug = regionaltriebwagen();
        let fahrweg = ast_fahrweg(&zug);
        let korpus = ReferenceCorpus::new("Beispielnetz").run(
            ReferenceRun::new(
                "Sandberg → Talheim",
                fahrweg,
                zug,
                Speed::ZERO,
                RunningTime::from_seconds(400),
                Tolerance::of(30, 100),
            )
            .expect("gültig"),
        );

        let erster = DeviationReport::measure(&korpus).expect("gültig");
        let zweiter = DeviationReport::measure(&korpus).expect("gültig");
        assert_eq!(erster, zweiter);
    }
}
