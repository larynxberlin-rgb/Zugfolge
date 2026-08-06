//! Determinismus-Testharnisch für Zugfolge.
//!
//! Dieses Crate enthält **kein** Fachwissen über Eisenbahnbetrieb. Es enthält
//! die vier Bausteine, ohne die die Replay-Invariante aus
//! `docs/architektur.md` nicht prüfbar wäre:
//!
//! | Baustein | Zweck |
//! |----------|-------|
//! | [`WorldSeed`] und [`Substream`] | ein Seed je Welt und Periode, aufgeteilt in **benannte** Ströme |
//! | [`Rng`] | ganzzahliger, reproduzierbarer Zufall — ohne jede Gleitkommaschnittstelle |
//! | [`StateHasher`] und [`StateHash`] | kanonischer, plattformunabhängiger Hash eines Zustands |
//! | [`Scenario`], [`run`], [`assert_deterministic`] | Replay zweier identischer Läufe und Vergleich |
//!
//! ## Die Replay-Invariante
//!
//! > gleicher `InfraRelease` + `EconomyRelease` + Seed + Kommandolog
//! > ⇒ bitgleicher Endzustand
//!
//! Der Harnisch prüft davon den in M0.2 prüfbaren Teil: gleicher Seed und
//! gleiches Kommandolog ergeben denselben Zustands-Hash — auf jedem
//! Betriebssystem, das die CI-Matrix abdeckt.
//!
//! ## Warum die Substreams über ihren **Namen** abgeleitet werden
//!
//! Ein neuer Substream darf die bestehenden nicht verschieben. Würden die
//! Ströme durchnummeriert, veränderte das Einfügen von `weather` zwischen
//! `tiebreak` und `demand` jeden späteren Strom — und damit rückwirkend jede
//! Welt. Die Ableitung geht deshalb über den Namen, nicht über einen Index.
//! [`Substream::name`] ist damit ein **Datenformat**, kein Bezeichner: Wer ihn
//! ändert, ändert die Welt.
//!
//! ## Beispiel
//!
//! ```
//! use zugfolge_determinism::{DeterministicModel, Scenario, SimTime, StateHasher, WorldSeed, assert_deterministic};
//!
//! struct Counter(i64);
//!
//! impl DeterministicModel for Counter {
//!     type Command = i64;
//!     const SCHEMA: &'static str = "counter/v1";
//!
//!     fn apply(&mut self, _at: SimTime, command: &i64) {
//!         self.0 = self.0.saturating_add(*command);
//!     }
//!
//!     fn write_state(&self, hasher: &mut StateHasher) {
//!         hasher.int("wert", self.0);
//!     }
//! }
//!
//! let scenario = Scenario::new(WorldSeed::new(7, 1))
//!     .at(SimTime::from_seconds(0), 3)
//!     .at(SimTime::from_seconds(60), 4);
//!
//! let hash = assert_deterministic::<Counter, _>("counter", &scenario, |_seed| Counter(0));
//! assert_eq!(hash.to_hex().len(), 64);
//! ```

mod golden;
mod harness;
mod hash;
mod rng;
mod seed;

pub use golden::assert_golden;
pub use harness::{DeterministicModel, Scenario, SimTime, assert_deterministic, run};
pub use hash::{StateHash, StateHashError, StateHasher};
pub use rng::Rng;
pub use seed::{Substream, WorldSeed};
