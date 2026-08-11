//! Sprachübergreifender, kanonischer M5→M6-Mobilisierungssnapshot.
//!
//! Der Rust-Single-Writer erzeugt diese Nutzdaten erst nach Beschaffungs-,
//! Formations-, Zulassungs-, Instandhaltungs-, Personal- und Trassenprüfung.
//! TypeScript darf daraus Werte lesen, aber keine technischen Kopien ergänzen.

#![allow(
    missing_docs,
    reason = "Transportfelder spiegeln das dokumentierte JSON-Schema wortgleich"
)]

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FLEET_MOBILIZATION_SCHEMA: &str = "zugfolge-fleet-mobilization/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobilizationAvailability {
    Available,
    Committed,
    Maintenance,
    Retired,
}

impl MobilizationAvailability {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Committed => "committed",
            Self::Maintenance => "maintenance",
            Self::Retired => "retired",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobilizationProcurement {
    Delivered,
    Ordered,
    Cancelled,
}

impl MobilizationProcurement {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Ordered => "ordered",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobilizationTraction {
    Electric,
    Diesel,
    Battery,
    Hydrogen,
}

impl MobilizationTraction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Electric => "electric",
            Self::Diesel => "diesel",
            Self::Battery => "battery",
            Self::Hydrogen => "hydrogen",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobilizationDutyStatus {
    Ready,
    Planned,
    Uncovered,
}

impl MobilizationDutyStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Planned => "planned",
            Self::Uncovered => "uncovered",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobilizationPathStatus {
    Confirmed,
    Requested,
    Rejected,
}

impl MobilizationPathStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Requested => "requested",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilizationCharacteristics {
    pub seats: u32,
    pub first_class_basis_points: u16,
    pub accessible: bool,
    pub bicycle_places: u16,
    pub wheelchair_places: u16,
    pub equipment: Vec<String>,
    pub vehicle_age_years: u16,
    pub maximum_speed_kph: u16,
    pub operating_cost_cents_per_train_km: u32,
    pub homologated_line_ids: Vec<String>,
    pub maintenance_valid_until: u64,
    pub traction: MobilizationTraction,
    pub replacement_plan: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilizationFormation {
    pub id: String,
    pub operator_id: String,
    pub vehicle_ids: Vec<String>,
    pub service_line_ids: Vec<String>,
    pub availability: MobilizationAvailability,
    pub procurement: MobilizationProcurement,
    pub available_from: u64,
    pub available_until: u64,
    pub characteristics: MobilizationCharacteristics,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilizationPersonnelDuty {
    pub id: String,
    pub operator_id: String,
    pub formation_ids: Vec<String>,
    pub status: MobilizationDutyStatus,
    pub valid_from: u64,
    pub valid_until: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilizationPathReservation {
    pub id: String,
    pub operator_id: String,
    pub service_line_ids: Vec<String>,
    pub status: MobilizationPathStatus,
    pub valid_from: u64,
    pub valid_until: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilizationSnapshot {
    pub schema: String,
    pub world_id: String,
    pub revision: u64,
    pub produced_at: u64,
    pub formations: Vec<MobilizationFormation>,
    pub personnel_duties: Vec<MobilizationPersonnelDuty>,
    pub path_reservations: Vec<MobilizationPathReservation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MobilizationSnapshotError {
    UnsupportedSchema,
    EmptyField(&'static str),
    EmptyList(&'static str),
    DuplicateId(&'static str),
    InvalidWindow(&'static str),
    UnsafeJsonInteger(&'static str),
    InvalidCharacteristics,
}

impl MobilizationSnapshot {
    pub fn validate(&self) -> Result<(), MobilizationSnapshotError> {
        if self.schema != FLEET_MOBILIZATION_SCHEMA {
            return Err(MobilizationSnapshotError::UnsupportedSchema);
        }
        non_empty(&self.world_id, "worldId")?;
        safe_integer(self.revision, "revision")?;
        safe_integer(self.produced_at, "producedAt")?;
        unique_ids(
            self.formations.iter().map(|item| item.id.as_str()),
            "formations",
        )?;
        unique_ids(
            self.personnel_duties.iter().map(|item| item.id.as_str()),
            "personnelDuties",
        )?;
        unique_ids(
            self.path_reservations.iter().map(|item| item.id.as_str()),
            "pathReservations",
        )?;
        for formation in &self.formations {
            non_empty(&formation.operator_id, "formations[].operatorId")?;
            string_list(&formation.vehicle_ids, "formations[].vehicleIds")?;
            string_list(&formation.service_line_ids, "formations[].serviceLineIds")?;
            valid_window(
                formation.available_from,
                formation.available_until,
                "formations[].availability",
            )?;
            let characteristics = &formation.characteristics;
            if characteristics.seats == 0
                || characteristics.first_class_basis_points > 10_000
                || characteristics.maximum_speed_kph == 0
            {
                return Err(MobilizationSnapshotError::InvalidCharacteristics);
            }
            string_list_allow_empty(
                &characteristics.equipment,
                "formations[].characteristics.equipment",
            )?;
            string_list(
                &characteristics.homologated_line_ids,
                "formations[].characteristics.homologatedLineIds",
            )?;
            safe_integer(
                characteristics.maintenance_valid_until,
                "formations[].characteristics.maintenanceValidUntil",
            )?;
        }
        for duty in &self.personnel_duties {
            non_empty(&duty.operator_id, "personnelDuties[].operatorId")?;
            string_list(&duty.formation_ids, "personnelDuties[].formationIds")?;
            valid_window(
                duty.valid_from,
                duty.valid_until,
                "personnelDuties[].validity",
            )?;
        }
        for path in &self.path_reservations {
            non_empty(&path.operator_id, "pathReservations[].operatorId")?;
            string_list(&path.service_line_ids, "pathReservations[].serviceLineIds")?;
            valid_window(
                path.valid_from,
                path.valid_until,
                "pathReservations[].validity",
            )?;
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, MobilizationSnapshotError> {
        self.validate()?;
        let mut formations = self.formations.clone();
        formations.sort_by(|left, right| left.id.cmp(&right.id));
        let mut duties = self.personnel_duties.clone();
        duties.sort_by(|left, right| left.id.cmp(&right.id));
        let mut paths = self.path_reservations.clone();
        paths.sort_by(|left, right| left.id.cmp(&right.id));

        let mut output = String::from("{\"formations\":[");
        write_joined(&mut output, &formations, write_formation);
        output.push_str("],\"pathReservations\":[");
        write_joined(&mut output, &paths, write_path);
        output.push_str("],\"personnelDuties\":[");
        write_joined(&mut output, &duties, write_duty);
        write!(
            output,
            "],\"producedAt\":{},\"revision\":{},\"schema\":\"{}\",\"worldId\":",
            self.produced_at, self.revision, FLEET_MOBILIZATION_SCHEMA
        )
        .expect("writing to String cannot fail");
        write_json_string(&mut output, &self.world_id);
        output.push('}');
        Ok(output)
    }

    pub fn sha256(&self) -> Result<String, MobilizationSnapshotError> {
        let digest = Sha256::digest(self.canonical_json()?.as_bytes());
        let mut output = String::with_capacity(64);
        for byte in digest {
            write!(output, "{byte:02x}").expect("writing to String cannot fail");
        }
        Ok(output)
    }
}

fn non_empty(value: &str, field: &'static str) -> Result<(), MobilizationSnapshotError> {
    if value.trim().is_empty() {
        Err(MobilizationSnapshotError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn safe_integer(value: u64, field: &'static str) -> Result<(), MobilizationSnapshotError> {
    if value > MAX_SAFE_JSON_INTEGER {
        Err(MobilizationSnapshotError::UnsafeJsonInteger(field))
    } else {
        Ok(())
    }
}

fn valid_window(
    from: u64,
    until: u64,
    field: &'static str,
) -> Result<(), MobilizationSnapshotError> {
    safe_integer(from, field)?;
    safe_integer(until, field)?;
    if until <= from {
        Err(MobilizationSnapshotError::InvalidWindow(field))
    } else {
        Ok(())
    }
}

fn unique_ids<'a>(
    values: impl Iterator<Item = &'a str>,
    field: &'static str,
) -> Result<(), MobilizationSnapshotError> {
    let mut collected = values.collect::<Vec<_>>();
    for value in &collected {
        non_empty(value, field)?;
    }
    collected.sort_unstable();
    if collected.windows(2).any(|window| window[0] == window[1]) {
        Err(MobilizationSnapshotError::DuplicateId(field))
    } else {
        Ok(())
    }
}

fn string_list(values: &[String], field: &'static str) -> Result<(), MobilizationSnapshotError> {
    if values.is_empty() {
        return Err(MobilizationSnapshotError::EmptyList(field));
    }
    string_list_allow_empty(values, field)
}

fn string_list_allow_empty(
    values: &[String],
    field: &'static str,
) -> Result<(), MobilizationSnapshotError> {
    unique_ids(values.iter().map(String::as_str), field)
}

fn write_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control <= '\u{1f}' => {
                write!(output, "\\u{:04x}", control as u32).expect("writing to String cannot fail");
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

fn write_string_array(output: &mut String, values: &[String]) {
    let mut sorted = values.to_vec();
    sorted.sort();
    output.push('[');
    for (index, value) in sorted.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        write_json_string(output, value);
    }
    output.push(']');
}

fn write_joined<T>(output: &mut String, values: &[T], writer: fn(&mut String, &T)) {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        writer(output, value);
    }
}

fn write_formation(output: &mut String, formation: &MobilizationFormation) {
    output.push_str("{\"availability\":");
    write_json_string(output, formation.availability.as_str());
    write!(
        output,
        ",\"availableFrom\":{},\"availableUntil\":{},\"characteristics\":{{\"accessible\":{}",
        formation.available_from, formation.available_until, formation.characteristics.accessible
    )
    .expect("writing to String cannot fail");
    let c = &formation.characteristics;
    write!(
        output,
        ",\"bicyclePlaces\":{},\"equipment\":",
        c.bicycle_places
    )
    .expect("writing to String cannot fail");
    write_string_array(output, &c.equipment);
    write!(
        output,
        ",\"firstClassBasisPoints\":{},\"homologatedLineIds\":",
        c.first_class_basis_points
    )
    .expect("writing to String cannot fail");
    write_string_array(output, &c.homologated_line_ids);
    write!(
        output,
        ",\"maintenanceValidUntil\":{},\"maximumSpeedKph\":{},\
         \"operatingCostCentsPerTrainKm\":{},\"replacementPlan\":{},\
         \"seats\":{},\"traction\":",
        c.maintenance_valid_until,
        c.maximum_speed_kph,
        c.operating_cost_cents_per_train_km,
        c.replacement_plan,
        c.seats
    )
    .expect("writing to String cannot fail");
    write_json_string(output, c.traction.as_str());
    write!(
        output,
        ",\"vehicleAgeYears\":{},\"wheelchairPlaces\":{}}},\"id\":",
        c.vehicle_age_years, c.wheelchair_places
    )
    .expect("writing to String cannot fail");
    write_json_string(output, &formation.id);
    output.push_str(",\"operatorId\":");
    write_json_string(output, &formation.operator_id);
    output.push_str(",\"procurement\":");
    write_json_string(output, formation.procurement.as_str());
    output.push_str(",\"serviceLineIds\":");
    write_string_array(output, &formation.service_line_ids);
    output.push_str(",\"vehicleIds\":");
    write_string_array(output, &formation.vehicle_ids);
    output.push('}');
}

fn write_duty(output: &mut String, duty: &MobilizationPersonnelDuty) {
    output.push_str("{\"formationIds\":");
    write_string_array(output, &duty.formation_ids);
    output.push_str(",\"id\":");
    write_json_string(output, &duty.id);
    output.push_str(",\"operatorId\":");
    write_json_string(output, &duty.operator_id);
    output.push_str(",\"status\":");
    write_json_string(output, duty.status.as_str());
    write!(
        output,
        ",\"validFrom\":{},\"validUntil\":{}}}",
        duty.valid_from, duty.valid_until
    )
    .expect("writing to String cannot fail");
}

fn write_path(output: &mut String, path: &MobilizationPathReservation) {
    output.push_str("{\"id\":");
    write_json_string(output, &path.id);
    output.push_str(",\"operatorId\":");
    write_json_string(output, &path.operator_id);
    output.push_str(",\"serviceLineIds\":");
    write_string_array(output, &path.service_line_ids);
    output.push_str(",\"status\":");
    write_json_string(output, path.status.as_str());
    write!(
        output,
        ",\"validFrom\":{},\"validUntil\":{}}}",
        path.valid_from, path.valid_until
    )
    .expect("writing to String cannot fail");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> MobilizationSnapshot {
        MobilizationSnapshot {
            schema: FLEET_MOBILIZATION_SCHEMA.into(),
            world_id: "11111111-1111-4111-8111-111111111111".into(),
            revision: 7,
            produced_at: 1_786_233_600,
            formations: vec![MobilizationFormation {
                id: "formation-1".into(),
                operator_id: "operator-1".into(),
                vehicle_ids: vec!["vehicle-2".into(), "vehicle-1".into()],
                service_line_ids: vec!["S1".into()],
                availability: MobilizationAvailability::Available,
                procurement: MobilizationProcurement::Delivered,
                available_from: 1_786_233_000,
                available_until: 1_788_825_600,
                characteristics: MobilizationCharacteristics {
                    seats: 220,
                    first_class_basis_points: 500,
                    accessible: true,
                    bicycle_places: 12,
                    wheelchair_places: 2,
                    equipment: vec!["passenger-information".into(), "wifi".into()],
                    vehicle_age_years: 2,
                    maximum_speed_kph: 160,
                    operating_cost_cents_per_train_km: 780,
                    homologated_line_ids: vec!["S1".into()],
                    maintenance_valid_until: 1_788_825_600,
                    traction: MobilizationTraction::Electric,
                    replacement_plan: true,
                },
            }],
            personnel_duties: vec![MobilizationPersonnelDuty {
                id: "duty-1".into(),
                operator_id: "operator-1".into(),
                formation_ids: vec!["formation-1".into()],
                status: MobilizationDutyStatus::Ready,
                valid_from: 1_786_233_000,
                valid_until: 1_788_825_600,
            }],
            path_reservations: vec![MobilizationPathReservation {
                id: "path-1".into(),
                operator_id: "operator-1".into(),
                service_line_ids: vec!["S1".into()],
                status: MobilizationPathStatus::Confirmed,
                valid_from: 1_786_233_000,
                valid_until: 1_788_825_600,
            }],
        }
    }

    #[test]
    fn golden_snapshot_is_byte_identical_for_typescript() {
        let expected = include_str!("../tests/fixtures/mobilization-snapshot-v1.json").trim_end();
        let expected_hash =
            include_str!("../tests/fixtures/mobilization-snapshot-v1.sha256").trim_end();
        let snapshot = fixture();
        assert_eq!(snapshot.canonical_json().unwrap(), expected);
        assert_eq!(snapshot.sha256().unwrap(), expected_hash);
    }

    #[test]
    fn rejects_numbers_typescript_cannot_hash_losslessly() {
        let mut snapshot = fixture();
        snapshot.revision = MAX_SAFE_JSON_INTEGER + 1;
        assert_eq!(
            snapshot.validate(),
            Err(MobilizationSnapshotError::UnsafeJsonInteger("revision"))
        );
    }
}
