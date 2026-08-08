//! Individuelle Fahrzeugassets und deterministischer Flottensnapshot — **M5.1**.
//!
//! Ein Katalogtyp ist noch kein Fahrzeug. Erst dieses Modul bindet ihn an eine
//! Welt, ein konkretes Bau- und Beschaffungsjahr, Eigentum oder Leasing,
//! Zulassungen, Wartungsfristen und die tatsächlich eingebaute Zugsicherung.
//! Gebraucht- und Leasingfahrzeuge behalten ihre vorgefundene Ausrüstung; eine
//! freie Neukonfiguration findet auf dem Sekundärmarkt ausdrücklich nicht statt.

use core::convert::Infallible;
use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;

use zugfolge_determinism::{
    DeterministicModel, SimTime as DeterministicSimTime, StateHash, StateHasher,
};
use zugfolge_infra::{FleetClass, ProtectionSystem, TrainProtection};

use crate::catalog::{
    ProcurementChannel, VehicleCatalogEntry, VehicleCatalogRelease, VehicleTypeId,
    VehicleWorldSettings,
};
use crate::{SimTime, VehicleId, WorldId};

/// Eigentumsstatus eines individuellen Fahrzeugs.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum OwnershipStatus {
    /// Fahrzeug im Eigentum des EVU.
    Owned,
    /// Fahrzeug für die Leasingdauer im Besitz des EVU.
    Leased,
}

impl OwnershipStatus {
    const fn tag(self) -> &'static str {
        match self {
            Self::Owned => "owned",
            Self::Leased => "leased",
        }
    }
}

/// Zulassung oder Einsatzfreigabe eines individuellen Fahrzeugs.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct VehicleApproval(String);

impl VehicleApproval {
    /// Prüft und übernimmt eine kurze, stabile Zulassungskennung.
    pub fn new(code: impl Into<String>) -> Result<Self, AssetError> {
        let code = code.into();
        if code.trim().is_empty() || code.chars().count() > 64 {
            return Err(AssetError::InvalidApproval);
        }
        Ok(Self(code))
    }

    /// Die Zulassungskennung.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Eine fällige Wartungsfrist eines individuellen Fahrzeugs.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MaintenanceDeadline {
    kind: String,
    due_at: SimTime,
}

impl MaintenanceDeadline {
    /// Baut eine benannte Frist in expliziter Simulationszeit.
    pub fn new(kind: impl Into<String>, due_at: SimTime) -> Result<Self, AssetError> {
        let kind = kind.into();
        if kind.trim().is_empty() || due_at < 0 {
            return Err(AssetError::InvalidMaintenanceDeadline);
        }
        Ok(Self { kind, due_at })
    }

    /// Stabile Fristart.
    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// Fälligkeit in Simulationssekunden seit Weltepoche.
    pub const fn due_at(&self) -> SimTime {
        self.due_at
    }
}

/// Ein konkretes, weltgebundenes Fahrzeug.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleAsset {
    world_id: WorldId,
    id: VehicleId,
    vehicle_type_id: VehicleTypeId,
    class_designation: FleetClass,
    trade_name: String,
    build_year: u16,
    acquisition_year: u16,
    procurement_channel: ProcurementChannel,
    ownership: OwnershipStatus,
    approvals: BTreeSet<VehicleApproval>,
    maintenance_deadlines: BTreeMap<String, MaintenanceDeadline>,
    installed_protection: TrainProtection,
    catalog_checksum: StateHash,
}

