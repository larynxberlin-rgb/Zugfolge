//! Persistenter Fahrzeugmarkt: Weltstartbestand, Vermieter und Lebenslaeufe.
//!
//! Das Modell erzeugt keine Kopien eines Typs. Jedes Angebot verweist auf das
//! konkrete [`VehicleAsset`]; Zustandswechsel schreiben einen unveraenderlichen
//! [`VehicleLifeEvent`] in dessen weltgebundene Historie. Alle Preise sind
//! Integer-Cent und alle Zeitpunkte explizite Simulationszeit.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;

use zugfolge_determinism::{StateHash, StateHasher};

use crate::{ProcurementChannel, SimTime, VehicleAsset, VehicleId, WorldId};

/// Hoechster gueltiger Zustandswert; 10.000 entspricht einem neuwertigen Teil.
pub const CONDITION_MAX: u16 = 10_000;
const BASIS_POINTS: i64 = 10_000;

/// Sichtbare technische und wirtschaftliche Zustandswerte eines Einzelfahrzeugs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleCondition {
    /// Laufwerk, Wagenkasten und mechanische Substanz.
    mechanical: u16,
    /// Antrieb, Energieversorgung und Zugbeeinflussung.
    traction: u16,
    /// Bremsen und sicherheitsrelevante Funktion.
    braking: u16,
    /// Tueren, Fahrgastinformation und sonstige Betriebszuverlaessigkeit.
    operational: u16,
    /// Innenraum und sichtbarer Komfortzustand.
    interior: u16,
}

impl VehicleCondition {
    /// Uebernimmt nur vollstaendige, nicht uebersteuerte Zustandswerte.
    pub const fn new(
        mechanical: u16,
        traction: u16,
        braking: u16,
        operational: u16,
        interior: u16,
    ) -> Result<Self, VehicleMarketError> {
        if mechanical > CONDITION_MAX
            || traction > CONDITION_MAX
            || braking > CONDITION_MAX
            || operational > CONDITION_MAX
            || interior > CONDITION_MAX
        {
            return Err(VehicleMarketError::InvalidCondition);
        }
        Ok(Self {
            mechanical,
            traction,
            braking,
            operational,
            interior,
        })
    }

    /// Ganzzahliger Mittelwert fuer Preis- und Angebotsvergleich.
    pub const fn score(self) -> u16 {
        (self.mechanical + self.traction + self.braking + self.operational + self.interior) / 5
    }

    /// Laufwerk, Wagenkasten und mechanische Substanz.
    pub const fn mechanical(self) -> u16 {
        self.mechanical
    }
    /// Antrieb, Energieversorgung und Zugbeeinflussung.
    pub const fn traction(self) -> u16 {
        self.traction
    }
    /// Bremsen und sicherheitsrelevante Funktion.
    pub const fn braking(self) -> u16 {
        self.braking
    }
    /// Tueren und sonstige Betriebszuverlaessigkeit.
    pub const fn operational(self) -> u16 {
        self.operational
    }
    /// Innenraum und sichtbarer Komfortzustand.
    pub const fn interior(self) -> u16 {
        self.interior
    }
}

/// Verkehrstyp, den ein Vermieter in seinem Angebotsprofil bevorzugen kann.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum TrafficKind {
    /// Schienenpersonennahverkehr.
    Spnv,
    /// Schienenpersonenfernverkehr.
    Spfv,
    /// Schienengueterverkehr.
    Sgv,
}

impl TrafficKind {
    const fn tag(self) -> &'static str {
        match self {
            Self::Spnv => "spnv",
            Self::Spfv => "spfv",
            Self::Sgv => "sgv",
        }
    }
}

/// Profil eines fiktiven servereigenen Vermieters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LessorProfile {
    id: String,
    display_name: String,
    /// Positiver Aufschlag gegenueber dem vergleichbaren Marktpreis in Basispunkten.
    market_uplift_basis_points: u16,
    preferred_class_designations: BTreeSet<String>,
    preferred_traffic_kinds: BTreeSet<TrafficKind>,
}

