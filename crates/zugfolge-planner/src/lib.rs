//! Der Trassen-Planner — **M3.4**.
//!
//! Er beantwortet eine andere Frage als der Konfliktprüfer aus M3.3. Der
//! Prüfer sagt, ob eine Trasse **zulässig** ist. Der Planner sagt, welche
//! Trasse **gut** ist — und das ist ein eigenes Verfahren, kein erweiterter
//! Prüfer.
//!
//! Der Spike aus M0.3 hat den Unterschied vorgeführt: Auf dem eingleisigen Ast
//! meldete seine Prüfung „6:57 min später"; betrieblich richtig war „6 min
//! früher und in Sandberg kreuzen". Diese Antwort entsteht nur aus drei
//! Freiheitsgraden, die eine Prüfung gar nicht hat:
//!
//! | Freiheitsgrad | Wo er entsteht |
//! |---------------|----------------|
//! | Laufweg — welches Strecken-, welches Bahnsteiggleis | [`enumerate_itineraries`] |
//! | Zeitlage — früher oder später innerhalb der Abweichung | [`PathTolerances`] |
//! | Betriebshalt — in einer Betriebsstelle kreuzen | [`TrainPathPlanner`] |
//!
//! ## Kein einzelner Optimierungswert (E11)
//!
//! Die Kandidaten werden nach einer **veröffentlichten Rangfolge** geordnet,
//! nicht nach einer Zielfunktion, und der Planner liefert sie **alle** —
//! Einzelheiten in [`CandidateDeviation`].
//!
//! ## Beispiel
//!
//! ```
//! use zugfolge_conflict::{
//!     OccupationLedger, TrainCategory, TrainNumber, TrainRun, derive_occupation_profile,
//!     example::{nordstadt_bis_talheim, reference_infrastructure, regional_train},
//! };
//! use zugfolge_determinism::SimTime;
//! use zugfolge_planner::{
//!     PathDecision, PathRequest, PathRequestId, PathTolerances, TrainPathPlanner,
//! };
//! use zugfolge_infra::OperatingPointId;
//!
//! let infra = reference_infrastructure();
//! let planner = TrainPathPlanner::new(&infra);
//! let buch = OccupationLedger::new(infra.exclusions().clone());
//!
//! let antrag = PathRequest::new(
//!     PathRequestId::new(1),
//!     TrainNumber::new(TrainCategory::Regional, 26_802)?,
//!     regional_train(),
//!     OperatingPointId::new(1),
//!     OperatingPointId::new(4),
//!     Vec::new(),
//!     SimTime::from_seconds(28_800),
//!     zugfolge_conflict::OperatingDays::DAILY,
//!     PathTolerances::new(600, 600, 300, 900, 1)?,
//! )?;
//!
//! // In ein leeres Netz passt die Wunschlage.
//! let ergebnis = planner.plan(&buch, &antrag)?;
//! assert_eq!(ergebnis.decision(), PathDecision::Granted);
//! assert!(ergebnis.offer().is_some_and(|trasse| trasse.deviation().is_exact()));
//! # Ok::<(), Box<dyn core::error::Error>>(())
//! ```

mod adhoc;
mod candidate;
mod error;
mod period;
mod planner;
mod request;
mod route;
mod run;

pub use adhoc::{AdHocLedger, AdHocOutcome, AdHocPath, AdHocPathId};
pub use candidate::{CandidateDeviation, PathCandidate};
pub use error::PlannerError;
pub use period::{PeriodPhase, SchedulePeriod};
pub use planner::{PathDecision, PlannerOptions, PlannerOutcome, TrainPathPlanner};
pub use request::{PathRequest, PathRequestId, PathTolerances, RequestedStop};
pub use route::enumerate_itineraries;
pub use run::{PlanningRun, PlanningRunOutcome, RequestOutcome, Tie};
