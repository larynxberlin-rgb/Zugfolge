//! Verlustfreier Transport der tatsächlichen M5-Fahrzeugkonfiguration.
//!
//! Geometrie, Decks und Wagenkastenpartitionen sind keine abgeleiteten M5-Fakten.
//! Dieser Vertrag führt ausschließlich die vorhandenen Struktur- und Innenraumwerte.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use zugfolge_infra::Length;

use crate::{
    Amenity, FleetError, InteriorConfiguration, MultipurposeArea, SeatType, SeatingDensity,
    StructuralConfiguration, VehicleConfiguration,
};

/// Version des vollständigen Konfigurationstransports.
pub const VEHICLE_CONFIGURATION_SCHEMA: &str = "m5-vehicle-configuration/v1";

/// Serde-Grenze für ein optionales Feld: Abwesenheit ist erlaubt, geliefertes null nicht.
/// Der Feldvertrag kombiniert diese Funktion mit `#[serde(default)]`.
pub fn deserialize_optional_vehicle_configuration<'de, D>(
    deserializer: D,
) -> Result<Option<VehicleConfigurationV1>, D::Error>
where
    D: Deserializer<'de>,
{
    VehicleConfigurationV1::deserialize(deserializer).map(Some)
}

/// Vollständige, ausdrücklich gelieferte Konfiguration eines konkreten Assets.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleConfigurationV1 {
    /// Muss [`VEHICLE_CONFIGURATION_SCHEMA`] entsprechen.
    pub schema_version: String,
    /// Baulich feste M5-Merkmale.
    pub structural: StructuralConfigurationV1,
    /// Veränderlicher, vollständig gelieferter M5-Innenraum.
    pub interior: InteriorConfigurationV1,
}

/// Baulich feste Daten ohne erfundene Türpositionen oder Decks.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuralConfigurationV1 {
    /// Zahl der Türen je Fahrzeugseite.
    pub door_count_per_side: u8,
    /// Lichte Türbreite in Millimetern.
    pub door_width_mm: u16,
    /// Gesamte Wagenkastenlänge dieses M5-Assets in Millimetern.
    pub body_length_mm: u32,
}

/// Bestuhlungsdichte des M5-Innenraums.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatingDensityV1 {
    /// Hohe Kapazität.
    Dense,
    /// Regelbestuhlung.
    Standard,
    /// Mehr Sitzabstand.
    Spacious,
}

/// Konfigurierte Sitzart.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatTypeV1 {
    /// Reihensitze.
    Row,
    /// Vis-à-vis-Gruppen.
    FaceToFace,
    /// Klappsitze.
    Folding,
}

/// Deterministisch geordnete M5-Ausstattung; Reihenfolge wie [`Amenity`].
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AmenityV1 {
    /// Klimatisierung.
    AirConditioning,
    /// Drahtloser Internetzugang.
    Wifi,
    /// Steckdosen.
    PowerSockets,
    /// Dynamische Fahrgastinformation.
    PassengerInformation,
}

/// Alle vorhandenen M5-Mehrzweckkontingente, ohne zusätzliche Fahrgäste.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultipurposeAreaV1 {
    /// Fahrradplätze.
    pub bicycles: u16,
    /// Kinderwagenplätze.
    pub pushchairs: u16,
    /// Rollstuhlplätze.
    pub wheelchairs: u16,
    /// Stehplätze.
    pub standing: u16,
}

/// Vollständiger veränderlicher M5-Innenraum.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorConfigurationV1 {
    /// Sitzplätze erster Klasse.
    pub first_class_seats: u16,
    /// Sitzplätze zweiter Klasse.
    pub second_class_seats: u16,
    /// Bestuhlungsdichte.
    pub density: SeatingDensityV1,
    /// Sitzart.
    pub seat_type: SeatTypeV1,
    /// Ausdrückliche Mehrzweckkontingente.
    pub multipurpose: MultipurposeAreaV1,
    /// Gesamtzahl der WCs.
    pub toilets: u8,
    /// Darin enthaltene barrierefreie WCs.
    pub accessible_toilets: u8,
    /// Ausstattung als eindeutige Liste in M5-Enumordnung.
    pub amenities: Vec<AmenityV1>,
}

/// Bereits belegte technische und Kapazitätsfakten aus Katalog oder Authority.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleConfigurationFacts {
    /// Belegte Gesamtlänge in Millimetern.
    pub length_mm: i64,
    /// Gesamte Sitzplätze beider Klassen.
    pub seats: u32,
    /// Sitzplätze erster Klasse.
    pub first_class_seats: u32,
    /// Fahrradplätze.
    pub bicycle_places: u16,
    /// Rollstuhlplätze.
    pub wheelchair_places: u16,
    /// Bestehende Barrierefreiheitszusage; keine WC- oder Platzquotenableitung.
    pub accessible: bool,
}

/// Fehler mit festen Diagnosewerten; keine privaten Daten im Fehlertext.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VehicleConfigurationError {
    /// Unbekanntes Transportschema.
    UnsupportedSchema,
    /// Mehrfach deklarierte Ausstattung wird nicht stillschweigend reduziert.
    DuplicateAmenity,
    /// Die vorhandene M5-Domäne lehnt die Konfiguration ab.
    InvalidDomain(FleetError),
    /// Feste Länge widerspricht dem Asset.
    LengthMismatch,
    /// Gesamte Sitzplatzzahl widerspricht dem Asset.
    SeatCountMismatch,
    /// Klassenaufteilung widerspricht dem Asset.
    FirstClassMismatch,
    /// Fahrradkontingent widerspricht dem Asset.
    BicyclePlacesMismatch,
    /// Rollstuhlkontingent widerspricht dem Asset.
    WheelchairPlacesMismatch,
    /// Barrierefreie Bereiche in einem ausdrücklich nicht barrierefreien Asset.
    AccessibilityMismatch,
    /// Die bekannten M5-Ausstattungszusagen stimmen nicht überein.
    EquipmentMismatch,
}

