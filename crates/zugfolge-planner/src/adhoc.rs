//! Ad-hoc-Trassen aus Restkapazität — **M3.7**.
//!
//! `docs/infrastruktur.md` 2.6: „Ad-hoc-Anträge verwenden ausschließlich
//! verbleibende Kapazität." Anders als der `PlanningRun` aus M3.5 verdrängt
//! ein Ad-hoc-Antrag nie eine bereits liegende Trasse — er bekommt seine
//! Wunschlage oder eine Alternative nur dort, wo das Belegungsbuch nach der
//! Koordinierung ohnehin noch frei ist. Das ist genau das, was
//! [`crate::planner::TrainPathPlanner::plan`] gegen ein gegebenes
//! Belegungsbuch ohnehin prüft — [`AdHocLedger`] fügt die Buchführung hinzu,
//! die eine einzelne Planung nicht braucht: Stornierung und Verfall.
//!
//! ## Stornierung und Verfall bei Nichtnutzung
//!
//! `docs/infrastruktur.md` 4 (Kapazitätsschutz, E4): „**Use it or lose it** —
//! unter einem Nutzungsschwellwert liegende Trassen verfallen und lösen
//! Stornoentgelt aus." Das Stornoentgelt selbst ist eine wirtschaftliche
//! Folge (`docs/wirtschaft.md`) und damit außerhalb des Kerns; hier steht nur
//! die technische Seite: [`AdHocLedger::report_usage`] nimmt entgegen, ob ein
//! Verkehrstag tatsächlich gefahren wurde — die tatsächliche Beobachtung
//! macht der Simulationskern (M4) —, und [`AdHocLedger::sweep_underused`]
//! storniert, was unter dem Schwellwert bleibt.

use core::fmt;
use std::collections::BTreeMap;

use zugfolge_conflict::{ConflictReport, OccupationLedger};
use zugfolge_determinism::SimTime;

use crate::candidate::PathCandidate;
use crate::error::PlannerError;
use crate::planner::TrainPathPlanner;
use crate::request::{PathRequest, PathRequestId};
use crate::run::insert_offer;

/// Die Kennung einer Ad-hoc-Trasse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AdHocPathId(u32);

impl AdHocPathId {
    /// Kennung aus ihrer Nummer.
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Die Nummer.
    pub const fn value(self) -> u32 {
        self.0
    }
}

impl fmt::Display for AdHocPathId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "AH{}", self.0)
    }
}

/// Eine zugeteilte Ad-hoc-Trasse.
#[derive(Clone, Debug)]
pub struct AdHocPath {
    id: AdHocPathId,
    request: PathRequestId,
    departure: SimTime,
    candidate: PathCandidate,
}

impl AdHocPath {
    /// Die Kennung.
    pub const fn id(&self) -> AdHocPathId {
        self.id
    }

    /// Der Antrag, aus dem die Trasse hervorging.
    pub const fn request(&self) -> PathRequestId {
        self.request
    }

    /// Die tatsächliche Abfahrt, mit der der Prüfhorizont berechnet wurde.
    pub const fn departure(&self) -> SimTime {
        self.departure
    }

    /// Der zugeteilte Trassenkandidat.
    pub const fn candidate(&self) -> &PathCandidate {
        &self.candidate
    }
}

/// Der Ausgang eines Ad-hoc-Antrags.
#[derive(Clone, Debug)]
pub enum AdHocOutcome {
    /// Die Restkapazität trägt den Antrag; die zugeteilte Trasse ist unter
    /// dieser Kennung gebucht.
    Granted(AdHocPathId),
    /// Auch innerhalb der zulässigen Abweichungen ist keine Restkapazität
    /// frei — der Prüfbericht der Wunschlage.
    Rejected(ConflictReport),
}

/// Nutzungszähler einer Ad-hoc-Trasse.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Usage {
    scheduled: u32,
    used: u32,
}

/// Das Belegungsbuch der Ad-hoc-Vergabe innerhalb einer laufenden
/// Fahrplanperiode.
///
/// `published` ist das Ergebnis der Koordinierung (M3.5/M3.6) — unveränderte
/// Grundlage, gegen die jede Ad-hoc-Trasse ausschließlich die **verbleibende**
/// Kapazität beansprucht.
#[derive(Clone, Debug)]
pub struct AdHocLedger<'a> {
    planner: TrainPathPlanner<'a>,
    published: OccupationLedger,
    ledger: OccupationLedger,
    horizon_days: i64,
    paths: BTreeMap<AdHocPathId, AdHocPath>,
    usage: BTreeMap<AdHocPathId, Usage>,
    next_id: u32,
}

