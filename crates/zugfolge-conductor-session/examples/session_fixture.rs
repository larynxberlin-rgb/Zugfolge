//! Ausschließlich fiktive Testdaten aus den echten Domänenproduzenten.
#![allow(
    dead_code,
    reason = "Gemeinsame Testhelfer werden auch von den Domänentests benutzt"
)]
#[path = "../tests/support/mod.rs"]
mod support;
use std::io::Write;
fn main() {
    let fixture = support::Fixture::new();
    let output = serde_json::json!({"testOnly":true,"source":fixture.source,"demand":fixture.demand,"initialState":fixture.initial(),"access":fixture.access(),"infrastructure":fixture.infrastructure,"materialization":fixture.materialization});
    std::io::stdout()
        .write_all(
            serde_json::to_string(&output)
                .expect("Testdaten")
                .as_bytes(),
        )
        .expect("stdout");
}
