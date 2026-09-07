//! Lokaler Single-Writer für die ausdrücklich fiktive Demo. Fachentscheidungen
//! bleiben in den unveränderten Session-, Nachfrage-, Betriebs- und Kontrollkernen.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use zugfolge_conductor::*;
use zugfolge_conductor_dialogue::IdentityStatusV1;
use zugfolge_conductor_session::*;
use zugfolge_demand::*;
use zugfolge_fare_control::*;
use zugfolge_sim::operational::*;

type Result<T> = std::result::Result<T, String>;
fn native<T, E: std::fmt::Display>(value: std::result::Result<T, E>) -> Result<T> { value.map_err(|error| error.to_string()) }
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> { serde_json::from_value(value).map_err(|_| "offline_input_invalid".into()) }
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(Sha256::digest(serde_json::to_vec(value).map_err(|_| "offline_hash_invalid")?).iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct ControlConfig {
    economy_release: Value,
    inspection_policy: FareInspectionPolicyV1,
    police_response_model: PoliceResponseModelV1,
    journeys: Vec<FareJourneyEvidenceV1>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Fixture {
    test_only: bool,
    source: ConductorSessionSourceV1,
    demand: DemandEvaluationInputV1,
    initial_state: ConductorTrainStateV1,
    access: ConductorSessionAccessV1,
    infrastructure: OperationalInfraRelease,
    control: ControlConfig,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Checkpoint {
    schema_version: String,
    fixture_hash: String,
    source: ConductorSessionSourceV1,
    demand: DemandEvaluationInputV1,
    state: ConductorTrainStateV1,
    fare: FareControlWorldStateV1,
    sequence: u64,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct Input {
    fixture: Fixture,
    checkpoint: Option<Checkpoint>,
    command: Option<ConductorCommandV1>,
    #[serde(default)] elapsed_ms: i64,
    target_node_id: Option<String>,
}

fn attach(cp: &mut Checkpoint, fixture: &Fixture) -> Result<()> {
    native(cp.source.operational_world.attach_infrastructure(Arc::new(crate::infrastructure::MemoryInfrastructure::new(fixture.infrastructure.clone())?)))?;
    native(cp.source.operational_world.verify_invariants())
}
fn initialize(fixture: &Fixture) -> Result<Checkpoint> {
    if !fixture.test_only { return Err("offline_test_fixture_required".into()); }
    let source = fixture.source.clone();
    let mut cp = Checkpoint { schema_version:"conductor-offline-checkpoint/v1".into(), fixture_hash:hash(fixture)?,
        source, demand:fixture.demand.clone(), state:fixture.initial_state.clone(),
        fare:native(initialize_fare_control(&fixture.access.world_id,&fixture.access.operator_id,fixture.source.operational_world.now_ms))?, sequence:0 };
    attach(&mut cp,fixture)?;
    let model = &fixture.control.police_response_model;
    let mut hold_policy = FareControlPolicyV1 { schema:FARE_CONTROL_POLICY_SCHEMA.into(),policy_id:"offline-explicit-test-hold".into(),revision:1,
        world_id:cp.state.world_id.clone(),schedule_period_id:fixture.control.inspection_policy.period_id.clone(),content_hash:String::new(),
        max_police_holds_per_train_run:1,eligible_reasons:BTreeSet::from([FareControlReasonV1::IdentityRefusal,FareControlReasonV1::ConcreteDanger]),
        target_rule:"next_unreached_scheduled_passenger_stop".into(),provider_by_stop_id:cp.demand.services.iter().flat_map(|s| s.stops.iter())
            .map(|s| (s.stop_id.clone(),"offline-explicit-test-authority".into())).collect(),max_wait_ms:60_000,
        police_response_model_id:model.model_id.clone(),police_response_model_hash:model.content_hash.clone(),public_cause:FARE_CONTROL_CAUSE.into() };
    hold_policy.content_hash=fare_control_policy_hash(&hold_policy);
    native(cp.source.operational_world.set_fare_control_policy(hold_policy))?;
    cp.source.expected_operational_world_hash=operational_world_hash(&cp.source.operational_world);
    Ok(cp)
}
fn restore(cp: Checkpoint, fixture: &Fixture) -> Result<Checkpoint> {
    if cp.schema_version!="conductor-offline-checkpoint/v1" || cp.fixture_hash!=hash(fixture)? { return Err("offline_fixture_mismatch".into()); }
    let mut cp=cp;
    attach(&mut cp,fixture)?;
    if cp.source.expected_operational_world_hash!=operational_world_hash(&cp.source.operational_world) { return Err("offline_world_hash_mismatch".into()); }
    cp.state=native(restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version:"conductor-session-restore-input/v1".into(),expected_state_hash:cp.state.state_hash.clone(),state:cp.state,
        dialogue_releases:cp.source.dialogue_releases.clone() }))?;
    cp.fare=native(restore_fare_control(&cp.fare,&cp.fare.state_hash))?;
    Ok(cp)
}
fn fare_command(cp: &mut Checkpoint, id: String, action: FareControlActionV1) -> Result<()> {
    cp.fare=native(apply_fare_control(&cp.fare,&cp.fare.state_hash,&FareControlCommandV1 { world_id:cp.state.world_id.clone(),
        operator_id:cp.fare.operator_id.clone(),command_id:id,expected_revision:cp.fare.revision,now_ms:cp.source.operational_world.now_ms,action }))?.state;
    Ok(())
}
fn control_evidence(cp: &mut Checkpoint) {
    cp.source.encounter_evidence=cp.fare.cases.values().filter(|case|cp.state.encounters.contains_key(&case.pin.encounter_id))
        .map(|case| ConductorEncounterEvidenceV1 { encounter_id:case.pin.encounter_id.clone(),evidence:case.evidence.clone() }).collect();
    let mut receipts=Vec::new();
    for receipt in cp.fare.receipts.values() {
        let (kind,ids)=match &receipt.binding {
            Some(FareControlEffectBindingV1::Claim {case_id})=>(ConductorControlReceiptKindV1::Claim,vec![case_id.clone()]),
            Some(FareControlEffectBindingV1::Hold {case_ids,..})=>(ConductorControlReceiptKindV1::Hold,case_ids.clone()),None=>continue };
        for id in ids { if let Some(case)=cp.fare.cases.get(&id) { if cp.state.encounters.contains_key(&case.pin.encounter_id) {
            receipts.push(ConductorSessionControlReceiptV1 { world_id:cp.state.world_id.clone(),train_run_id:cp.state.train_run_id.clone(),effect_id:receipt.command_id.clone(),
                encounter_id:case.pin.encounter_id.clone(),kind,domain_receipt_id:receipt.command_id.clone(),domain_state_hash:receipt.domain_state_hash.clone() });
        } } }
    }
    cp.source.control_receipts=receipts;
}
fn sync(cp: &mut Checkpoint,fixture: &Fixture) -> Result<()> {
    if cp.state.session.is_none() { return Ok(()); }
    cp.sequence=cp.sequence.checked_add(1).ok_or("offline_sequence_overflow")?;
    control_evidence(cp);
    cp.state=native(synchronize_conductor_session(&SynchronizeConductorSessionInputV1 { schema_version:"conductor-session-synchronize-input/v1".into(),
        expected_state_hash:cp.state.state_hash.clone(),state:cp.state.clone(),access:fixture.access.clone(),source:cp.source.clone(),
        causality_id:format!("offline-sync-{}",cp.sequence) }))?.state;
    Ok(())
}
fn demand_refresh(cp: &mut Checkpoint) -> Result<()> {
    let old=cp.source.projection.as_ref().ok_or("offline_projection_missing")?.clone();
    let world=&cp.source.operational_world;
    let progress=DemandOperationalProgressV1 { schema_version:"demand-operational-progress/v1".into(),world_id:world.world_id.clone(),
        as_of_ms:world.now_ms,receipt_id:format!("offline-actual-{}-{}",world.event_sequence,world.now_ms),trains:world.trains.values().filter_map(|train| {
            train.passenger_stops.as_ref().map(|progress| TrainOperationalProgressV1 { train_run_id:train.id.clone(),stops:progress.plan.stops.iter().zip(&progress.receipts)
                .filter(|(_,receipt)|receipt.actual_arrival_ms.is_some()||receipt.actual_departure_ms.is_some())
                .map(|(stop,receipt)|StopOperationalProgressV1 { stop_id:stop.stop_id.clone(),actual_arrival_ms:receipt.actual_arrival_ms,actual_departure_ms:receipt.actual_departure_ms }).collect() })
        }).collect() };
    cp.source.expected_operational_world_hash=operational_world_hash(world);
    // Eine weiterlaufende Uhr erfindet keinen neuen Fahrgastbeleg. Erst echte
    // veränderte Haltquittungen führen zur nächsten M10-Auswertung; der Sessionkern
    // prüft weiterhin jede tatsächliche Quittung gegen die aktuelle Quelle.
    if old.evaluation.operational_progress.as_ref().is_some_and(|previous|previous.trains==progress.trains) {return Ok(());}
    cp.demand.previous_evaluation=Some(Box::new(PreviousDemandEvaluationV1 { result:old.evaluation,services:cp.demand.services.clone() }));
    cp.demand.now_ms=world.now_ms;
    cp.demand.revision=cp.demand.revision.checked_add(1).ok_or("offline_revision_overflow")?;
    cp.demand.operational_progress=Some(progress);
    let evaluation=native(evaluate_demand(&cp.demand))?;
    let binding=ConductorPassengerBindingV1 { world_id:evaluation.world_id.clone(),period_id:evaluation.period_id.clone(),demand_release_id:evaluation.demand_release_id.clone(),
        release_hash:evaluation.release_hash.clone(),seed_hash:evaluation.seed_hash.clone(),train_run_id:cp.state.train_run_id.clone(),operator_id:cp.fare.operator_id.clone(),
        manifest_revision:evaluation.revision,demand_state_hash:evaluation.state_hash.clone(),operational_receipt_id:evaluation.operational_progress.as_ref().unwrap().receipt_id.clone() };
    cp.source.projection=Some(ProjectConductorPassengersInputV2 { schema_version:PROJECTION_INPUT_V2_SCHEMA.into(),binding,evaluation,service:old.service,
        interior:old.interior,previous_projection:cp.state.passengers.clone() });
    cp.source.expected_operational_world_hash=operational_world_hash(world);
    Ok(())
}
fn police_evidence(cp:&Checkpoint,hold:&FareControlHoldV1)->PoliceOperationalEvidenceV1 {
    PoliceOperationalEvidenceV1 { world_id:hold.world_id.clone(),train_run_id:hold.train_run_id.clone(),hold_id:hold.hold_id.clone(),target_stop_id:hold.target_stop_id.clone(),
        model_hash:hold.model_hash.clone(),operational_state_hash:operational_world_hash(&cp.source.operational_world),activated_at_ms:hold.activated_at_ms,deadline_ms:hold.deadline_ms,
        released_at_ms:hold.released_at_ms,target_unavailable:hold.outcome==Some(FareControlHoldOutcomeV1::TargetUnavailable),outcome:match hold.outcome {
            None=>PoliceResolutionV1::Pending,Some(FareControlHoldOutcomeV1::IdentityConfirmed)=>PoliceResolutionV1::IdentityConfirmed,
            Some(FareControlHoldOutcomeV1::IdentityNotConfirmed)=>PoliceResolutionV1::IdentityNotConfirmed,Some(FareControlHoldOutcomeV1::Unavailable)=>PoliceResolutionV1::Unavailable,
            Some(FareControlHoldOutcomeV1::Timeout)=>PoliceResolutionV1::TimedOut,Some(FareControlHoldOutcomeV1::TargetUnavailable)=>PoliceResolutionV1::TargetUnavailable } }
}
fn police_progress(cp:&mut Checkpoint)->Result<()> {
    for plan in cp.fare.police_plans.values().filter(|p|p.resolution==PoliceResolutionV1::Pending).cloned().collect::<Vec<_>>() {
        let mut hold=cp.source.operational_world.fare_control_hold(&plan.train_run_id).ok_or("offline_hold_missing")?.clone();
        let evidence=police_evidence(cp,&hold);
        if let Some(outcome)=native(police_response_due(&plan,&evidence,cp.source.operational_world.now_ms))? {
            let outcome=match outcome { PoliceResolutionV1::IdentityConfirmed=>ResolveFareControlHoldOutcomeV1::IdentityConfirmed,
                PoliceResolutionV1::IdentityNotConfirmed=>ResolveFareControlHoldOutcomeV1::IdentityNotConfirmed,PoliceResolutionV1::Unavailable=>ResolveFareControlHoldOutcomeV1::Unavailable,
                _=>return Err("offline_police_outcome_invalid".into()) };
            hold=native(cp.source.operational_world.resolve_fare_control_hold(&ResolveFareControlHoldInputV1 { train_id:plan.train_run_id.clone(),hold_id:hold.hold_id.clone(),
                expected_revision:hold.revision,model_hash:hold.model_hash.clone(),outcome,causality_id:format!("offline-police-{}",cp.sequence) }))?;
        }
        if hold.released_at_ms.is_some() { let evidence=police_evidence(cp,&hold);
            fare_command(cp,format!("offline-police-result-{}",hold.hold_id),FareControlActionV1::ResolvePolice {evidence})?; }
    }
    Ok(())
}
fn advance(cp:&mut Checkpoint,fixture:&Fixture,elapsed:i64,synchronize:bool)->Result<()> {
    if !(0..=60_000).contains(&elapsed) {return Err("offline_elapsed_out_of_range".into());}
    if elapsed==0 {return Ok(());}
    let target=cp.source.operational_world.now_ms.checked_add(elapsed).ok_or("offline_time_overflow")?;
    while cp.source.operational_world.now_ms<target {
        let at=(cp.source.operational_world.now_ms+1000).min(target);
        native(cp.source.operational_world.advance_to(at))?;
        police_progress(cp)?;
        if native(next_fare_control_wakeup(&cp.fare,&cp.fare.state_hash))?.is_some_and(|time|time<=at) {
            fare_command(cp,format!("offline-fare-time-{at}"),FareControlActionV1::AdvanceTime)?;
        }
    }
    demand_refresh(cp)?;
    if synchronize {sync(cp,fixture)} else {Ok(())}
}
fn effects(cp:&mut Checkpoint,fixture:&Fixture,rows:&[ConductorSessionEffectV1])->Result<()> {
    for encounter in cp.state.encounters.values().cloned().collect::<Vec<_>>() {
        if encounter.dialogue.status!=zugfolge_conductor_dialogue::EncounterStatusV1::Active || cp.fare.cases.values().any(|case|case.pin.encounter_id==encounter.dialogue.encounter_id) {continue;}
        let projection=cp.source.projection.as_ref().ok_or("offline_projection_missing")?;
        let segment=&cp.state.passengers.as_ref().ok_or("offline_passengers_missing")?.segment_id;
        let passenger=projection.evaluation.manifests.iter().find(|m|m.train_run_id==cp.state.train_run_id&&m.segment_id==*segment)
            .and_then(|m|m.passengers.iter().find(|p|p.passenger_key==encounter.passenger_key)).ok_or("offline_passenger_missing")?.clone();
        let journey=fixture.control.journeys.iter().find(|j|j.train_run_id==cp.state.train_run_id&&j.boarding_stop_id==passenger.boarding_stop_id&&j.alighting_stop_id==passenger.alighting_stop_id).cloned();
        let pin=decode(json!({"worldId":cp.state.world_id,"operatorId":cp.fare.operator_id,"periodId":projection.binding.period_id,"trainRunId":cp.state.train_run_id,
            "encounterId":encounter.dialogue.encounter_id,"manifestRevision":projection.binding.manifest_revision,"demandStateHash":projection.binding.demand_state_hash,
            "segmentId":segment,"passenger":passenger,"dialogueReleaseHash":encounter.dialogue.release_hash,"inspectedAtMs":cp.source.operational_world.now_ms,
            "seedHash":projection.binding.seed_hash,"inspectionPolicy":fixture.control.inspection_policy,"journeyEvidence":journey,
            "economyRelease":fixture.control.economy_release,"expectedEconomyReleaseHash":fixture.control.economy_release["checksum"]}))?;
        fare_command(cp,format!("offline-open-{}",encounter.dialogue.encounter_id),FareControlActionV1::OpenCase {case_id:encounter.dialogue.encounter_id,pin:Box::new(pin)})?;
    }
    for effect in rows {
        let case=cp.fare.cases.values().find(|case|case.pin.encounter_id==effect.encounter_id).ok_or("offline_case_missing")?.clone();
        let action=match effect.kind {
            ConductorSessionEffectKindV1::RequestDocumentCheck=>FareControlActionV1::InspectDocument {case_id:case.case_id},
            ConductorSessionEffectKindV1::CloseWithoutAction=>FareControlActionV1::CloseCase {case_id:case.case_id},
            ConductorSessionEffectKindV1::RequestRegularClaim=>FareControlActionV1::CreateClaim {case_id:case.case_id,kind:FareClaimKindV1::Regular},
            ConductorSessionEffectKindV1::RequestProvisionalClaim=>FareControlActionV1::CreateClaim {case_id:case.case_id,kind:FareClaimKindV1::Provisional},
            ConductorSessionEffectKindV1::RequestPolice=>{
                let reason=if case.evidence.identity_status==IdentityStatusV1::Refused {FareControlReasonV1::IdentityRefusal}
                    else if case.evidence.concrete_danger {FareControlReasonV1::ConcreteDanger} else {return Err("offline_police_reason_missing".into());};
                let hold=native(cp.source.operational_world.request_fare_control_hold(&RequestFareControlHoldInputV1 {
                    train_id:cp.state.train_run_id.clone(),case_id:case.case_id.clone(),reason,causality_id:effect.effect_id.clone()}))?;
                FareControlActionV1::PlanPolice {hold_id:hold.hold_id,train_run_id:cp.state.train_run_id.clone(),target_stop_id:hold.target_stop_id,case_ids:vec![case.case_id],model:fixture.control.police_response_model.clone()}
            }
        };
        fare_command(cp,effect.effect_id.clone(),action)?;
    }
    cp.source.expected_operational_world_hash=operational_world_hash(&cp.source.operational_world);
    Ok(())
}
fn report(cp:&Checkpoint)->Result<Value> {
    let value=native(project_fare_control_report(&cp.fare,&cp.fare.state_hash,&cp.state.world_id,&cp.fare.operator_id))?;
    let hold=cp.source.operational_world.fare_control_hold(&cp.state.train_run_id).map(|hold|json!({"holdId":hold.hold_id,"targetStopId":hold.target_stop_id,
        "status":hold.status,"deadlineMs":hold.deadline_ms,"outcome":hold.outcome}));
    Ok(json!({"schemaVersion":"conductor-control-status/v1","cases":value.cases,"days":value.days,"hold":hold}))
}
fn output(cp:Checkpoint,fixture:&Fixture)->Result<Value> {
    let snapshot=if cp.state.session.is_some() {Some(native(project_conductor_session_snapshot(&ProjectConductorSessionSnapshotInputV1 {schema_version:"conductor-session-project-input/v1".into(),
        state:cp.state.clone(),expected_state_hash:cp.state.state_hash.clone(),access:fixture.access.clone(),source:cp.source.clone()}))?)} else {None};
    let control=report(&cp)?;
    let response=snapshot.as_ref().map(|snapshot|json!({"schemaVersion":"conductor-session-response/v1","snapshot":snapshot,"layout":cp.state.layout,"scene":null,"control":control}));
    let availability=json!({"available":true,"revision":cp.state.session.as_ref().map_or(0,|s|s.revision),
        "manifestRevision":cp.source.projection.as_ref().map(|p|p.binding.manifest_revision).unwrap_or(0),"sessionId":cp.state.session.as_ref().map(|s|&s.session_id)});
    Ok(json!({"context":{"worldId":cp.state.world_id,"operatorId":cp.fare.operator_id,"trainRunId":cp.state.train_run_id,"fixtureHash":cp.fixture_hash},
        "availability":availability,"response":response,"report":control,"checkpoint":cp}))
}
fn path(cp:&Checkpoint,target:&str)->Result<Value> {
    let layout=cp.state.layout.as_ref().ok_or("offline_layout_missing")?;
    let from=cp.state.session.as_ref().ok_or("offline_session_missing")?.position.clone();
    let mut candidates=layout.nodes.iter().filter(|n|n.point.vehicle_id==from.vehicle_id&&n.point.body_id==from.body_id&&n.point.deck_id==from.deck_id).collect::<Vec<_>>();
    candidates.sort_by_key(|node|((node.point.x_mm-from.x_mm).abs()+(node.point.y_mm-from.y_mm).abs(),&node.node_id));
    let start=candidates.into_iter().find(|node|check_interior_movement(&CheckInteriorMovementInputV1 {schema_version:"conductor-interior-movement-input/v1".into(),
        layout:layout.clone(),expected_layout_hash:layout.layout_hash.clone(),from:from.clone(),to:node.point.clone(),transition_edge_id:None,wheelchair:false}).is_ok_and(|r|r.allowed))
        .ok_or("offline_path_unavailable")?;
    let route=native(find_interior_path(&FindInteriorPathInputV1 {schema_version:"conductor-interior-path-input/v1".into(),layout:layout.clone(),expected_layout_hash:layout.layout_hash.clone(),
        from_node_id:start.node_id.clone(),to_node_id:target.into(),wheelchair:false}))?;
    let mut points=vec![json!({"to":start.point,"transitionEdgeId":null})];
    for index in 1..route.node_ids.len() {
        let edge=layout.edges.iter().find(|e|e.edge_id==route.edge_ids[index-1]).ok_or("offline_path_edge_missing")?;
        let node=layout.nodes.iter().find(|n|n.node_id==route.node_ids[index]).ok_or("offline_path_node_missing")?;
        points.push(json!({"to":node.point,"transitionEdgeId":if edge.kind==InteriorEdgeKindV1::Walk {None}else{Some(&edge.edge_id)}}));
    }
    Ok(json!({"schemaVersion":"conductor-walking-path/v1","layoutHash":layout.layout_hash,"from":from,"points":points}))
}
pub(super) fn execute(method:&str,input:Value)->Result<Value> {
    let input:Input=decode(input)?;
    let mut cp=if method=="offline.initialize" {initialize(&input.fixture)?} else {restore(input.checkpoint.ok_or("offline_checkpoint_missing")?,&input.fixture)?};
    match method {
        "offline.initialize"|"offline.restore"=>{},
        "offline.command"=>{
            // Erst die reale Uhr aktualisieren, ohne die erwartete Sitzungsrevision vor dem Kommando zu verändern.
            let command=input.command.ok_or("offline_command_missing")?;
            advance(&mut cp,&input.fixture,input.elapsed_ms,false)?;
            let result=native(apply_conductor_session_command(&ApplyConductorSessionCommandInputV1 {schema_version:"conductor-session-apply-input/v1".into(),
                expected_state_hash:cp.state.state_hash.clone(),state:cp.state.clone(),command,access:input.fixture.access.clone(),source:cp.source.clone()}))?;
            cp.state=result.state; effects(&mut cp,&input.fixture,&result.effects)?; sync(&mut cp,&input.fixture)?;
        },
        "offline.tick"=>advance(&mut cp,&input.fixture,input.elapsed_ms,true)?,
        "offline.path"=>return path(&cp,input.target_node_id.as_deref().ok_or("offline_path_target_missing")?),
        "offline.report"=>return report(&cp),
        _=>return Err("offline_command_unknown".into()),
    }
    output(cp,&input.fixture)
}