impl VehicleAsset {
    /// Kauft ein neues Fahrzeug und übernimmt ausschließlich zulässige
    /// Werksoptionen des genauen Typs.
    #[allow(
        clippy::too_many_arguments,
        reason = "Welt, Asset, Katalogtyp, Jahr, Werksoptionen, Zulassungen und Fristen sind getrennte Fachwerte"
    )]
    pub fn buy_new(
        catalog: &VehicleCatalogRelease,
        settings: VehicleWorldSettings,
        world_id: WorldId,
        id: VehicleId,
        vehicle_type_id: VehicleTypeId,
        year: u16,
        requested_factory_options: impl IntoIterator<Item = ProtectionSystem>,
        approvals: impl IntoIterator<Item = VehicleApproval>,
        maintenance_deadlines: impl IntoIterator<Item = MaintenanceDeadline>,
    ) -> Result<Self, AssetError> {
        let entry = catalog
            .vehicle(vehicle_type_id)
            .ok_or(AssetError::UnknownVehicleType)?;
        validate_years(entry, settings, ProcurementChannel::NewBuild, year, year)?;
        let standard: BTreeSet<_> = entry.protection().standard_systems().collect();
        let requested: BTreeSet<_> = requested_factory_options.into_iter().collect();
        for system in &requested {
            if standard.contains(system) {
                return Err(AssetError::ProtectionAlreadyStandard);
            }
            if !entry.protection().is_factory_option(*system, year) {
                return Err(AssetError::NotAFactoryOption);
            }
        }
        let installed_protection =
            TrainProtection::from_systems(standard.into_iter().chain(requested));
        Self::from_validated(
            catalog,
            entry,
            world_id,
            id,
            year,
            year,
            ProcurementChannel::NewBuild,
            OwnershipStatus::Owned,
            installed_protection,
            approvals,
            maintenance_deadlines,
        )
    }

    /// Übernimmt ein vorhandenes Leasing- oder Gebrauchtfahrzeug mit seiner
    /// **tatsächlich vorgefundenen** Zugsicherung.
    #[allow(
        clippy::too_many_arguments,
        reason = "Welt, Asset, Katalogtyp, Bau-/Beschaffungsjahr, Markt, Ist-Ausrüstung, Zulassungen und Fristen sind getrennte Fachwerte"
    )]
    pub fn acquire_secondary(
        catalog: &VehicleCatalogRelease,
        settings: VehicleWorldSettings,
        world_id: WorldId,
        id: VehicleId,
        vehicle_type_id: VehicleTypeId,
        build_year: u16,
        acquisition_year: u16,
        channel: ProcurementChannel,
        installed_protection: TrainProtection,
        approvals: impl IntoIterator<Item = VehicleApproval>,
        maintenance_deadlines: impl IntoIterator<Item = MaintenanceDeadline>,
    ) -> Result<Self, AssetError> {
        if channel == ProcurementChannel::NewBuild {
            return Err(AssetError::NotSecondaryMarket);
        }
        let entry = catalog
            .vehicle(vehicle_type_id)
            .ok_or(AssetError::UnknownVehicleType)?;
        validate_years(entry, settings, channel, build_year, acquisition_year)?;
        for system in entry.protection().standard_systems() {
            if !installed_protection.contains(system) {
                return Err(AssetError::MissingStandardProtection);
            }
        }
        for system in installed_protection.systems() {
            if !entry.protection().historical_installation_is_plausible(
                system,
                build_year,
                acquisition_year,
            ) {
                return Err(AssetError::UnsupportedProtection);
            }
        }
        let ownership = match channel {
            ProcurementChannel::Leasing => OwnershipStatus::Leased,
            ProcurementChannel::Used => OwnershipStatus::Owned,
            ProcurementChannel::NewBuild => return Err(AssetError::NotSecondaryMarket),
        };
        Self::from_validated(
            catalog,
            entry,
            world_id,
            id,
            build_year,
            acquisition_year,
            channel,
            ownership,
            installed_protection,
            approvals,
            maintenance_deadlines,
        )
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "nur gemeinsamer, bereits validierter Konstruktionspfad der beiden öffentlichen Beschaffungswege"
    )]
    fn from_validated(
        catalog: &VehicleCatalogRelease,
        entry: &VehicleCatalogEntry,
        world_id: WorldId,
        id: VehicleId,
        build_year: u16,
        acquisition_year: u16,
        procurement_channel: ProcurementChannel,
        ownership: OwnershipStatus,
        installed_protection: TrainProtection,
        approvals: impl IntoIterator<Item = VehicleApproval>,
        maintenance_deadlines: impl IntoIterator<Item = MaintenanceDeadline>,
    ) -> Result<Self, AssetError> {
        if id == 0 {
            return Err(AssetError::InvalidVehicleId);
        }
        let approvals = approvals.into_iter().collect();
        let mut deadlines = BTreeMap::new();
        for deadline in maintenance_deadlines {
            if deadlines.insert(deadline.kind.clone(), deadline).is_some() {
                return Err(AssetError::DuplicateMaintenanceDeadline);
            }
        }
        Ok(Self {
            world_id,
            id,
            vehicle_type_id: entry.id(),
            class_designation: entry.class_designation().clone(),
            trade_name: entry.trade_name().to_owned(),
            build_year,
            acquisition_year,
            procurement_channel,
            ownership,
            approvals,
            maintenance_deadlines: deadlines,
            installed_protection,
            catalog_checksum: catalog.checksum(),
        })
    }

    /// Baut eine nachweislich für diesen Typ freigegebene Zugsicherung in der
    /// Werkstatt nach. Eine Werksoption allein genügt hierfür nicht.
    pub fn install_protection_retrofit(
        &mut self,
        catalog: &VehicleCatalogRelease,
        year: u16,
        system: ProtectionSystem,
    ) -> Result<(), AssetError> {
        if catalog.checksum() != self.catalog_checksum {
            return Err(AssetError::WrongCatalogRelease);
        }
        let entry = catalog
            .vehicle(self.vehicle_type_id)
            .ok_or(AssetError::UnknownVehicleType)?;
        if entry.class_designation() != &self.class_designation {
            return Err(AssetError::WrongVehicleType);
        }
        if year < self.acquisition_year {
            return Err(AssetError::RetrofitBeforeAcquisition);
        }
        if self.installed_protection.contains(system) {
            return Err(AssetError::ProtectionAlreadyInstalled);
        }
        if !entry.protection().is_retrofit(system, year) {
            return Err(AssetError::RetrofitNotAvailable);
        }
        self.installed_protection =
            TrainProtection::from_systems(self.installed_protection.systems().chain([system]));
        Ok(())
    }

    /// Weltzugehörigkeit.
    pub const fn world_id(&self) -> WorldId {
        self.world_id
    }

    /// Individuelle Fahrzeugkennung.
    pub const fn id(&self) -> VehicleId {
        self.id
    }

    /// Katalogtyp.
    pub const fn vehicle_type_id(&self) -> VehicleTypeId {
        self.vehicle_type_id
    }

    /// Faktische Baureihenbezeichnung.
    pub const fn class_designation(&self) -> &FleetClass {
        &self.class_designation
    }

    /// Fiktiver Handelsname des Katalogtyps.
    pub fn trade_name(&self) -> &str {
        &self.trade_name
    }

    /// Tatsächliches Baujahr.
    pub const fn build_year(&self) -> u16 {
        self.build_year
    }

    /// Jahr der Übernahme durch das EVU.
    pub const fn acquisition_year(&self) -> u16 {
        self.acquisition_year
    }

    /// Beschaffungsweg.
    pub const fn procurement_channel(&self) -> ProcurementChannel {
        self.procurement_channel
    }

    /// Eigentum oder Leasing.
    pub const fn ownership(&self) -> OwnershipStatus {
        self.ownership
    }

    /// Tatsächlich eingebaute Zugsicherung.
    pub const fn installed_protection(&self) -> &TrainProtection {
        &self.installed_protection
    }

    /// Zulassungen in stabiler Reihenfolge.
    pub fn approvals(&self) -> impl Iterator<Item = &VehicleApproval> {
        self.approvals.iter()
    }

    /// Wartungsfristen nach Fristart geordnet.
    pub fn maintenance_deadlines(&self) -> impl Iterator<Item = &MaintenanceDeadline> {
        self.maintenance_deadlines.values()
    }
}

