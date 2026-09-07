// Ausschließlich synthetischer Testkorpus auf dem echten Operational-Produzenten.
fn service_day_input(two_services: bool, cost_known: bool) -> Value {
    let mut input = serde_json::to_value(initialization()).unwrap();
    input["trains"][0]["scheduledDepartureMs"] = json!(0);
    input["trains"][0]["publicPassengerStop"] = json!(true);
    input["trains"][0]["serviceOutcome"] = json!({
        "schemaVersion":"zugfolge-operational-service-outcome-binding/v1", "serviceId":"service:1",
        "serviceRunId":"service:1:service-day:2026-09-05", "lotId":"lot:1", "serviceDay":"2026-09-05",
        "scheduledArrivalMs":1000,"requiredSeats":100,"connectionAssessment":"none-contracted" });
    if two_services {
        let mut second = input["trains"][0].clone();
        second["id"] = json!("train:2");
        second["trainNumber"] = json!("RB 2");
        second["serviceOutcome"]["serviceId"] = json!("service:2");
        second["serviceOutcome"]["serviceRunId"] = json!("service:2:service-day:2026-09-05");
        input["trains"].as_array_mut().unwrap().push(second);
    }
    let trains = input["trains"].as_array().unwrap();
    input["serviceOutcomePolicy"] = json!({"schemaVersion":"zugfolge-operational-service-outcome-policy/v1",
        "serviceIds":trains.iter().map(|train| train["serviceOutcome"]["serviceId"].clone()).collect::<Vec<_>>(),
        "vehicleCapacities":[{"vehicleId":"vehicle:1","seats":120,"sourceReference":"fleet:test:vehicle:1"}]});
    input["serviceDayPolicy"] = json!({"schemaVersion":"zugfolge-operational-service-day-policy/v1", "epochServiceDay":"2026-09-05","dayLengthMs":86400000,
        "services":input["trains"].as_array().unwrap().iter().map(|train| json!({"trainRunId":train["id"],"operatorId":train["operatorId"],"firstDayIndex":0,
            "scheduledDepartureMs":train["scheduledDepartureMs"],"binding":train["serviceOutcome"]})).collect::<Vec<_>>(),
        "vehicleCostPolicy":if cost_known { json!({"economyReleaseHash":"a".repeat(64),"fleetAuthorityReleaseHash":"b".repeat(64),
            "vehicleCosts":[{"vehicleId":"vehicle:1","centsPerTrainKm":700,"sourceReference":"fleet:test:vehicle:1"}]}) } else { Value::Null }});
    input
}

fn service_day_finished(input: &Value) -> (Value, Value) {
    let initialized: Value = serde_json::from_str(&initialize_operational_simulation(&input.to_string()).unwrap()).unwrap();
    let opened = apply_value(&initialized["state"], "day:open", json!({"type":"open-service-day","dayIndex":0}));
    assert_eq!(opened["events"].as_array().unwrap().iter().filter(|event| event["kind"] == "service-day-planned").count(), 1);
    let materialized = apply_value(&opened["state"], "day:materialize", json!({"type":"materialize","train":input["trains"][0]}));
    let dispatched = apply_value(&materialized["state"], "day:dispatch", json!({"type":"dispatch","requests":[{
        "trainId":"train:1","interlockingRouteId":"interlocking:1","committedRank":0,"timetableDeviationMs":0,
        "passengerImpact":0,"contractualImpact":0,"networkImpact":0,"resourceConsequence":0,"recoveryRank":0,"waitingSinceMs":0}]}));
    let finished = apply_value(&dispatched["state"], "day:finish", json!({"type":"advance-to","atMs":1000000}));
    (initialized, finished)
}

fn rehash_service_day_state(value: &Value) -> Value {
    let mut state: RuntimeState = serde_json::from_value(value.clone()).unwrap();
    state.state_hash = state_hash(&state.initialization_hash, &state.infra_release, &state.world,
        state.revision, state.publisher_sequence, &state.command_receipts, &state.passenger_stop_templates);
    serde_json::to_value(state).unwrap()
}