impl LessorProfile {
    /// Baut ein sichtbares Profil. Serverseitige Vermieter duerfen nie zum oder
    /// unter dem Marktpreis anbieten; daher muss ihr Aufschlag positiv sein.
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        market_uplift_basis_points: u16,
        preferred_class_designations: impl IntoIterator<Item = String>,
        preferred_traffic_kinds: impl IntoIterator<Item = TrafficKind>,
    ) -> Result<Self, VehicleMarketError> {
        let id = id.into();
        let display_name = display_name.into();
        if id.trim().is_empty() || display_name.trim().is_empty() || market_uplift_basis_points == 0
        {
            return Err(VehicleMarketError::InvalidLessorProfile);
        }
        let preferred_class_designations = preferred_class_designations
            .into_iter()
            .map(|value| {
                if value.trim().is_empty() {
                    Err(VehicleMarketError::InvalidLessorProfile)
                } else {
                    Ok(value)
                }
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        Ok(Self {
            id,
            display_name,
            market_uplift_basis_points,
            preferred_class_designations,
            preferred_traffic_kinds: preferred_traffic_kinds.into_iter().collect(),
        })
    }

    /// Stabile Kennung des Vermieters.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Fiktiver, sichtbarer Name.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Veroeffentlichter Mindestaufschlag gegenueber dem Marktpreis.
    pub const fn market_uplift_basis_points(&self) -> u16 {
        self.market_uplift_basis_points
    }

    /// Berechnet eine stets strikt ueber dem Referenzmarkt liegende Rate.
    pub fn quote_above_market(
        &self,
        market_reference_cents: i64,
    ) -> Result<i64, VehicleMarketError> {
        if market_reference_cents <= 0 {
            return Err(VehicleMarketError::InvalidMarketReference);
        }
        let multiplier = BASIS_POINTS
            .checked_add(i64::from(self.market_uplift_basis_points))
            .ok_or(VehicleMarketError::PriceOverflow)?;
        let quoted = market_reference_cents
            .checked_mul(multiplier)
            .ok_or(VehicleMarketError::PriceOverflow)?
            .checked_add(BASIS_POINTS - 1)
            .ok_or(VehicleMarketError::PriceOverflow)?
            / BASIS_POINTS;
        Ok(quoted.max(market_reference_cents.saturating_add(1)))
    }

    /// Liefert die Zahl der sichtbaren Angebots-Passungen, ohne Preise zu
    /// verstecken oder eine Zufallsauswahl zu treffen.
    pub fn preference_score(&self, vehicle: &VehicleAsset, traffic: TrafficKind) -> u8 {
        u8::from(
            self.preferred_class_designations
                .contains(vehicle.class_designation().as_str()),
        ) + u8::from(self.preferred_traffic_kinds.contains(&traffic))
    }
}

/// Drei standardisierte, fiktive Startvermieter. Welten duerfen sie durch
/// administrativ gepinnte Profile ersetzen, aber nicht ohne Profil starten.
pub fn default_server_lessors() -> [LessorProfile; 3] {
    [
        LessorProfile::new(
            "eichenbahn-leasing",
            "Eichenbahn Leasing",
            900,
            ["423".to_owned(), "442".to_owned()],
            [TrafficKind::Spnv],
        )
        .expect("fiktives Standardprofil ist gueltig"),
        LessorProfile::new(
            "brueckental-mobilitaet",
            "Brueckental Mobilitaet",
            1_150,
            ["101".to_owned(), "193".to_owned()],
            [TrafficKind::Spfv, TrafficKind::Sgv],
        )
        .expect("fiktives Standardprofil ist gueltig"),
        LessorProfile::new(
            "nordbogen-fahrzeugfonds",
            "Nordbogen Fahrzeugfonds",
            1_300,
            Vec::new(),
            [TrafficKind::Spnv, TrafficKind::Sgv],
        )
        .expect("fiktives Standardprofil ist gueltig"),
    ]
}

/// Grund, aus dem ein Leasingfahrzeug zum Vermieter zurueckgeht.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseReturnReason {
    /// Regulaires Ende des Leasingvertrags.
    LeaseEnd,
    /// Freiwillige Aufgabe des EVU.
    OperatorClosure,
    /// Insolvenz des EVU.
    Insolvency,
}

impl LeaseReturnReason {
    const fn tag(self) -> &'static str {
        match self {
            Self::LeaseEnd => "lease-end",
            Self::OperatorClosure => "operator-closure",
            Self::Insolvency => "insolvency",
        }
    }
}

/// Aktueller, durchsetzbarer Marktstatus eines konkreten Fahrzeugs.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "Feldnamen benennen den Halter, Vermieter, Preis und Zeitpunkt unmittelbar"
)]
pub enum VehicleMarketStatus {
    /// Das Fahrzeug gehoert einem EVU.
    Owned { operator_id: String },
    /// Das Fahrzeug wird durch ein EVU geleast.
    Leased {
        operator_id: String,
        lessor_id: String,
        lease_ends_at: SimTime,
    },
    /// Das konkrete Fahrzeug kann nur beim genannten Vermieter geleast werden.
    AvailableForLease { lessor_id: String },
    /// Das konkrete eigene Fahrzeug wird auf dem Gebrauchtmarkt angeboten.
    ListedForUsedSale {
        seller_id: String,
        asking_price_cents: i64,
    },
    /// Ausgemustert bleibt es historisch sichtbar, aber nie wieder handelbar.
    Retired,
}

/// Unveraenderliche Historienzeile eines Fahrzeugs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleLifeEvent {
    at: SimTime,
    kind: VehicleLifeEventKind,
}

