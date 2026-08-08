//! Der Konfliktprüfer mit erklärbarem Ergebnis — **M3.3**.
//!
//! > **Harte Invariante 1:** Keine zwei Züge dürfen zur gleichen Zeit
//! > inkompatible Belegungen derselben Konfliktressource besitzen.
//!
//! Die Regel ist **eine**: Zwei Sperrzeiten, die dieselbe Konfliktressource
//! oder zwei einander ausschließende Ressourcen betreffen, dürfen sich zeitlich
//! nicht überschneiden. Dass daraus betrieblich sehr verschiedene Fälle werden
//! — Zugfolge, Gegenfahrt, Fahrstraßenausschluss —, ist eine Eigenschaft des
//! Netzes, keine zweite Regel.
//!
//! ## Erklärbar heißt: ohne zweite Abfrage
//!
//! `docs/infrastruktur.md` 2.7 verlangt eine **maschinenlesbare und
//! verständliche** Begründung. Beides fällt bei der Prüfung ohnehin an:
//! Ressource, Fenster, Gegenzug und Konfliktart. [`OccupationConflict`] hält
//! genau diese vier Angaben, [`OccupationConflict::explain`] setzt daraus einen
//! deutschen Satz zusammen. Es braucht dafür keinen zweiten Mechanismus, nur
//! eine Ausgabeform — der Befund des Spikes aus M0.3.
//!
//! ## Die Mindestzugfolgezeit ist ein Ergebnis
//!
//! Sie steht nirgends als Parameter. [`minimum_headway`] rechnet sie aus zwei
//! Sperrzeitentreppen aus: der kleinste Abstand, bei dem sich keine zwei
//! Sperrzeiten mehr überschneiden. Genau an der Grenze des halboffenen
//! Intervalls liegt sie.
//!
//! ## Was der Prüfer nicht ist
//!
//! Er sagt, **dass** und **warum** etwas nicht geht, und er nennt die kleinste
//! Verspätung, die den Konflikt auflöst
//! ([`OccupationLedger::earliest_conflict_free_shift`]). Betrieblich ist das oft
//! die falsche Antwort: Bei einer Gegenfahrt auf eingleisiger Strecke lautet
//! sie meist „früher fahren und in einer Betriebsstelle kreuzen". Diese Wahl
//! trifft der Trassen-Planner aus M3.4 — er ist keine Erweiterung des Prüfers,
//! sondern ein eigenes Verfahren.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use zugfolge_determinism::SimTime;
use zugfolge_infra::TravelDirection;

use crate::blocking::{BlockingTime, BlockingTimeStaircase};
use crate::resource::{ConflictResource, ResourceExclusions};
use crate::service::{RunReference, TrainRun};

/// Wie viele Runden die Suche nach einer auflösenden Verschiebung höchstens
/// dreht.
///
/// Jede Runde vergrößert die Verschiebung echt, die Zahl der Belegungen ist
/// endlich — die Schranke ist deshalb ein Schutz gegen fehlerhafte Eingaben,
/// keine Näherung.
const MAX_SHIFT_ROUNDS: usize = 64;

/// Die betriebliche Art eines Belegungskonflikts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConflictKind {
    /// Zugfolgefall: zwei Fahrten derselben Richtung folgen zu dicht.
    Headway,
    /// Gegenfahrt: zwei Fahrten entgegengesetzter Richtung auf demselben
    /// Abschnitt.
    OpposingMove,
    /// Fahrstraßenausschluss: zwei Fahrstraßen desselben Bahnhofskopfs, die
    /// sich ein Fahrwegelement oder eine Weiche teilen.
    RouteExclusion,
    /// Zwei Fahrten beanspruchen dieselbe Anlage.
    FacilityContention,
}

