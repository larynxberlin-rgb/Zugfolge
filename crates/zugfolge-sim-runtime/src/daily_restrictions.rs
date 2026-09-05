//! Nativer, releasegebundener Anschluss des M8-Tagesmodells.
//! Nicht darstellbare Originalwirkungen bleiben explizite Diagnosen.

use crate::operational_runtime::{InfrastructureBinding, infrastructure_for_binding};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zugfolge_conflict::ConflictResource;
use zugfolge_determinism::{SimTime, WorldSeed};
use zugfolge_disruption::{
    DisruptionEffect, DisruptionMode, DisruptionPolicy, RestrictionDirection, RestrictionTraffic,
    SimulationProfile, generate_daily_restrictions,
};
use zugfolge_infra::TrackId;

const DAY_MS: i64 = 86_400_000;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_DAILY_RESTRICTIONS: u32 = 10_000;
const MAX_DISTINCT_OPERATIONAL_EDGES: usize = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyInput {
    version: u32,
    planned_works_mode: DisruptionMode,
    operational_incident_mode: DisruptionMode,
    provider_set_id: Option<String>,
    simulation_profile: SimulationProfile,
    ruleset_version: String,
    valid_from_ms: i64,
    valid_until_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    schema_version: String,
    world_id: String,
    region_id: String,
    seed: String,
    day_start_ms: i64,
    infra_release: InfrastructureBinding,
    route_version_ids: Vec<String>,
    policy: PolicyInput,
}

fn effect_json(effect: &DisruptionEffect, edges: &BTreeMap<ConflictResource, String>) -> Value {
    match effect {
        DisruptionEffect::Closure => json!({"type":"closure"}),
        DisruptionEffect::SingleTrack {
            shared_resource,
            remaining_capacity,
        } => {
            json!({"type":"single-track","sharedEdgeId":edges.get(shared_resource),"remainingCapacity":remaining_capacity})
        }
        DisruptionEffect::SpeedRestriction {
            maximum_speed_mm_per_second,
        } => json!({"type":"speed-restriction","maximumSpeedMmps":maximum_speed_mm_per_second}),
        DisruptionEffect::PlatformChange { replacement } => {
            json!({"type":"platform-change","replacementEdgeId":edges.get(replacement)})
        }
        DisruptionEffect::TrafficHold {
            maximum_hold_seconds,
        } => json!({"type":"traffic-hold","maximumHoldSeconds":maximum_hold_seconds}),
        DisruptionEffect::RouteDeviation {
            alternative_resources,
        } => {
            json!({"type":"route-deviation","alternativeEdgeIds":alternative_resources.iter().map(|resource| edges.get(resource)).collect::<Vec<_>>()})
        }
        DisruptionEffect::VehicleRestriction {
            maximum_axle_load_kg,
            maximum_train_length_mm,
        } => {
            json!({"type":"vehicle-restriction","maximumAxleLoadKg":maximum_axle_load_kg,"maximumTrainLengthMm":maximum_train_length_mm})
        }
        DisruptionEffect::PlatformUsableLength {
            maximum_usable_length_mm,
        } => {
            json!({"type":"platform-usable-length","maximumUsableLengthMm":maximum_usable_length_mm})
        }
    }
}

