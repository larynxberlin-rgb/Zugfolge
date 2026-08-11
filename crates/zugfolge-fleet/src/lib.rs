//! Fahrzeugkatalog, individuelle Flotte und Betriebsplanung — **M5.1 bis M5.14**.
//!
//! [`VehicleCatalogRelease`] trennt faktische Baureihe und fiktiven Handelsnamen,
//! führt Bau- und Marktzeiträume sowie exakt belegte Zugsicherungsoptionen.
//! [`VehicleAsset`] macht daraus weltgebundene Einzelfahrzeuge mit Eigentum,
//! Zulassungen und Fristen. Die bestehende Konfiguration trennt die beim Bau
//! festgelegten Türen vom später umbaubaren Innenraum; Umbauten sind
//! reservierte, kostenpflichtige Werkstattaufträge.

mod assets;
mod catalog;
mod market;
mod mobilization;
mod operations;

pub use assets::{
    AssetError, FleetSnapshot, MaintenanceDeadline, OwnershipStatus, VehicleApproval, VehicleAsset,
};
pub use catalog::{
    CatalogError, CatalogSource, CatalogSourceId, MarketAvailability, MarketEvidence,
    OPEN_ENDED_YEAR, ProcurementChannel, ProtectionEquipment, ProtectionFitment, ProtectionOption,
    VehicleCatalogBuilder, VehicleCatalogEntry, VehicleCatalogRelease, VehicleEra, VehicleTypeId,
    VehicleWorldSettings, YearRange,
};
pub use market::{
    CONDITION_MAX, LeaseReturnReason, LessorProfile, PersistentVehicle, PersistentVehicleMarket,
    ServerLeaseQuote, TrafficKind, VehicleCondition, VehicleLifeEvent, VehicleLifeEventKind,
    VehicleMarketError, VehicleMarketStatus, default_server_lessors,
};
pub use mobilization::*;
pub use operations::*;

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use zugfolge_infra::{FacilityCatalog, FacilityId, FacilityKind, FleetClass, Length, TimeOfDay};

/// Stabile Weltkennung (Invariante 4).
pub type WorldId = u64;
/// Stabile Fahrzeugkennung.
pub type VehicleId = u64;
/// Stabile Umbaukennung.
pub type ConversionId = u64;
/// Simulationssekunden seit Weltepoche.
pub type SimTime = i64;

/// Bestuhlungsdichte.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeatingDensity {
    /// Hohe Kapazität, niedrigerer Komfort.
    Dense,
    /// Ausgewogene Regelbestuhlung.
    Standard,
    /// Mehr Abstand und Komfort.
    Spacious,
}

/// Sitzart und Anordnung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeatType {
    /// Reihensitze.
    Row,
    /// Gegenübersitzende Vis-à-vis-Gruppen.
    FaceToFace,
    /// Klappsitze in flexibel nutzbaren Bereichen.
    Folding,
}

/// Optionale Innenraumausstattung.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Amenity {
    /// Klimatisierung.
    AirConditioning,
    /// Drahtloser Internetzugang.
    Wifi,
    /// Steckdosen am Platz.
    PowerSockets,
    /// Dynamische Fahrgastinformation.
    PassengerInformation,
}

/// Ein Mehrzweckbereich in Plätzen.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MultipurposeArea {
    /// Fahrradplätze.
    pub bicycles: u16,
    /// Kinderwagenplätze.
    pub pushchairs: u16,
    /// Rollstuhlplätze.
    pub wheelchairs: u16,
    /// Stehplätze.
    pub standing: u16,
}

/// Baulich unveränderliche Fahrzeugmerkmale.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuralConfiguration {
    door_count_per_side: u8,
    door_width_mm: u16,
    body_length: Length,
}