/// Fachliche Ursache einer Historienzeile.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "Feldnamen benennen den Halter, Vermieter, Preis und Zeitpunkt unmittelbar"
)]
pub enum VehicleLifeEventKind {
    /// Erstmalige Aufnahme eines Gebrauchtfahrzeugs in den Weltstartbestand.
    EnteredWorld { lessor_id: String },
    /// Ein Neubau oder Neufahrzeug-Leasing hat das konkrete Asset erzeugt.
    NewVehicleDelivered {
        operator_id: String,
        lessor_id: Option<String>,
    },
    /// Leasingbeginn mit Preis und bindendem Ende.
    Leased {
        lessor_id: String,
        operator_id: String,
        lease_ends_at: SimTime,
        price_cents: i64,
    },
    /// Ruecklauf zum Vermieter.
    LeaseReturned {
        lessor_id: String,
        reason: LeaseReturnReason,
    },
    /// Angebot eines eigenen Fahrzeugs auf dem Gebrauchtmarkt.
    ListedForUsedSale {
        seller_id: String,
        asking_price_cents: i64,
    },
    /// Verkauf an ein anderes EVU.
    SoldUsed {
        seller_id: String,
        buyer_id: String,
        price_cents: i64,
    },
    /// Sichtbar fortgeschriebener Fahrzeugzustand.
    ConditionRecorded { condition: VehicleCondition },
    /// Endgueltige Ausmusterung.
    Retired,
}

/// Ein konkretes Asset mitsamt Marktstatus, Zustand und vollstaendiger Historie.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistentVehicle {
    asset: VehicleAsset,
    condition: VehicleCondition,
    status: VehicleMarketStatus,
    history: Vec<VehicleLifeEvent>,
}

impl PersistentVehicle {
    /// Das unverwechselbare technische Asset.
    pub const fn asset(&self) -> &VehicleAsset {
        &self.asset
    }

    /// Aktueller sichtbarer Zustand.
    pub const fn condition(&self) -> VehicleCondition {
        self.condition
    }

    /// Aktueller Marktstatus.
    pub const fn status(&self) -> &VehicleMarketStatus {
        &self.status
    }

    /// Unveraenderliche, zeitlich geordnete Historie.
    pub fn history(&self) -> &[VehicleLifeEvent] {
        &self.history
    }
}

impl VehicleLifeEvent {
    /// Explizite Simulationszeit der Zustandsaenderung.
    pub const fn at(&self) -> SimTime {
        self.at
    }

    /// Fachlicher Ereignistyp.
    pub const fn kind(&self) -> &VehicleLifeEventKind {
        &self.kind
    }
}

/// Weltgebundener, persistierbarer Markt aller konkreten Fahrzeuge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistentVehicleMarket {
    world_id: WorldId,
    starter_fleet_configured: bool,
    lessors: BTreeMap<String, LessorProfile>,
    vehicles: BTreeMap<VehicleId, PersistentVehicle>,
}

impl PersistentVehicleMarket {
    /// Erstellt einen leeren Markt. Ein leerer Weltstartbestand ist absichtlich
    /// zulaessig, wenn ihn die Administration nicht festgelegt hat.
    pub fn new(
        world_id: WorldId,
        lessors: impl IntoIterator<Item = LessorProfile>,
    ) -> Result<Self, VehicleMarketError> {
        if world_id == 0 {
            return Err(VehicleMarketError::WrongWorld);
        }
        let mut profiles = BTreeMap::new();
        for lessor in lessors {
            if profiles.insert(lessor.id.clone(), lessor).is_some() {
                return Err(VehicleMarketError::DuplicateLessor);
            }
        }
        Ok(Self {
            world_id,
            starter_fleet_configured: false,
            lessors: profiles,
            vehicles: BTreeMap::new(),
        })
    }

    /// Weltkennung des Markts.
    pub const fn world_id(&self) -> WorldId {
        self.world_id
    }

    /// Ob die Administration einen Gebrauchtfahrzeug-Startbestand festgelegt hat.
    pub const fn starter_fleet_configured(&self) -> bool {
        self.starter_fleet_configured
    }

