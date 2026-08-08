//! Der deterministische Planungslauf — **M3.5**.
//!
//! `docs/infrastruktur.md` 2.3 bis 2.5: „Reguläre Anträge eines
//! Planungsfensters werden gemeinsam in einem deterministischen `PlanningRun`
//! behandelt. Reihenfolge innerhalb des Fensters und Bezahlstatus beeinflussen
//! das Ergebnis nicht. Exakte Gleichstände werden über einen veröffentlichten,
//! je Planungsperiode rotierenden Seed aufgelöst."
//!
//! `crates/zugfolge-conflict::NetworkTimetable` sagt es selbst: Es ist „kein
//! Vergabeverfahren" — wer zuerst eingereicht wird, bekommt die Trasse. Genau
//! das verbietet Invariante 5 in dieser Domäne (`path-allocation`,
//! `docs/monorepo.md` 3): Bezahlstatus und Ankunftsreihenfolge dürfen eine
//! Trassenvergabe nicht beeinflussen.
//!
//! ## Warum die gesamte Menge ein einziger Gleichstand ist
//!
//! Der Kern kennt kein drittes Merkmal, das eine Bevorzugung rechtfertigt:
//! Bezahlstatus ist verboten (Invariante 5), Ankunftsreihenfolge ist verboten
//! (Abschnitt 2.4). Das Markteintrittskontingent für neue EVU (E4) ist eine
//! Entscheidung der Game-Services, die den Kern nicht kennt — er weiß nichts
//! von EVU. Ohne ein zulässiges Unterscheidungsmerkmal ist die gesamte Menge
//! der Anträge eines Planungsfensters deshalb ein einziger [`Tie`], aufgelöst
//! über den Substream [`Substream::Tiebreak`] des [`WorldSeed`] dieser
//! Fahrplanperiode.
//!
//! Das erfüllt beides zugleich: Die Bearbeitungsreihenfolge wird aus den
//! Kennungen der Anträge und dem Seed neu bestimmt — die Reihenfolge, in der
//! sie diesem Lauf übergeben wurden, geht dabei gar nicht erst ein.
//!
//! ## Koordinierung, Alternativangebote, Einspruchsfenster
//!
//! Ein Lauf verarbeitet jeden Antrag in dieser Reihenfolge gegen den
//! [`TrainPathPlanner`] aus M3.4 — sein Ergebnis ist ein **Entwurf**
//! (`docs/infrastruktur.md` 3: „Koordinierung — deterministischer
//! `PlanningRun`, Alternativangebote, Einspruchsfenster"). Wer eine
//! Alternativtrasse oder eine Ablehnung erhalten hat, kann binnen des
//! [`ObjectionWindow`] einen geänderten Antrag einreichen
//! ([`PlanningRun::object`]) — etwa mit einer weiteren Abweichung. Der Lauf
//! wird dann mit demselben Seed erneut gerechnet: vollständig deterministisch,
//! weil Seed und Anträge zusammen den Ausgang bestimmen. [`PlanningRun::finalize`]
//! schließt das Fenster; danach ist der letzte Entwurf endgültig.

use std::collections::BTreeMap;

use zugfolge_conflict::{OccupationLedger, SECONDS_PER_DAY, ServicePattern};
use zugfolge_determinism::{SimTime, Substream, WorldSeed};

use crate::candidate::PathCandidate;
use crate::error::PlannerError;
use crate::planner::{PathDecision, PlannerOutcome, TrainPathPlanner};
use crate::request::{PathRequest, PathRequestId};

/// Eine Gruppe von Trassenanträgen mit exakt gleichem Rang im Planungslauf.
///
/// Siehe die Modulbeschreibung: Ohne ein zulässiges Unterscheidungsmerkmal
/// bildet die gesamte Menge der Anträge eines Fensters einen einzigen `Tie`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tie(Vec<PathRequestId>);

