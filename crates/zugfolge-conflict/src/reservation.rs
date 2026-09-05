//! Kapazitätsfähige Reservierungen für Fahrweg-nahe Ressourcen.
//!
//! Zugfahrten verwenden weiterhin die fachlich reichere Sperrzeitentreppe.
//! Anlagen, Abstellung und automatisiertes Rangieren benötigen dagegen ein
//! direktes halboffenes Intervall mit Kapazität. Beide Pfade verwenden
//! [`ConflictResource`] und liegen bewusst in derselben Konfliktengine.

use std::collections::BTreeMap;

use zugfolge_determinism::SimTime;

use crate::{ConflictResource, ResourceExclusions};

/// Weltweit nur zusammen mit `world_id` eindeutige Reservierungskennung.
pub type ResourceReservationId = u64;

/// Eine Belegung einer Konfliktressource im halboffenen Intervall `[start,end)`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceReservation {
    /// Welt der Belegung (Invariante 4).
    pub world_id: u64,
    /// Kennung innerhalb der Welt.
    pub id: ResourceReservationId,
    /// Belegte Ressource.
    pub resource: ConflictResource,
    /// Beginn einschließlich.
    pub starts_at: SimTime,
    /// Ende ausschließlich.
    pub ends_at: SimTime,
}

impl ResourceReservation {
    /// Baut ein geprüftes, nicht leeres Intervall.
    pub fn new(
        world_id: u64,
        id: ResourceReservationId,
        resource: ConflictResource,
        starts_at: SimTime,
        ends_at: SimTime,
    ) -> Result<Self, CapacityConflict> {
        if ends_at <= starts_at {
            return Err(CapacityConflict::InvalidInterval);
        }
        Ok(Self {
            world_id,
            id,
            resource,
            starts_at,
            ends_at,
        })
    }

    fn overlaps(self, other: Self) -> bool {
        self.starts_at < other.ends_at && other.starts_at < self.ends_at
    }
}

/// Erklärbarer Ablehnungsgrund der kapazitätsfähigen Engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapacityConflict {
    /// Das Intervall ist leer oder rückwärts.
    InvalidInterval,
    /// Für eine Ressource wurde Kapazität null konfiguriert.
    InvalidCapacity,
    /// Dieselbe Kennung existiert in dieser Welt bereits.
    DuplicateReservation,
    /// Kapazität der Ressource oder einer Ausschlussressource ist ausgeschöpft.
    Exhausted {
        /// Angefragte Ressource.
        resource: ConflictResource,
        /// Beginn der kollidierenden Spanne.
        starts_at: SimTime,
        /// Ende der kollidierenden Spanne.
        ends_at: SimTime,
        /// Konfigurierte Parallelkapazität.
        capacity: u32,
    },
    /// Die freizugebende Reservierung ist unbekannt.
    UnknownReservation,
}

/// Gemeinsames Belegungsbuch für Anlagen und kurzzeitige Betriebsbelegungen.
#[derive(Clone, Debug, Default)]
pub struct CapacityLedger {
    exclusions: ResourceExclusions,
    capacities: BTreeMap<(u64, ConflictResource), u32>,
    reservations: BTreeMap<(u64, ResourceReservationId), ResourceReservation>,
}

impl CapacityLedger {
    /// Belegungsbuch mit Fahrstraßenausschlüssen des Infra-Releases.
    pub fn new(exclusions: ResourceExclusions) -> Self {
        Self {
            exclusions,
            capacities: BTreeMap::new(),
            reservations: BTreeMap::new(),
        }
    }

    /// Setzt die Parallelkapazität einer Ressource in genau einer Welt.
    pub fn set_capacity(
        &mut self,
        world_id: u64,
        resource: ConflictResource,
        capacity: u32,
    ) -> Result<(), CapacityConflict> {
        if capacity == 0 {
            return Err(CapacityConflict::InvalidCapacity);
        }
        let previous = self
            .capacities
            .get(&(world_id, resource))
            .copied()
            .unwrap_or(1);
        if capacity < previous {
            let intervals = self
                .reservations(world_id)
                .filter(|reservation| reservation.resource == resource)
                .map(|reservation| (reservation.starts_at, reservation.ends_at));
            if let Some((starts_at, ends_at)) = first_capacity_conflict(intervals, capacity) {
                return Err(CapacityConflict::Exhausted {
                    resource,
                    starts_at,
                    ends_at,
                    capacity,
                });
            }
        }
        self.capacities.insert((world_id, resource), capacity);
        Ok(())
    }