    /// Fuegt genau ein gebrauchtes Asset in den vor Weltenstart eingefrorenen Bestand.
    pub fn add_starter_vehicle(
        &mut self,
        at: SimTime,
        lessor_id: &str,
        asset: VehicleAsset,
        condition: VehicleCondition,
    ) -> Result<(), VehicleMarketError> {
        self.ensure_lessor(lessor_id)?;
        if at < 0 || asset.world_id() != self.world_id {
            return Err(VehicleMarketError::WrongWorld);
        }
        if asset.procurement_channel() != ProcurementChannel::Used {
            return Err(VehicleMarketError::StarterVehicleMustBeUsed);
        }
        self.insert_vehicle(
            asset,
            condition,
            VehicleMarketStatus::AvailableForLease {
                lessor_id: lessor_id.to_owned(),
            },
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::EnteredWorld {
                    lessor_id: lessor_id.to_owned(),
                },
            },
        )?;
        self.starter_fleet_configured = true;
        Ok(())
    }

    /// Bringt ein neu gebautes, bereits geliefertes Asset in die Welt.
    pub fn introduce_new_vehicle(
        &mut self,
        at: SimTime,
        asset: VehicleAsset,
        operator_id: &str,
        lessor_id: Option<&str>,
        condition: VehicleCondition,
    ) -> Result<(), VehicleMarketError> {
        if at < 0 || asset.world_id() != self.world_id || operator_id.trim().is_empty() {
            return Err(VehicleMarketError::WrongWorld);
        }
        match (asset.procurement_channel(), lessor_id) {
            (ProcurementChannel::NewBuild, None) => {}
            (ProcurementChannel::Leasing, Some(id)) => self.ensure_lessor(id)?,
            _ => return Err(VehicleMarketError::InvalidNewVehicleIntroduction),
        }
        let status = match lessor_id {
            Some(id) => VehicleMarketStatus::Leased {
                operator_id: operator_id.to_owned(),
                lessor_id: id.to_owned(),
                lease_ends_at: i64::MAX,
            },
            None => VehicleMarketStatus::Owned {
                operator_id: operator_id.to_owned(),
            },
        };
        self.insert_vehicle(
            asset,
            condition,
            status,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::NewVehicleDelivered {
                    operator_id: operator_id.to_owned(),
                    lessor_id: lessor_id.map(ToOwned::to_owned),
                },
            },
        )
    }

    /// Gibt ein servereigenes Angebot mitsamt strikt hoeherem Marktpreis aus.
    pub fn quote_server_lease(
        &self,
        vehicle_id: VehicleId,
        traffic: TrafficKind,
        market_reference_cents: i64,
    ) -> Result<ServerLeaseQuote, VehicleMarketError> {
        let vehicle = self.vehicle(vehicle_id)?;
        let VehicleMarketStatus::AvailableForLease { lessor_id } = &vehicle.status else {
            return Err(VehicleMarketError::VehicleNotAvailableForLease);
        };
        let lessor = self.lessor(lessor_id)?;
        Ok(ServerLeaseQuote {
            vehicle_id,
            lessor_id: lessor_id.clone(),
            price_cents: lessor.quote_above_market(market_reference_cents)?,
            preference_score: lessor.preference_score(&vehicle.asset, traffic),
        })
    }

    /// Schlaegt ein transparentes, bereits berechnetes Serverangebot zu.
    pub fn lease_server_vehicle(
        &mut self,
        at: SimTime,
        operator_id: &str,
        lease_ends_at: SimTime,
        quote: ServerLeaseQuote,
    ) -> Result<(), VehicleMarketError> {
        if at < 0 || lease_ends_at <= at || operator_id.trim().is_empty() {
            return Err(VehicleMarketError::InvalidLease);
        }
        let vehicle = self.vehicle_mut(quote.vehicle_id)?;
        let VehicleMarketStatus::AvailableForLease { lessor_id } = &vehicle.status else {
            return Err(VehicleMarketError::VehicleNotAvailableForLease);
        };
        if lessor_id != &quote.lessor_id || quote.price_cents <= 0 {
            return Err(VehicleMarketError::InvalidLease);
        }
        ensure_history_time(&vehicle.history, at)?;
        vehicle.status = VehicleMarketStatus::Leased {
            operator_id: operator_id.to_owned(),
            lessor_id: quote.lessor_id.clone(),
            lease_ends_at,
        };
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::Leased {
                    lessor_id: quote.lessor_id,
                    operator_id: operator_id.to_owned(),
                    lease_ends_at,
                    price_cents: quote.price_cents,
                },
            },
        )?;
        Ok(())
    }

    /// Gibt ein einzelnes Leasingfahrzeug an den Vermieter zurueck.
    pub fn return_lease(
        &mut self,
        at: SimTime,
        vehicle_id: VehicleId,
        reason: LeaseReturnReason,
    ) -> Result<(), VehicleMarketError> {
        let vehicle = self.vehicle_mut(vehicle_id)?;
        let VehicleMarketStatus::Leased { lessor_id, .. } = &vehicle.status else {
            return Err(VehicleMarketError::VehicleNotLeased);
        };
        let lessor_id = lessor_id.clone();
        ensure_history_time(&vehicle.history, at)?;
        vehicle.status = VehicleMarketStatus::AvailableForLease {
            lessor_id: lessor_id.clone(),
        };
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::LeaseReturned { lessor_id, reason },
            },
        )?;
        Ok(())
    }

    /// Listet ein eigenes Fahrzeug mit Zustand und kompletter Historie.
    pub fn list_owned_vehicle(
        &mut self,
        at: SimTime,
        vehicle_id: VehicleId,
        seller_id: &str,
        asking_price_cents: i64,
    ) -> Result<(), VehicleMarketError> {
        if asking_price_cents <= 0 || seller_id.trim().is_empty() {
            return Err(VehicleMarketError::InvalidUsedSale);
        }
        let vehicle = self.vehicle_mut(vehicle_id)?;
        let VehicleMarketStatus::Owned { operator_id } = &vehicle.status else {
            return Err(VehicleMarketError::VehicleNotOwned);
        };
        if operator_id != seller_id {
            return Err(VehicleMarketError::WrongOperator);
        }
        ensure_history_time(&vehicle.history, at)?;
        vehicle.status = VehicleMarketStatus::ListedForUsedSale {
            seller_id: seller_id.to_owned(),
            asking_price_cents,
        };
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::ListedForUsedSale {
                    seller_id: seller_id.to_owned(),
                    asking_price_cents,
                },
            },
        )?;
        Ok(())
    }

    /// Uebergibt genau das gelistete Asset an den Kaeufer.
    pub fn buy_used_vehicle(
        &mut self,
        at: SimTime,
        vehicle_id: VehicleId,
        buyer_id: &str,
        price_cents: i64,
    ) -> Result<(), VehicleMarketError> {
        if buyer_id.trim().is_empty() || price_cents <= 0 {
            return Err(VehicleMarketError::InvalidUsedSale);
        }
        let vehicle = self.vehicle_mut(vehicle_id)?;
        let VehicleMarketStatus::ListedForUsedSale {
            seller_id,
            asking_price_cents,
        } = &vehicle.status
        else {
            return Err(VehicleMarketError::VehicleNotListed);
        };
        if price_cents < *asking_price_cents || seller_id == buyer_id {
            return Err(VehicleMarketError::InvalidUsedSale);
        }
        let seller_id = seller_id.clone();
        ensure_history_time(&vehicle.history, at)?;
        vehicle.status = VehicleMarketStatus::Owned {
            operator_id: buyer_id.to_owned(),
        };
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::SoldUsed {
                    seller_id,
                    buyer_id: buyer_id.to_owned(),
                    price_cents,
                },
            },
        )?;
        Ok(())
    }

    /// Verarbeitet Betriebsaufgabe oder Insolvenz fuer alle konkreten Fahrzeuge
    /// eines EVU. Leasing kehrt zurueck; Eigentum wird zum Gebrauchtangebot.
    pub fn exit_operator(
        &mut self,
        at: SimTime,
        operator_id: &str,
        insolvent: bool,
        used_market_prices: &BTreeMap<VehicleId, i64>,
    ) -> Result<(), VehicleMarketError> {
        if operator_id.trim().is_empty() {
            return Err(VehicleMarketError::WrongOperator);
        }
        let reason = if insolvent {
            LeaseReturnReason::Insolvency
        } else {
            LeaseReturnReason::OperatorClosure
        };
        let affected = self
            .vehicles
            .iter()
            .filter_map(|(id, vehicle)| match &vehicle.status {
                VehicleMarketStatus::Owned { operator_id: owner } if owner == operator_id => {
                    Some((*id, true))
                }
                VehicleMarketStatus::Leased {
                    operator_id: lessee,
                    ..
                } if lessee == operator_id => Some((*id, false)),
                _ => None,
            })
            .collect::<Vec<_>>();
        for (vehicle_id, owned) in affected {
            if owned {
                let price = *used_market_prices
                    .get(&vehicle_id)
                    .ok_or(VehicleMarketError::MissingLiquidationPrice)?;
                self.list_owned_vehicle(at, vehicle_id, operator_id, price)?;
            } else {
                self.return_lease(at, vehicle_id, reason)?;
            }
        }
        Ok(())
    }

    /// Schreibt einen spaeteren sichtbaren Zustandsstand in den Lebenslauf.
    pub fn record_condition(
        &mut self,
        at: SimTime,
        vehicle_id: VehicleId,
        condition: VehicleCondition,
    ) -> Result<(), VehicleMarketError> {
        let vehicle = self.vehicle_mut(vehicle_id)?;
        ensure_history_time(&vehicle.history, at)?;
        vehicle.condition = condition;
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::ConditionRecorded { condition },
            },
        )?;
        Ok(())
    }

    /// Mustert ein Fahrzeug endgueltig aus, ohne seinen Lebenslauf zu loeschen.
    pub fn retire(&mut self, at: SimTime, vehicle_id: VehicleId) -> Result<(), VehicleMarketError> {
        let vehicle = self.vehicle_mut(vehicle_id)?;
        if matches!(vehicle.status, VehicleMarketStatus::Leased { .. }) {
            return Err(VehicleMarketError::LeasedVehicleCannotBeRetired);
        }
        ensure_history_time(&vehicle.history, at)?;
        vehicle.status = VehicleMarketStatus::Retired;
        append_history(
            &mut vehicle.history,
            VehicleLifeEvent {
                at,
                kind: VehicleLifeEventKind::Retired,
            },
        )?;
        Ok(())
    }

    /// Konkretes Fahrzeug nach Kennung.
    pub fn vehicle(&self, vehicle_id: VehicleId) -> Result<&PersistentVehicle, VehicleMarketError> {
        self.vehicles
            .get(&vehicle_id)
            .ok_or(VehicleMarketError::UnknownVehicle)
    }

    /// Alle Fahrzeuge in stabiler Kennungsreihenfolge.
    pub fn vehicles(&self) -> impl Iterator<Item = &PersistentVehicle> {
        self.vehicles.values()
    }

    /// Kanonischer Zustandshash fuer Replays und persistente Checkpoints.
    pub fn state_hash(&self) -> StateHash {
        let mut hasher = StateHasher::new("persistent-vehicle-market/v1");
        hasher
            .uint("world-id", self.world_id)
            .flag("starter-fleet-configured", self.starter_fleet_configured)
            .seq("lessors", self.lessors.len());
        for lessor in self.lessors.values() {
            hasher
                .text("lessor-id", &lessor.id)
                .text("lessor-name", &lessor.display_name)
                .uint(
                    "lessor-uplift",
                    u64::from(lessor.market_uplift_basis_points),
                )
                .seq("lessor-classes", lessor.preferred_class_designations.len());
            for class in &lessor.preferred_class_designations {
                hasher.text("lessor-class", class);
            }
            hasher.seq("lessor-traffic", lessor.preferred_traffic_kinds.len());
            for traffic in &lessor.preferred_traffic_kinds {
                hasher.text("lessor-traffic-kind", traffic.tag());
            }
        }
        hasher.seq("vehicles", self.vehicles.len());
        for vehicle in self.vehicles.values() {
            hasher
                .uint("vehicle-id", vehicle.asset.id())
                .uint("vehicle-type", vehicle.asset.vehicle_type_id())
                .uint(
                    "condition-mechanical",
                    u64::from(vehicle.condition.mechanical),
                )
                .uint("condition-traction", u64::from(vehicle.condition.traction))
                .uint("condition-braking", u64::from(vehicle.condition.braking))
                .uint(
                    "condition-operational",
                    u64::from(vehicle.condition.operational),
                )
                .uint("condition-interior", u64::from(vehicle.condition.interior));
            write_status(&mut hasher, &vehicle.status);
            hasher.seq("history", vehicle.history.len());
            for event in &vehicle.history {
                hasher.int("history-at", event.at);
                write_event(&mut hasher, &event.kind);
            }
        }
        hasher.finish()
    }

    fn ensure_lessor(&self, lessor_id: &str) -> Result<(), VehicleMarketError> {
        self.lessor(lessor_id).map(|_| ())
    }

    fn lessor(&self, lessor_id: &str) -> Result<&LessorProfile, VehicleMarketError> {
        self.lessors
            .get(lessor_id)
            .ok_or(VehicleMarketError::UnknownLessor)
    }

    fn vehicle_mut(
        &mut self,
        vehicle_id: VehicleId,
    ) -> Result<&mut PersistentVehicle, VehicleMarketError> {
        self.vehicles
            .get_mut(&vehicle_id)
            .ok_or(VehicleMarketError::UnknownVehicle)
    }

    fn insert_vehicle(
        &mut self,
        asset: VehicleAsset,
        condition: VehicleCondition,
        status: VehicleMarketStatus,
        first_event: VehicleLifeEvent,
    ) -> Result<(), VehicleMarketError> {
        if self.vehicles.contains_key(&asset.id()) {
            return Err(VehicleMarketError::DuplicateVehicle);
        }
        self.vehicles.insert(
            asset.id(),
            PersistentVehicle {
                asset,
                condition,
                status,
                history: vec![first_event],
            },
        );
        Ok(())
    }
}

