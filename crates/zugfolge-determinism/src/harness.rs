//! Replay-Harnisch: Szenario, Lauf, Vergleich.

use crate::hash::{StateHash, StateHasher};
use crate::seed::WorldSeed;

/// Simulationszeit in **Sekunden seit Weltepoche**.
///
/// Invariante 2 aus `CLAUDE.md`: Es gibt kein `now()` im Simulationskern.
/// Simulationszeit ist ein Wert, den der Aufrufer mitgibt — deshalb hat dieser
/// Typ absichtlich keinen Konstruktor, der die Uhr liest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SimTime(i64);

impl SimTime {
    /// Der Nullpunkt der Welt.
    pub const EPOCH: Self = Self(0);

    /// Zeitpunkt aus Sekunden seit Weltepoche.
    pub const fn from_seconds(seconds: i64) -> Self {
        Self(seconds)
    }

    /// Sekunden seit Weltepoche.
    pub const fn seconds(self) -> i64 {
        self.0
    }

    /// Zeitpunkt um `seconds` später; sättigt an den Grenzen von `i64`.
    pub const fn plus_seconds(self, seconds: i64) -> Self {
        Self(self.0.saturating_add(seconds))
    }
}

/// Ein Modell, dessen Zustand reproduzierbar sein muss.
///
/// Der Vertrag ist eng gehalten — Kommandos hinein, Zustand heraus, kein
/// Datenbankzugriff, keine Uhr, kein ungezähmter Zufall. Genau dieser enge
/// Vertrag ist laut `docs/architektur.md` die Bedingung dafür, dass der Kern
/// austauschbar bleibt.
pub trait DeterministicModel {
    /// Die Kommandos, die den Zustand verändern dürfen.
    type Command;

    /// Versionierte Bezeichnung des Zustandsschemas, etwa `"belegung/v1"`.
    ///
    /// Ändert sich die Bedeutung der gehashten Felder, wird die Version
    /// hochgezählt. Sonst prüft ein Golden-Master lautlos etwas anderes als
    /// beim Aufschreiben.
    const SCHEMA: &'static str;

    /// Wendet ein Kommando zur Simulationszeit `at` an.
    fn apply(&mut self, at: SimTime, command: &Self::Command);

    /// Schreibt den **vollständigen** zustandsrelevanten Inhalt in den Hasher.
    ///
    /// Was hier fehlt, deckt kein Determinismus-Test je auf. Deshalb gehört
    /// jedes Feld hinein, das eine spätere Entscheidung beeinflussen kann —
    /// auch der Fortschritt eines Zufallsstroms.
    fn write_state(&self, hasher: &mut StateHasher);

    /// Der Hash des aktuellen Zustands.
    fn state_hash(&self) -> StateHash {
        let mut hasher = StateHasher::new(Self::SCHEMA);
        self.write_state(&mut hasher);
        hasher.finish()
    }
}

/// Ein Kommandolog mit Seed — alles, was ein Lauf zum Wiederholen braucht.
#[derive(Clone, Debug)]
pub struct Scenario<C> {
    seed: WorldSeed,
    commands: Vec<(SimTime, C)>,
}

impl<C> Scenario<C> {
    /// Leeres Szenario zu einem Seed.
    pub const fn new(seed: WorldSeed) -> Self {
        Self { seed, commands: Vec::new() }
    }

    /// Hängt ein Kommando an.
    ///
    /// # Panics
    ///
    /// Wenn `at` vor dem zuletzt angehängten Zeitpunkt liegt. Ein
    /// Kommandolog, das in der Zeit zurückspringt, ist nicht wiederholbar —
    /// der Fehler gehört an die Stelle des Aufschreibens, nicht in einen
    /// stillen Sortierschritt, der die Reihenfolge gleicher Zeitpunkte
    /// verändern könnte.
    #[must_use]
    pub fn at(mut self, at: SimTime, command: C) -> Self {
        if let Some((letzter, _)) = self.commands.last() {
            assert!(
                at >= *letzter,
                "Kommandolog springt zurück: {} nach {}",
                at.seconds(),
                letzter.seconds()
            );
        }
        self.commands.push((at, command));
        self
    }

    /// Der Seed des Szenarios.
    pub const fn seed(&self) -> WorldSeed {
        self.seed
    }

    /// Anzahl der Kommandos.
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Ob das Szenario leer ist.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    /// Die Kommandos in Reihenfolge.
    pub fn commands(&self) -> &[(SimTime, C)] {
        &self.commands
    }
}

/// Führt ein Szenario einmal aus und liefert den Zustands-Hash.
pub fn run<M, F>(scenario: &Scenario<M::Command>, build: F) -> StateHash
where
    M: DeterministicModel,
    F: FnOnce(WorldSeed) -> M,
{
    let mut model = build(scenario.seed());
    for (at, command) in scenario.commands() {
        model.apply(*at, command);
    }
    model.state_hash()
}

