//! Die abgelegten Bildfahrpläne müssen zeigen, was die Prüfung rechnet.
//!
//! Der Beweis von M0.3 ist ein Bild. Ein Bild im Repositorium veraltet still —
//! man sieht ihm nicht an, dass es zu einer früheren Rechnung gehört. Dieser
//! Test vergleicht die abgelegte Datei mit der frisch gezeichneten.
//!
//! Neu erzeugen:
//!
//! ```text
//! cargo run -p zugfolge-spike-blocking-time-staircase
//! ```

use std::fs;

use zugfolge_spike_blocking_time_staircase::case::Case;
use zugfolge_spike_blocking_time_staircase::diagram::render;
use zugfolge_spike_blocking_time_staircase::images;

#[test]
fn jeder_betriebsfall_hat_einen_abgelegten_bildfahrplan() {
    for fall in Case::all() {
        let pfad = images::path_of(&fall);
        let abgelegt = fs::read_to_string(&pfad).unwrap_or_else(|fehler| {
            panic!(
                "{} fehlt oder ist nicht lesbar: {fehler}\n\
                 Neu erzeugen mit: cargo run -p zugfolge-spike-blocking-time-staircase",
                pfad.display()
            )
        });

        assert_eq!(
            abgelegt,
            render(&fall),
            "{} weicht von der aktuellen Rechnung ab.\n\
             Neu erzeugen mit: cargo run -p zugfolge-spike-blocking-time-staircase — \
             und die Änderung im Commit begründen.",
            pfad.display()
        );
    }
}

#[test]
fn im_verzeichnis_liegen_keine_verwaisten_bilder() {
    // Ein Bild ohne Betriebsfall gehört zu einer Rechnung, die es nicht mehr
    // gibt. Es zu behalten heißt, einen Beweis zu behaupten, der nicht mehr
    // geführt wird.
    let bekannt: Vec<String> = Case::all()
        .iter()
        .map(|fall| format!("{}.svg", fall.id))
        .collect();

    for eintrag in fs::read_dir(images::directory()).expect("Bildverzeichnis ist lesbar") {
        let eintrag = eintrag.expect("Verzeichniseintrag ist lesbar");
        let name = eintrag.file_name().to_string_lossy().into_owned();
        assert!(
            bekannt.contains(&name),
            "{name} gehört zu keinem Betriebsfall mehr"
        );
    }
}
