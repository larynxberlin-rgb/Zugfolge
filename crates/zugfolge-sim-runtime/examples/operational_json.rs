//! Native JSON bridge for integration evidence, using the same release loader as N-API.
use std::io::{self, Read};
use zugfolge_sim_runtime::operational_runtime::{
    apply_operational_simulation_command, apply_operational_simulation_command_batch,
    hash_operational_simulation_command, initialize_operational_simulation,
    restore_operational_simulation,
};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    method: String,
    args: Vec<String>,
}

fn run() -> Result<String, String> {
    let mut json = String::new();
    io::stdin()
        .take(256 * 1024 * 1024 + 1)
        .read_to_string(&mut json)
        .map_err(|e| e.to_string())?;
    if json.len() > 256 * 1024 * 1024 {
        return Err("request_too_large".into());
    }
    let request: Request = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let args: Vec<&str> = request.args.iter().map(String::as_str).collect();
    let result = match (request.method.as_str(), args.as_slice()) {
        ("initialize", [input, path]) => initialize_operational_simulation(input, path),
        ("restore", [state, path]) => restore_operational_simulation(state, path),
        ("apply", [state, command, path]) => {
            apply_operational_simulation_command(state, command, path)
        }
        ("batch", [state, commands, path]) => {
            apply_operational_simulation_command_batch(state, commands, path)
        }
        ("hash", [command]) => hash_operational_simulation_command(command),
        ("fare-control-policy-hash", [policy]) => {
            zugfolge_sim_runtime::operational_runtime::hash_fare_control_policy(policy)
        }
        _ => return Err("unsupported_operation".into()),
    };
    result.map_err(|error| error.to_string())
}

fn main() {
    match run() {
        Ok(output) => print!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
