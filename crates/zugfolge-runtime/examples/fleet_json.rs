//! Schmaler JSON-Einstieg in den echten M5-Kern für lokale Integrationsnachweise.

use std::io::{Read, Write};

use serde::Deserialize;
use serde_json::Value;
use zugfolge_runtime::{apply_fleet_command, initialize_fleet_world, verify_fleet_world_state};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Initialize {
        input: Value,
    },
    Verify {
        state: Value,
        #[serde(rename = "expectedStateHash")]
        expected_state_hash: String,
    },
    Apply {
        state: Value,
        command: Value,
        #[serde(default, rename = "replayReceipt")]
        replay_receipt: Option<Value>,
    },
}

fn run() -> Result<String, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "M5-Eingabe ist nicht lesbar.".to_owned())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("M5-Eingabe überschreitet die erlaubte Größe.".into());
    }
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|_| "M5-Eingabe benötigt gültiges JSON und ein bekanntes Kommando.".to_owned())?;
    let result = match request {
        Request::Initialize { input } => initialize_fleet_world(&input.to_string()),
        Request::Verify {
            state,
            expected_state_hash,
        } => verify_fleet_world_state(&state.to_string(), &expected_state_hash),
        Request::Apply {
            state,
            command,
            replay_receipt,
        } => {
            let receipt = replay_receipt.map(|value| value.to_string());
            apply_fleet_command(&state.to_string(), &command.to_string(), receipt.as_deref())
        }
    };
    result.map_err(|_| "M5-Kern hat Eingabe oder Zustandsbindung abgewiesen.".to_owned())
}

fn main() {
    match run() {
        Ok(result) => {
            if std::io::stdout()
                .lock()
                .write_all(result.as_bytes())
                .is_err()
            {
                eprintln!("M5-Ausgabe ist nicht schreibbar.");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
