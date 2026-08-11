//! Weltseed und benannte Substreams.

use sha2::{Digest, Sha256};

use crate::rng::Rng;

/// Trennt die Substream-Ableitung von jeder anderen Hashverwendung.
///
/// Die Version im Namen ist Absicht: Ändert sich das Ableitungsverfahren
/// jemals, bekommt es eine neue Domäne und alte Welten bleiben lesbar.
const SUBSTREAM_DOMAIN: &[u8] = b"zugfolge/substream/v1";

/// Ein benannter Zufallsstrom einer Welt.
///
/// Jeder Strom ist gegen die anderen unabhängig. Neue Varianten dürfen
/// jederzeit ergänzt werden — sie verändern die bestehenden Ströme nicht,
/// weil die Ableitung über den Namen läuft und nicht über die Reihenfolge.
///
/// Die Namen stammen aus `docs/architektur.md`, Abschnitt 4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum Substream {
    /// Entstehung von Störungen und Baustellen (M8.2).
    Disruption,
    /// Tagesaktuelle, modellierte Langsamfahrstellen und Sonderbedingungen.
    DailyRestriction,
    /// Auflösung exakter Gleichstände im `PlanningRun` (M3.5).
    Tiebreak,
    /// Nachfrageschwankung im Personen- und Güterverkehr (M10, M11).
    Demand,
    /// Fahrzeug- und Anlagenausfälle jenseits der Fristen (M5.4).
    Failure,
    /// Vergabekalender einer Welt (M6.3a).
    TenderRelease,
    /// Vergabeprofile der SPNV-Ausschreibungen (M6.4a).
    TenderProfile,
}

impl Substream {
    /// Alle derzeit definierten Ströme.
    ///
    /// Dient dem Nachweis, dass jeder Strom einen eigenen Namen hat — nicht
    /// der Iteration im Betrieb.
    pub const ALL: [Self; 7] = [
        Self::Disruption,
        Self::DailyRestriction,
        Self::Tiebreak,
        Self::Demand,
        Self::Failure,
        Self::TenderRelease,
        Self::TenderProfile,
    ];

    /// Der Name, aus dem der Strom abgeleitet wird.
    ///
    /// **Dieser Wert ist ein Datenformat.** Wer ihn ändert, verändert jede
    /// bereits gelaufene Welt rückwirkend. Umbenennen ist nur zulässig, wenn
    /// gleichzeitig die Ableitungsdomäne `zugfolge/substream/vN` hochgezählt
    /// wird.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Disruption => "disruption",
            Self::DailyRestriction => "daily_restriction",
            Self::Tiebreak => "tiebreak",
            Self::Demand => "demand",
            Self::Failure => "failure",
            Self::TenderRelease => "tender_release",
            Self::TenderProfile => "tender_profile",
        }
    }
}

/// Der Seed einer Welt für eine bestimmte Fahrplanperiode.
///
/// `docs/architektur.md`: „Ein Seed je Welt und Periode, aufgeteilt in
/// benannte Substreams." Beide Anteile gehen in die Ableitung ein, damit eine
/// neue Periode denselben Strom nicht fortsetzt — sonst wäre der
/// Vergabekalender der zweiten Periode aus dem der ersten vorhersagbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorldSeed {
    world: u64,
    period: u32,
}

impl WorldSeed {
    /// Erzeugt einen Seed aus Weltwert und Periodennummer.
    pub const fn new(world: u64, period: u32) -> Self {
        Self { world, period }
    }

    /// Der Weltanteil.
    pub const fn world(self) -> u64 {
        self.world
    }

    /// Die Periodennummer.
    pub const fn period(self) -> u32 {
        self.period
    }

    /// Derselbe Weltanteil, aber die angegebene Periode.
    pub const fn for_period(self, period: u32) -> Self {
        Self {
            world: self.world,
            period,
        }
    }

    /// Der Zufallsstrom eines benannten Substreams.
    pub fn substream(self, substream: Substream) -> Rng {
        self.named_substream(substream.name())
    }