fn ensure_history_time(
    history: &[VehicleLifeEvent],
    at: SimTime,
) -> Result<(), VehicleMarketError> {
    if at < 0 || at < history.last().map_or(0, VehicleLifeEvent::at) {
        return Err(VehicleMarketError::HistoryTimeRegression);
    }
    Ok(())
}

fn append_history(
    history: &mut Vec<VehicleLifeEvent>,
    event: VehicleLifeEvent,
) -> Result<(), VehicleMarketError> {
    ensure_history_time(history, event.at)?;
    history.push(event);
    Ok(())
}

/// Ergebnis eines transparenten Server-Leasingangebots.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerLeaseQuote {
    /// Konkretes Asset.
    pub vehicle_id: VehicleId,
    /// Vermieter des Angebots.
    pub lessor_id: String,
    /// Immer strikt ueber dem uebergebenen Marktpreis liegender Integer-Cent-Preis.
    pub price_cents: i64,
    /// Sichtbarer, deterministischer Angebotsvorrang des Vermieters.
    pub preference_score: u8,
}

fn write_status(hasher: &mut StateHasher, status: &VehicleMarketStatus) {
    match status {
        VehicleMarketStatus::Owned { operator_id } => {
            hasher
                .text("status", "owned")
                .text("status-operator", operator_id);
        }
        VehicleMarketStatus::Leased {
            operator_id,
            lessor_id,
            lease_ends_at,
        } => {
            hasher
                .text("status", "leased")
                .text("status-operator", operator_id)
                .text("status-lessor", lessor_id)
                .int("status-lease-ends", *lease_ends_at);
        }
        VehicleMarketStatus::AvailableForLease { lessor_id } => {
            hasher
                .text("status", "available-for-lease")
                .text("status-lessor", lessor_id);
        }
        VehicleMarketStatus::ListedForUsedSale {
            seller_id,
            asking_price_cents,
        } => {
            hasher
                .text("status", "listed-for-used-sale")
                .text("status-seller", seller_id)
                .int("status-price", *asking_price_cents);
        }
        VehicleMarketStatus::Retired => {
            hasher.text("status", "retired");
        }
    }
}