impl<'a> AdHocLedger<'a> {
    /// Ein Ad-hoc-Belegungsbuch über dem veröffentlichten Netzfahrplan einer
    /// Periode.
    pub fn new(
        planner: TrainPathPlanner<'a>,
        published: OccupationLedger,
        horizon_days: i64,
    ) -> Self {
        Self {
            planner,
            ledger: published.clone(),
            published,
            horizon_days: horizon_days.max(1),
            paths: BTreeMap::new(),
            usage: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// Das aktuelle Belegungsbuch — veröffentlichter Netzfahrplan plus die
    /// noch gültigen Ad-hoc-Trassen.
    pub const fn ledger(&self) -> &OccupationLedger {
        &self.ledger
    }

    /// Wie viele Ad-hoc-Trassen aktuell gültig sind.
    pub fn path_count(&self) -> usize {
        self.paths.len()
    }

    /// Eine zugeteilte Ad-hoc-Trasse.
    pub fn path(&self, id: AdHocPathId) -> Option<&AdHocPath> {
        self.paths.get(&id)
    }

    /// Behandelt einen Ad-hoc-Antrag gegen die verbleibende Kapazität.
    ///
    /// Anders als der `PlanningRun` verdrängt dieser Antrag nie eine bereits
    /// liegende Trasse — er nutzt genau das, was
    /// [`crate::planner::TrainPathPlanner::plan`] gegen das aktuelle
    /// Belegungsbuch ohnehin als frei ausweist.
    ///
    /// # Errors
    ///
    /// [`PlannerError::NoRoute`] oder verwandte Fehler, wenn das Netz den
    /// Antrag unabhängig von jeder Kapazität nicht tragen kann.
    pub fn request(&mut self, request: &PathRequest) -> Result<AdHocOutcome, PlannerError> {
        let outcome = self.planner.plan(&self.ledger, request)?;
        let Some(candidate) = outcome.offer() else {
            return Ok(AdHocOutcome::Rejected(outcome.desired_conflicts().clone()));
        };

        let departure = request
            .desired_departure()
            .plus_seconds(candidate.deviation().shift_s());
        let id = AdHocPathId::new(self.next_id);
        self.next_id = self.next_id.saturating_add(1);

        insert_offer(
            &mut self.ledger,
            departure,
            candidate.pattern(),
            self.horizon_days,
        );
        self.paths.insert(
            id,
            AdHocPath {
                id,
                request: request.id(),
                departure,
                candidate: candidate.clone(),
            },
        );
        self.usage.insert(id, Usage::default());
        Ok(AdHocOutcome::Granted(id))
    }

    /// Storniert eine Ad-hoc-Trasse und gibt ihre Kapazität sofort frei.
    ///
    /// # Errors
    ///
    /// [`PlannerError::UnknownAdHocPath`], wenn die Kennung nicht bekannt ist.
    pub fn cancel(&mut self, id: AdHocPathId) -> Result<(), PlannerError> {
        if self.paths.remove(&id).is_none() {
            return Err(PlannerError::UnknownAdHocPath(id.value()));
        }
        self.usage.remove(&id);
        self.rebuild();
        Ok(())
    }

    /// Meldet, ob ein Verkehrstag einer Ad-hoc-Trasse tatsächlich gefahren
    /// wurde.
    ///
    /// Die Beobachtung selbst macht der Simulationskern (M4); dieses
    /// Verfahren führt nur Buch darüber.
    ///
    /// # Errors
    ///
    /// [`PlannerError::UnknownAdHocPath`], wenn die Kennung nicht bekannt ist.
    pub fn report_usage(&mut self, id: AdHocPathId, used: bool) -> Result<(), PlannerError> {
        let usage = self
            .usage
            .get_mut(&id)
            .ok_or(PlannerError::UnknownAdHocPath(id.value()))?;
        usage.scheduled = usage.scheduled.saturating_add(1);
        if used {
            usage.used = usage.used.saturating_add(1);
        }
        Ok(())
    }

    /// Ob eine Ad-hoc-Trasse unter dem Nutzungsschwellwert liegt.
    ///
    /// `threshold_basis_points` ist der Schwellwert in Basispunkten
    /// (1 % = 100 Basispunkte). Eine Trasse ohne eine einzige gemeldete Fahrt
    /// gilt **nicht** als unternutzt — sie hatte noch keine Gelegenheit, genutzt
    /// zu werden.
    pub fn is_underused(&self, id: AdHocPathId, threshold_basis_points: u32) -> bool {
        self.usage.get(&id).is_some_and(|usage| {
            usage.scheduled > 0
                && u64::from(usage.used).saturating_mul(10_000)
                    < u64::from(usage.scheduled).saturating_mul(u64::from(threshold_basis_points))
        })
    }

    /// Storniert alle Ad-hoc-Trassen unter dem Nutzungsschwellwert und
    /// liefert ihre Kennungen.
    ///
    /// Das ist die technische Seite von „Use it or lose it"
    /// (`docs/infrastruktur.md` 4); das Stornoentgelt zieht die Wirtschaft
    /// anhand der gelieferten Kennungen ein.
    pub fn sweep_underused(&mut self, threshold_basis_points: u32) -> Vec<AdHocPathId> {
        let verfallen: Vec<AdHocPathId> = self
            .paths
            .keys()
            .copied()
            .filter(|id| self.is_underused(*id, threshold_basis_points))
            .collect();
        if verfallen.is_empty() {
            return verfallen;
        }
        for id in &verfallen {
            self.paths.remove(id);
            self.usage.remove(id);
        }
        self.rebuild();
        verfallen
    }

    /// Baut das Belegungsbuch aus dem veröffentlichten Netzfahrplan und den
    /// noch gültigen Ad-hoc-Trassen neu auf — derselbe Ansatz wie
    /// `NetworkTimetable::rebuild` (M3.2): linear in der Zahl der Trassen,
    /// ohne einen verwaisten Eintrag zurückzulassen.
    fn rebuild(&mut self) {
        let mut ledger = self.published.clone();
        for path in self.paths.values() {
            insert_offer(
                &mut ledger,
                path.departure,
                path.candidate.pattern(),
                self.horizon_days,
            );
        }
        self.ledger = ledger;
    }
}

#[cfg(test)]
mod tests {
    use super::{AdHocLedger, AdHocOutcome};
    use crate::planner::TrainPathPlanner;
    use crate::request::{PathRequest, PathRequestId, PathTolerances};
    use zugfolge_conflict::example::{reference_infrastructure, regional_train};
    use zugfolge_conflict::{OccupationLedger, OperatingDays, TrainCategory, TrainNumber};
    use zugfolge_determinism::SimTime;
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
    fn eine_trasse_aus_freier_restkapazitaet_wird_angenommen() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        let ergebnis = buch.request(&antrag(1, 26_802)).expect("Planung gelingt");
        assert!(matches!(ergebnis, AdHocOutcome::Granted(_)));
        assert_eq!(buch.path_count(), 1);
    }

    #[test]
    fn eine_ad_hoc_trasse_verdraengt_keine_belegte() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        buch.request(&antrag(1, 26_802)).expect("Planung gelingt");
        let ergebnis = buch.request(&antrag(2, 26_804)).expect("Planung gelingt");
        assert!(
            matches!(ergebnis, AdHocOutcome::Rejected(_)),
            "die zweite Trasse hätte die erste verdrängt"
        );
        assert_eq!(buch.path_count(), 1);
    }