impl ConflictKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Headway => "headway",
            Self::OpposingMove => "opposing-move",
            Self::RouteExclusion => "route-exclusion",
            Self::FacilityContention => "facility-contention",
        }
    }

    /// Deutsche Bezeichnung für Bericht und Bildfahrplan.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Headway => "Zugfolge",
            Self::OpposingMove => "Gegenfahrt",
            Self::RouteExclusion => "Fahrstraßenausschluss",
            Self::FacilityContention => "Anlagenbelegung",
        }
    }

    /// Warum dieser Fall ein Konflikt ist.
    pub const fn explanation(self) -> &'static str {
        match self {
            Self::Headway => {
                "Der folgende Zug erreicht den Abschnitt, bevor die Sperrzeit des \
                 vorausfahrenden abgelaufen ist. Die Mindestzugfolgezeit ist unterschritten."
            }
            Self::OpposingMove => {
                "Beide Züge beanspruchen denselben Abschnitt in entgegengesetzter Richtung. \
                 Eine Kreuzung ist nur in einer Betriebsstelle möglich."
            }
            Self::RouteExclusion => {
                "Die beiden Fahrstraßen teilen sich ein Fahrwegelement oder eine Weiche und \
                 können deshalb nicht gleichzeitig gestellt werden."
            }
            Self::FacilityContention => {
                "Beide Fahrten beanspruchen dieselbe Anlage zur selben Zeit."
            }
        }
    }

    /// Bestimmt die Art aus den beiden Belegungen.
    fn of(own: &BlockingTime, other: &BlockingTime) -> Self {
        if own.resource() != other.resource() {
            return Self::RouteExclusion;
        }
        match own.resource() {
            ConflictResource::Facility(_) => Self::FacilityContention,
            _ if own.direction() == other.direction() => Self::Headway,
            _ => Self::OpposingMove,
        }
    }
}

impl fmt::Display for ConflictKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Ein erkannter Belegungskonflikt — mit allem, was zur Erklärung nötig ist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccupationConflict {
    label: String,
    kind: ConflictKind,
    own: BlockingTime,
    other: BlockingTime,
    other_run: RunReference,
}

impl OccupationConflict {
    /// Laufende Kennung im Prüfbericht: `K1`, `K2`, …
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Die Art des Konflikts.
    pub const fn kind(&self) -> ConflictKind {
        self.kind
    }

    /// Die eigene Konfliktressource.
    pub const fn resource(&self) -> ConflictResource {
        self.own.resource()
    }

    /// Die Ressource des Gegenzugs — bei allem außer dem
    /// Fahrstraßenausschluss dieselbe.
    pub const fn other_resource(&self) -> ConflictResource {
        self.other.resource()
    }

    /// Die eigene Sperrzeit.
    pub const fn own(&self) -> BlockingTime {
        self.own
    }

    /// Die Sperrzeit des Gegenzugs.
    pub const fn other(&self) -> BlockingTime {
        self.other
    }

    /// Die Fahrt, mit der der Konflikt besteht.
    pub const fn other_run(&self) -> RunReference {
        self.other_run
    }

    /// Die Fahrtrichtung, in der die eigene Fahrt den Abschnitt befährt.
    pub const fn direction(&self) -> TravelDirection {
        self.own.direction()
    }

    /// Beginn der Überschneidung.
    pub const fn overlap_start(&self) -> SimTime {
        self.own.overlap_start(&self.other)
    }

    /// Ende der Überschneidung.
    pub const fn overlap_end(&self) -> SimTime {
        self.own.overlap_end(&self.other)
    }

    /// Dauer der Überschneidung in Sekunden.
    pub const fn overlap_seconds(&self) -> i64 {
        self.overlap_end()
            .seconds()
            .saturating_sub(self.overlap_start().seconds())
    }

    /// Die kleinste Verspätung der eigenen Fahrt, die **diesen** Konflikt
    /// auflöst.
    ///
    /// Ob sie danach in einen anderen läuft, sagt erst
    /// [`OccupationLedger::earliest_conflict_free_shift`].
    pub const fn resolving_shift_s(&self) -> i64 {
        self.other
            .end()
            .seconds()
            .saturating_sub(self.own.start().seconds())
    }