impl Tie {
    /// Löst den Gleichstand über den Tiebreak-Substream des Weltseeds auf.
    ///
    /// Die Kennungen werden zuerst kanonisch sortiert — unabhängig davon, in
    /// welcher Reihenfolge sie hier ankamen —, bevor der Seed sie mischt. So
    /// hängt das Ergebnis ausschließlich vom Seed und von der **Menge** der
    /// Kennungen ab, nie von der Reihenfolge, in der sie übergeben wurden.
    fn resolve(mut self, seed: WorldSeed) -> Vec<PathRequestId> {
        self.0.sort_unstable();
        let mut rng = seed.substream(Substream::Tiebreak);
        let permutation = rng.permutation(self.0.len());
        permutation.into_iter().map(|index| self.0[index]).collect()
    }

    /// Die Kennungen der Anträge in diesem Gleichstand.
    pub fn members(&self) -> &[PathRequestId] {
        &self.0
    }
}

/// Das Ergebnis der Bearbeitung eines einzelnen Antrags in einem Planungslauf.
#[derive(Clone, Debug)]
pub enum RequestOutcome {
    /// Der Antrag wurde gegen das Belegungsbuch geplant — mit Annahme,
    /// Alternativtrasse oder Ablehnung (M3.4).
    Planned(PlannerOutcome),
    /// Das Netz kann den Antrag unabhängig von jeder Konkurrenz nicht tragen
    /// — etwa weil kein Laufweg existiert.
    Unroutable(PlannerError),
}

impl RequestOutcome {
    /// Ob der Antrag eine Trasse erhalten hat — Annahme oder Alternativtrasse.
    pub const fn is_served(&self) -> bool {
        matches!(
            self,
            Self::Planned(outcome) if !matches!(outcome.decision(), PathDecision::Rejected)
        )
    }

    /// Stabile Kennung des Ausgangs, etwa für Berichte in anderen Systemen.
    pub const fn tag(&self) -> &'static str {
        match self {
            Self::Planned(outcome) => outcome.decision().tag(),
            Self::Unroutable(_) => "unroutable",
        }
    }

    /// Die angebotene Trasse, sofern der Antrag eine erhalten hat.
    pub fn offer(&self) -> Option<&PathCandidate> {
        match self {
            Self::Planned(outcome) => outcome.offer(),
            Self::Unroutable(_) => None,
        }
    }

    /// Die Begründung als deutscher Text.
    pub fn explain(&self) -> String {
        match self {
            Self::Planned(outcome) => outcome.explain(),
            Self::Unroutable(error) => format!("nicht befahrbar: {error}"),
        }
    }
}

/// Der Entwurf oder das endgültige Ergebnis eines Planungslaufs.
#[derive(Clone, Debug)]
pub struct PlanningRunOutcome {
    order: Vec<PathRequestId>,
    outcomes: BTreeMap<PathRequestId, RequestOutcome>,
    ledger: OccupationLedger,
}

impl PlanningRunOutcome {
    /// Die tatsächlich verwendete Bearbeitungsreihenfolge — aus dem Seed
    /// bestimmt, nicht aus der Reihenfolge der Übergabe.
    pub fn order(&self) -> &[PathRequestId] {
        &self.order
    }

    /// Das Ergebnis eines einzelnen Antrags.
    pub fn outcome(&self, id: PathRequestId) -> Option<&RequestOutcome> {
        self.outcomes.get(&id)
    }

    /// Alle Ergebnisse, nach Kennung geordnet — nicht nach
    /// Bearbeitungsreihenfolge, siehe [`PlanningRunOutcome::order`].
    pub fn outcomes(&self) -> impl Iterator<Item = (PathRequestId, &RequestOutcome)> {
        self.outcomes.iter().map(|(id, outcome)| (*id, outcome))
    }

    /// Die angenommenen Trassenkandidaten — Annahme oder Alternativtrasse —,
    /// in Bearbeitungsreihenfolge.
    ///
    /// Das ist die Menge, aus der ein Netzfahrplan (M3.6) entsteht.
    pub fn accepted(&self) -> impl Iterator<Item = &PathCandidate> {
        self.order
            .iter()
            .filter_map(|id| self.outcomes.get(id))
            .filter_map(RequestOutcome::offer)
    }

    /// Wie viele Anträge eine Trasse erhalten haben — Annahme oder
    /// Alternativtrasse.
    pub fn served_count(&self) -> usize {
        self.outcomes.values().filter(|o| o.is_served()).count()
    }