impl fmt::Display for VehicleConfigurationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl Error for VehicleConfigurationError {}

impl VehicleConfigurationV1 {
    /// Kanonisiert ausschließlich die ungeordnete Ausstattungsmenge; ergänzt nichts.
    pub fn normalize(&mut self) {
        self.interior.amenities.sort();
    }

    /// Prüft alle Transport- und vorhandenen M5-Domäneninvarianten.
    pub fn validate(&self) -> Result<(), VehicleConfigurationError> {
        self.to_domain().map(|_| ())
    }

    /// Erzeugt die echte M5-Domänenkonfiguration ohne Ersatzwerte.
    pub fn to_domain(&self) -> Result<VehicleConfiguration, VehicleConfigurationError> {
        if self.schema_version != VEHICLE_CONFIGURATION_SCHEMA {
            return Err(VehicleConfigurationError::UnsupportedSchema);
        }
        let amenities = self
            .interior
            .amenities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if amenities.len() != self.interior.amenities.len() {
            return Err(VehicleConfigurationError::DuplicateAmenity);
        }
        let structural = StructuralConfiguration::new(
            self.structural.door_count_per_side,
            self.structural.door_width_mm,
            Length::from_millimetres(i64::from(self.structural.body_length_mm)),
        )
        .map_err(VehicleConfigurationError::InvalidDomain)?;
        let interior = InteriorConfiguration {
            first_class_seats: self.interior.first_class_seats,
            second_class_seats: self.interior.second_class_seats,
            density: match self.interior.density {
                SeatingDensityV1::Dense => SeatingDensity::Dense,
                SeatingDensityV1::Standard => SeatingDensity::Standard,
                SeatingDensityV1::Spacious => SeatingDensity::Spacious,
            },
            seat_type: match self.interior.seat_type {
                SeatTypeV1::Row => SeatType::Row,
                SeatTypeV1::FaceToFace => SeatType::FaceToFace,
                SeatTypeV1::Folding => SeatType::Folding,
            },
            multipurpose: MultipurposeArea {
                bicycles: self.interior.multipurpose.bicycles,
                pushchairs: self.interior.multipurpose.pushchairs,
                wheelchairs: self.interior.multipurpose.wheelchairs,
                standing: self.interior.multipurpose.standing,
            },
            toilets: self.interior.toilets,
            accessible_toilets: self.interior.accessible_toilets,
            amenities: amenities
                .into_iter()
                .map(|amenity| match amenity {
                    AmenityV1::AirConditioning => Amenity::AirConditioning,
                    AmenityV1::Wifi => Amenity::Wifi,
                    AmenityV1::PowerSockets => Amenity::PowerSockets,
                    AmenityV1::PassengerInformation => Amenity::PassengerInformation,
                })
                .collect(),
        };
        VehicleConfiguration::new(structural, interior)
            .map_err(VehicleConfigurationError::InvalidDomain)
    }

    /// Gleicht vorhandene Konfiguration mit den unveränderten Authority-Fakten ab.
    pub fn validate_against(
        &self,
        facts: VehicleConfigurationFacts,
    ) -> Result<(), VehicleConfigurationError> {
        let configuration = self.to_domain()?;
        let interior = configuration.interior();
        if configuration.structural().body_length().millimetres() != facts.length_mm {
            return Err(VehicleConfigurationError::LengthMismatch);
        }
        if interior.seats() != facts.seats {
            return Err(VehicleConfigurationError::SeatCountMismatch);
        }
        if u32::from(interior.first_class_seats) != facts.first_class_seats {
            return Err(VehicleConfigurationError::FirstClassMismatch);
        }
        if interior.multipurpose.bicycles != facts.bicycle_places {
            return Err(VehicleConfigurationError::BicyclePlacesMismatch);
        }
        if interior.multipurpose.wheelchairs != facts.wheelchair_places {
            return Err(VehicleConfigurationError::WheelchairPlacesMismatch);
        }
        if !facts.accessible
            && (interior.multipurpose.wheelchairs > 0 || interior.accessible_toilets > 0)
        {
            return Err(VehicleConfigurationError::AccessibilityMismatch);
        }
        Ok(())
    }

    /// Vergleicht ausschließlich die explizit bekannten M5-Ausstattungskennungen.
    /// Andere Authority-Ausstattung bleibt erhalten und wird nicht als Innenraumwert erfunden.
    pub fn validate_equipment(
        &self,
        equipment: &[String],
    ) -> Result<(), VehicleConfigurationError> {
        self.validate()?;
        let authority = equipment
            .iter()
            .filter_map(|item| match item.as_str() {
                "air-conditioning" | "air_conditioning" => Some(AmenityV1::AirConditioning),
                "wifi" => Some(AmenityV1::Wifi),
                "power-sockets" | "power_sockets" => Some(AmenityV1::PowerSockets),
                "passenger-information" | "passenger_information" | "pis" => {
                    Some(AmenityV1::PassengerInformation)
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if authority != self.interior.amenities.iter().copied().collect() {
            return Err(VehicleConfigurationError::EquipmentMismatch);
        }
        Ok(())
    }
}