impl StructuralConfiguration {
    /// Baut eine Grundauslegung. Türen und Wagenkasten müssen positiv sein.
    pub fn new(
        door_count_per_side: u8,
        door_width_mm: u16,
        body_length: Length,
    ) -> Result<Self, FleetError> {
        if door_count_per_side == 0 || door_width_mm == 0 || !body_length.is_positive() {
            return Err(FleetError::InvalidStructuralConfiguration);
        }
        Ok(Self {
            door_count_per_side,
            door_width_mm,
            body_length,
        })
    }
    /// Türen je Fahrzeugseite.
    pub const fn door_count_per_side(&self) -> u8 {
        self.door_count_per_side
    }
    /// Lichte Breite einer Tür in Millimetern.
    pub const fn door_width_mm(&self) -> u16 {
        self.door_width_mm
    }
    /// Wagenkastenlänge.
    pub const fn body_length(&self) -> Length {
        self.body_length
    }
    /// Gesamte Türbreite einer Bahnsteigseite.
    pub const fn total_door_width_mm(&self) -> u32 {
        self.door_count_per_side as u32 * self.door_width_mm as u32
    }
}

/// Der in einer Werkstatt veränderliche Innenraum.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InteriorConfiguration {
    /// Sitze erster Klasse.
    pub first_class_seats: u16,
    /// Sitze zweiter Klasse.
    pub second_class_seats: u16,
    /// Bestuhlungsdichte.
    pub density: SeatingDensity,
    /// Sitzart.
    pub seat_type: SeatType,
    /// Mehrzweckplätze.
    pub multipurpose: MultipurposeArea,
    /// Zahl der Toiletten.
    pub toilets: u8,
    /// Davon barrierefreie Toiletten.
    pub accessible_toilets: u8,
    /// Ausstattungsmerkmale als deterministisch geordnete Menge.
    pub amenities: BTreeSet<Amenity>,
}

impl InteriorConfiguration {
    /// Prüft die inneren Zusicherungen des Innenraums.
    pub fn validate(&self) -> Result<(), FleetError> {
        if self.first_class_seats == 0
            && self.second_class_seats == 0
            && self.multipurpose.standing == 0
        {
            return Err(FleetError::EmptyPassengerArea);
        }
        if self.accessible_toilets > self.toilets {
            return Err(FleetError::InvalidAccessibleToilets);
        }
        Ok(())
    }
    /// Gesamte Sitzplatzzahl.
    pub const fn seats(&self) -> u32 {
        self.first_class_seats as u32 + self.second_class_seats as u32
    }
}

/// Vollständige Fahrzeugkonfiguration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleConfiguration {
    structural: StructuralConfiguration,
    interior: InteriorConfiguration,
}

impl VehicleConfiguration {
    /// Verbindet feste Grundauslegung und geprüften Innenraum.
    pub fn new(
        structural: StructuralConfiguration,
        interior: InteriorConfiguration,
    ) -> Result<Self, FleetError> {
        interior.validate()?;
        Ok(Self {
            structural,
            interior,
        })
    }
    /// Feste Grundauslegung.
    pub const fn structural(&self) -> &StructuralConfiguration {
        &self.structural
    }
    /// Veränderlicher Innenraum.
    pub const fn interior(&self) -> &InteriorConfiguration {
        &self.interior
    }

    /// Mindesthaltezeit in Sekunden.
    ///
    /// Der Fahrgastwechsel wird durch die gesamte lichte Türbreite geteilt und
    /// stets aufgerundet. Mehr oder breitere Türen verkürzen damit nachweisbar
    /// die Haltezeit; Grundzeit und Barrierefreiheitszuschlag bleiben explizit.
    pub fn dwell_time_seconds(
        &self,
        boarding: u32,
        alighting: u32,
        accessibility_boardings: u16,
    ) -> u32 {
        let passenger_mm = boarding.saturating_add(alighting).saturating_mul(1_000);
        let exchange = passenger_mm.div_ceil(self.structural.total_door_width_mm());
        15_u32
            .saturating_add(exchange)
            .saturating_add(u32::from(accessibility_boardings).saturating_mul(8))
    }
}