    /// Prüft und übernimmt eine Belegung atomar.
    pub fn try_reserve(
        &mut self,
        reservation: ResourceReservation,
    ) -> Result<(), CapacityConflict> {
        if reservation.ends_at <= reservation.starts_at {
            return Err(CapacityConflict::InvalidInterval);
        }
        let key = (reservation.world_id, reservation.id);
        if self.reservations.contains_key(&key) {
            return Err(CapacityConflict::DuplicateReservation);
        }
        let mut incompatible = vec![reservation.resource];
        incompatible.extend(self.exclusions.excluded_by(reservation.resource));
        for resource in incompatible {
            let capacity = self
                .capacities
                .get(&(reservation.world_id, resource))
                .copied()
                .unwrap_or(1);
            let intervals = self
                .reservations(reservation.world_id)
                .filter(|existing| {
                    existing.resource == resource && reservation.overlaps(**existing)
                })
                .map(|existing| {
                    (
                        existing.starts_at.max(reservation.starts_at),
                        existing.ends_at.min(reservation.ends_at),
                    )
                })
                .chain([(reservation.starts_at, reservation.ends_at)]);
            if let Some((starts_at, ends_at)) = first_capacity_conflict(intervals, capacity) {
                return Err(CapacityConflict::Exhausted {
                    resource,
                    starts_at,
                    ends_at,
                    capacity,
                });
            }
        }
        self.reservations.insert(key, reservation);
        Ok(())
    }

    /// Gibt eine bestehende Belegung frei.
    pub fn release(
        &mut self,
        world_id: u64,
        id: ResourceReservationId,
    ) -> Result<ResourceReservation, CapacityConflict> {
        self.reservations
            .remove(&(world_id, id))
            .ok_or(CapacityConflict::UnknownReservation)
    }

    /// Alle Belegungen einer Welt in stabiler Kennungsreihenfolge.
    pub fn reservations(&self, world_id: u64) -> impl Iterator<Item = &ResourceReservation> {
        self.reservations
            .range((world_id, 0)..=(world_id, u64::MAX))
            .map(|(_, value)| value)
    }
}

/// Prüft Gleichzeitigkeit statt der Gesamtzahl überlappender Termine. Enden
/// stehen bei gleicher Zeit vor Anfängen: `[a,b)` und `[b,c)` teilen keinen Platz.
fn first_capacity_conflict(
    intervals: impl Iterator<Item = (SimTime, SimTime)>,
    capacity: u32,
) -> Option<(SimTime, SimTime)> {
    let mut changes: Vec<_> = intervals
        .flat_map(|(start, end)| [(start, 1_i64), (end, -1)])
        .collect();
    changes.sort_unstable();
    let mut occupied = 0_i64;
    for span in changes.windows(2) {
        let (starts_at, change) = span[0];
        let ends_at = span[1].0;
        occupied += change;
        if occupied > i64::from(capacity) && starts_at < ends_at {
            return Some((starts_at, ends_at));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use zugfolge_infra::FacilityId;

    fn at(seconds: i64) -> SimTime {
        SimTime::from_seconds(seconds)
    }

    #[test]
    fn halboffene_intervalle_und_kapazitaet_gelten_weltisoliert() {
        let resource = ConflictResource::Facility(FacilityId::new(7));
        let mut ledger = CapacityLedger::default();
        ledger.set_capacity(1, resource, 2).unwrap();
        ledger
            .try_reserve(ResourceReservation::new(1, 1, resource, at(0), at(10)).unwrap())
            .unwrap();
        ledger
            .try_reserve(ResourceReservation::new(1, 2, resource, at(0), at(10)).unwrap())
            .unwrap();
        assert!(matches!(
            ledger.try_reserve(ResourceReservation::new(1, 3, resource, at(5), at(6)).unwrap()),
            Err(CapacityConflict::Exhausted { capacity: 2, .. })
        ));
        ledger
            .try_reserve(ResourceReservation::new(1, 4, resource, at(10), at(20)).unwrap())
            .unwrap();
        ledger
            .try_reserve(ResourceReservation::new(2, 1, resource, at(5), at(6)).unwrap())
            .unwrap();
    }

    #[test]
    fn aufeinanderfolgende_termine_belegen_nur_einen_parallelen_platz() {
        let resource = ConflictResource::Facility(FacilityId::new(7));
        let mut ledger = CapacityLedger::default();
        ledger.set_capacity(1, resource, 2).unwrap();
        for (id, start, end) in [(1, 0, 10), (2, 10, 20), (3, 0, 20)] {
            ledger
                .try_reserve(ResourceReservation::new(1, id, resource, at(start), at(end)).unwrap())
                .unwrap();
        }
        assert_eq!(
            ledger.try_reserve(ResourceReservation::new(1, 4, resource, at(5), at(15)).unwrap()),
            Err(CapacityConflict::Exhausted {
                resource,
                starts_at: at(5),
                ends_at: at(10),
                capacity: 2
            })
        );
        assert!(ledger.set_capacity(1, resource, 1).is_err());
        assert_eq!(ledger.reservations(1).count(), 3);
        ledger.release(1, 3).unwrap();
        ledger.set_capacity(1, resource, 1).unwrap();
    }

    #[test]
    fn direkt_erzeugte_ungueltige_intervalle_bleiben_atomare_ablehnungen() {
        let mut ledger = CapacityLedger::default();
        for end in [0, -1] {
            assert_eq!(
                ledger.try_reserve(ResourceReservation {
                    world_id: 1,
                    id: 1,
                    resource: ConflictResource::Facility(FacilityId::new(7)),
                    starts_at: at(0),
                    ends_at: at(end),
                }),
                Err(CapacityConflict::InvalidInterval)
            );
        }
        assert_eq!(ledger.reservations(1).count(), 0);
    }
}