fn generate_for_edges(
    input: &Input,
    infra_id: &str,
    edges: BTreeSet<String>,
) -> Result<Value, String> {
    if input.schema_version != "zugfolge-operational-daily-restrictions/v1"
        || input.world_id.trim().is_empty()
        || input.region_id.trim().is_empty()
        || input.day_start_ms < 0
        || input.day_start_ms % DAY_MS != 0
        || input.day_start_ms > 9_007_199_254_740_991 - 2 * DAY_MS
        || input.policy.valid_from_ms > input.day_start_ms
        || input
            .policy
            .valid_until_ms
            .is_some_and(|until| until <= input.day_start_ms)
        || input.policy.simulation_profile.daily_restrictions_per_day > MAX_DAILY_RESTRICTIONS
        || edges.is_empty()
    {
        return Err("invalid_daily_restriction_request".into());
    }
    let seed = input
        .seed
        .parse::<u64>()
        .map_err(|_| "invalid_daily_restriction_seed")?;
    if seed.to_string() != input.seed {
        return Err("invalid_daily_restriction_seed".into());
    }
    let world_digest = Sha256::digest(input.world_id.as_bytes());
    let world_key =
        u64::from_be_bytes(world_digest[..8].try_into().expect("eight hash bytes")).max(1);
    let policy = DisruptionPolicy::new(
        world_key,
        input.policy.version,
        input.policy.planned_works_mode,
        input.policy.operational_incident_mode,
        input.policy.provider_set_id.clone(),
        input.policy.simulation_profile.clone(),
        input.policy.ruleset_version.clone(),
        SimTime::from_seconds(input.policy.valid_from_ms / 1_000),
        input
            .policy
            .valid_until_ms
            .map(|until| SimTime::from_seconds(until / 1_000)),
    )
    .map_err(|error| format!("invalid_daily_restriction_policy: {error}"))?;
    let mut resources = Vec::new();
    let mut by_resource = BTreeMap::new();
    for (index, edge_id) in edges.into_iter().enumerate() {
        // Die ordinale Bruecke ist ausschliesslich ein stabiler Modellindex,
        // niemals ein behaupteter Betriebsgraph-Track oder Belastungsnachweis.
        let resource = ConflictResource::Track(TrackId::new(
            u32::try_from(index + 1).map_err(|_| "daily_resource_overflow")?,
        ));
        resources.push((edge_id.clone(), resource, 0));
        by_resource.insert(resource, edge_id);
    }
    let generated = if input.policy.planned_works_mode == DisruptionMode::Manual
        && input.policy.operational_incident_mode == DisruptionMode::Manual
    {
        Vec::new()
    } else {
        generate_daily_restrictions(
            &policy,
            WorldSeed::new(seed, 0),
            infra_id,
            SimTime::from_seconds(input.day_start_ms / 1_000),
            &resources,
        )
        .map_err(|error| format!("daily_restriction_generation_failed: {error}"))?
    };
    let mut restrictions = Vec::new();
    let mut unsupported = Vec::new();
    for event in generated {
        let edge_id = by_resource
            .get(&event.resources[0])
            .ok_or("unbound_daily_resource")?;
        let disruption_id = format!(
            "daily:{}:{}:{}",
            input.region_id, input.policy.version, event.id
        );
        let starts_at_ms = event
            .starts_at
            .seconds()
            .checked_mul(1_000)
            .ok_or("daily_time_overflow")?;
        let ends_at_ms = event
            .ends_at
            .seconds()
            .checked_mul(1_000)
            .ok_or("daily_time_overflow")?
            .min(input.policy.valid_until_ms.unwrap_or(i64::MAX));
        let provenance = json!({"kind":"simulated-daily-restriction","substream":event.source.substream,
            "infraRelease":event.source.infra_release,"simulationProfile":event.source.simulation_profile,
            "rulesetVersion":event.source.ruleset_version,"calibrationVersion":event.source.calibration_version,
            "seed":input.seed,"causeCode":event.cause_code,"fineCauseId":event.fine_cause_id,
            "resourceModel":"sorted-operational-edges/v1","loadBasisPoints":0});
        let global_scope = event.scope.direction == RestrictionDirection::Both
            && event.scope.traffic == RestrictionTraffic::All
            && event.scope.train_run_ids.is_empty();
        if let DisruptionEffect::SpeedRestriction {
            maximum_speed_mm_per_second,
        } = event.effect
            && global_scope
        {
            restrictions.push(json!({"disruptionId":disruption_id,"startsAtMs":starts_at_ms,"endsAtMs":ends_at_ms,
                "effect":zugfolge_sim::operational::OperationalDisruption::SpeedRestriction{edge_id:edge_id.clone(), maximum_speed_mmps:maximum_speed_mm_per_second},"provenance":provenance}));
        } else {
            unsupported.push(json!({"disruptionId":disruption_id,"startsAtMs":starts_at_ms,"endsAtMs":ends_at_ms,"edgeId":edge_id,
                "effect":effect_json(&event.effect, &by_resource),"scope":{
                    "direction":match event.scope.direction { RestrictionDirection::Both=>"both",RestrictionDirection::RegularDirection=>"regular-direction",RestrictionDirection::OppositeDirection=>"opposite-direction" },
                    "traffic":match event.scope.traffic { RestrictionTraffic::All=>"all",RestrictionTraffic::Passenger=>"passenger",RestrictionTraffic::Freight=>"freight" },
                    "trainRunIds":event.scope.train_run_ids},"provenance":provenance,
                "reason":if global_scope {"operational-effect-not-supported"} else {"operational-scope-not-supported"}}));
        }
    }
    Ok(
        json!({"schemaVersion":"zugfolge-operational-daily-restrictions-generated/v1","worldId":input.world_id,
        "regionId":input.region_id,"dayStartMs":input.day_start_ms,"policyVersion":input.policy.version,
        "restrictions":restrictions,"unsupportedRestrictions":unsupported}),
    )
}

