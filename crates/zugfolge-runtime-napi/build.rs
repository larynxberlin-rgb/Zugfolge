//! napi-rs build configuration for the isolated Node adapter.

fn main() {
    if std::env::var_os("CARGO_FEATURE_NODE_ADDON").is_some() {
        napi_build::setup();
    }
}
