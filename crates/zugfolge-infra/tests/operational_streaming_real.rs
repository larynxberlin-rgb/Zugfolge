//! Expliziter RSS-Realtest fuer den nativen Operational-v2-Streamingpfad.
//!
//! Die Tests sind absichtlich ignoriert: Sie lesen einen exakt gepinnten
//! realen Korpus vollstaendig, erzeugen seinen temporaeren redb-Index und
//! kanonisieren ihn ein zweites Mal fuer die Hashbindung. Sie schreiben kein
//! Releaseartefakt, sondern ausschliesslich einen create-new RSS-Beleg.
//! Der aktuelle 2026.4-Kandidat belegt den >=900-MiB-Pfad:
//!
//! ```text
//! $env:ZUGFOLGE_RUN_OPERATIONAL_V2_REAL_RSS='1'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_INPUT='C:\\...\\operational-infrastructure-v2.json'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_RELEASE_ID='infra-deutschland-2026.4'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_BYTES='983736272'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_SOURCE_SHA256='64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_STATE_HASH='deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788'
//! $env:ZUGFOLGE_OPERATIONAL_V2_REAL_RSS_PROOF_OUTPUT='C:\\...\\operational-v2-rss-proof.json'
//! cargo test --release --locked -p zugfolge-infra --test operational_streaming_real -- --ignored --exact realer_korpus_ab_900_mib_bleibt_unter_fester_rss_grenze --nocapture
//! ```
//!
//! Der davon getrennte, archivierte und nicht aktivierbare 2026.3-Korpus
//! belegt mit exakt 1.455.920.792 Bytes den >1-GiB-Pfad. Sein manueller Aufruf
//! und sein noch ausstehender Laufstatus sind im 2026.4-Readiness-Bericht
//! dokumentiert.
//!
//! Linux-CI setzt zusaetzlich
//! `ZUGFOLGE_OPERATIONAL_V2_REAL_REQUIRE_CGROUP_LIMIT=1` und fuehrt den Test in
//! einer frischen cgroup-v2 mit exakt 512 MiB `memory.max` und ohne Swap aus.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

use serde_json::{Value, json};
use zugfolge_infra::validate_operational_infrastructure_v2_file;

const MINIMUM_CURRENT_2026_4_CORPUS_BYTES: u64 = 900 * 1024 * 1024;
const MINIMUM_OVER_ONE_GIB_CORPUS_BYTES: u64 = 1024 * 1024 * 1024 + 1;
const MAX_RSS_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy)]
struct RealCorpusContract {
    profile: &'static str,
    release_id: &'static str,
    expected_source_bytes: u64,
    expected_source_sha256: &'static str,
    expected_state_hash: &'static str,
    minimum_source_bytes: u64,
    minimum_description: &'static str,
    input_environment_variable: &'static str,
    release_id_environment_variable: &'static str,
    expected_bytes_environment_variable: &'static str,
    expected_source_sha256_environment_variable: &'static str,
    expected_state_hash_environment_variable: &'static str,
    proof_environment_variable: &'static str,
}

const CURRENT_2026_4_CONTRACT: RealCorpusContract = RealCorpusContract {
    profile: "current-2026.4-at-least-900-mib",
    release_id: "infra-deutschland-2026.4",
    expected_source_bytes: 983_736_272,
    expected_source_sha256: "64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6",
    expected_state_hash: "deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788",
    minimum_source_bytes: MINIMUM_CURRENT_2026_4_CORPUS_BYTES,
    minimum_description: "mindestens 900 MiB",
    input_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_INPUT",
    release_id_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_RELEASE_ID",
    expected_bytes_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_BYTES",
    expected_source_sha256_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_SOURCE_SHA256",
    expected_state_hash_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_STATE_HASH",
    proof_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_REAL_RSS_PROOF_OUTPUT",
};

const ARCHIVED_2026_3_OVER_ONE_GIB_CONTRACT: RealCorpusContract = RealCorpusContract {
    profile: "archived-2026.3-over-one-gib-robustness-only",
    release_id: "infra-deutschland-2026.3",
    expected_source_bytes: 1_455_920_792,
    expected_source_sha256: "64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c",
    expected_state_hash: "5972ef9d4897e5dc225ff463620745913846a6b16dba813f5fd12598c768399f",
    minimum_source_bytes: MINIMUM_OVER_ONE_GIB_CORPUS_BYTES,
    minimum_description: "mehr als 1 GiB",
    input_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_INPUT",
    release_id_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_RELEASE_ID",
    expected_bytes_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_BYTES",
    expected_source_sha256_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_SOURCE_SHA256",
    expected_state_hash_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_STATE_HASH",
    proof_environment_variable: "ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_RSS_PROOF_OUTPUT",
};

