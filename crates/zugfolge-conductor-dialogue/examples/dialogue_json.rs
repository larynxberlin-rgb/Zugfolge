//! Schmale native Dateigrenze für Offlineprüfung und reproduzierbare Plattformtests.
use serde::Deserialize;
use std::io::{self, Read};
use zugfolge_conductor_dialogue::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    release: DialogueReleaseV1,
    input: StartDialogueInputV1,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Advance {
    release: DialogueReleaseV1,
    state: DialogueStateV1,
    input: ChooseDialogueInputV1,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    release: DialogueReleaseV1,
    state: DialogueStateV1,
}
fn run() -> Result<String, DialogueErrorV1> {
    let mut source = String::new();
    io::stdin()
        .read_to_string(&mut source)
        .map_err(|_| DialogueErrorV1::InvalidInput)?;
    let command = std::env::args()
        .nth(1)
        .ok_or(DialogueErrorV1::InvalidInput)?;
    let value = match command.as_str() {
        "validate" => serde_json::to_value(validate_dialogue_release(
            &serde_json::from_str(&source).map_err(|_| DialogueErrorV1::InvalidInput)?,
        )?),
        "start" => {
            let input: Start =
                serde_json::from_str(&source).map_err(|_| DialogueErrorV1::InvalidInput)?;
            serde_json::to_value(start_dialogue(&input.release, &input.input)?)
        }
        "advance" => {
            let input: Advance =
                serde_json::from_str(&source).map_err(|_| DialogueErrorV1::InvalidInput)?;
            serde_json::to_value(advance_dialogue(
                &input.release,
                &input.state,
                &input.input,
            )?)
        }
        "project" => {
            let input: Project =
                serde_json::from_str(&source).map_err(|_| DialogueErrorV1::InvalidInput)?;
            serde_json::to_value(project_encounter(&input.release, &input.state)?)
        }
        _ => return Err(DialogueErrorV1::InvalidInput),
    }
    .map_err(|_| DialogueErrorV1::InvalidInput)?;
    serde_json::to_string(&value).map_err(|_| DialogueErrorV1::InvalidInput)
}
fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
