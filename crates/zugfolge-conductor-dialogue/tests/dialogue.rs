//! Verhalten, Geheimhaltung und Restore des tatsächlich geschriebenen Korpus.
use sha2::{Digest, Sha256};
use zugfolge_conductor_dialogue::*;
use zugfolge_demand::FareFactV1;

const RELEASE: &str = include_str!("../../../assets/conductor-dialogue/v1/release.json");
fn release() -> DialogueReleaseV1 {
    serde_json::from_str(RELEASE).expect("Geschriebener Korpus ist lesbar")
}
fn input(release: &DialogueReleaseV1) -> StartDialogueInputV1 {
    StartDialogueInputV1 {
        world_id: "world-a".into(),
        period_id: "period-a".into(),
        train_run_id: "train-a".into(),
        passenger_key: "private-passenger-a".into(),
        encounter_id: "encounter-a".into(),
        now_ms: 10_000,
        release_hash: dialogue_release_hash(release).unwrap(),
        seed: "seed-a".into(),
        fare_fact: FareFactV1::Valid,
        evidence: DialogueEvidenceV1::default(),
    }
}
fn choose(state: &DialogueStateV1, option: &str) -> ChooseDialogueInputV1 {
    ChooseDialogueInputV1 {
        command_id: format!("command-{}", state.revision),
        expected_revision: state.revision,
        now_ms: state.available_at_ms,
        option_id: option.into(),
        evidence: state.evidence.clone(),
    }
}
fn revealed(document_status: DocumentStatusV1) -> DialogueEvidenceV1 {
    DialogueEvidenceV1 {
        document_status,
        acquisition_exception: AcquisitionExceptionV1::Excluded,
        identity_status: IdentityStatusV1::Confirmed,
        concrete_danger: false,
    }
}