    /// Das Belegungsbuch am Ende dieses Laufs.
    pub const fn ledger(&self) -> &OccupationLedger {
        &self.ledger
    }

    /// Der Bericht als deutscher Text, ein Absatz je Antrag in
    /// Bearbeitungsreihenfolge.
    pub fn explain(&self) -> String {
        self.order
            .iter()
            .filter_map(|id| self.outcomes.get(id).map(|outcome| (id, outcome)))
            .map(|(id, outcome)| format!("{id}: {}", outcome.explain()))
            .collect::<Vec<String>>()
            .join("\n")
    }
}

/// Der Zustand eines Planungslaufs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunPhase {
    /// Vor dem ersten Lauf.
    Coordination,
    /// Ein Entwurf steht; das Einspruchsfenster ist offen.
    Objection,
    /// Das Einspruchsfenster ist zu; der letzte Entwurf ist endgültig.
    Final,
}

/// Ein deterministischer Planungslauf über einem festen Antragsbestand.
///
/// Der Bestand — welche Anträge teilnehmen — steht mit [`PlanningRun::new`]
/// fest; das Einspruchsverfahren ändert nur den **Inhalt** einzelner Anträge
/// unter ihrer Kennung, nie die Menge der teilnehmenden Kennungen. Deshalb
/// bleibt die Bearbeitungsreihenfolge über alle Runden eines Laufs dieselbe.
#[derive(Clone, Debug)]
pub struct PlanningRun<'a> {
    planner: TrainPathPlanner<'a>,
    baseline: OccupationLedger,
    requests: BTreeMap<PathRequestId, PathRequest>,
    order: Vec<PathRequestId>,
    outcome: Option<PlanningRunOutcome>,
    phase: RunPhase,
}

impl<'a> PlanningRun<'a> {
    /// Beginnt einen Planungslauf über einem festen Antragsbestand.
    ///
    /// `baseline` ist das Belegungsbuch vor diesem Fenster — etwa aus
    /// Rahmenverträgen der Vorperiode (M3.8) oder bereits laufendem Betrieb.
    ///
    /// # Errors
    ///
    /// [`PlannerError::DuplicateRequest`], wenn zwei Anträge dieselbe Kennung
    /// tragen.
    pub fn new(
        planner: TrainPathPlanner<'a>,
        seed: WorldSeed,
        baseline: OccupationLedger,
        requests: Vec<PathRequest>,
    ) -> Result<Self, PlannerError> {
        let mut by_id = BTreeMap::new();
        for request in requests {
            let id = request.id();
            if by_id.insert(id, request).is_some() {
                return Err(PlannerError::DuplicateRequest(id));
            }
        }
        let order = Tie(by_id.keys().copied().collect()).resolve(seed);

        Ok(Self {
            planner,
            baseline,
            requests: by_id,
            order,
            outcome: None,
            phase: RunPhase::Coordination,
        })
    }

    /// Die Bearbeitungsreihenfolge — aus dem Seed bestimmt, mit
    /// [`PlanningRun::new`] festgelegt und über alle Runden stabil.
    pub fn processing_order(&self) -> &[PathRequestId] {
        &self.order
    }

    /// Ob das Einspruchsfenster geschlossen ist.
    pub const fn is_final(&self) -> bool {
        matches!(self.phase, RunPhase::Final)
    }

    /// Der letzte Entwurf oder das endgültige Ergebnis, sofern schon ein Lauf
    /// stattgefunden hat.
    pub fn outcome(&self) -> Option<&PlanningRunOutcome> {
        self.outcome.as_ref()
    }