fn write_event(hasher: &mut StateHasher, event: &VehicleLifeEventKind) {
    match event {
        VehicleLifeEventKind::EnteredWorld { lessor_id } => {
            hasher
                .text("event", "entered-world")
                .text("event-lessor", lessor_id);
        }
        VehicleLifeEventKind::NewVehicleDelivered {
            operator_id,
            lessor_id,
        } => {
            hasher
                .text("event", "new-vehicle-delivered")
                .text("event-operator", operator_id);
            if let Some(lessor_id) = lessor_id {
                hasher.text("event-lessor", lessor_id);
            }
        }
        VehicleLifeEventKind::Leased {
            lessor_id,
            operator_id,
            lease_ends_at,
            price_cents,
        } => {
            hasher
                .text("event", "leased")
                .text("event-lessor", lessor_id)
                .text("event-operator", operator_id)
                .int("event-lease-ends", *lease_ends_at)
                .int("event-price", *price_cents);
        }
        VehicleLifeEventKind::LeaseReturned { lessor_id, reason } => {
            hasher
                .text("event", "lease-returned")
                .text("event-lessor", lessor_id)
                .text("event-reason", reason.tag());
        }
        VehicleLifeEventKind::ListedForUsedSale {
            seller_id,
            asking_price_cents,
        } => {
            hasher
                .text("event", "listed-for-used-sale")
                .text("event-seller", seller_id)
                .int("event-price", *asking_price_cents);
        }
        VehicleLifeEventKind::SoldUsed {
            seller_id,
            buyer_id,
            price_cents,
        } => {
            hasher
                .text("event", "sold-used")
                .text("event-seller", seller_id)
                .text("event-buyer", buyer_id)
                .int("event-price", *price_cents);
        }
        VehicleLifeEventKind::ConditionRecorded { condition } => {
            hasher
                .text("event", "condition-recorded")
                .uint("event-mechanical", u64::from(condition.mechanical))
                .uint("event-traction", u64::from(condition.traction))
                .uint("event-braking", u64::from(condition.braking))
                .uint("event-operational", u64::from(condition.operational))
                .uint("event-interior", u64::from(condition.interior));
        }
        VehicleLifeEventKind::Retired => {
            hasher.text("event", "retired");
        }
    }
}

