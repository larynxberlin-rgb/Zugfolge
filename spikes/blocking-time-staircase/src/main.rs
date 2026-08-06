//! Führt den Spike vor: Prüfbericht auf die Standardausgabe, Bildfahrpläne in
//! `images/`.
//!
//! ```text
//! cargo run -p zugfolge-spike-blocking-time-staircase
//! ```

use std::process::ExitCode;

use zugfolge_spike_blocking_time_staircase::case::Case;
use zugfolge_spike_blocking_time_staircase::images;

fn main() -> ExitCode {
    let mut konflikte = 0_usize;
    for fall in Case::all() {
        println!("{}", fall.report());
        println!("{}", "─".repeat(78));
        konflikte += fall.conflicts().len();
    }

    match images::write_all() {
        Ok(pfade) => {
            for pfad in pfade {
                println!("geschrieben: {}", pfad.display());
            }
        }
        Err(fehler) => {
            eprintln!("Bildfahrpläne nicht schreibbar: {fehler}");
            return ExitCode::FAILURE;
        }
    }

    println!("\n{konflikte} Belegungskonflikt(e) über alle Betriebsfälle.");
    ExitCode::SUCCESS
}
