//! Sperrzeiten, Belegungsprofile und Konfliktprüfung — **M3.1 bis M3.3**.
//!
//! Dieses Crate beantwortet genau eine Frage, und zwar erschöpfend:
//!
//! > **Harte Invariante 1:** Keine zwei Züge dürfen zur gleichen Zeit
//! > inkompatible Belegungen derselben Konfliktressource besitzen.
//!
//! Es entscheidet **nicht**, welche Trasse ein Antrag bekommt — das ist der
//! Trassen-Planner aus M3.4 (`zugfolge-planner`) und ein eigenes Verfahren.
//!
//! ## Der Aufbau in vier Schritten
//!
//! | Schritt | Baustein | Milestone |
//! |---------|----------|-----------|
//! | Was kann knapp werden? | [`ConflictResource`], [`ResourceExclusions`] | M3.1 |
//! | Wie lange ist es belegt? | [`derive_occupation_profile`], [`RelativeOccupation`] | M3.1 |
//! | Wann fährt der Zug? | [`ServicePattern`], [`TrainRun`] | M3.2 |
//! | Geht das zusammen? | [`OccupationLedger`], [`ConflictReport`] | M3.3 |
//!
//! **Der Spike aus M0.3 ist damit abgelöst und gelöscht.** Drei seiner Befunde
//! stehen hier als Code statt als Notiz: Ein Ressourcenmodell trägt beide
//! Konfliktarten; halboffene Intervalle sind die richtige Grenze, und die
//! Mindestzugfolgezeit fällt dadurch aus dem Modell heraus statt darin zu
//! stehen; der Befund ist von sich aus erklärbar. Was er offengelassen hatte —
//! den Bahnhofskopf — trägt jetzt die Ausschlussmenge aus M1.7.
//!
//! ## Beispiel
//!
//! ```
//! use zugfolge_conflict::{
//!     OccupationLedger, TrainCategory, TrainNumber, TrainRun, derive_occupation_profile,
//!     example::{nordstadt_bis_talheim, reference_infrastructure, regional_train},
//! };
//! use zugfolge_determinism::SimTime;
//!
//! let infra = reference_infrastructure();
//! let laufweg = nordstadt_bis_talheim(&infra);
//! let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())?;
//!
//! // Einmal rechnen, oft verschieben: Die Zeitlage ist eine Addition.
//! let nummer = TrainNumber::new(TrainCategory::Regional, 26_802)?;
//! let erste = TrainRun::new(nummer, SimTime::from_seconds(28_800), &profil);
//!
//! let mut buch = OccupationLedger::new(infra.exclusions().clone());
//! buch.try_insert(&erste).expect("die erste Fahrt liegt frei");
//!
//! // Eine Minute später ist zu dicht — und der Prüfer sagt, warum.
//! let folger = TrainRun::new(
//!     TrainNumber::new(TrainCategory::Regional, 26_804)?,
//!     SimTime::from_seconds(28_860),
//!     &profil,
//! );
//! let bericht = buch.check(&folger);
//! assert!(!bericht.is_clear());
//! assert!(bericht.explain().contains("Zugfolge"));
//! # Ok::<(), zugfolge_conflict::ConflictError>(())
//! ```

mod blocking;
mod conflict;
mod error;
pub mod example;
mod framework;
mod infrastructure;
mod itinerary;
mod profile;
mod reservation;
mod resource;
mod service;
mod signalling;
mod timetable;

pub use blocking::{BlockingPhase, BlockingTime, BlockingTimeStaircase, RelativeOccupation};
pub use conflict::{
    ConflictKind, ConflictReport, OccupationConflict, OccupationLedger, ShiftOutcome,
    minimum_headway,
};
pub use error::ConflictError;
pub use framework::{FrameworkAgreement, FrameworkAgreementId, FrameworkCapacityLedger};
pub use infrastructure::{Infrastructure, InfrastructureBuilder, ResourceSpan};
pub use itinerary::{CheckedLeg, Itinerary, ItineraryLeg};
pub use profile::{OccupationProfile, derive_occupation_profile, resources_of};
pub use reservation::{
    CapacityConflict, CapacityLedger, ResourceReservation, ResourceReservationId,
};
pub use resource::{ConflictResource, ResourceExclusions};
pub use service::{
    OperatingDays, RunReference, SECONDS_PER_DAY, ServicePattern, TrainCategory, TrainNumber,
    TrainRun, Weekday,
};
pub use signalling::{InterlockingKind, SignallingModel, SignallingParameters};
pub use timetable::{DEFAULT_HORIZON_DAYS, NetworkTimetable, TimetableCommand};