/// Individuelles Fahrzeugasset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vehicle {
    /// Weltzugehörigkeit.
    pub world_id: WorldId,
    /// Fahrzeugkennung.
    pub id: VehicleId,
    /// Baureihe.
    pub fleet_class: FleetClass,
    /// Fahrzeuglänge.
    pub length: Length,
    configuration: VehicleConfiguration,
}

impl Vehicle {
    /// Erzeugt ein individuelles Fahrzeug mit seiner aktuellen Konfiguration.
    pub fn new(
        world_id: WorldId,
        id: VehicleId,
        fleet_class: FleetClass,
        length: Length,
        configuration: VehicleConfiguration,
    ) -> Result<Self, FleetError> {
        if !length.is_positive() || length != configuration.structural.body_length() {
            return Err(FleetError::VehicleLengthMismatch);
        }
        Ok(Self {
            world_id,
            id,
            fleet_class,
            length,
            configuration,
        })
    }
    /// Aktuelle Konfiguration.
    pub const fn configuration(&self) -> &VehicleConfiguration {
        &self.configuration
    }
}

/// Kosten- und Zeitregeln eines Umbaus, versioniert vom Aufrufer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversionQuote {
    /// Preis in Integer-Cent.
    pub cost_cents: i64,
    /// Werkstattdauer in Sekunden.
    pub duration_seconds: u32,
}

/// Reservierter Werkstattauftrag.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionOrder {
    /// Weltzugehörigkeit.
    pub world_id: WorldId,
    /// Auftragskennung.
    pub id: ConversionId,
    /// Fahrzeug.
    pub vehicle_id: VehicleId,
    /// Werkstatt.
    pub facility_id: FacilityId,
    /// Beginn (inklusive).
    pub starts_at: SimTime,
    /// Ende (exklusive).
    pub ends_at: SimTime,
    /// Preis in Cent.
    pub cost_cents: i64,
    target: InteriorConfiguration,
    completed: bool,
}

/// Port zum doppelt geführten Ledger: Ein Umbau wird vor seiner Übernahme
/// tatsächlich in Integer-Cent belastet.
pub trait ConversionLedger {
    /// Belastet das EVU in der genannten Welt. Ein Fehler lässt Auftrag und
    /// Fahrzeug unverändert.
    fn debit_conversion(
        &mut self,
        world_id: WorldId,
        vehicle_id: VehicleId,
        conversion_id: ConversionId,
        amount_cents: i64,
    ) -> Result<(), FleetError>;
}

/// Deterministisches Belegungsbuch für Werkstattumbauten.
#[derive(Default)]
pub struct WorkshopSchedule {
    orders: BTreeMap<(WorldId, ConversionId), ConversionOrder>,
}

