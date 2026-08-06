//! Ablage der Bildfahrpläne.
//!
//! Die Bilder liegen im Repositorium, nicht nur im Kopf des Programms: Der
//! Beweis von M0.3 ist ein **sichtbarer** Konflikt, und der muss ohne
//! Werkzeugkette zu betrachten sein. Ein Test vergleicht die abgelegten Bilder
//! gegen die frisch gezeichneten — driften sie auseinander, schlägt er fehl.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::case::Case;
use crate::diagram::render;

/// Verzeichnis der abgelegten Bilder, relativ zum Wurzelverzeichnis des Spikes.
pub const DIRECTORY: &str = "images";

/// Das Verzeichnis der abgelegten Bilder dieses Spikes.
pub fn directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(DIRECTORY)
}

/// Der Pfad des Bildfahrplans eines Betriebsfalls.
pub fn path_of(case: &Case) -> PathBuf {
    directory().join(format!("{}.svg", case.id))
}

/// Zeichnet alle Betriebsfälle und legt sie ab.
///
/// # Errors
///
/// Wenn das Verzeichnis nicht angelegt oder eine Datei nicht geschrieben werden
/// kann.
pub fn write_all() -> io::Result<Vec<PathBuf>> {
    fs::create_dir_all(directory())?;
    let mut geschrieben = Vec::new();
    for fall in Case::all() {
        let pfad = path_of(&fall);
        fs::write(&pfad, render(&fall))?;
        geschrieben.push(pfad);
    }
    Ok(geschrieben)
}
