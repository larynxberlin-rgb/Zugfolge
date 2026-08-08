//! Der Netzfahrplan als reproduzierbarer Zustand.
//!
//! `crates/CLAUDE.md` verlangt für jedes zustandsrelevante Modell einen
//! Determinismus-Test **und** einen Golden-Master. Das ist hier keine Formalie:
//! Ein Netzfahrplan wird über Jahre fortgeschrieben, und die Frage „hat sich
//! etwas geändert, das sich nicht ändern durfte" beantwortet nur ein
//! Fingerabdruck.
//!
//! [`NetworkTimetable`] nimmt Verkehrsangebote entgegen, materialisiert sie
//! über einen Betriebshorizont und trägt jede Fahrt in ein
//! [`OccupationLedger`] ein — **nur wenn sie konfliktfrei liegt**. Damit hält
//! der Fahrplan Invariante 1 durch Konstruktion, und der Zustands-Hash umfasst
//! genau das, was eine spätere Entscheidung beeinflussen kann: die
//! angenommenen Angebote, die abgewiesenen und die Zahl der Belegungen.
//!
//! **Was hier bewusst noch nicht steht:** das Koordinierungsverfahren. Welches
//! von zwei konkurrierenden Angeboten den Zuschlag bekommt, wenn beide nicht
//! zusammenpassen, entscheidet der `PlanningRun` aus M3.5 — hier gilt schlicht
//! die Reihenfolge der Kommandos. Genau deshalb ist dieses Modell ein
//! Prüfstand und noch kein Vergabeverfahren.

use std::collections::{BTreeMap, BTreeSet};

use zugfolge_determinism::{DeterministicModel, SimTime, StateHasher};

use crate::conflict::OccupationLedger;
use crate::resource::ResourceExclusions;
use crate::service::{ServicePattern, TrainNumber};

/// Wie viele Tage ein Netzfahrplan im Voraus materialisiert.
///
/// Eine Woche deckt jedes Verkehrstagemuster genau einmal ab — mehr fügt dem
/// Prüfstand nichts hinzu, weniger ließe Wochenendangebote unbeachtet.
pub const DEFAULT_HORIZON_DAYS: i64 = 7;

/// Was einen Netzfahrplan verändern darf.
#[derive(Clone, Debug)]
pub enum TimetableCommand {
    /// Ein Verkehrsangebot aufnehmen — angenommen, wenn jede seiner Fahrten
    /// im Horizont konfliktfrei liegt.
    Schedule(Box<ServicePattern>),
    /// Ein aufgenommenes Verkehrsangebot zurückziehen.
    Withdraw(TrainNumber),
}

/// Der Netzfahrplan einer Fahrplanperiode.
#[derive(Clone, Debug)]
pub struct NetworkTimetable {
    exclusions: ResourceExclusions,
    horizon_days: i64,
    accepted: BTreeMap<TrainNumber, ServicePattern>,
    rejected: BTreeSet<TrainNumber>,
    ledger: OccupationLedger,
}

impl NetworkTimetable {
    /// Ein leerer Netzfahrplan.
    pub fn new(exclusions: ResourceExclusions, horizon_days: i64) -> Self {
        Self {
            ledger: OccupationLedger::new(exclusions.clone()),
            exclusions,
            horizon_days: horizon_days.max(1),
            accepted: BTreeMap::new(),
            rejected: BTreeSet::new(),
        }
    }

    /// Die angenommenen Verkehrsangebote, nach Zugnummer geordnet.
    pub fn accepted(&self) -> impl Iterator<Item = &ServicePattern> {
        self.accepted.values()
    }

    /// Die Zugnummern, deren Angebot abgewiesen wurde.
    pub fn rejected(&self) -> impl Iterator<Item = TrainNumber> + '_ {
        self.rejected.iter().copied()
    }

    /// Das Belegungsbuch.
    pub const fn ledger(&self) -> &OccupationLedger {
        &self.ledger
    }

    /// Wie viele Angebote angenommen sind.
    pub fn accepted_count(&self) -> usize {
        self.accepted.len()
    }

    /// Nimmt ein Verkehrsangebot auf, wenn jede seiner Fahrten im Horizont
    /// konfliktfrei liegt. Liefert `true`, wenn es angenommen wurde.
    pub fn schedule(&mut self, pattern: ServicePattern) -> bool {
        let nummer = pattern.number();
        let mut probe = self.ledger.clone();
        for tag in 0..self.horizon_days {
            let Some(fahrt) = pattern.materialise(tag) else {
                continue;
            };
            if probe.try_insert(&fahrt).is_err() {
                self.rejected.insert(nummer);
                return false;
            }
        }

        self.ledger = probe;
        self.rejected.remove(&nummer);
        self.accepted.insert(nummer, pattern);
        true
    }

    /// Zieht ein Verkehrsangebot zurück und baut das Belegungsbuch neu auf.
    pub fn withdraw(&mut self, number: TrainNumber) {
        if self.accepted.remove(&number).is_none() {
            return;
        }
        self.rebuild();
    }

    /// Baut das Belegungsbuch aus den angenommenen Angeboten neu auf.
    ///
    /// Ein Belegungsbuch ist nach Ressource gruppiert; einzelne Fahrten daraus
    /// zu entfernen wäre buchhalterisch möglich, aber fehleranfällig. Ein
    /// Neuaufbau ist linear in der Zahl der Fahrten und lässt keinen
    /// verwaisten Eintrag zurück.
    fn rebuild(&mut self) {
        let mut buch = OccupationLedger::new(self.exclusions.clone());
        for pattern in self.accepted.values() {
            for tag in 0..self.horizon_days {
                if let Some(fahrt) = pattern.materialise(tag) {
                    buch.insert(&fahrt);
                }
            }
        }
        self.ledger = buch;
    }
}

