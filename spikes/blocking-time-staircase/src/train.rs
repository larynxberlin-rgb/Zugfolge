//! Zugcharakteristik und Zugfahrt.
//!
//! Der Spike kennt vom Zug nur, was die Sperrzeit braucht: Länge und
//! Höchstgeschwindigkeit. Masse, Anfahr- und Bremsvermögen, Antriebsart und
//! Zugsicherung gehören zur vollständigen `TrainCharacteristics` aus M1.9 und
//! fehlen hier **mit Absicht** — sie wirken erst über die Fahrdynamik (M1.10),
//! und die ist nicht Gegenstand dieses Spikes.

use zugfolge_determinism::SimTime;

use crate::network::{Direction, Itinerary, Network, ResourceId};

/// Die Eigenschaften eines Zuges, soweit die Sperrzeit sie braucht.
#[derive(Clone, Copy, Debug)]
pub struct TrainCharacteristics {
    /// Bezeichnung der Charakteristik, etwa `Triebzug 140`.
    pub name: &'static str,
    /// Zuglänge — geht über die Räumfahrzeit in jede Sperrzeit ein.
    pub length_mm: i64,
    /// Höchstgeschwindigkeit des Zuges.
    pub top_speed_mm_s: i64,
}

/// Eine Zugfahrt: Laufweg, Abfahrtszeit und Haltezeiten.
#[derive(Clone, Debug)]
pub struct TrainRun {
    /// Zugnummer. Die Systematik selbst entsteht in M3.2.
    pub number: &'static str,
    /// Die Zugcharakteristik.
    pub characteristics: TrainCharacteristics,
    /// Der Laufweg.
    pub itinerary: Itinerary,
    /// Abfahrt aus dem ersten Abschnitt des Laufwegs.
    pub departure: SimTime,
    /// Haltezeit je Abschnitt des Laufwegs, in Sekunden. Gleich lang wie
    /// [`Itinerary::sections`]; `0` bedeutet Durchfahrt.
    pub dwell_s: Vec<i64>,
}

impl TrainRun {
    /// Baut eine Zugfahrt und prüft, dass die Haltezeiten zum Laufweg passen.
    ///
    /// # Panics
    ///
    /// Wenn die Zahl der Haltezeiten nicht zur Zahl der Abschnitte passt.
    pub fn new(
        number: &'static str,
        characteristics: TrainCharacteristics,
        itinerary: Itinerary,
        departure: SimTime,
        dwell_s: Vec<i64>,
    ) -> Self {
        assert_eq!(
            itinerary.sections.len(),
            dwell_s.len(),
            "{number}: {} Abschnitte, aber {} Haltezeiten",
            itinerary.sections.len(),
            dwell_s.len()
        );
        Self {
            number,
            characteristics,
            itinerary,
            departure,
            dwell_s,
        }
    }

    /// Fahrtrichtung.
    pub const fn direction(&self) -> Direction {
        self.itinerary.direction
    }

    /// Dieselbe Fahrt, um `seconds` später.
    #[must_use]
    pub fn shifted(&self, seconds: i64) -> Self {
        Self {
            number: self.number,
            characteristics: self.characteristics,
            itinerary: self.itinerary.clone(),
            departure: self.departure.plus_seconds(seconds),
            dwell_s: self.dwell_s.clone(),
        }
    }

    /// Die Geschwindigkeit, mit der dieser Zug den Abschnitt befährt: das
    /// Kleinere aus Streckengeschwindigkeit und Höchstgeschwindigkeit.
    pub fn speed_in(&self, network: &Network, section: ResourceId) -> i64 {
        network
            .section(section)
            .max_speed_mm_s
            .min(self.characteristics.top_speed_mm_s)
    }
}

/// Der Regionalzug des Spikes: 140 m lang, 140 km/h.
pub const REGIONAL_TRAIN: TrainCharacteristics = TrainCharacteristics {
    name: "Triebzug 140",
    length_mm: 140_000,
    top_speed_mm_s: 38_889,
};

#[cfg(test)]
mod tests {
    use zugfolge_determinism::SimTime;

    use super::{REGIONAL_TRAIN, TrainRun};
    use crate::network::{Direction, Network};

    #[test]
    fn die_geschwindigkeit_ist_das_minimum_aus_zug_und_strecke() {
        let netz = Network::example();
        let laufweg = netz.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]);
        let fahrt = TrainRun::new(
            "RB 26801",
            REGIONAL_TRAIN,
            laufweg,
            SimTime::from_seconds(0),
            vec![0; 8],
        );

        let strecke = fahrt.speed_in(&netz, fahrt.itinerary.sections[1]);
        assert_eq!(
            strecke, REGIONAL_TRAIN.top_speed_mm_s,
            "auf der 160er Strecke begrenzt der Zug"
        );

        let bahnhof = fahrt.speed_in(&netz, fahrt.itinerary.sections[0]);
        assert!(
            bahnhof < REGIONAL_TRAIN.top_speed_mm_s,
            "im Bahnhof begrenzt das Gleis"
        );
    }

    #[test]
    #[should_panic(expected = "8 Abschnitte, aber 2 Haltezeiten")]
    fn haltezeiten_muessen_zum_laufweg_passen() {
        let netz = Network::example();
        let laufweg = netz.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]);
        let _ = TrainRun::new(
            "RB 26801",
            REGIONAL_TRAIN,
            laufweg,
            SimTime::from_seconds(0),
            vec![0, 0],
        );
    }
}