    /// Der Zufallsstrom zu einem frei gewählten Namen.
    ///
    /// Für Ströme, die es als Variante (noch) nicht gibt — etwa in Tests oder
    /// in einem Wegwerf-Spike. Im Produktivpfad gehört jeder Strom in
    /// [`Substream`], sonst weiß niemand, welche Ströme eine Welt besitzt.
    pub fn named_substream(self, name: &str) -> Rng {
        let mut hasher = Sha256::new();
        hasher.update(SUBSTREAM_DOMAIN);
        hasher.update(self.world.to_be_bytes());
        hasher.update(self.period.to_be_bytes());
        hasher.update(
            u64::try_from(name.len())
                .expect("Name passt in 64 Bit")
                .to_be_bytes(),
        );
        hasher.update(name.as_bytes());
        let digest = hasher.finalize();

        let mut zustand = [0_u8; 8];
        zustand.copy_from_slice(&digest[..8]);
        Rng::from_state(u64::from_be_bytes(zustand))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{Substream, WorldSeed};

    fn erste_werte(seed: WorldSeed, substream: Substream) -> Vec<u64> {
        let mut rng = seed.substream(substream);
        (0..4).map(|_| rng.next_u64()).collect()
    }

    #[test]
    fn namen_sind_eindeutig() {
        let namen: BTreeSet<&str> = Substream::ALL.iter().map(|s| s.name()).collect();
        assert_eq!(
            namen.len(),
            Substream::ALL.len(),
            "zwei Ströme teilen sich einen Namen"
        );
    }

    #[test]
    fn gleicher_seed_gleicher_strom() {
        let seed = WorldSeed::new(42, 3);
        for substream in Substream::ALL {
            assert_eq!(erste_werte(seed, substream), erste_werte(seed, substream));
        }
    }

    #[test]
    fn stroeme_sind_untereinander_verschieden() {
        let seed = WorldSeed::new(42, 3);
        let werte: BTreeSet<Vec<u64>> = Substream::ALL
            .iter()
            .map(|&s| erste_werte(seed, s))
            .collect();
        assert_eq!(
            werte.len(),
            Substream::ALL.len(),
            "zwei Ströme laufen synchron"
        );
    }

    #[test]
    fn periode_verschiebt_den_strom() {
        let seed = WorldSeed::new(42, 3);
        assert_ne!(
            erste_werte(seed, Substream::Tiebreak),
            erste_werte(seed.for_period(4), Substream::Tiebreak),
            "die Folgeperiode wiederholt den Strom der Vorperiode"
        );
    }

    #[test]
    fn welt_verschiebt_den_strom() {
        assert_ne!(
            erste_werte(WorldSeed::new(42, 3), Substream::Demand),
            erste_werte(WorldSeed::new(43, 3), Substream::Demand),
        );
    }

    #[test]
    fn ein_neuer_strom_veraendert_die_bestehenden_nicht() {
        // Das ist der eigentliche Grund für die Ableitung über den Namen:
        // Ein zusätzlicher Strom darf keine bestehende Welt verändern.
        let seed = WorldSeed::new(42, 3);
        let vorher: Vec<Vec<u64>> = Substream::ALL
            .iter()
            .map(|&s| erste_werte(seed, s))
            .collect();

        let mut neuer = seed.named_substream("weather");
        let _ = neuer.next_u64();

        let nachher: Vec<Vec<u64>> = Substream::ALL
            .iter()
            .map(|&s| erste_werte(seed, s))
            .collect();
        assert_eq!(vorher, nachher);
    }

    #[test]
    fn verschiedene_namen_ergeben_verschiedene_stroeme() {
        // Das Längenpräfix vor dem Namen ist die Vorsorge dafür, dass später
        // ein weiteres Feld hinter den Namen tritt: Ohne Präfix wären dann
        // "tender" + "_release" und "tender_release" derselbe Hasheingang.
        let seed = WorldSeed::new(1, 1);
        assert_ne!(
            seed.named_substream("tender_release").next_u64(),
            seed.named_substream("tender").next_u64(),
        );
    }

    #[test]
    fn golden_vector_bleibt_sprachuebergreifend_stabil() {
        // Derselbe Vektor steht in packages/economy/src/m6.test.ts. Damit
        // brechen Rust und TypeScript bei jeder Byte-/Endian-Abweichung.
        let mut release = WorldSeed::new(42, 0).substream(Substream::TenderRelease);
        let mut profile = WorldSeed::new(42, 0).substream(Substream::TenderProfile);
        assert_eq!(release.next_u64(), 15_648_887_706_766_360_790);
        assert_eq!(profile.next_u64(), 2_062_826_105_575_757_761);
    }
}