/// Erzeugt alle La/Diagnosen aus derselben signierten Infrastrukturbindung.
pub fn generate_operational_daily_restrictions(
    input_json: &str,
    infrastructure_path: &str,
) -> Result<String, String> {
    if input_json.len() > MAX_REQUEST_BYTES {
        return Err("daily_restriction_request_too_large".into());
    }
    let input: Input = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid_daily_restriction_request: {error}"))?;
    if input.route_version_ids.is_empty() || input.route_version_ids.len() > 100_000 {
        return Err("invalid_daily_restriction_routes".into());
    }
    let infrastructure = infrastructure_for_binding(&input.infra_release, infrastructure_path)
        .map_err(|error| error.to_string())?;
    let mut edges = BTreeSet::new();
    for route_id in input.route_version_ids.iter().collect::<BTreeSet<_>>() {
        let route = infrastructure
            .route_version(route_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("unknown_daily_restriction_route: {route_id}"))?;
        edges.extend(route.legs.into_iter().map(|leg| leg.edge_id));
        if edges.len() > MAX_DISTINCT_OPERATIONAL_EDGES {
            return Err("daily_restriction_resource_budget_exceeded".into());
        }
    }
    serde_json::to_string(&generate_for_edges(
        &input,
        infrastructure.release_id(),
        edges,
    )?)
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Input {
        serde_json::from_value(json!({"schemaVersion":"zugfolge-operational-daily-restrictions/v1","worldId":"world:1","regionId":"region:a","seed":"77","dayStartMs":0,
            "infraRelease":{"schemaVersion":"zugfolge-operational-infrastructure-binding/v2","infraReleaseId":"infra:test","file":"operational-infrastructure-v2.json","bytes":1,"sha256":"a".repeat(64),"stateHash":"b".repeat(64)},
            "routeVersionIds":["route:1"],"policy":{"version":1,"plannedWorksMode":"REALISTIC","operationalIncidentMode":"REALISTIC","providerSetId":"rights-approved-provider","simulationProfile":SimulationProfile {daily_restrictions_per_day:400,..SimulationProfile::pilot("la-test/v1")},"rulesetVersion":"disruption-rules/v1","validFromMs":0,"validUntilMs":null}})).unwrap()
    }

    #[test]
    fn realistic_daily_model_is_deterministic_and_never_broadens_unsupported_scopes() {
        let input = input();
        let edges = BTreeSet::from(["edge:a".to_owned(), "edge:b".to_owned()]);
        let generated = generate_for_edges(&input, "infra:test", edges.clone()).unwrap();
        assert_eq!(
            generated,
            generate_for_edges(&input, "infra:test", edges).unwrap()
        );
        let applicable = generated["restrictions"].as_array().unwrap();
        let unsupported = generated["unsupportedRestrictions"].as_array().unwrap();
        assert!(!applicable.is_empty());
        assert!(!unsupported.is_empty());
        assert_eq!(applicable.len() + unsupported.len(), 400);
        assert!(
            applicable
                .iter()
                .all(|item| item["effect"]["speed-restriction"].is_object()
                    && item["provenance"]["kind"] == "simulated-daily-restriction")
        );
        assert!(
            unsupported
                .iter()
                .any(|item| item["scope"]["traffic"] == "passenger")
        );
        assert!(
            unsupported
                .iter()
                .any(|item| item["effect"]["type"] == "platform-usable-length")
        );
    }

    #[test]
    fn manual_policy_is_empty_and_invalid_windows_or_unbounded_counts_fail_closed() {
        let mut input = input();
        let edges = BTreeSet::from(["edge:a".to_owned()]);
        input.policy.planned_works_mode = DisruptionMode::Manual;
        input.policy.operational_incident_mode = DisruptionMode::Manual;
        assert!(
            generate_for_edges(&input, "infra:test", edges.clone()).unwrap()["restrictions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        input.day_start_ms = 1;
        assert!(generate_for_edges(&input, "infra:test", edges.clone()).is_err());
        input.day_start_ms = 0;
        input.policy.simulation_profile.daily_restrictions_per_day = 10_001;
        assert!(generate_for_edges(&input, "infra:test", edges).is_err());
    }
}