    /// Rechnet den Planungslauf: jeden Antrag in der Bearbeitungsreihenfolge
    /// gegen das mit den bereits angenommenen Angeboten fortgeschriebene
    /// Belegungsbuch.
    ///
    /// Ein Antrag, den das Netz unabhängig von jeder Konkurrenz nicht tragen
    /// kann — kein Laufweg, keine passende Zugsicherung —, wird als
    /// [`RequestOutcome::Unroutable`] geführt und bricht den Lauf nicht ab:
    /// Ein einzelner unbefahrbarer Antrag ist kein Fehler der Koordinierung.
    ///
    /// Öffnet nach dem ersten Aufruf das Einspruchsfenster; erneute Aufrufe
    /// währenddessen sind zulässig und lösen eine neue Koordinierungsrunde
    /// aus, etwa nach [`PlanningRun::object`].
    ///
    /// # Errors
    ///
    /// [`PlannerError::ObjectionWindowClosed`], wenn [`PlanningRun::finalize`]
    /// bereits aufgerufen wurde.
    pub fn coordinate(&mut self) -> Result<&PlanningRunOutcome, PlannerError> {
        if self.phase == RunPhase::Final {
            return Err(PlannerError::ObjectionWindowClosed);
        }

        let horizon_days = self.planner.options().horizon_days();
        let mut ledger = self.baseline.clone();
        let mut outcomes = BTreeMap::new();

        for &id in &self.order {
            let request = self
                .requests
                .get(&id)
                .expect("die Bearbeitungsreihenfolge stammt aus den Anträgen dieses Laufs");
            let outcome = match self.planner.plan(&ledger, request) {
                Ok(outcome) => {
                    if let Some(candidate) = outcome.offer() {
                        let departure = request
                            .desired_departure()
                            .plus_seconds(candidate.deviation().shift_s());
                        insert_offer(&mut ledger, departure, candidate.pattern(), horizon_days);
                    }
                    RequestOutcome::Planned(outcome)
                }
                Err(error) => RequestOutcome::Unroutable(error),
            };
            outcomes.insert(id, outcome);
        }

        self.outcome = Some(PlanningRunOutcome {
            order: self.order.clone(),
            outcomes,
            ledger,
        });
        if self.phase == RunPhase::Coordination {
            self.phase = RunPhase::Objection;
        }
        Ok(self.outcome.as_ref().expect("gerade gesetzt"))
    }

    /// Reicht einen geänderten Antrag ein, während das Einspruchsfenster
    /// offen ist — etwa mit einer weiteren zulässigen Abweichung.
    ///
    /// Die Kennung muss zu einem Antrag dieses Laufs gehören: Ein Einspruch
    /// ändert einen bestehenden Antrag, er meldet keinen neuen an — das
    /// Anmeldefenster ist eine eigene Phase der Fahrplanperiode (M3.6).
    /// Die geänderte Fassung wirkt erst mit dem nächsten
    /// [`PlanningRun::coordinate`].
    ///
    /// # Errors
    ///
    /// - [`PlannerError::ObjectionWindowClosed`], vor dem ersten Lauf oder
    ///   nach [`PlanningRun::finalize`].
    /// - [`PlannerError::UnknownRequest`], wenn die Kennung nicht zu diesem
    ///   Lauf gehört.
    pub fn object(&mut self, amended: PathRequest) -> Result<(), PlannerError> {
        if self.phase != RunPhase::Objection {
            return Err(PlannerError::ObjectionWindowClosed);
        }
        let id = amended.id();
        if !self.requests.contains_key(&id) {
            return Err(PlannerError::UnknownRequest(id));
        }
        self.requests.insert(id, amended);
        Ok(())
    }

    /// Schließt das Einspruchsfenster: der letzte Entwurf wird endgültig.
    ///
    /// # Errors
    ///
    /// [`PlannerError::NotYetCoordinated`], wenn noch kein einziger Lauf
    /// stattgefunden hat.
    pub fn finalize(&mut self) -> Result<&PlanningRunOutcome, PlannerError> {
        if self.phase == RunPhase::Coordination {
            return Err(PlannerError::NotYetCoordinated);
        }
        self.phase = RunPhase::Final;
        Ok(self
            .outcome
            .as_ref()
            .expect("phase Objection setzt einen Entwurf voraus"))
    }
}