#[cfg(target_os = "linux")]
fn proc_status_bytes(field: &str) -> Result<u64, String> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("/proc/self/status kann nicht gelesen werden: {error}"))?;
    let prefix = format!("{field}:");
    let line = status
        .lines()
        .find(|line| line.starts_with(&prefix))
        .ok_or_else(|| format!("{field} fehlt in /proc/self/status."))?;
    let kibibytes = line
        .split_ascii_whitespace()
        .nth(1)
        .ok_or_else(|| format!("{field} besitzt keinen Zahlenwert."))?
        .parse::<u64>()
        .map_err(|error| format!("{field} ist ungueltig: {error}"))?;
    kibibytes
        .checked_mul(1024)
        .ok_or_else(|| format!("{field} laeuft ueber."))
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> Result<u64, String> {
    proc_status_bytes("VmRSS")
}

#[cfg(target_os = "linux")]
fn peak_rss_bytes() -> Result<u64, String> {
    proc_status_bytes("VmHWM")
}

#[cfg(windows)]
fn process_memory_property_bytes(property: &str) -> Result<u64, String> {
    let expression = format!("(Get-Process -Id {}).{}", std::process::id(), property);
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &expression])
        .output()
        .map_err(|error| format!("PowerShell-RSS-Abfrage kann nicht gestartet werden: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "PowerShell-RSS-Abfrage ist fehlgeschlagen: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("PowerShell-{property} ist ungueltig: {error}"))
}

#[cfg(windows)]
fn current_rss_bytes() -> Result<u64, String> {
    process_memory_property_bytes("WorkingSet64")
}

#[cfg(windows)]
fn peak_rss_bytes() -> Result<u64, String> {
    process_memory_property_bytes("PeakWorkingSet64")
}

#[cfg(not(any(target_os = "linux", windows)))]
fn current_rss_bytes() -> Result<u64, String> {
    Err("RSS-Realtest unterstuetzt nur Linux und Windows.".to_owned())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn peak_rss_bytes() -> Result<u64, String> {
    Err("RSS-Realtest unterstuetzt nur Linux und Windows.".to_owned())
}

#[cfg(target_os = "linux")]
fn cgroup_v2_bytes(name: &str) -> Result<Option<u64>, String> {
    let path = PathBuf::from("/sys/fs/cgroup").join(name);
    let value = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cgroup-v2-Wert {} kann nicht gelesen werden: {error}",
                path.display()
            ));
        }
    };
    let value = value.trim();
    if value == "max" {
        return Ok(None);
    }
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| format!("cgroup-v2-Wert {} ist ungueltig: {error}", path.display()))
}