impl WorkshopSchedule {
    /// Reserviert einen Umbau und belastet dabei noch kein externes Ledger.
    #[allow(
        clippy::too_many_arguments,
        reason = "Auftrag, Fahrzeug, Anlage und explizite Simulationszeit sind getrennte Domänenwerte"
    )]
    pub fn schedule(
        &mut self,
        world_id: WorldId,
        id: ConversionId,
        vehicle: &Vehicle,
        facility_id: FacilityId,
        starts_at: SimTime,
        target: InteriorConfiguration,
        quote: ConversionQuote,
        facilities: &FacilityCatalog,
    ) -> Result<&ConversionOrder, FleetError> {
        if vehicle.world_id != world_id {
            return Err(FleetError::WrongWorld);
        }
        target.validate()?;
        if quote.cost_cents < 0 || quote.duration_seconds == 0 {
            return Err(FleetError::InvalidQuote);
        }
        let facility = facilities
            .facility(facility_id)
            .ok_or(FleetError::UnknownFacility)?;
        if facility.kind() != FacilityKind::Workshop {
            return Err(FleetError::NotAWorkshop);
        }
        if !facility.accommodates(&vehicle.fleet_class, vehicle.length) {
            return Err(FleetError::WorkshopIncompatible);
        }
        let ends_at = starts_at
            .checked_add(i64::from(quote.duration_seconds))
            .ok_or(FleetError::InvalidTime)?;
        if starts_at < 0 || !window_is_open(facility, starts_at, ends_at) {
            return Err(FleetError::WorkshopClosed);
        }
        let overlapping = self
            .orders
            .values()
            .filter(|o| {
                o.world_id == world_id
                    && o.facility_id == facility_id
                    && o.starts_at < ends_at
                    && starts_at < o.ends_at
            })
            .count();
        let capacity =
            usize::try_from(facility.capacity()).map_err(|_| FleetError::CapacityExhausted)?;
        if overlapping >= capacity {
            return Err(FleetError::CapacityExhausted);
        }
        if self.orders.contains_key(&(world_id, id)) {
            return Err(FleetError::DuplicateOrder);
        }
        if self.orders.values().any(|o| {
            o.world_id == world_id
                && o.vehicle_id == vehicle.id
                && o.starts_at < ends_at
                && starts_at < o.ends_at
        }) {
            return Err(FleetError::VehicleUnavailable);
        }
        let order = ConversionOrder {
            world_id,
            id,
            vehicle_id: vehicle.id,
            facility_id,
            starts_at,
            ends_at,
            cost_cents: quote.cost_cents,
            target,
            completed: false,
        };
        self.orders.insert((world_id, id), order);
        Ok(self
            .orders
            .get(&(world_id, id))
            .expect("soeben eingefügter Auftrag"))
    }

    /// Schließt einen fälligen Auftrag ab und liefert die zu buchenden Kosten.
    pub fn complete(
        &mut self,
        world_id: WorldId,
        id: ConversionId,
        at: SimTime,
        vehicle: &mut Vehicle,
        ledger: &mut impl ConversionLedger,
    ) -> Result<(), FleetError> {
        let order = self
            .orders
            .get_mut(&(world_id, id))
            .ok_or(FleetError::UnknownOrder)?;
        if vehicle.world_id != world_id || vehicle.id != order.vehicle_id {
            return Err(FleetError::WrongVehicle);
        }
        if at < order.ends_at {
            return Err(FleetError::OrderNotDue);
        }
        if order.completed {
            return Err(FleetError::OrderAlreadyCompleted);
        }
        ledger.debit_conversion(world_id, vehicle.id, id, order.cost_cents)?;
        vehicle.configuration = VehicleConfiguration::new(
            vehicle.configuration.structural.clone(),
            order.target.clone(),
        )?;
        order.completed = true;
        Ok(())
    }
}

fn window_is_open(facility: &zugfolge_infra::Facility, starts: SimTime, ends: SimTime) -> bool {
    if ends <= starts {
        return false;
    }
    match facility.opening_hours() {
        zugfolge_infra::OpeningHours::Continuous => true,
        zugfolge_infra::OpeningHours::Daily { opens, closes } => {
            let day = i64::from(TimeOfDay::SECONDS_PER_DAY);
            let start = starts.rem_euclid(day);
            let open = i64::from(opens.seconds_since_midnight());
            let close = i64::from(closes.seconds_since_midnight());
            let available = if open < close {
                if start < open || start >= close {
                    return false;
                }
                close - start
            } else if start >= open {
                day - start + close
            } else if start < close {
                close - start
            } else {
                return false;
            };
            ends - starts <= available
        }
    }
}

/// Fehler der Fahrzeugkonfiguration und Umbauplanung.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "die selbsterklärenden Fehlernamen sind Teil der öffentlichen Diagnose"
)]
pub enum FleetError {
    InvalidStructuralConfiguration,
    EmptyPassengerArea,
    InvalidAccessibleToilets,
    VehicleLengthMismatch,
    WrongWorld,
    InvalidQuote,
    InvalidTime,
    UnknownFacility,
    NotAWorkshop,
    WorkshopIncompatible,
    WorkshopClosed,
    CapacityExhausted,
    DuplicateOrder,
    VehicleUnavailable,
    UnknownOrder,
    WrongVehicle,
    OrderNotDue,
    OrderAlreadyCompleted,
}

impl fmt::Display for FleetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl Error for FleetError {}

#[cfg(test)]
mod tests;
