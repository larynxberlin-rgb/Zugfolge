//! Schreibt den releasefesten Deutschland-Semantikexport aus einem EBO-PBF.
//!
//! zugfolge:quelle=osm-pbf-deutschland

use std::fs::File;
use std::io::BufReader;

use serde_json::json;
use zugfolge_infra::{SourceId, export_semantic_geojsonseq, import_pbf_document};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let input = arguments
        .next()
        .ok_or("usage: pbf_semantic_export INPUT.pbf SOURCE_ID OUTPUT_DIRECTORY")?;
    let source_id = arguments.next().ok_or("source id fehlt")?;
    let output = arguments.next().ok_or("output directory fehlt")?;
    if arguments.next().is_some() {
        return Err("zu viele Argumente".into());
    }

    let mut reader = BufReader::new(File::open(input)?);
    let document = import_pbf_document(&mut reader, SourceId::new(source_id)?)?;
    let summary = export_semantic_geojsonseq(&document, output)?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "corpusSha256": summary.corpus_sha256(),
            "layers": summary.layer_counts(),
            "sourceId": summary.source_id(),
        }))?
    );
    Ok(())
}