fn validate_years(
    entry: &VehicleCatalogEntry,
    settings: VehicleWorldSettings,
    channel: ProcurementChannel,
    build_year: u16,
    acquisition_year: u16,
) -> Result<(), AssetError> {
    if build_year > acquisition_year {
        return Err(AssetError::BuildAfterAcquisition);
    }
    if !entry.construction().contains(build_year) {
        return Err(AssetError::BuildOutsideConstructionPeriod);
    }
    if !settings.allows_construction_year(build_year) {
        return Err(AssetError::ConstructionEraExcluded);
    }
    if !settings.allows_procurement_year(acquisition_year) {
        return Err(AssetError::ProcurementEraExcluded);
    }
    if !entry
        .market(channel)
        .is_some_and(|market| market.is_available(acquisition_year))
    {
        return Err(AssetError::MarketUnavailable);
    }
    Ok(())
}

/// Deterministischer Schnappschuss aller Fahrzeuge einer Welt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetSnapshot {
    world_id: WorldId,
    catalog_checksum: StateHash,
    vehicles: BTreeMap<VehicleId, VehicleAsset>,
}

impl FleetSnapshot {
    /// Beginnt einen leeren Flottensnapshot und pinnt den Katalog-Release.
    pub fn new(world_id: WorldId, catalog: &VehicleCatalogRelease) -> Self {
        Self {
            world_id,
            catalog_checksum: catalog.checksum(),
            vehicles: BTreeMap::new(),
        }
    }

