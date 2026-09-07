use crate::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn digest<T: serde::Serialize>(value: &T) -> Result<String, DialogueErrorV1> {
    let bytes = serde_json::to_vec(value).map_err(|_| DialogueErrorV1::InvalidInput)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-./".contains(&b))
}
pub(crate) fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text_ok(value: &str, limit: usize) -> bool {
    let lower = value.to_lowercase();
    !value.trim().is_empty()
        && value == value.trim()
        && value.chars().count() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() || "{}[]<>$".contains(c))
        && ![
            "http:",
            "https:",
            "www.",
            "@",
            "bußgeld",
            "strafe zahlen",
            "deutsche bahn",
            "flixtrain",
            "iphone",
            "android",
            "ausländer",
            "hautfarbe",
            "religion",
            "nationalität",
            "behinderten",
            "schwarzfahrer",
        ]
        .iter()
        .any(|word| lower.contains(word))
}
fn option_valid(option: &DialogueOptionV1) -> bool {
    if !identifier(&option.option_id)
        || !text_ok(&option.text, 64)
        || !(500..=60_000).contains(&option.time_cost_ms)
        || (option.next_node_id.is_none() && option.intent.is_none())
    {
        return false;
    }
    match option.intent {
        Some(DialogueIntentV1::RequestRegularClaim) => {
            option.condition == DialogueConditionV1::RegularClaimAllowed
        }
        Some(DialogueIntentV1::RequestProvisionalClaim) => {
            option.condition == DialogueConditionV1::ProvisionalClaimAllowed
        }
        Some(DialogueIntentV1::RequestPolice) => {
            option.condition == DialogueConditionV1::PoliceAllowed
        }
        _ => true,
    }
}
fn visit<'a>(
    id: &'a str,
    nodes: &BTreeMap<&'a str, &'a DialogueNodeV1>,
    active: &mut BTreeSet<&'a str>,
    done: &mut BTreeSet<&'a str>,
) -> Result<(), DialogueErrorV1> {
    if active.contains(id) {
        return Err(DialogueErrorV1::InvalidRelease);
    }
    if done.contains(id) {
        return Ok(());
    }
    let node = nodes.get(id).ok_or(DialogueErrorV1::InvalidRelease)?;
    active.insert(id);
    // Ein bedingungsloser Abschluss verhindert Sackgassen bei jeder Evidenzlage.
    if !node.options.is_empty()
        && !node.options.iter().any(|o| {
            o.condition == DialogueConditionV1::Always
                && o.intent == Some(DialogueIntentV1::CloseWithoutAction)
        })
    {
        return Err(DialogueErrorV1::InvalidRelease);
    }
    for option in &node.options {
        if let Some(target) = &option.next_node_id {
            let next = nodes
                .get(target.as_str())
                .ok_or(DialogueErrorV1::InvalidRelease)?;
            if option
                .intent
                .is_some_and(|i| i != DialogueIntentV1::RequestDocumentCheck)
                && !next.options.is_empty()
            {
                return Err(DialogueErrorV1::InvalidRelease);
            }
            if option.intent.is_none() && next.options.is_empty() {
                return Err(DialogueErrorV1::InvalidRelease);
            }
            visit(target, nodes, active, done)?;
        }
    }
    active.remove(id);
    done.insert(id);
    Ok(())
}

pub fn dialogue_release_hash(release: &DialogueReleaseV1) -> Result<String, DialogueErrorV1> {
    digest(release)
}
pub fn validate_dialogue_release(
    release: &DialogueReleaseV1,
) -> Result<DialogueReleaseReportV1, DialogueErrorV1> {
    let invalid = DialogueErrorV1::InvalidRelease;
    if release.schema_version != "conductor-dialogue-release/v1"
        || release.locale != "de-DE"
        || !identifier(&release.release_id)
        || !(12..=64).contains(&release.families.len())
    {
        return Err(invalid);
    }
    let mut family_ids = BTreeSet::new();
    let mut tree_ids = BTreeSet::new();
    let mut scenes = BTreeSet::new();
    let mut utterance_texts = BTreeSet::new();
    let mut utterances = 0_u32;
    let mut family_weight = 0_u32;
    for family in &release.families {
        if !identifier(&family.family_id)
            || !family_ids.insert(&family.family_id)
            || family.trees.is_empty()
            || family.trees.len() > 1000
            || !(1..=10_000).contains(&family.weight_basis_points)
        {
            return Err(invalid);
        }
        family_weight = family_weight
            .checked_add(family.weight_basis_points)
            .ok_or(invalid)?;
        let mut tree_weight = 0_u32;
        for tree in &family.trees {
            if !identifier(&tree.tree_id)
                || !tree_ids.insert(&tree.tree_id)
                || !text_ok(&tree.scenario, 120)
                || !scenes.insert(&tree.scenario)
                || !(1..=10_000).contains(&tree.weight_basis_points)
                || !(2..=12).contains(&tree.nodes.len())
            {
                return Err(invalid);
            }
            tree_weight = tree_weight
                .checked_add(tree.weight_basis_points)
                .ok_or(invalid)?;
            let mut nodes = BTreeMap::new();
            for node in &tree.nodes {
                if !identifier(&node.node_id)
                    || !text_ok(&node.passenger_text, 200)
                    || nodes.insert(node.node_id.as_str(), node).is_some()
                    || node.options.len() > 8
                {
                    return Err(invalid);
                }
                utterance_texts.insert(&node.passenger_text);
                utterances = utterances.checked_add(1).ok_or(invalid)?;
                let mut options = BTreeSet::new();
                if node
                    .options
                    .iter()
                    .any(|o| !option_valid(o) || !options.insert(&o.option_id))
                {
                    return Err(invalid);
                }
            }
            let mut done = BTreeSet::new();
            visit(&tree.entry_node_id, &nodes, &mut BTreeSet::new(), &mut done)?;
            if done.len() != nodes.len() {
                return Err(invalid);
            }
        }
        if tree_weight != 10_000 {
            return Err(invalid);
        }
    }
    if family_weight != 10_000
        || tree_ids.len() < 150
        || utterances < 600
        || utterance_texts.len() < 600
    {
        return Err(invalid);
    }
    Ok(DialogueReleaseReportV1 {
        release_id: release.release_id.clone(),
        release_hash: dialogue_release_hash(release)?,
        families: u32::try_from(family_ids.len()).map_err(|_| invalid)?,
        trees: u32::try_from(tree_ids.len()).map_err(|_| invalid)?,
        utterances,
    })
}