    /// Der Befund als deutscher Satz: welche Ressource, welches Fenster,
    /// welcher Gegenzug.
    pub fn explain(&self) -> String {
        let ressource = if self.own.resource() == self.other.resource() {
            format!("{} {}", self.own.resource().label(), self.own.resource())
        } else {
            format!(
                "{} {} gegen {}",
                self.own.resource().label(),
                self.own.resource(),
                self.other.resource()
            )
        };
        format!(
            "{label}: {kind} auf {ressource}. Eigene Sperrzeit {von}–{bis} s, {gegenzug} sperrt \
             {gegen_von}–{gegen_bis} s; Überschneidung {ueberschneidung} s ab {beginn} s. {warum}",
            label = self.label,
            kind = self.kind.label(),
            ressource = ressource,
            von = self.own.start().seconds(),
            bis = self.own.end().seconds(),
            gegenzug = self.other_run,
            gegen_von = self.other.start().seconds(),
            gegen_bis = self.other.end().seconds(),
            ueberschneidung = self.overlap_seconds(),
            beginn = self.overlap_start().seconds(),
            warum = self.kind.explanation(),
        )
    }
}

/// Das Ergebnis einer Prüfung.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConflictReport {
    conflicts: Vec<OccupationConflict>,
}

impl ConflictReport {
    /// Ob die geprüfte Fahrt konfliktfrei liegt.
    pub fn is_clear(&self) -> bool {
        self.conflicts.is_empty()
    }

    /// Die Befunde, nach Beginn der Überschneidung geordnet.
    pub fn conflicts(&self) -> &[OccupationConflict] {
        &self.conflicts
    }

    /// Wie viele Befunde es gibt.
    pub fn len(&self) -> usize {
        self.conflicts.len()
    }

    /// Ob es keinen Befund gibt — dasselbe wie [`ConflictReport::is_clear`],
    /// nur unter dem Namen, den die Sammlungen tragen.
    pub fn is_empty(&self) -> bool {
        self.conflicts.is_empty()
    }

    /// Die Arten der Befunde, ohne Wiederholung.
    pub fn kinds(&self) -> BTreeSet<ConflictKind> {
        self.conflicts
            .iter()
            .map(OccupationConflict::kind)
            .collect()
    }

    /// Der Bericht als deutscher Text, eine Zeile je Befund.
    pub fn explain(&self) -> String {
        if self.conflicts.is_empty() {
            return "Konfliktfrei.".to_owned();
        }
        self.conflicts
            .iter()
            .map(OccupationConflict::explain)
            .collect::<Vec<String>>()
            .join("\n")
    }

    /// Ordnet die Befunde und vergibt ihre Kennungen.
    fn finish(mut conflicts: Vec<OccupationConflict>) -> Self {
        conflicts.sort_by(|a, b| {
            (
                a.overlap_start().seconds(),
                a.own.resource(),
                a.other.resource(),
                a.other_run,
            )
                .cmp(&(
                    b.overlap_start().seconds(),
                    b.own.resource(),
                    b.other.resource(),
                    b.other_run,
                ))
        });
        for (nummer, befund) in conflicts.iter_mut().enumerate() {
            befund.label = format!("K{}", nummer.saturating_add(1));
        }
        Self { conflicts }
    }
}

/// Was eine Verschiebung der geprüften Fahrt bewirkt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShiftOutcome {
    /// Die Fahrt liegt bereits konfliktfrei.
    Clear,
    /// So viele Sekunden später ist die Fahrt konfliktfrei.
    Later(i64),
    /// Durch Verschieben dieser einen Fahrt nach hinten ist keine
    /// konfliktfreie Lage zu erreichen.
    Impossible,
}