#[test]
fn service_days_close_real_movement_at_day_end_and_restore_exactly() {
    let input = service_day_input(false, true);
    let (initialized, finished) = service_day_finished(&input);
    assert!(!finished["events"].as_array().unwrap().iter().any(|event| event["kind"] == "service-day-closed"));
    let cost: Value = serde_json::from_str(finished["events"].as_array().unwrap().iter().find(|event| event["kind"] == "service-vehicle-cost").unwrap()["detail"].as_str().unwrap()).unwrap();
    let outcome: Value = serde_json::from_str(finished["events"].as_array().unwrap().iter().find(|event| event["kind"] == "train-outcome").unwrap()["detail"].as_str().unwrap()).unwrap();
    let distance: i128 = outcome["distanceMm"].as_str().unwrap().parse().unwrap();
    assert!(distance > 0);
    assert_eq!(cost["millimetreCents"], (distance * 700).to_string());
    let restored = restore_value(&finished["state"], &initialized["initializationHash"]).unwrap();
    let command = json!({"type":"advance-to","atMs":86400001});
    let closed = apply_value(&finished["state"], "day:close", command.clone());
    let replayed = apply_value(&restored["state"], "day:close", command.clone());
    assert_eq!(closed["stateHash"], replayed["stateHash"]);
    assert_eq!(closed["events"], replayed["events"]);
    let receipts: Vec<_> = closed["events"].as_array().unwrap().iter().filter(|event| event["kind"] == "service-day-closed").collect();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["atMs"], 86400000);
    let receipt: Value = serde_json::from_str(receipts[0]["detail"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["formationOperatingCostCents"], (distance * 700 / 1_000_000).to_string());
    assert_eq!(receipt["vehicleCostEvidenceComplete"], true);
    let retry = apply_value(&closed["state"], "day:close", command);
    assert_eq!(retry["stateHash"], closed["stateHash"]);
    assert_eq!(retry["events"], json!([]));
    let reopening = apply_value(&closed["state"], "day:reopen", json!({"type":"open-service-day","dayIndex":0}));
    assert_eq!(reopening["events"], json!([]));
    assert_eq!(reopening["state"]["world"]["serviceDayState"]["open"], json!({}));
}

#[test]
fn service_days_missing_original_service_never_closes_and_unknown_cost_stays_null() {
    let (initialized, finished) = service_day_finished(&service_day_input(true, true));
    let next = apply_value(&finished["state"], "day:missing", json!({"type":"advance-to","atMs":86400001}));
    assert!(!next["events"].as_array().unwrap().iter().any(|event| event["kind"] == "service-day-closed"));
    assert!(restore_value(&next["state"], &initialized["initializationHash"]).is_ok());
    let (_, unknown) = service_day_finished(&service_day_input(false, false));
    let closed = apply_value(&unknown["state"], "day:unknown", json!({"type":"advance-to","atMs":86400000}));
    let receipt: Value = serde_json::from_str(closed["events"].as_array().unwrap().iter().find(|event| event["kind"] == "service-day-closed").unwrap()["detail"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["dayPlanComplete"], true);
    assert_eq!(receipt["vehicleCostEvidenceComplete"], false);
    assert_eq!(receipt["formationOperatingCostCents"], Value::Null);
}

#[test]
fn service_days_reject_incomplete_or_foreign_original_catalogs() {
    let input = service_day_input(true, true);
    for (pointer, changed) in [("/serviceDayPolicy/services", json!([input["serviceDayPolicy"]["services"][0]])),
        ("/serviceDayPolicy/services/0/operatorId", json!("foreign")),
        ("/serviceDayPolicy/services/0/firstDayIndex", json!(1)),
        ("/serviceDayPolicy/services/0/binding/lotId", json!("foreign")),
        ("/serviceDayPolicy/dayLengthMs", json!(1000))] {
        let mut invalid = input.clone();
        *invalid.pointer_mut(pointer).unwrap() = changed;
        assert!(initialize_operational_simulation(&invalid.to_string()).is_err(), "{pointer}");
    }
}

#[test]
fn service_days_restore_revalidates_cost_source_and_original_outcomes_even_with_new_outer_hash() {
    let (initialized, finished) = service_day_finished(&service_day_input(false, true));
    let id = "service:1:service-day:2026-09-05";
    for (collection, field, changed) in [("costs", "millimetreCents", json!("999999999")),
        ("costs", "worldId", json!("foreign")), ("costs", "economyReleaseHash", json!("c".repeat(64))),
        ("outcomes", "trainRunId", json!("foreign")), ("outcomes", "delaySeconds", json!(0))] {
        let mut bad = finished["state"].clone();
        bad["world"]["serviceDayState"]["open"]["0"][collection][id][field] = changed;
        assert!(restore_value(&rehash_service_day_state(&bad), &initialized["initializationHash"]).is_err(), "{collection}.{field}");
    }
    let input = service_day_input(false, true);
    let start = apply_value(&initialized["state"], "day:active", json!({"type":"materialize","train":input["trains"][0]}));
    let mut bad = start["state"].clone();
    bad["world"]["serviceDayState"]["vehicleProgress"] = json!({});
    assert!(restore_value(&rehash_service_day_state(&bad), &initialized["initializationHash"]).is_err());
}