    #[test]
    fn eine_stornierte_trasse_gibt_ihre_kapazitaet_frei() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        let AdHocOutcome::Granted(erste) =
            buch.request(&antrag(1, 26_802)).expect("Planung gelingt")
        else {
            panic!("die erste Trasse hätte angenommen werden müssen");
        };
        assert!(matches!(
            buch.request(&antrag(2, 26_804)).expect("Planung gelingt"),
            AdHocOutcome::Rejected(_)
        ));

        buch.cancel(erste).expect("Stornierung gelingt");
        assert_eq!(buch.path_count(), 0);
        assert!(matches!(
            buch.request(&antrag(3, 26_806)).expect("Planung gelingt"),
            AdHocOutcome::Granted(_)
        ));
    }

    #[test]
    fn eine_unbekannte_kennung_faellt_bei_stornierung_auf() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);
        assert!(matches!(
            buch.cancel(super::AdHocPathId::new(99)),
            Err(super::PlannerError::UnknownAdHocPath(99))
        ));
    }

    #[test]
    fn eine_unternutzte_trasse_verfaellt() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        let AdHocOutcome::Granted(id) = buch.request(&antrag(1, 26_802)).expect("Planung gelingt")
        else {
            panic!("die Trasse hätte angenommen werden müssen");
        };
        for _ in 0..10 {
            buch.report_usage(id, false).expect("bekannte Kennung");
        }

        assert!(buch.is_underused(id, 5_000));
        let verfallen = buch.sweep_underused(5_000);
        assert_eq!(verfallen, vec![id]);
        assert_eq!(buch.path_count(), 0);
    }

    #[test]
    fn eine_ausreichend_genutzte_trasse_verfaellt_nicht() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        let AdHocOutcome::Granted(id) = buch.request(&antrag(1, 26_802)).expect("Planung gelingt")
        else {
            panic!("die Trasse hätte angenommen werden müssen");
        };
        for durchgang in 0..10 {
            buch.report_usage(id, durchgang < 8)
                .expect("bekannte Kennung");
        }

        assert!(!buch.is_underused(id, 5_000));
        assert!(buch.sweep_underused(5_000).is_empty());
        assert_eq!(buch.path_count(), 1);
    }

    #[test]
    fn eine_frische_trasse_ohne_gemeldete_fahrt_gilt_nicht_als_unternutzt() {
        let infra = reference_infrastructure();
        let planner = TrainPathPlanner::new(&infra);
        let published = OccupationLedger::new(infra.exclusions().clone());
        let mut buch = AdHocLedger::new(planner, published, 7);

        let AdHocOutcome::Granted(id) = buch.request(&antrag(1, 26_802)).expect("Planung gelingt")
        else {
            panic!("die Trasse hätte angenommen werden müssen");
        };
        assert!(!buch.is_underused(id, 10_000));
    }
}