#[test]
fn authored_release_has_required_distinct_content_and_exact_canonical_bytes() {
    let release = release();
    let report = validate_dialogue_release(&release).unwrap();
    assert_eq!(
        (report.families, report.trees, report.utterances),
        (12, 156, 624)
    );
    assert_eq!(
        serde_json::to_string(&release).unwrap(),
        RELEASE,
        "Signierte Dateibytes entsprechen exakt dem Rust-DTO"
    );
    let bytes_hash: String = Sha256::digest(RELEASE.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(report.release_hash, bytes_hash);
    assert_eq!(
        report.release_hash,
        "a602cc60e168cc7cc39e60fddfa57e44cf10f4c9b72cfe79fb014f0679e5e651"
    );
}

#[test]
fn hidden_fare_truth_never_selects_persona_text_or_options() {
    let release = release();
    let mut families = std::collections::BTreeSet::new();
    for seed in 0..96 {
        let mut input = input(&release);
        input.seed = format!("privacy-{seed}");
        let valid = start_dialogue(&release, &input).unwrap();
        families.insert(valid.state.tree_id.rsplit_once('-').unwrap().0.to_string());
        for fare in [FareFactV1::ValidUnpresentable, FareFactV1::Invalid] {
            input.fare_fact = fare;
            let other = start_dialogue(&release, &input).unwrap();
            assert_eq!(
                valid.encounter, other.encounter,
                "Verdeckte Tarifwahrheit verändert die sichtbare Begegnung nicht"
            );
            assert_eq!(valid.state.tree_id, other.state.tree_id);
            assert_ne!(valid.state.state_hash, other.state.state_hash);
        }
        let public = serde_json::to_string(&valid.encounter).unwrap();
        for secret in [
            "private-passenger-a",
            "fareFact",
            "treeId",
            "familyId",
            "selectionHash",
            "seed",
            "presentation",
            "cooperation",
        ] {
            assert!(
                !public.contains(secret),
                "Private Felder bleiben in der öffentlichen Projektion verborgen"
            );
        }
        assert!(
            !valid
                .encounter
                .options
                .iter()
                .any(|o| ["regular", "provisional", "police"].contains(&o.option_id.as_str()))
        );
    }
    assert_eq!(
        families.len(),
        12,
        "Gegenprobe umfasst auch Intoxikation und vollständige Verweigerung"
    );
}

#[test]
fn authored_refusal_and_safety_claims_never_manufacture_police_evidence() {
    let release = release();
    for (seed, expected_tree) in [
        ("review-223", "refusal-01"),
        ("review-657", "safety_escalation-01"),
    ] {
        let mut input = input(&release);
        input.seed = seed.into();
        let initial = start_dialogue(&release, &input).unwrap();
        assert_eq!(initial.state.tree_id, expected_tree);
        assert_eq!(initial.encounter.hints, DialogueEvidenceV1::default());
        let detail =
            advance_dialogue(&release, &initial.state, &choose(&initial.state, "ask")).unwrap();
        let response =
            advance_dialogue(&release, &detail.state, &choose(&detail.state, "explain")).unwrap();
        for encounter in [&initial.encounter, &detail.encounter, &response.encounter] {
            assert_eq!(encounter.hints, DialogueEvidenceV1::default());
            assert!(
                !encounter.options.iter().any(|o| o.option_id == "police"),
                "Erzählung und Autorenprofil begründen keine Polizeibefugnis"
            );
        }
    }
}

#[test]
fn document_check_observation_claim_and_restore_are_deterministic() {
    let release = release();
    let mut start = input(&release);
    start.fare_fact = FareFactV1::Invalid;
    let initial = start_dialogue(&release, &start).unwrap();
    let checking =
        advance_dialogue(&release, &initial.state, &choose(&initial.state, "check")).unwrap();
    assert_eq!(
        checking.intent,
        Some(DialogueIntentV1::RequestDocumentCheck)
    );
    assert_eq!(checking.state.status, EncounterStatusV1::Active);
    let observation = ObserveDialogueInputV1 {
        command_id: "observe-proof".into(),
        expected_revision: checking.state.revision,
        now_ms: checking.state.available_at_ms,
        evidence: revealed(DocumentStatusV1::VerifiedInvalid),
    };
    let observed = observe_dialogue(&release, &checking.state, &observation).unwrap();
    assert!(
        observed
            .encounter
            .options
            .iter()
            .any(|o| o.option_id == "regular")
    );
    assert!(
        !observed
            .encounter
            .options
            .iter()
            .any(|o| o.option_id == "provisional")
    );
    let restored: DialogueStateV1 =
        serde_json::from_str(&serde_json::to_string(&observed.state).unwrap()).unwrap();
    assert_eq!(
        project_encounter(&release, &restored).unwrap(),
        observed.encounter
    );
    let command = choose(&observed.state, "regular");
    let result = advance_dialogue(&release, &observed.state, &command).unwrap();
    assert_eq!(
        result,
        advance_dialogue(&release, &restored, &command).unwrap()
    );
    assert_eq!(
        result,
        advance_dialogue(&release, &result.state, &command).unwrap(),
        "Identische Wiederholung ist quittiert"
    );
    assert_eq!(result.intent, Some(DialogueIntentV1::RequestRegularClaim));
    assert!(result.encounter.options.is_empty());
    let mut conflict = command;
    conflict.option_id = "close".into();
    assert_eq!(
        advance_dialogue(&release, &result.state, &conflict),
        Err(DialogueErrorV1::ConflictingCommand)
    );
}

#[test]
fn claim_and_police_gates_use_only_previously_revealed_evidence() {
    let release = release();
    let initial = start_dialogue(&release, &input(&release)).unwrap();
    let mut forged_choice = choose(&initial.state, "regular");
    forged_choice.evidence = revealed(DocumentStatusV1::VerifiedInvalid);
    assert_eq!(
        advance_dialogue(&release, &initial.state, &forged_choice),
        Err(DialogueErrorV1::OptionNotAllowed)
    );
    for (document, regular, provisional) in [
        (DocumentStatusV1::VerifiedValid, false, false),
        (DocumentStatusV1::NotPresentable, false, true),
        (DocumentStatusV1::VerifiedInvalid, true, false),
    ] {
        let mut evidence = revealed(document);
        for exception in [
            AcquisitionExceptionV1::Unknown,
            AcquisitionExceptionV1::Proven,
            AcquisitionExceptionV1::Excluded,
        ] {
            evidence.acquisition_exception = exception;
            let observed = observe_dialogue(
                &release,
                &initial.state,
                &ObserveDialogueInputV1 {
                    command_id: "observation".into(),
                    expected_revision: 0,
                    now_ms: 10_000,
                    evidence: evidence.clone(),
                },
            )
            .unwrap();
            let options = &observed.encounter.options;
            assert_eq!(
                options.iter().any(|o| o.option_id == "regular"),
                regular && exception == AcquisitionExceptionV1::Excluded
            );
            assert_eq!(
                options.iter().any(|o| o.option_id == "provisional"),
                provisional && exception == AcquisitionExceptionV1::Excluded
            );
            assert!(!options.iter().any(|o| o.option_id == "police"));
        }
    }
    for (identity, danger, allowed) in [
        (IdentityStatusV1::Unknown, false, false),
        (IdentityStatusV1::Confirmed, false, false),
        (IdentityStatusV1::Refused, false, true),
        (IdentityStatusV1::Unknown, true, true),
    ] {
        let evidence = DialogueEvidenceV1 {
            identity_status: identity,
            concrete_danger: danger,
            ..Default::default()
        };
        let observed = observe_dialogue(
            &release,
            &initial.state,
            &ObserveDialogueInputV1 {
                command_id: "police-evidence".into(),
                expected_revision: 0,
                now_ms: 10_000,
                evidence,
            },
        )
        .unwrap();
        assert_eq!(
            observed
                .encounter
                .options
                .iter()
                .any(|o| o.option_id == "police"),
            allowed
        );
        if allowed {
            assert_eq!(
                advance_dialogue(
                    &release,
                    &observed.state,
                    &choose(&observed.state, "police")
                )
                .unwrap()
                .intent,
                Some(DialogueIntentV1::RequestPolice)
            );
        }
    }
}

#[test]
fn commands_reject_time_revision_release_and_evidence_regressions() {
    let release = release();
    let initial = start_dialogue(&release, &input(&release)).unwrap();
    let next = advance_dialogue(&release, &initial.state, &choose(&initial.state, "ask")).unwrap();
    let mut command = choose(&next.state, "explain");
    command.now_ms -= 1;
    assert_eq!(
        advance_dialogue(&release, &next.state, &command),
        Err(DialogueErrorV1::NotReady)
    );
    command.now_ms += 1;
    command.expected_revision = 0;
    assert_eq!(
        advance_dialogue(&release, &next.state, &command),
        Err(DialogueErrorV1::StaleRevision)
    );
    let mut changed = release.clone();
    changed.release_id = "new-period-release".into();
    assert_eq!(
        project_encounter(&changed, &next.state),
        Err(DialogueErrorV1::ReleaseMismatch)
    );
    let mut corrupt = next.state.clone();
    corrupt.world_id = "another-world".into();
    assert_eq!(
        project_encounter(&release, &corrupt),
        Err(DialogueErrorV1::InvalidState)
    );
    let observed = observe_dialogue(
        &release,
        &next.state,
        &ObserveDialogueInputV1 {
            command_id: "verified".into(),
            expected_revision: 1,
            now_ms: next.state.available_at_ms,
            evidence: revealed(DocumentStatusV1::VerifiedValid),
        },
    )
    .unwrap();
    assert_eq!(
        observe_dialogue(
            &release,
            &observed.state,
            &ObserveDialogueInputV1 {
                command_id: "forget".into(),
                expected_revision: 2,
                now_ms: observed.state.available_at_ms,
                evidence: Default::default()
            }
        ),
        Err(DialogueErrorV1::EvidenceRegression)
    );
    let closed = close_dialogue(
        &release,
        &observed.state,
        &CloseDialogueInputV1 {
            command_id: "leave-train".into(),
            expected_revision: 2,
            now_ms: observed.state.available_at_ms,
        },
    )
    .unwrap();
    assert_eq!(closed.intent, Some(DialogueIntentV1::CloseWithoutAction));
    assert!(closed.encounter.options.is_empty());
}

#[test]
fn malformed_graphs_text_and_unjustified_escalations_fail_closed() {
    let base = release();
    let reject = |release: DialogueReleaseV1| {
        assert_eq!(
            validate_dialogue_release(&release),
            Err(DialogueErrorV1::InvalidRelease)
        )
    };
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes[0].options[0].next_node_id = Some("opening".into());
    reject(bad);
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes[0].options[0].next_node_id = Some("missing".into());
    reject(bad);
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes[0]
        .options
        .retain(|o| o.option_id != "close");
    reject(bad);
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes[0]
        .options
        .iter_mut()
        .find(|o| o.option_id == "police")
        .unwrap()
        .condition = DialogueConditionV1::Always;
    reject(bad);
    for text in [
        "Hallo {name}.",
        "Die Nationalität beweist das.",
        "Mein iPhone fehlt.",
        "Ein Bußgeld bezahlen.",
    ] {
        let mut bad = base.clone();
        bad.families[0].trees[0].nodes[0].passenger_text = text.into();
        reject(bad);
    }
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes[0].passenger_text = "a".repeat(201);
    reject(bad);
    let mut bad = base.clone();
    bad.families[0].weight_basis_points += 1;
    reject(bad);
    let mut bad = base.clone();
    bad.families[0].trees[0].nodes.push(DialogueNodeV1 {
        node_id: "orphan".into(),
        passenger_text: "Dieser Zweig ist unerreichbar.".into(),
        options: vec![],
    });
    reject(bad);
    let mut bad = base;
    bad.families.truncate(11);
    reject(bad);
}