/// Verletzung einer Markt- oder Lebenslaufregel.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "die selbsterklaerenden Fehlernamen sind Teil der oeffentlichen Diagnose"
)]
pub enum VehicleMarketError {
    WrongWorld,
    InvalidCondition,
    InvalidLessorProfile,
    DuplicateLessor,
    UnknownLessor,
    DuplicateVehicle,
    UnknownVehicle,
    StarterVehicleMustBeUsed,
    InvalidNewVehicleIntroduction,
    InvalidMarketReference,
    PriceOverflow,
    VehicleNotAvailableForLease,
    InvalidLease,
    VehicleNotLeased,
    VehicleNotOwned,
    VehicleNotListed,
    InvalidUsedSale,
    WrongOperator,
    MissingLiquidationPrice,
    HistoryTimeRegression,
    LeasedVehicleCannotBeRetired,
}

impl fmt::Display for VehicleMarketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for VehicleMarketError {}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use zugfolge_infra::{FleetClass, TrainProtection};

    use super::{
        LeaseReturnReason, PersistentVehicleMarket, TrafficKind, VehicleCondition,
        VehicleMarketError, VehicleMarketStatus, default_server_lessors,
    };
    use crate::{ProcurementChannel, VehicleAsset};

    fn asset(id: u64, channel: ProcurementChannel) -> VehicleAsset {
        VehicleAsset::from_authority_release(
            "market-test-release",
            7,
            id,
            42,
            FleetClass::new("423").expect("Baureihe"),
            "Mittelzug",
            2010,
            2026,
            channel,
            [],
            [],
            TrainProtection::from_systems([]),
        )
        .expect("Asset")
    }

    fn condition() -> VehicleCondition {
        VehicleCondition::new(8_000, 7_500, 9_000, 6_500, 5_000).expect("Zustand")
    }

    #[test]
    fn startbestand_ist_gebraucht_und_serverangebot_liegt_ueber_markt() {
        let mut market = PersistentVehicleMarket::new(7, default_server_lessors()).expect("Markt");
        market
            .add_starter_vehicle(
                0,
                "eichenbahn-leasing",
                asset(1, ProcurementChannel::Used),
                condition(),
            )
            .expect("Gebrauchtfahrzeug im Startbestand");
        let quote = market
            .quote_server_lease(1, TrafficKind::Spnv, 10_000)
            .expect("Serverangebot");
        assert_eq!(quote.lessor_id, "eichenbahn-leasing");
        assert!(quote.price_cents > 10_000);
        assert_eq!(quote.preference_score, 2);

        let error = market.add_starter_vehicle(
            0,
            "eichenbahn-leasing",
            asset(2, ProcurementChannel::NewBuild),
            condition(),
        );
        assert_eq!(error, Err(VehicleMarketError::StarterVehicleMustBeUsed));
    }

    #[test]
    fn leasingruecklauf_und_insolvenz_erhalten_dasselbe_asset_und_den_lebenslauf() {
        let mut market = PersistentVehicleMarket::new(7, default_server_lessors()).expect("Markt");
        market
            .add_starter_vehicle(
                0,
                "eichenbahn-leasing",
                asset(1, ProcurementChannel::Used),
                condition(),
            )
            .expect("Startbestand");
        let quote = market
            .quote_server_lease(1, TrafficKind::Spnv, 10_000)
            .expect("Angebot");
        market
            .lease_server_vehicle(1, "evu-a", 20, quote)
            .expect("Leasing");
        market
            .record_condition(
                2,
                1,
                VehicleCondition::new(7_000, 7_500, 8_000, 6_000, 4_000).expect("Zustand"),
            )
            .expect("Zustandsfortschreibung");
        market
            .exit_operator(21, "evu-a", true, &BTreeMap::new())
            .expect("Insolvenz");

        let vehicle = market.vehicle(1).expect("gleiches Fahrzeug");
        assert!(matches!(
            vehicle.status(),
            VehicleMarketStatus::AvailableForLease { lessor_id } if lessor_id == "eichenbahn-leasing"
        ));
        assert_eq!(vehicle.asset().id(), 1);
        assert_eq!(vehicle.history().len(), 4);
        assert!(matches!(
            vehicle.history().last().expect("Ruecklauf").kind(),
            super::VehicleLifeEventKind::LeaseReturned {
                reason: LeaseReturnReason::Insolvency,
                ..
            }
        ));
    }

    #[test]
    fn eigentuemer_fahrzeug_wird_bei_betriebsaufgabe_als_dasselbe_asset_gelistet() {
        let mut market = PersistentVehicleMarket::new(7, default_server_lessors()).expect("Markt");
        market
            .introduce_new_vehicle(
                5,
                asset(9, ProcurementChannel::NewBuild),
                "evu-a",
                None,
                condition(),
            )
            .expect("Neukauf");
        let mut prices = BTreeMap::new();
        prices.insert(9, 123_456);
        market
            .exit_operator(10, "evu-a", false, &prices)
            .expect("Betriebsaufgabe");
        assert!(matches!(
            market.vehicle(9).expect("Asset").status(),
            VehicleMarketStatus::ListedForUsedSale { seller_id, asking_price_cents: 123_456 } if seller_id == "evu-a"
        ));
        market
            .buy_used_vehicle(11, 9, "evu-b", 123_456)
            .expect("Gebrauchtkauf");
        assert!(matches!(
            market.vehicle(9).expect("Asset").status(),
            VehicleMarketStatus::Owned { operator_id } if operator_id == "evu-b"
        ));
    }

    #[test]
    fn lebenslauf_ist_zeitlich_geordnet_und_fehlgeschlagene_aenderung_bleibt_atomisch() {
        let mut market = PersistentVehicleMarket::new(7, default_server_lessors()).expect("Markt");
        market
            .add_starter_vehicle(
                5,
                "eichenbahn-leasing",
                asset(1, ProcurementChannel::Used),
                condition(),
            )
            .expect("Startbestand");
        let quote = market
            .quote_server_lease(1, TrafficKind::Spnv, 10_000)
            .expect("Angebot");
        let before = market.state_hash();
        assert_eq!(
            market.lease_server_vehicle(4, "evu-a", 20, quote),
            Err(VehicleMarketError::HistoryTimeRegression)
        );
        assert_eq!(market.state_hash(), before);
        assert!(matches!(
            market.vehicle(1).expect("Asset").status(),
            VehicleMarketStatus::AvailableForLease { .. }
        ));
    }

    #[test]
    fn gleicher_ablauf_erzeugt_denselben_persistenten_markthash() {
        fn build() -> PersistentVehicleMarket {
            let mut market =
                PersistentVehicleMarket::new(7, default_server_lessors()).expect("Markt");
            market
                .add_starter_vehicle(
                    0,
                    "eichenbahn-leasing",
                    asset(1, ProcurementChannel::Used),
                    condition(),
                )
                .expect("Startbestand");
            let quote = market
                .quote_server_lease(1, TrafficKind::Spnv, 10_000)
                .expect("Angebot");
            market
                .lease_server_vehicle(1, "evu-a", 20, quote)
                .expect("Leasing");
            market
        }
        assert_eq!(build().state_hash(), build().state_hash());
    }
}