/// Das Belegungsbuch: welche Fahrt belegt wann welche Konfliktressource.
///
/// Es ist nach Ressource gruppiert, weil das die einzige Struktur ist, die die
/// Prüfung braucht: Bei 40 000 bis 80 000 Blöcken und 40 000 bis 60 000
/// Zugfahrten je Tag (`docs/architektur.md` 1) ist der paarweise Vergleich
/// **innerhalb** einer Ressource billig und der zwischen Ressourcen unnötig.
#[derive(Clone, Debug, Default)]
pub struct OccupationLedger {
    exclusions: ResourceExclusions,
    by_resource: BTreeMap<ConflictResource, Vec<(RunReference, BlockingTime)>>,
    runs: BTreeSet<RunReference>,
}

impl OccupationLedger {
    /// Ein leeres Belegungsbuch mit den Ausschlussbeziehungen des Netzes.
    pub fn new(exclusions: ResourceExclusions) -> Self {
        Self {
            exclusions,
            by_resource: BTreeMap::new(),
            runs: BTreeSet::new(),
        }
    }

    /// Wie viele Fahrten eingetragen sind.
    pub fn run_count(&self) -> usize {
        self.runs.len()
    }

    /// Wie viele einzelne Belegungen eingetragen sind.
    pub fn occupation_count(&self) -> usize {
        self.by_resource.values().map(Vec::len).sum()
    }

    /// Ob eine Fahrt eingetragen ist.
    pub fn contains(&self, run: RunReference) -> bool {
        self.runs.contains(&run)
    }

    /// Prüft eine Fahrt gegen alle eingetragenen.
    pub fn check(&self, run: &TrainRun) -> ConflictReport {
        self.check_staircase(run.staircase(), Some(run.reference()))
    }

    /// Prüft eine Sperrzeitentreppe gegen alle eingetragenen Fahrten.
    ///
    /// `own` schließt die eigene Fahrt aus dem Vergleich aus — eine Fahrt gerät
    /// mit sich selbst nicht in Konflikt, auch wenn sie eine Ressource mehrfach
    /// befährt.
    pub fn check_staircase(
        &self,
        staircase: &BlockingTimeStaircase,
        own: Option<RunReference>,
    ) -> ConflictReport {
        let mut befunde: Vec<OccupationConflict> = Vec::new();

        for stufe in staircase.steps() {
            let mut kandidaten: Vec<ConflictResource> = vec![stufe.resource()];
            kandidaten.extend(self.exclusions.excluded_by(stufe.resource()));

            for ressource in kandidaten {
                let Some(eintraege) = self.by_resource.get(&ressource) else {
                    continue;
                };
                for (referenz, fremde) in eintraege {
                    if own == Some(*referenz) {
                        continue;
                    }
                    if !stufe.overlaps(fremde) {
                        continue;
                    }
                    befunde.push(OccupationConflict {
                        label: String::new(),
                        kind: ConflictKind::of(stufe, fremde),
                        own: *stufe,
                        other: *fremde,
                        other_run: *referenz,
                    });
                }
            }
        }

        ConflictReport::finish(befunde)
    }

    /// Trägt eine Fahrt ein, ohne zu prüfen.
    ///
    /// Für den Aufbau eines Ausgangszustands, dessen Konfliktfreiheit
    /// anderweitig feststeht. Wer Invariante 1 durch Konstruktion halten will,
    /// nimmt [`OccupationLedger::try_insert`].
    pub fn insert(&mut self, run: &TrainRun) {
        let referenz = run.reference();
        self.runs.insert(referenz);
        for stufe in run.staircase().steps() {
            self.by_resource
                .entry(stufe.resource())
                .or_default()
                .push((referenz, *stufe));
        }
    }

    /// Trägt eine Fahrt nur ein, wenn sie konfliktfrei liegt.
    ///
    /// Damit hält das Belegungsbuch Invariante 1 **durch Konstruktion**: Was
    /// darin steht, hat die Prüfung bestanden.
    ///
    /// # Errors
    ///
    /// Der Prüfbericht, wenn die Fahrt mit einer eingetragenen kollidiert.
    pub fn try_insert(&mut self, run: &TrainRun) -> Result<(), ConflictReport> {
        let bericht = self.check(run);
        if !bericht.is_clear() {
            return Err(bericht);
        }
        self.insert(run);
        Ok(())
    }

