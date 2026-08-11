#![allow(missing_docs)]

fn main() {
    #[cfg(feature = "node-addon")]
    napi_build::setup();
}