/// Führt ein Szenario **zweimal** aus und stellt sicher, dass beide Läufe
/// denselben Zustand erzeugen.
///
/// Das ist der Determinismus-Test in seiner kleinsten Form. Er fängt genau die
/// Fehlerklasse, die sonst erst Monate später und nur sporadisch auffällt:
/// Iteration über eine ungeordnete Menge, gelesene Uhrzeit, ungesäter Zufall,
/// Zeigerwerte im Zustand.
///
/// # Panics
///
/// Wenn die beiden Läufe verschiedene Zustände erzeugen.
pub fn assert_deterministic<M, F>(
    label: &str,
    scenario: &Scenario<M::Command>,
    build: F,
) -> StateHash
where
    M: DeterministicModel,
    F: Fn(WorldSeed) -> M,
{
    let erster = run::<M, _>(scenario, &build);
    let zweiter = run::<M, _>(scenario, &build);
    assert_eq!(
        erster, zweiter,
        "{label}: zwei identische Läufe ergaben verschiedene Zustände — \
         der Zustand hängt an etwas, das nicht im Kommandolog steht"
    );
    erster
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{DeterministicModel, Scenario, SimTime, assert_deterministic, run};
    use crate::hash::StateHasher;
    use crate::seed::{Substream, WorldSeed};

    /// Zählt Kommandos und zieht je Kommando einen Wert aus dem Tiebreak-Strom.
    struct Zaehler {
        summe: i64,
        gezogen: Vec<u64>,
        rng: crate::Rng,
    }

    impl DeterministicModel for Zaehler {
        type Command = i64;
        const SCHEMA: &'static str = "zaehler/v1";

        fn apply(&mut self, at: SimTime, command: &i64) {
            self.summe = self.summe.saturating_add(*command).saturating_add(at.seconds());
            self.gezogen.push(self.rng.below(1_000));
        }

        fn write_state(&self, hasher: &mut StateHasher) {
            hasher.int("summe", self.summe);
            hasher.seq("gezogen", self.gezogen.len());
            for (index, wert) in self.gezogen.iter().enumerate() {
                hasher.uint("zug", *wert);
                hasher.uint("index", u64::try_from(index).expect("Index passt"));
            }
        }
    }

    fn baue(seed: WorldSeed) -> Zaehler {
        Zaehler { summe: 0, gezogen: Vec::new(), rng: seed.substream(Substream::Tiebreak) }
    }

    fn szenario(seed: WorldSeed) -> Scenario<i64> {
        Scenario::new(seed)
            .at(SimTime::EPOCH, 5)
            .at(SimTime::from_seconds(60), -2)
            .at(SimTime::from_seconds(60), 7)
    }

    #[test]
    fn gleicher_seed_gleicher_zustand() {
        let scenario = szenario(WorldSeed::new(1, 1));
        assert_deterministic::<Zaehler, _>("zaehler", &scenario, baue);
    }

    #[test]
    fn anderer_seed_anderer_zustand() {
        let erster = run::<Zaehler, _>(&szenario(WorldSeed::new(1, 1)), baue);
        let zweiter = run::<Zaehler, _>(&szenario(WorldSeed::new(2, 1)), baue);
        assert_ne!(erster, zweiter, "der Seed wirkt nicht auf den Zustand");
    }

    #[test]
    fn anderes_kommandolog_anderer_zustand() {
        let seed = WorldSeed::new(1, 1);
        let kurz = Scenario::new(seed).at(SimTime::EPOCH, 5);
        assert_ne!(run::<Zaehler, _>(&kurz, baue), run::<Zaehler, _>(&szenario(seed), baue));
    }

    #[test]
    fn szenario_meldet_laenge() {
        let seed = WorldSeed::new(1, 1);
        assert!(Scenario::<i64>::new(seed).is_empty());
        assert_eq!(szenario(seed).len(), 3);
    }

    #[test]
    #[should_panic(expected = "Kommandolog springt zurück")]
    fn kommandolog_darf_nicht_zurueckspringen() {
        let _ = Scenario::new(WorldSeed::new(1, 1))
            .at(SimTime::from_seconds(60), 1_i64)
            .at(SimTime::from_seconds(59), 2);
    }

    thread_local! {
        static LAUFNUMMER: Cell<i64> = const { Cell::new(0) };
    }

    /// Ein absichtlich kaputtes Modell: Sein Zustand hängt an etwas außerhalb
    /// des Kommandologs. Der Harnisch muss das melden — täte er es nicht,
    /// wäre jeder grüne Determinismus-Test wertlos.
    struct Undeterministisch(i64);

    impl DeterministicModel for Undeterministisch {
        type Command = ();
        const SCHEMA: &'static str = "undeterministisch/v1";

        fn apply(&mut self, _at: SimTime, _command: &()) {}

        fn write_state(&self, hasher: &mut StateHasher) {
            hasher.int("lauf", self.0);
        }
    }

    #[test]
    #[should_panic(expected = "verschiedene Zustände")]
    fn harnisch_erkennt_undeterminismus() {
        let scenario = Scenario::new(WorldSeed::new(1, 1)).at(SimTime::EPOCH, ());
        assert_deterministic::<Undeterministisch, _>("kaputt", &scenario, |_seed| {
            let nummer = LAUFNUMMER.with(|zelle| {
                let naechste = zelle.get().saturating_add(1);
                zelle.set(naechste);
                naechste
            });
            Undeterministisch(nummer)
        });
    }
}