    /// Sucht die kleinste Verspätung, nach der die Fahrt konfliktfrei liegt.
    ///
    /// **Das ist kein Planner.** Es verschiebt eine einzige Fahrt starr nach
    /// hinten, bis kein Konflikt mehr an ihr hängt. Ob das betrieblich die
    /// richtige Lösung ist, weiß es nicht — bei einer Gegenfahrt auf
    /// eingleisiger Strecke ist die richtige Antwort oft, den Zug **früher**
    /// fahren und in einer Betriebsstelle kreuzen zu lassen. Diese Wahl trifft
    /// der Trassen-Planner aus M3.4.
    pub fn earliest_conflict_free_shift(&self, run: &TrainRun, limit_s: i64) -> ShiftOutcome {
        let mut verschiebung = 0_i64;

        for _ in 0..MAX_SHIFT_ROUNDS {
            let treppe = run.staircase().shifted(verschiebung);
            let bericht = self.check_staircase(&treppe, Some(run.reference()));
            if bericht.is_clear() {
                return if verschiebung == 0 {
                    ShiftOutcome::Clear
                } else {
                    ShiftOutcome::Later(verschiebung)
                };
            }

            let schritt = bericht
                .conflicts()
                .iter()
                .map(OccupationConflict::resolving_shift_s)
                .max()
                .unwrap_or(0);
            if schritt <= 0 {
                return ShiftOutcome::Impossible;
            }
            verschiebung = verschiebung.saturating_add(schritt);
            if verschiebung > limit_s {
                return ShiftOutcome::Impossible;
            }
        }

        ShiftOutcome::Impossible
    }
}

