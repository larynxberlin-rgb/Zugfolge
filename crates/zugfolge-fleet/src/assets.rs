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
    OPEN_ENDED_YEAR, ProcurementChannel, VehicleCatalogEntry, VehicleCatalogRelease, VehicleTypeId,
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
    /// Stellt ein Fahrzeug ausschließlich aus serververtrauenswürdigen Fakten
    /// eines versionierten Authority-Releases wieder her.
    ///
    /// Anders als die Beschaffungspfade wertet dieser Restore keine
    /// clientseitig angelieferten Katalog- oder Mobilisierungs-DTOs aus. Der
    /// Release wird als domänengetrennter Hash gepinnt, sodass anschließend nur
    /// Fahrzeuge desselben Releases in einen [`FleetSnapshot`] gelangen.
    #[allow(
        clippy::too_many_arguments,
        reason = "der Authority-Release liefert diese getrennten, bereits fachlich belegten Fahrzeugfakten"
    )]
    pub fn from_authority_release(
        release_id: &str,
        world_id: WorldId,
        id: VehicleId,
        vehicle_type_id: VehicleTypeId,
        class_designation: FleetClass,
        trade_name: impl Into<String>,
        build_year: u16,
        acquisition_year: u16,
        procurement_channel: ProcurementChannel,
        approvals: impl IntoIterator<Item = VehicleApproval>,
        maintenance_deadlines: impl IntoIterator<Item = MaintenanceDeadline>,
        installed_protection: TrainProtection,
    ) -> Result<Self, AssetError> {
        let catalog_checksum = authority_release_checksum(release_id)?;
        if world_id == 0 {
            return Err(AssetError::InvalidWorldId);
        }
        if id == 0 {
            return Err(AssetError::InvalidVehicleId);
        }
        if vehicle_type_id == 0 {
            return Err(AssetError::InvalidVehicleTypeId);
        }
        if build_year == 0
            || acquisition_year == 0
            || build_year > OPEN_ENDED_YEAR
            || acquisition_year > OPEN_ENDED_YEAR
        {
            return Err(AssetError::InvalidYear);
        }
        if build_year > acquisition_year {
            return Err(AssetError::BuildAfterAcquisition);
        }
        let trade_name = trade_name.into();
        if trade_name.trim().is_empty() {
            return Err(AssetError::EmptyTradeName);
        }
        validate_protection_dependency(&installed_protection)?;

        let mut approval_set = BTreeSet::new();
        for approval in approvals {
            if !approval_set.insert(approval) {
                return Err(AssetError::DuplicateApproval);
            }
        }
        let mut deadline_map = BTreeMap::new();
        for deadline in maintenance_deadlines {
            if deadline_map
                .insert(deadline.kind.clone(), deadline)
                .is_some()
            {
                return Err(AssetError::DuplicateMaintenanceDeadline);
            }
        }
        let ownership = match procurement_channel {
            ProcurementChannel::NewBuild | ProcurementChannel::Used => OwnershipStatus::Owned,
            ProcurementChannel::Leasing => OwnershipStatus::Leased,
        };

        Ok(Self {
            world_id,
            id,
            vehicle_type_id,
            class_designation,
            trade_name,
            build_year,
            acquisition_year,
            procurement_channel,
            ownership,
            approvals: approval_set,
            maintenance_deadlines: deadline_map,
            installed_protection,
            catalog_checksum,
        })
    }

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
        let option_year = settings.factory_option_year(entry.construction(), year);
        for system in &requested {
            if standard.contains(system) {
                return Err(AssetError::ProtectionAlreadyStandard);
            }
            if !entry.protection().is_factory_option(*system, option_year) {
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
        validate_protection_dependency(&installed_protection)?;
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
        validate_protection_dependency(&installed_protection)?;
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
        if system == ProtectionSystem::Lzb
            && !self.installed_protection.contains(ProtectionSystem::Pzb)
        {
            return Err(AssetError::LzbRequiresPzb);
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

fn validate_protection_dependency(protection: &TrainProtection) -> Result<(), AssetError> {
    if protection.contains(ProtectionSystem::Lzb) && !protection.contains(ProtectionSystem::Pzb) {
        return Err(AssetError::LzbRequiresPzb);
    }
    Ok(())
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
    let continued_new_build = settings.continues_new_build(entry.construction(), channel);
    if !entry.construction().contains(build_year)
        && (!continued_new_build || build_year != acquisition_year)
    {
        return Err(AssetError::BuildOutsideConstructionPeriod);
    }
    if !settings.allows_construction_year(build_year) {
        return Err(AssetError::ConstructionEraExcluded);
    }
    if !entry
        .construction()
        .overlaps(settings.construction_era().years())
        && !continued_new_build
    {
        return Err(AssetError::ConstructionEraExcluded);
    }
    if !settings.allows_procurement_year(acquisition_year) {
        return Err(AssetError::ProcurementEraExcluded);
    }
    if !entry.is_available(settings, channel, acquisition_year) {
        return Err(AssetError::MarketUnavailable);
    }
    Ok(())
}

fn authority_release_checksum(release_id: &str) -> Result<StateHash, AssetError> {
    if release_id.trim().is_empty() {
        return Err(AssetError::EmptyAuthorityReleaseId);
    }
    let mut hasher = StateHasher::new("vehicle-authority-release/v1");
    hasher.text("release-id", release_id);
    Ok(hasher.finish())
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

    /// Stellt einen Snapshot aus Fahrzeugen desselben Authority-Releases her.
    ///
    /// Die vorhandene Einfügeprüfung erzwingt Welt, Release-Pin und eindeutige
    /// Fahrzeugkennungen auch beim Restore.
    pub fn from_authority_release(
        world_id: WorldId,
        release_id: &str,
        vehicles: impl IntoIterator<Item = VehicleAsset>,
    ) -> Result<Self, AssetError> {
        if world_id == 0 {
            return Err(AssetError::InvalidWorldId);
        }
        let mut snapshot = Self {
            world_id,
            catalog_checksum: authority_release_checksum(release_id)?,
            vehicles: BTreeMap::new(),
        };
        for vehicle in vehicles {
            snapshot.insert(vehicle)?;
        }
        Ok(snapshot)
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

    /// Gepinnte Fahrzeugkatalog- oder Authority-Release-Prüfsumme.
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
    EmptyAuthorityReleaseId,
    InvalidWorldId,
    UnknownVehicleType,
    InvalidVehicleId,
    InvalidVehicleTypeId,
    InvalidYear,
    EmptyTradeName,
    BuildAfterAcquisition,
    BuildOutsideConstructionPeriod,
    ConstructionEraExcluded,
    ProcurementEraExcluded,
    MarketUnavailable,
    ProtectionAlreadyStandard,
    LzbRequiresPzb,
    NotAFactoryOption,
    NotSecondaryMarket,
    MissingStandardProtection,
    UnsupportedProtection,
    InvalidApproval,
    DuplicateApproval,
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

#[cfg(test)]
mod authority_restore_tests {
    use super::{
        AssetError, FleetSnapshot, MaintenanceDeadline, OwnershipStatus, VehicleApproval,
        VehicleAsset,
    };
    use crate::catalog::ProcurementChannel;
    use zugfolge_infra::{FleetClass, ProtectionSystem, TrainProtection};

    #[derive(Clone)]
    struct AuthorityFacts {
        release_id: &'static str,
        world_id: u64,
        id: u64,
        vehicle_type_id: u64,
        trade_name: &'static str,
        build_year: u16,
        acquisition_year: u16,
        channel: ProcurementChannel,
        approvals: Vec<VehicleApproval>,
        deadlines: Vec<MaintenanceDeadline>,
    }

    impl AuthorityFacts {
        fn valid() -> Self {
            Self {
                release_id: "fleet-release-2026-08",
                world_id: 7,
                id: 2,
                vehicle_type_id: 423,
                trade_name: "Silberstrom",
                build_year: 1998,
                acquisition_year: 2026,
                channel: ProcurementChannel::Leasing,
                approvals: vec![VehicleApproval::new("DE").unwrap()],
                deadlines: vec![MaintenanceDeadline::new("revision", 2_000).unwrap()],
            }
        }

        fn restore(self) -> Result<VehicleAsset, AssetError> {
            VehicleAsset::from_authority_release(
                self.release_id,
                self.world_id,
                self.id,
                self.vehicle_type_id,
                FleetClass::new("423").unwrap(),
                self.trade_name,
                self.build_year,
                self.acquisition_year,
                self.channel,
                self.approvals,
                self.deadlines,
                TrainProtection::single(ProtectionSystem::Pzb),
            )
        }
    }

    fn valid_asset(release_id: &'static str, world_id: u64, id: u64) -> VehicleAsset {
        AuthorityFacts {
            release_id,
            world_id,
            id,
            ..AuthorityFacts::valid()
        }
        .restore()
        .unwrap()
    }

    fn assert_invalid(change: impl FnOnce(&mut AuthorityFacts), expected: AssetError) {
        let mut facts = AuthorityFacts::valid();
        change(&mut facts);
        assert_eq!(facts.restore(), Err(expected));
    }

    #[test]
    fn authority_release_pin_and_ownership_are_deterministic() {
        let leased = valid_asset("fleet-release-2026-08", 7, 2);
        let owned = AuthorityFacts {
            id: 1,
            acquisition_year: 2025,
            channel: ProcurementChannel::Used,
            approvals: Vec::new(),
            deadlines: Vec::new(),
            ..AuthorityFacts::valid()
        }
        .restore()
        .unwrap();
        assert_eq!(leased.ownership(), OwnershipStatus::Leased);
        assert_eq!(owned.ownership(), OwnershipStatus::Owned);

        let first = FleetSnapshot::from_authority_release(
            7,
            "fleet-release-2026-08",
            [leased.clone(), owned.clone()],
        )
        .unwrap();
        let reversed =
            FleetSnapshot::from_authority_release(7, "fleet-release-2026-08", [owned, leased])
                .unwrap();
        assert_eq!(first.catalog_checksum(), reversed.catalog_checksum());
        assert_eq!(first.checksum(), reversed.checksum());
        let other = FleetSnapshot::from_authority_release(7, "other-release", []).unwrap();
        assert_ne!(first.catalog_checksum(), other.catalog_checksum());
    }

    #[test]
    fn authority_facts_reject_empty_ids_years_names_and_duplicates() {
        assert_invalid(
            |facts| facts.release_id = " ",
            AssetError::EmptyAuthorityReleaseId,
        );
        assert_invalid(|facts| facts.world_id = 0, AssetError::InvalidWorldId);
        assert_invalid(|facts| facts.id = 0, AssetError::InvalidVehicleId);
        assert_invalid(
            |facts| facts.vehicle_type_id = 0,
            AssetError::InvalidVehicleTypeId,
        );
        assert_invalid(|facts| facts.trade_name = " ", AssetError::EmptyTradeName);
        assert_invalid(|facts| facts.build_year = 0, AssetError::InvalidYear);
        assert_invalid(
            |facts| facts.build_year = facts.acquisition_year + 1,
            AssetError::BuildAfterAcquisition,
        );
        assert_invalid(
            |facts| {
                let duplicate = facts.approvals[0].clone();
                facts.approvals.push(duplicate);
            },
            AssetError::DuplicateApproval,
        );
        assert_invalid(
            |facts| {
                let duplicate = facts.deadlines[0].clone();
                facts.deadlines.push(duplicate);
            },
            AssetError::DuplicateMaintenanceDeadline,
        );
    }

    #[test]
    fn authority_snapshot_reuses_insert_guards() {
        let vehicle = valid_asset("release-a", 7, 1);
        assert_eq!(
            FleetSnapshot::from_authority_release(7, "release-a", [vehicle.clone(), vehicle]),
            Err(AssetError::DuplicateVehicle)
        );
        assert_eq!(
            FleetSnapshot::from_authority_release(7, "release-a", [valid_asset("release-a", 8, 1)]),
            Err(AssetError::WrongWorld)
        );
        assert_eq!(
            FleetSnapshot::from_authority_release(7, "release-a", [valid_asset("release-b", 7, 1)]),
            Err(AssetError::WrongCatalogRelease)
        );
    }
}
