//! Determinismus-Test an einem kleinen Zustandsmodell.
//!
//! Die Belegungstafel ist bewusst **kein** Sperrzeitenmodell — das entsteht in
//! M0.3 und M3.1. Sie hat nur die Eigenschaften, an denen Determinismus
//! erfahrungsgemäß scheitert: eine Menge von Ressourcen, eine Entscheidung im
//! Gleichstand, ein Zufallsstrom und ein Zustand, der über die Zeit wächst.
//!
//! Ist dieser Test grün — auf Linux und auf Windows, gegen denselben
//! Golden-Master —, dann trägt der Harnisch, und M0.3 kann sich auf die
//! Fachlichkeit beschränken.

use std::collections::BTreeMap;

use zugfolge_determinism::{
    DeterministicModel, Rng, Scenario, SimTime, StateHash, StateHasher, Substream, WorldSeed,
    assert_deterministic, assert_golden, golden_path, run,
};

/// Was an der Belegungstafel geschehen kann.
#[derive(Clone, Debug)]
enum Command {
    /// Ein Zug beansprucht eine Ressource bis zum angegebenen Zeitpunkt.
    Occupy { resource: u16, until: SimTime },
    /// Ein Zug gibt eine Ressource frei.
    Release { resource: u16 },
}

/// Belegte Ressourcen und die Entscheidungen, die dazu geführt haben.
struct OccupationBoard {
    occupied_until: BTreeMap<u16, SimTime>,
    granted: u32,
    rejected: u32,
    tiebreak: Rng,
    tiebreak_draws: Vec<u64>,
}

impl OccupationBoard {
    fn new(seed: WorldSeed) -> Self {
        Self {
            occupied_until: BTreeMap::new(),
            granted: 0,
            rejected: 0,
            tiebreak: seed.substream(Substream::Tiebreak),
            tiebreak_draws: Vec::new(),
        }
    }
}

impl DeterministicModel for OccupationBoard {
    type Command = Command;
    const SCHEMA: &'static str = "occupation-board/v1";

    fn apply(&mut self, at: SimTime, command: &Command) {
        match *command {
            Command::Occupy { resource, until } => {
                let belegt = self.occupied_until.get(&resource).is_some_and(|bis| *bis > at);
                if belegt {
                    // Exakter Gleichstand wird über den veröffentlichten Seed
                    // aufgelöst (docs/infrastruktur.md 2.5) — hier in seiner
                    // einfachsten denkbaren Form.
                    let wurf = self.tiebreak.below(2);
                    self.tiebreak_draws.push(wurf);
                    if wurf == 1 {
                        self.occupied_until.insert(resource, until);
                        self.granted = self.granted.saturating_add(1);
                    } else {
                        self.rejected = self.rejected.saturating_add(1);
                    }
                } else {
                    self.occupied_until.insert(resource, until);
                    self.granted = self.granted.saturating_add(1);
                }
            }
            Command::Release { resource } => {
                self.occupied_until.remove(&resource);
            }
        }
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher.seq("belegungen", self.occupied_until.len());
        for (resource, until) in &self.occupied_until {
            hasher.uint("ressource", u64::from(*resource));
            hasher.int("bis", until.seconds());
        }
        hasher.uint("erteilt", u64::from(self.granted));
        hasher.uint("abgelehnt", u64::from(self.rejected));
        hasher.seq("gleichstaende", self.tiebreak_draws.len());
        for wurf in &self.tiebreak_draws {
            hasher.uint("wurf", *wurf);
        }
    }
}

/// Ein Szenario mit zwei Zügen, die sich um zwei Ressourcen streiten.
fn szenario(seed: WorldSeed) -> Scenario<Command> {
    Scenario::new(seed)
        .at(SimTime::EPOCH, Command::Occupy { resource: 1, until: SimTime::from_seconds(180) })
        .at(
            SimTime::from_seconds(30),
            Command::Occupy { resource: 1, until: SimTime::from_seconds(240) },
        )
        .at(
            SimTime::from_seconds(30),
            Command::Occupy { resource: 2, until: SimTime::from_seconds(300) },
        )
        .at(SimTime::from_seconds(120), Command::Release { resource: 1 })
        .at(
            SimTime::from_seconds(150),
            Command::Occupy { resource: 1, until: SimTime::from_seconds(400) },
        )
        .at(
            SimTime::from_seconds(200),
            Command::Occupy { resource: 2, until: SimTime::from_seconds(500) },
        )
}

fn lauf(seed: WorldSeed) -> StateHash {
    run::<OccupationBoard, _>(&szenario(seed), OccupationBoard::new)
}

#[test]
fn zwei_laeufe_ergeben_denselben_zustand() {
    let scenario = szenario(WorldSeed::new(20_260_806, 1));
    assert_deterministic::<OccupationBoard, _>("belegungstafel", &scenario, OccupationBoard::new);
}

#[test]
fn der_seed_wirkt_auf_die_gleichstandsentscheidung() {
    let mut hashes: Vec<StateHash> =
        (1..=8_u64).map(|welt| lauf(WorldSeed::new(welt, 1))).collect();
    hashes.sort_unstable();
    hashes.dedup();
    assert!(
        hashes.len() > 1,
        "acht verschiedene Seeds ergeben denselben Zustand — der Strom wirkt nicht"
    );
}

#[test]
fn gleichstaende_treten_im_szenario_tatsaechlich_auf() {
    // Ohne diesen Test könnte der Zufallsstrom im Szenario nie gezogen werden,
    // und die beiden Tests darüber wären grün, ohne etwas zu prüfen.
    let mut board = OccupationBoard::new(WorldSeed::new(20_260_806, 1));
    for (at, command) in szenario(WorldSeed::new(20_260_806, 1)).commands() {
        board.apply(*at, command);
    }
    assert!(!board.tiebreak_draws.is_empty(), "im Szenario gab es keinen Gleichstand");
    assert!(board.granted > 0);
}

#[test]
fn einfuegereihenfolge_veraendert_den_zustand_nicht() {
    // BTreeMap statt HashMap ist kein Stilwunsch: Der Zustand darf nicht davon
    // abhängen, in welcher Reihenfolge unabhängige Ressourcen belegt wurden.
    let seed = WorldSeed::new(5, 2);
    let vorwaerts = Scenario::new(seed)
        .at(SimTime::EPOCH, Command::Occupy { resource: 7, until: SimTime::from_seconds(60) })
        .at(SimTime::EPOCH, Command::Occupy { resource: 3, until: SimTime::from_seconds(90) });
    let rueckwaerts = Scenario::new(seed)
        .at(SimTime::EPOCH, Command::Occupy { resource: 3, until: SimTime::from_seconds(90) })
        .at(SimTime::EPOCH, Command::Occupy { resource: 7, until: SimTime::from_seconds(60) });

    assert_eq!(
        run::<OccupationBoard, _>(&vorwaerts, OccupationBoard::new),
        run::<OccupationBoard, _>(&rueckwaerts, OccupationBoard::new),
    );
}

#[test]
fn golden_master_haelt_ueber_plattformen() {
    // Der eigentliche Beweis von M0.2: Dieser Hash ist auf Linux und auf
    // Windows derselbe, und er bleibt es über die Zeit.
    assert_golden(golden_path!("occupation-board"), lauf(WorldSeed::new(20_260_806, 1)));
}