impl DeterministicModel for NetworkTimetable {
    type Command = TimetableCommand;

    const SCHEMA: &'static str = "netzfahrplan/v1";

    fn apply(&mut self, _at: SimTime, command: &Self::Command) {
        match command {
            TimetableCommand::Schedule(pattern) => {
                self.schedule(pattern.as_ref().clone());
            }
            TimetableCommand::Withdraw(number) => self.withdraw(*number),
        }
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher.int("horizon_days", self.horizon_days);
        hasher.seq("accepted", self.accepted.len());
        for (nummer, pattern) in &self.accepted {
            hasher.uint("number", u64::from(nummer.value()));
            pattern.write_canonical(hasher);
        }
        hasher.seq("rejected", self.rejected.len());
        for nummer in &self.rejected {
            hasher.uint("number", u64::from(nummer.value()));
        }
        hasher.uint(
            "occupations",
            u64::try_from(self.ledger.occupation_count()).unwrap_or(u64::MAX),
        );
        hasher.uint(
            "runs",
            u64::try_from(self.ledger.run_count()).unwrap_or(u64::MAX),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_HORIZON_DAYS, NetworkTimetable};
    use crate::example::{nordstadt_bis_talheim, reference_infrastructure, regional_train};
    use crate::profile::derive_occupation_profile;
    use crate::service::{OperatingDays, ServicePattern, TrainCategory, TrainNumber};
    use zugfolge_determinism::DeterministicModel;
    use zugfolge_infra::TrainCharacteristicsId;

    fn angebot(nummer: u32, abfahrt_s: i64) -> ServicePattern {
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
            OperatingDays::DAILY,
        )
        .expect("gültiges Verkehrsangebot")
    }

    #[test]
    fn ein_konfliktfreies_angebot_wird_angenommen() {
        let infra = reference_infrastructure();
        let mut fahrplan = NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
        assert!(fahrplan.schedule(angebot(26_802, 28_800)));
        assert_eq!(fahrplan.accepted_count(), 1);
        assert_eq!(
            fahrplan.ledger().run_count(),
            usize::try_from(DEFAULT_HORIZON_DAYS).expect("Horizont passt in usize")
        );
    }

    #[test]
    fn ein_kollidierendes_angebot_wird_ganz_abgewiesen() {
        // Halb angenommen gibt es nicht: Entweder liegt jede Fahrt des
        // Angebots frei, oder das Angebot fällt aus.
        let infra = reference_infrastructure();
        let mut fahrplan = NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
        assert!(fahrplan.schedule(angebot(26_802, 28_800)));
        assert!(!fahrplan.schedule(angebot(26_804, 28_860)));

        assert_eq!(fahrplan.accepted_count(), 1);
        assert_eq!(
            fahrplan.rejected().collect::<Vec<_>>(),
            vec![TrainNumber::new(TrainCategory::Regional, 26_804).expect("gültige Nummer")]
        );
        assert_eq!(
            fahrplan.ledger().run_count(),
            usize::try_from(DEFAULT_HORIZON_DAYS).expect("Horizont passt in usize")
        );
    }

    #[test]
    fn ein_zurueckgezogenes_angebot_gibt_die_kapazitaet_frei() {
        let infra = reference_infrastructure();
        let mut fahrplan = NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
        fahrplan.schedule(angebot(26_802, 28_800));
        assert!(!fahrplan.schedule(angebot(26_804, 28_860)));

        fahrplan.withdraw(TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültig"));
        assert_eq!(fahrplan.ledger().run_count(), 0);
        assert!(fahrplan.schedule(angebot(26_804, 28_860)));
    }

    #[test]
    fn zwei_gleiche_fahrplaene_haben_denselben_zustand() {
        let infra = reference_infrastructure();
        let bauen = || {
            let mut fahrplan =
                NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
            fahrplan.schedule(angebot(26_802, 28_800));
            fahrplan.schedule(angebot(26_806, 32_400));
            fahrplan
        };
        assert_eq!(bauen().state_hash(), bauen().state_hash());
    }

    #[test]
    fn ein_anderer_fahrplan_hat_einen_anderen_zustand() {
        // Die Gegenprobe: Ohne sie prüfte der Golden-Master nur, dass
        // irgendetwas stabil ist.
        let infra = reference_infrastructure();
        let mut a = NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
        a.schedule(angebot(26_802, 28_800));
        let mut b = NetworkTimetable::new(infra.exclusions().clone(), DEFAULT_HORIZON_DAYS);
        b.schedule(angebot(26_802, 28_860));
        assert_ne!(a.state_hash(), b.state_hash());
    }
}
