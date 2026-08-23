//! Atomarer Kommandozeilen-Compiler für Fahrzeugkatalog-Releases.

use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use zugfolge_fleet::release_catalog::{compile_vehicle_catalog_json, to_pretty_json};

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let source_path = required_path(arguments.next(), "SOURCE-CATALOG.json")?;
    let seed_path = required_path(arguments.next(), "WORLD-SEED.json")?;
    let output_directory = required_path(arguments.next(), "OUTPUT-DIRECTORY")?;
    if arguments.next().is_some() {
        return Err(usage().into());
    }
    let source_json = fs::read_to_string(&source_path)?;
    let seed_json = fs::read_to_string(&seed_path)?;
    let compilation = compile_vehicle_catalog_json(&source_json, &seed_json)?;
    // Erst alle Bytes erzeugen. Ein Serialisierungsfehler darf nicht einmal
    // ein temporaeres, teilweise geschriebenes Artefaktset hinterlassen.
    let files = [
        (
            "vehicle-catalog-v3.json",
            to_pretty_json(&compilation.catalog)?,
        ),
        (
            "fleet-authority-release-v2.json",
            to_pretty_json(&compilation.fleet_authority)?,
        ),
        (
            "fleet-authority-release-catalog-v1.json",
            to_pretty_json(&compilation.fleet_authority_catalog)?,
        ),
        (
            "operational-vehicle-inventory-v2.json",
            to_pretty_json(&compilation.operational_inventory)?,
        ),
        (
            "vehicle-catalog-compile-receipt-v4.json",
            to_pretty_json(&compilation.receipt)?,
        ),
    ];
    publish_new_directory(&output_directory, &files)?;
    println!("{}", compilation.receipt.output_set_sha256);
    Ok(())
}

fn required_path(value: Option<std::ffi::OsString>, name: &str) -> Result<PathBuf, Box<dyn Error>> {
    value.map(PathBuf::from).ok_or_else(|| {
        let message = format!("fehlendes Argument {name}\n{}", usage());
        message.into()
    })
}

fn usage() -> &'static str {
    "Aufruf: zugfolge-vehicle-catalog SOURCE-CATALOG.json WORLD-SEED.json OUTPUT-DIRECTORY"
}

fn publish_new_directory(output: &Path, files: &[(&str, String)]) -> Result<(), Box<dyn Error>> {
    if output.exists() {
        return Err(format!(
            "Ausgabeverzeichnis '{}' existiert bereits; kein Artefaktsatz wurde ersetzt",
            output.display()
        )
        .into());
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let filename = output
        .file_name()
        .ok_or_else(|| "Ausgabeverzeichnis braucht einen Dateinamen".to_owned())?;
    let staging = parent.join(format!(
        ".{}.tmp-{}",
        filename.to_string_lossy(),
        std::process::id()
    ));
    if staging.exists() {
        return Err(format!(
            "temporaeres Ausgabeverzeichnis '{}' existiert bereits",
            staging.display()
        )
        .into());
    }
    fs::create_dir(&staging)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        for (name, contents) in files {
            fs::write(staging.join(name), contents)?;
        }
        fs::rename(&staging, output)?;
        Ok(())
    })();
    if result.is_err() && staging.exists() {
        // Ausschliesslich das in diesem Lauf neu angelegte, exakt aufgeloeste
        // Staging-Verzeichnis wird entfernt; bestehende Ziele bleiben tabu.
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