/// Die Mindestzugfolgezeit zweier Fahrten: der kleinste Abstand ihrer
/// Abfahrten, bei dem sich keine zwei Sperrzeiten mehr überschneiden.
///
/// Sie ist **kein Parameter**, sondern ein Ergebnis der Sperrzeiten
/// (`docs/infrastruktur.md` 1). `None` heißt: Auch mit `limit_s` Abstand ist
/// die zweite Fahrt nicht konfliktfrei einzulegen — dann trägt der Laufweg die
/// beiden Fahrten nicht.
pub fn minimum_headway(
    first: &TrainRun,
    second: &TrainRun,
    exclusions: &ResourceExclusions,
    limit_s: i64,
) -> Option<i64> {
    let mut buch = OccupationLedger::new(exclusions.clone());
    buch.insert(first);

    let abstand = second
        .departure()
        .seconds()
        .saturating_sub(first.departure().seconds());
    match buch.earliest_conflict_free_shift(second, limit_s) {
        ShiftOutcome::Clear => Some(abstand),
        ShiftOutcome::Later(verschiebung) => Some(abstand.saturating_add(verschiebung)),
        ShiftOutcome::Impossible => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{ConflictKind, OccupationLedger, ShiftOutcome, minimum_headway};
    use crate::example::{
        nordstadt_bis_talheim, reference_infrastructure, regional_train, talheim_bis_nordstadt,
    };
    use crate::profile::derive_occupation_profile;
    use crate::service::{TrainCategory, TrainNumber, TrainRun};
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::TrackId;

    use crate::infrastructure::Infrastructure;
    use crate::itinerary::Itinerary;

    fn fahrt(infra: &Infrastructure, laufweg: &Itinerary, nummer: u32, abfahrt: i64) -> TrainRun {
        let profil =
            derive_occupation_profile(infra, laufweg, &regional_train()).expect("gültiges Profil");
        TrainRun::new(
            TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Nummer"),
            SimTime::from_seconds(abfahrt),
            &profil,
        )
    }

    /// Die Mitte der Zeit, in der eine Fahrt den eingleisigen Ast belegt —
    /// relativ zu ihrer Abfahrt.
    fn ast_mitte(infra: &Infrastructure, laufweg: &Itinerary) -> i64 {
        let profil =
            derive_occupation_profile(infra, laufweg, &regional_train()).expect("gültiges Profil");
        let auf_dem_ast: Vec<_> = profil
            .occupations()
            .iter()
            .filter(|belegung| {
                matches!(
                    belegung.resource(),
                    crate::resource::ConflictResource::Block { track, .. }
                        if track == TrackId::new(3001)
                )
            })
            .collect();
        let von = auf_dem_ast
            .iter()
            .map(|belegung| belegung.start_s())
            .min()
            .expect("der Laufweg führt über den Ast");
        let bis = auf_dem_ast
            .iter()
            .map(|belegung| belegung.end_s())
            .max()
            .expect("der Laufweg führt über den Ast");
        (von + bis) / 2
    }

    #[test]
    fn eine_einzelne_fahrt_hat_keinen_konflikt() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let buch = OccupationLedger::new(infra.exclusions().clone());
        assert!(
            buch.check(&fahrt(&infra, &laufweg, 26_802, 28_800))
                .is_clear()
        );
    }

    #[test]
    fn eine_fahrt_geraet_mit_sich_selbst_nicht_in_konflikt() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        let fahrt = fahrt(&infra, &laufweg, 26_802, 28_800);
        buch.insert(&fahrt);
        assert!(buch.check(&fahrt).is_clear());
    }

    #[test]
    fn zwei_zuege_derselben_richtung_geraten_in_den_zugfolgefall() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&fahrt(&infra, &laufweg, 26_802, 28_800));

        let bericht = buch.check(&fahrt(&infra, &laufweg, 26_804, 28_860));
        assert!(!bericht.is_clear(), "zu dichte Zugfolge bleibt unentdeckt");
        assert_eq!(
            bericht.kinds(),
            [ConflictKind::Headway].into_iter().collect()
        );
        assert!(bericht.explain().contains("Zugfolge"));
    }

    #[test]
    fn gegenfahrt_entsteht_nur_auf_dem_eingleisigen_ast() {
        // Auf der zweigleisigen Strecke ist jedes Richtungsgleis eine eigene
        // Ressource — dort kann keine Gegenfahrt entstehen, ohne dass der
        // Prüfer davon wüsste. Ein Ressourcenmodell, zwei Konfliktarten.
        let infra = reference_infrastructure();
        let hin = nordstadt_bis_talheim(&infra);
        let zurueck = talheim_bis_nordstadt(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&fahrt(&infra, &hin, 26_802, 28_800));

        // Die Gegenfahrt muss den Ast befahren, während der erste Zug darauf
        // ist. Wann das ist, sagt das Profil selbst — ein geratener Zeitpunkt
        // wäre bei jeder Änderung der Fahrdynamik falsch.
        let versatz = ast_mitte(&infra, &hin) - ast_mitte(&infra, &zurueck);
        let bericht = buch.check(&fahrt(&infra, &zurueck, 26_801, 28_800 + versatz));
        assert!(!bericht.is_clear(), "die Gegenfahrt bleibt unentdeckt");
        for befund in bericht.conflicts() {
            assert_eq!(befund.kind(), ConflictKind::OpposingMove);
            let ressource = befund.resource();
            let auf_dem_ast = matches!(
                ressource,
                crate::resource::ConflictResource::Block { track, .. }
                    if track == TrackId::new(3001)
            ) || matches!(
                ressource,
                crate::resource::ConflictResource::Track(track)
                    if track == TrackId::new(401) || track == TrackId::new(402)
            );
            assert!(
                auf_dem_ast,
                "eine Gegenfahrt außerhalb des eingleisigen Astes: {ressource}"
            );
        }
    }

    #[test]
    fn die_gemeldete_verschiebung_loest_auf_und_eine_sekunde_weniger_nicht() {
        // Der schärfste Test des Prüfers: Der gemeldete Wert muss stimmen,
        // nicht nur grob in die richtige Richtung zeigen.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&fahrt(&infra, &laufweg, 26_802, 28_800));

        let zweite = fahrt(&infra, &laufweg, 26_804, 28_860);
        let ShiftOutcome::Later(verschiebung) = buch.earliest_conflict_free_shift(&zweite, 7_200)
        else {
            panic!("keine auflösende Verschiebung gefunden");
        };

        assert!(buch.check(&zweite.shifted(verschiebung)).is_clear());
        assert!(
            !buch.check(&zweite.shifted(verschiebung - 1)).is_clear(),
            "eine Sekunde weniger ist bereits konfliktfrei — der Wert ist nicht der kleinste"
        );
    }

    #[test]
    fn die_mindestzugfolgezeit_faellt_aus_den_sperrzeiten() {
        // Sie steht nirgends als Parameter: Sie ist der kleinste Abstand, bei
        // dem sich die Sperrzeiten gerade noch berühren.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let erste = fahrt(&infra, &laufweg, 26_802, 28_800);
        let zweite = fahrt(&infra, &laufweg, 26_804, 28_800);

        let abstand =
            minimum_headway(&erste, &zweite, infra.exclusions(), 7_200).expect("auflösbar");
        assert!(abstand > 0, "zwei Züge dürfen nicht gleichzeitig abfahren");

        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&erste);
        assert!(buch.check(&zweite.shifted(abstand)).is_clear());
        assert!(!buch.check(&zweite.shifted(abstand - 1)).is_clear());
    }

    #[test]
    fn ein_belegungsbuch_nimmt_keine_kollidierende_fahrt_auf() {
        // Invariante 1 durch Konstruktion: Was im Buch steht, ist geprüft.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());

        assert!(
            buch.try_insert(&fahrt(&infra, &laufweg, 26_802, 28_800))
                .is_ok()
        );
        let abgewiesen = buch.try_insert(&fahrt(&infra, &laufweg, 26_804, 28_860));
        assert!(abgewiesen.is_err());
        assert_eq!(buch.run_count(), 1);
    }

    #[test]
    fn der_befund_erklaert_sich_ohne_zweite_abfrage() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&fahrt(&infra, &laufweg, 26_802, 28_800));
        let bericht = buch.check(&fahrt(&infra, &laufweg, 26_804, 28_860));

        let erster = &bericht.conflicts()[0];
        assert_eq!(erster.label(), "K1");
        let satz = erster.explain();
        // Ressource, Fenster, Gegenzug, Grund — die vier Angaben aus M3.3.
        assert!(satz.contains(&erster.resource().to_string()), "{satz}");
        assert!(
            satz.contains(&erster.overlap_start().seconds().to_string()),
            "{satz}"
        );
        assert!(satz.contains("RV 26802"), "{satz}");
        assert!(satz.contains("Mindestzugfolgezeit"), "{satz}");
    }

    #[test]
    fn befunde_sind_durchnummeriert_und_stabil_sortiert() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let mut buch = OccupationLedger::new(infra.exclusions().clone());
        buch.insert(&fahrt(&infra, &laufweg, 26_802, 28_800));

        let zweite = fahrt(&infra, &laufweg, 26_804, 28_860);
        let erster = buch.check(&zweite);
        let zweiter = buch.check(&zweite);
        assert_eq!(erster, zweiter);
        assert_eq!(erster.conflicts()[0].label(), "K1");
        for paar in erster.conflicts().windows(2) {
            assert!(paar[0].overlap_start().seconds() <= paar[1].overlap_start().seconds());
        }
    }

    #[test]
    fn ein_leerer_bericht_sagt_es_deutlich() {
        let bericht = super::ConflictReport::default();
        assert!(bericht.is_empty());
        assert_eq!(bericht.len(), 0);
        assert_eq!(bericht.explain(), "Konfliktfrei.");
    }
}