#[cfg(not(target_os = "linux"))]
fn cgroup_v2_bytes(_name: &str) -> Result<Option<u64>, String> {
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
fn rss_proof(
    corpus_profile: &str,
    release_id: &str,
    minimum_source_bytes: u64,
    source_bytes: u64,
    source_sha256: &Value,
    canonical_bytes: &Value,
    canonical_sha256: &Value,
    state_hash: &Value,
    validation_mode: &Value,
    baseline_rss_bytes: u64,
    peak_rss_bytes: u64,
    require_cgroup_limit: bool,
    cgroup_memory_max_bytes: Option<u64>,
    cgroup_memory_peak_bytes: Option<u64>,
    cgroup_swap_max_bytes: Option<u64>,
) -> Value {
    json!({
        "schema": "zugfolge-operational-streaming-rss-proof/v1",
        "corpusProfile": corpus_profile,
        "infraReleaseId": release_id,
        "minimumSourceBytes": minimum_source_bytes,
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
        "canonicalBytes": canonical_bytes,
        "canonicalSha256": canonical_sha256,
        "stateHash": state_hash,
        "baselineRssBytes": baseline_rss_bytes,
        "peakRssBytes": peak_rss_bytes,
        "maxRssBytes": MAX_RSS_BYTES,
        "memoryLimitEnforcement": if require_cgroup_limit {
            "cgroup-v2-memory-max-without-swap"
        } else {
            "kernel-peak-rss-assertion"
        },
        "cgroupMemoryMaxBytes": cgroup_memory_max_bytes,
        "cgroupMemoryPeakBytes": cgroup_memory_peak_bytes,
        "cgroupSwapMaxBytes": cgroup_swap_max_bytes,
        "platform": std::env::consts::OS,
        "validationMode": validation_mode,
    })
}

fn write_proof(path: &PathBuf, proof: &Value) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "RSS-Belegverzeichnis {} kann nicht angelegt werden: {error}",
                parent.display()
            )
        })?;
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "RSS-Beleg {} kann nicht create-new angelegt werden: {error}",
                path.display()
            )
        })?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, proof)
        .map_err(|error| format!("RSS-Beleg ist nicht serialisierbar: {error}"))?;
    writer
        .write_all(b"\n")
        .map_err(|error| format!("RSS-Beleg kann nicht abgeschlossen werden: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("RSS-Beleg kann nicht geschrieben werden: {error}"))?;
    writer
        .into_inner()
        .map_err(|error| format!("RSS-Beleg kann nicht synchronisiert werden: {error}"))?
        .sync_all()
        .map_err(|error| format!("RSS-Beleg kann nicht synchronisiert werden: {error}"))
}

#[test]
fn rss_belegvertrag_ist_maschinenlesbar_hashgebunden_und_create_new() {
    let proof = rss_proof(
        CURRENT_2026_4_CONTRACT.profile,
        "infra-deutschland-rss-contract",
        MINIMUM_CURRENT_2026_4_CORPUS_BYTES,
        MINIMUM_CURRENT_2026_4_CORPUS_BYTES,
        &json!("a".repeat(64)),
        &json!(MINIMUM_CURRENT_2026_4_CORPUS_BYTES),
        &json!("b".repeat(64)),
        &json!("c".repeat(64)),
        &json!("native-streaming-redb-v1"),
        16 * 1024 * 1024,
        32 * 1024 * 1024,
        true,
        Some(MAX_RSS_BYTES),
        Some(64 * 1024 * 1024),
        Some(0),
    );
    let path = std::env::temp_dir().join(format!(
        "zugfolge-operational-streaming-rss-proof-contract-{}.json",
        std::process::id()
    ));
    write_proof(&path, &proof).expect("create-new RSS-Beleg schreiben");
    let stored: Value = serde_json::from_reader(
        File::open(&path).expect("RSS-Beleg fuer Vertragspruefung oeffnen"),
    )
    .expect("RSS-Beleg ist maschinenlesbar");
    assert_eq!(stored, proof);
    assert_eq!(stored["corpusProfile"], CURRENT_2026_4_CONTRACT.profile);
    assert_eq!(
        stored["minimumSourceBytes"],
        MINIMUM_CURRENT_2026_4_CORPUS_BYTES
    );
    assert_eq!(stored["sourceBytes"], MINIMUM_CURRENT_2026_4_CORPUS_BYTES);
    assert_eq!(stored["maxRssBytes"], MAX_RSS_BYTES);
    assert_eq!(stored["cgroupMemoryMaxBytes"], MAX_RSS_BYTES);
    assert!(
        write_proof(&path, &proof)
            .expect_err("RSS-Beleg darf nie ueberschrieben werden")
            .contains("create-new")
    );
    fs::remove_file(path).expect("RSS-Vertragsbeleg aufraeumen");
}

fn run_real_corpus(contract: RealCorpusContract) {
    assert_eq!(
        std::env::var("ZUGFOLGE_RUN_OPERATIONAL_V2_REAL_RSS").as_deref(),
        Ok("1"),
        "Realtest braucht die explizite Freigabe ZUGFOLGE_RUN_OPERATIONAL_V2_REAL_RSS=1."
    );
    let candidate = PathBuf::from(
        std::env::var_os(contract.input_environment_variable)
            .unwrap_or_else(|| panic!("{} fehlt.", contract.input_environment_variable)),
    );
    assert_eq!(
        std::env::var(contract.release_id_environment_variable).as_deref(),
        Ok(contract.release_id),
        "{} muss die fest kodierte Release-ID fuer {} bestaetigen.",
        contract.release_id_environment_variable,
        contract.profile
    );
    assert_eq!(
        std::env::var(contract.expected_bytes_environment_variable)
            .ok()
            .and_then(|value| value.parse::<u64>().ok()),
        Some(contract.expected_source_bytes),
        "{} muss die fest kodierte Bytebindung fuer {} bestaetigen.",
        contract.expected_bytes_environment_variable,
        contract.profile
    );
    assert_eq!(
        std::env::var(contract.expected_source_sha256_environment_variable).as_deref(),
        Ok(contract.expected_source_sha256),
        "{} muss den fest kodierten Source-SHA-256 fuer {} bestaetigen.",
        contract.expected_source_sha256_environment_variable,
        contract.profile
    );
    assert_eq!(
        std::env::var(contract.expected_state_hash_environment_variable).as_deref(),
        Ok(contract.expected_state_hash),
        "{} muss den fest kodierten State-Hash fuer {} bestaetigen.",
        contract.expected_state_hash_environment_variable,
        contract.profile
    );
    let proof_path = PathBuf::from(
        std::env::var_os(contract.proof_environment_variable)
            .unwrap_or_else(|| panic!("{} fehlt.", contract.proof_environment_variable)),
    );
    assert!(
        !proof_path.exists(),
        "Ein vorhandener RSS-Beleg darf nicht als neuer Lauf ausgegeben werden."
    );
    let source_bytes = fs::metadata(&candidate)
        .expect("Operational-v2-Realdatei fehlt.")
        .len();
    assert_eq!(
        source_bytes, contract.expected_source_bytes,
        "Operational-v2-Realdatei verletzt die erwartete Bytebindung fuer {}.",
        contract.profile
    );
    assert!(
        source_bytes >= contract.minimum_source_bytes,
        "Operational-v2-Realdatei fuer {} muss {} gross sein.",
        contract.profile,
        contract.minimum_description
    );
    let require_cgroup_limit =
        std::env::var("ZUGFOLGE_OPERATIONAL_V2_REAL_REQUIRE_CGROUP_LIMIT").as_deref() == Ok("1");
    let cgroup_memory_max_bytes =
        cgroup_v2_bytes("memory.max").expect("cgroup-v2-memory.max kann nicht gelesen werden.");
    let cgroup_swap_max_bytes = cgroup_v2_bytes("memory.swap.max")
        .expect("cgroup-v2-memory.swap.max kann nicht gelesen werden.");
    if require_cgroup_limit {
        assert_eq!(
            cgroup_memory_max_bytes,
            Some(MAX_RSS_BYTES),
            "CI-Realtest braucht eine frische cgroup-v2 mit exakt 512 MiB memory.max."
        );
        assert_eq!(
            cgroup_swap_max_bytes,
            Some(0),
            "CI-Realtest darf die feste Speichergrenze nicht durch Swap umgehen."
        );
    }
    let baseline_rss = current_rss_bytes().expect("RSS-Baseline kann nicht gemessen werden.");
    assert!(
        baseline_rss < MAX_RSS_BYTES,
        "Testprozess startet bereits oberhalb der festen 512-MiB-RSS-Grenze."
    );

    let receipt =
        validate_operational_infrastructure_v2_file(&candidate, contract.release_id, None)
            .expect("Realdatei besteht die Streamingvalidierung nicht.");
    let peak_rss = peak_rss_bytes().expect("Kernel-Peak-RSS kann nicht gemessen werden.");
    let cgroup_memory_peak_bytes =
        cgroup_v2_bytes("memory.peak").expect("cgroup-v2-memory.peak kann nicht gelesen werden.");

    assert_eq!(receipt["sourceBytes"], source_bytes);
    assert_eq!(receipt["sourceSha256"], contract.expected_source_sha256);
    assert_eq!(receipt["stateHash"], contract.expected_state_hash);
    assert_eq!(receipt["validationMode"], "native-streaming-redb-v1");
    assert!(
        peak_rss <= MAX_RSS_BYTES,
        "Peak-RSS {peak_rss} ueberschreitet die feste 512-MiB-Grenze {MAX_RSS_BYTES}."
    );
    if require_cgroup_limit {
        assert!(
            cgroup_memory_peak_bytes.is_some_and(|peak| peak <= MAX_RSS_BYTES),
            "cgroup-v2-memory.peak fehlt oder ueberschreitet die feste 512-MiB-Grenze."
        );
    }
    let proof = rss_proof(
        contract.profile,
        contract.release_id,
        contract.minimum_source_bytes,
        source_bytes,
        &receipt["sourceSha256"],
        &receipt["bytes"],
        &receipt["sha256"],
        &receipt["stateHash"],
        &receipt["validationMode"],
        baseline_rss,
        peak_rss,
        require_cgroup_limit,
        cgroup_memory_max_bytes,
        cgroup_memory_peak_bytes,
        cgroup_swap_max_bytes,
    );
    write_proof(&proof_path, &proof).expect("maschinenlesbaren RSS-Beleg schreiben");
    println!(
        "{}",
        serde_json::to_string(&proof).expect("RSS-Beleg fuer Konsolenausgabe serialisieren")
    );
}

#[test]
#[ignore = "expliziter aktueller 2026.4-Realtest mit >=900 MiB, temporaerem redb-Index und RSS-Messung"]
fn realer_korpus_ab_900_mib_bleibt_unter_fester_rss_grenze() {
    run_real_corpus(CURRENT_2026_4_CONTRACT);
}

#[test]
#[ignore = "expliziter archivierter 2026.3-Robustheitstest mit >1 GiB, temporaerem redb-Index und RSS-Messung"]
fn archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze() {
    run_real_corpus(ARCHIVED_2026_3_OVER_ONE_GIB_CONTRACT);
}