    /// Fügt ein Fahrzeug derselben Welt und desselben Katalog-Releases ein.
    pub fn insert(&mut self, vehicle: VehicleAsset) -> Result<(), AssetError> {
        if vehicle.world_id != self.world_id {
            return Err(AssetError::WrongWorld);
        }
        if vehicle.catalog_checksum != self.catalog_checksum {
            return Err(AssetError::WrongCatalogRelease);
        }
        if self.vehicles.contains_key(&vehicle.id) {
            return Err(AssetError::DuplicateVehicle);
        }
        self.vehicles.insert(vehicle.id, vehicle);
        Ok(())
    }

    /// Fahrzeug nach individueller Kennung.
    pub fn vehicle(&self, id: VehicleId) -> Option<&VehicleAsset> {
        self.vehicles.get(&id)
    }

    /// Zahl der individuellen Fahrzeuge.
    pub fn len(&self) -> usize {
        self.vehicles.len()
    }

    /// Ob die Flotte leer ist.
    pub fn is_empty(&self) -> bool {
        self.vehicles.is_empty()
    }

    /// Gepinnte Fahrzeugkatalog-Prüfsumme.
    pub const fn catalog_checksum(&self) -> StateHash {
        self.catalog_checksum
    }

    /// Kanonische Prüfsumme der individuellen Flotte.
    pub fn checksum(&self) -> StateHash {
        self.state_hash()
    }
}

impl DeterministicModel for FleetSnapshot {
    type Command = Infallible;

    const SCHEMA: &'static str = "fleet-snapshot/v2";

    fn apply(&mut self, _at: DeterministicSimTime, command: &Infallible) {
        match *command {}
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher
            .uint("world-id", self.world_id)
            .hash("catalog", self.catalog_checksum)
            .seq("vehicles", self.vehicles.len());
        for vehicle in self.vehicles.values() {
            hasher
                .uint("vehicle-id", vehicle.id)
                .uint("vehicle-type-id", vehicle.vehicle_type_id)
                .text("class", vehicle.class_designation.as_str())
                .text("trade-name", &vehicle.trade_name)
                .uint("build-year", u64::from(vehicle.build_year))
                .uint("acquisition-year", u64::from(vehicle.acquisition_year))
                .text("procurement-channel", vehicle.procurement_channel.tag())
                .text("ownership", vehicle.ownership.tag())
                .seq("approvals", vehicle.approvals.len());
            for approval in &vehicle.approvals {
                hasher.text("approval", approval.as_str());
            }
            hasher.seq("maintenance-deadlines", vehicle.maintenance_deadlines.len());
            for deadline in vehicle.maintenance_deadlines.values() {
                hasher
                    .text("maintenance-kind", deadline.kind())
                    .int("maintenance-due-at", deadline.due_at());
            }
            hasher.seq("installed-protection", vehicle.installed_protection.count());
            for system in vehicle.installed_protection.systems() {
                hasher.text("protection-system", system.tag());
            }
        }
    }
}

/// Fehler bei Beschaffung, Umbau und Flottensnapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "die selbsterklärenden Varianten sind stabile, maschinenlesbare Diagnosen"
)]
pub enum AssetError {
    UnknownVehicleType,
    InvalidVehicleId,
    BuildAfterAcquisition,
    BuildOutsideConstructionPeriod,
    ConstructionEraExcluded,
    ProcurementEraExcluded,
    MarketUnavailable,
    ProtectionAlreadyStandard,
    NotAFactoryOption,
    NotSecondaryMarket,
    MissingStandardProtection,
    UnsupportedProtection,
    InvalidApproval,
    InvalidMaintenanceDeadline,
    DuplicateMaintenanceDeadline,
    WrongCatalogRelease,
    WrongVehicleType,
    RetrofitBeforeAcquisition,
    ProtectionAlreadyInstalled,
    RetrofitNotAvailable,
    WrongWorld,
    DuplicateVehicle,
}

impl fmt::Display for AssetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for AssetError {}