/// Trägt ein Verkehrsangebot ab einer Abfahrt über den Prüfhorizont in das
/// Belegungsbuch ein.
///
/// Der Tagesbereich entspricht exakt dem, den [`TrainPathPlanner::plan`]
/// gegen dasselbe Belegungsbuch bereits als konfliktfrei geprüft hat — die
/// Einfügung selbst prüft deshalb nicht erneut. Auch der Ad-hoc-Vergabe
/// (M3.7) dient diese eine Stelle, damit beide denselben Tagesbereich
/// verwenden.
pub(crate) fn insert_offer(
    ledger: &mut OccupationLedger,
    departure: SimTime,
    pattern: &ServicePattern,
    horizon_days: i64,
) {
    let tag0 = departure.seconds().div_euclid(SECONDS_PER_DAY);
    for tag in tag0..tag0.saturating_add(horizon_days) {
        if let Some(run) = pattern.materialise(tag) {
            ledger.insert(&run);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlanningRun, RequestOutcome, Tie};
    use crate::planner::{PathDecision, TrainPathPlanner};
    use crate::request::{PathRequest, PathRequestId, PathTolerances};
    use std::collections::BTreeSet;
    use zugfolge_conflict::example::{reference_infrastructure, regional_train};
    use zugfolge_conflict::{OccupationLedger, OperatingDays, TrainCategory, TrainNumber};
    use zugfolge_determinism::{SimTime, WorldSeed};
    use zugfolge_infra::OperatingPointId;

    fn antrag(id: u32, nummer: u32) -> PathRequest {
        PathRequest::new(
            PathRequestId::new(id),
            TrainNumber::new(TrainCategory::Regional, nummer).expect("gültige Nummer"),
            regional_train(),
            OperatingPointId::new(1),
            OperatingPointId::new(4),
            Vec::new(),
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::EXACT,
        )
        .expect("gültiger Antrag")
    }

    #[test]
    fn zwei_gleiche_kennungen_fallen_beim_bau_auf() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let buch = OccupationLedger::new(infra.exclusions().clone());
        let ergebnis = PlanningRun::new(
            planner,
            WorldSeed::new(1, 1),
            buch,
            vec![antrag(1, 26_802), antrag(1, 26_804)],
        );
        assert!(matches!(
            ergebnis,
            Err(super::PlannerError::DuplicateRequest(_))
        ));
    }

    #[test]
    fn die_uebergabereihenfolge_beeinflusst_das_ergebnis_nicht() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let a = antrag(1, 26_802);
        let b = antrag(2, 26_804);

        let sieger = |requests: Vec<PathRequest>| {
            let mut lauf = PlanningRun::new(
                planner.clone(),
                WorldSeed::new(7, 3),
                baseline.clone(),
                requests,
            )
            .expect("gültiger Lauf");
            let ergebnis = lauf.coordinate().expect("Koordinierung gelingt");
            ergebnis
                .outcomes()
                .find(|(_, outcome)| outcome.is_served())
                .map(|(id, _)| id)
        };

        let erste = sieger(vec![a.clone(), b.clone()]);
        let zweite = sieger(vec![b, a]);
        assert!(erste.is_some(), "kein Antrag hat eine Trasse erhalten");
        assert_eq!(
            erste, zweite,
            "die Übergabereihenfolge hat das Ergebnis verändert"
        );
    }

    #[test]
    fn der_seed_entscheidet_tatsaechlich_ueber_den_gleichstand() {
        // Gegenprobe: Ohne Wirkung des Seeds gewänne immer dieselbe Kennung —
        // dann wäre „Reihenfolge egal" nur behauptet, nicht bewiesen.
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let requests = vec![antrag(1, 26_802), antrag(2, 26_804)];

        let mut sieger: BTreeSet<PathRequestId> = BTreeSet::new();
        for periode in 0..20 {
            let mut lauf = PlanningRun::new(
                planner.clone(),
                WorldSeed::new(1, periode),
                baseline.clone(),
                requests.clone(),
            )
            .expect("gültiger Lauf");
            let ergebnis = lauf.coordinate().expect("Koordinierung gelingt");
            if let Some((id, _)) = ergebnis.outcomes().find(|(_, outcome)| outcome.is_served()) {
                sieger.insert(id);
            }
        }
        assert_eq!(
            sieger.len(),
            2,
            "über 20 Perioden hätte jeder der beiden Anträge einmal gewinnen müssen"
        );
    }

    #[test]
    fn genau_ein_antrag_gewinnt_den_widerstreit() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let mut lauf = PlanningRun::new(
            planner,
            WorldSeed::new(5, 2),
            baseline,
            vec![antrag(1, 26_802), antrag(2, 26_804)],
        )
        .expect("gültiger Lauf");

        let ergebnis = lauf.coordinate().expect("Koordinierung gelingt");
        let angenommen = ergebnis
            .outcomes()
            .filter(|(_, outcome)| outcome.is_served())
            .count();
        assert_eq!(angenommen, 1, "beide Anträge wollen dieselbe Wunschlage");
        assert_eq!(ergebnis.served_count(), 1);

        let abgelehnt = ergebnis
            .outcomes()
            .find(|(_, outcome)| !outcome.is_served())
            .expect("ein Antrag muss abgelehnt werden");
        assert!(matches!(
            abgelehnt.1,
            RequestOutcome::Planned(o) if o.decision() == PathDecision::Rejected
        ));
    }

    #[test]
    fn ein_einspruch_kann_die_ablehnung_in_eine_annahme_wandeln() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let mut lauf = PlanningRun::new(
            planner,
            WorldSeed::new(5, 2),
            baseline,
            vec![antrag(1, 26_802), antrag(2, 26_804)],
        )
        .expect("gültiger Lauf");

        let entwurf = lauf.coordinate().expect("Koordinierung gelingt");
        let verlierer = entwurf
            .outcomes()
            .find(|(_, outcome)| !outcome.is_served())
            .map(|(id, _)| id)
            .expect("ein Antrag verliert den Widerstreit");

        // Der Verlierer legt Einspruch ein: Er lässt eine spätere Zeitlage zu.
        let geaenderter_antrag = PathRequest::new(
            verlierer,
            TrainNumber::new(TrainCategory::Regional, 26_806).expect("gültige Nummer"),
            regional_train(),
            OperatingPointId::new(1),
            OperatingPointId::new(4),
            Vec::new(),
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::new(0, 3_600, 60, 0, 0).expect("gültige Toleranz"),
        )
        .expect("gültiger Antrag");
        lauf.object(geaenderter_antrag).expect("Einspruch gelingt");

        let ergebnis = lauf.coordinate().expect("erneute Koordinierung gelingt");
        assert_eq!(
            ergebnis.served_count(),
            2,
            "nach dem Einspruch bekommen beide eine Trasse"
        );

        lauf.finalize().expect("Abschluss gelingt");
        assert!(lauf.is_final());
        assert!(matches!(
            lauf.coordinate(),
            Err(super::PlannerError::ObjectionWindowClosed)
        ));
    }

    #[test]
    fn ein_einspruch_auf_eine_unbekannte_kennung_faellt_auf() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let mut lauf = PlanningRun::new(
            planner,
            WorldSeed::new(1, 1),
            baseline,
            vec![antrag(1, 26_802)],
        )
        .expect("gültiger Lauf");
        lauf.coordinate().expect("Koordinierung gelingt");

        assert!(matches!(
            lauf.object(antrag(99, 26_808)),
            Err(super::PlannerError::UnknownRequest(_))
        ));
    }

    #[test]
    fn ein_einspruch_vor_dem_ersten_lauf_faellt_auf() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let baseline = OccupationLedger::new(infra.exclusions().clone());
        let mut lauf = PlanningRun::new(
            planner,
            WorldSeed::new(1, 1),
            baseline,
            vec![antrag(1, 26_802)],
        )
        .expect("gültiger Lauf");
        assert!(matches!(
            lauf.object(antrag(1, 26_804)),
            Err(super::PlannerError::ObjectionWindowClosed)
        ));
        assert!(matches!(
            lauf.finalize(),
            Err(super::PlannerError::NotYetCoordinated)
        ));
    }

    #[test]
    fn ein_gleichstand_ist_kanonisch_sortiert_vor_der_mischung() {
        // Die Übergabereihenfolge der Kennungen darf die Ausgangslage der
        // Mischung nicht heimlich prägen.
        let a = Tie(vec![PathRequestId::new(3), PathRequestId::new(1)]);
        let b = Tie(vec![PathRequestId::new(1), PathRequestId::new(3)]);
        let seed = WorldSeed::new(9, 4);
        assert_eq!(a.resolve(seed), b.resolve(seed));
    }
}
