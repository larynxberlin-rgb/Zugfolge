//! Datentraegergestuetzte, autoritative Validierung grosser Operational-v2-Artefakte.
//!
//! Der JSON-Deserializer haelt immer nur einen fachlichen Datensatz im Speicher.
//! Korpusweite Schluessel und Referenzen liegen in einer temporaeren, auf 16 MiB
//! Cache begrenzten redb-Datei und wachsen deshalb nicht mit dem Rust-Heap.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use redb::{
    Database, Durability, MultimapTableDefinition, ReadTransaction, ReadableTable,
    ReadableTableMetadata, TableDefinition, WriteTransaction,
};
use serde::Serialize;
use serde::de::{DeserializeOwned, DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zugfolge_sim::operational::{
    EdgeGeometryPoint, InterlockingRouteTemplate, MovementKind, OperationalError,
    OperationalInfrastructure, RouteMillimetres, RouteVersion, TrackInterval,
};

const SCHEMA: &str = "operational-infrastructure-v2";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DATABASE_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SINGLE_RECORD_APPROXIMATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SINGLE_RECORD_NODES: usize = 131_072;
const MAX_SINGLE_RECORD_DEPTH: usize = 64;
const MAX_SINGLE_JSON_STRING_BYTES: usize = 1024 * 1024;
const REQUIRED_FIELDS: [&str; 11] = [
    "id",
    "directedEdges",
    "edgeGeometries",
    "routeVersions",
    "interlockingRoutes",
    "signals",
    "switches",
    "blockResources",
    "platformIntervals",
    "regionBoundaries",
    "rzueLayoutId",
];
static NEXT_SCRATCH_ID: AtomicU64 = AtomicU64::new(0);

const META: TableDefinition<&str, &str> = TableDefinition::new("meta");
const DIRECTED_EDGES: TableDefinition<&str, i64> = TableDefinition::new("directed_edges");
const GEOMETRY_META: TableDefinition<&str, (u64, i64)> = TableDefinition::new("geometry_meta");
const GEOMETRY_POINTS: TableDefinition<(&str, u64), &str> = TableDefinition::new("geometry_points");
const ROUTES: TableDefinition<&str, &str> = TableDefinition::new("routes");
const INTERLOCKING: TableDefinition<&str, &str> = TableDefinition::new("interlocking");
const PLATFORMS: TableDefinition<&str, &str> = TableDefinition::new("platforms");
const SIGNALS: TableDefinition<&str, ()> = TableDefinition::new("signals");
const SWITCHES: TableDefinition<&str, ()> = TableDefinition::new("switches");
const BLOCK_RESOURCES: TableDefinition<&str, ()> = TableDefinition::new("block_resources");
const REGION_BOUNDARIES: TableDefinition<&str, ()> = TableDefinition::new("region_boundaries");
const ROUTES_BY_TEMPLATE: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("routes_by_template");
const INTERLOCKING_BY_TEMPLATE: MultimapTableDefinition<&str, &str> =
    MultimapTableDefinition::new("interlocking_by_template");

/// Stabiler Fehler der dateibasierten Operational-v2-Validierung.
#[derive(Debug)]
pub struct OperationalStreamingError(String);

impl OperationalStreamingError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for OperationalStreamingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OperationalStreamingError {}

type Result<T> = std::result::Result<T, OperationalStreamingError>;

fn db_message(error: impl fmt::Display) -> String {
    format!("Temporaerer Operational-v2-Index ist fehlgeschlagen: {error}")
}

fn database_error(error: impl fmt::Display) -> OperationalStreamingError {
    OperationalStreamingError::new(db_message(error))
}

fn io_error(what: &str, path: &Path, error: io::Error) -> OperationalStreamingError {
    OperationalStreamingError::new(format!(
        "{what} {} ist fehlgeschlagen: {error}",
        path.display()
    ))
}

fn require(condition: bool, message: impl fmt::Display) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(OperationalStreamingError::new(message.to_string()))
    }
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(
            &serde_json::to_string(value).expect("eine Zeichenkette ist immer serialisierbar"),
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .expect("ein JSON-Objektschluessel ist immer serialisierbar"),
                );
                output.push(':');
                canonical(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn safe_integers(value: &Value) -> bool {
    match value {
        Value::Number(number) => number
            .as_i64()
            .is_some_and(|number| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number)),
        Value::Array(values) => values.iter().all(safe_integers),
        Value::Object(values) => values.values().all(safe_integers),
        _ => true,
    }
}

fn canonical_typed<T>(value: Value, what: &str) -> std::result::Result<(T, String), String>
where
    T: DeserializeOwned + Serialize,
{
    if !safe_integers(&value) {
        return Err(format!(
            "{what} enthaelt keine sichere kanonische Ganzzahl."
        ));
    }
    let typed: T = serde_json::from_value(value.clone())
        .map_err(|error| format!("{what} ist ungueltig: {error}"))?;
    let normalized = serde_json::to_value(&typed)
        .map_err(|error| format!("{what} kann nicht kanonisiert werden: {error}"))?;
    if normalized != value {
        return Err(format!(
            "{what} ist nicht in der kanonischen nativen Darstellung."
        ));
    }
    let mut serialized = String::new();
    canonical(&normalized, &mut serialized);
    Ok((typed, serialized))
}

struct RecordBudget {
    remaining_bytes: usize,
    remaining_nodes: usize,
}

impl RecordBudget {
    fn new() -> Self {
        Self {
            remaining_bytes: MAX_SINGLE_RECORD_APPROXIMATE_BYTES,
            remaining_nodes: MAX_SINGLE_RECORD_NODES,
        }
    }

    fn enter_node<E>(&mut self, depth: usize) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        if depth > MAX_SINGLE_RECORD_DEPTH || self.remaining_nodes == 0 {
            return Err(E::custom(
                "Operational-v2-Einzeldatensatz ueberschreitet die native Strukturgrenze.",
            ));
        }
        self.remaining_nodes -= 1;
        self.charge::<E>(32)
    }

    fn charge<E>(&mut self, bytes: usize) -> std::result::Result<(), E>
    where
        E: serde::de::Error,
    {
        self.remaining_bytes = self.remaining_bytes.checked_sub(bytes).ok_or_else(|| {
            E::custom("Operational-v2-Einzeldatensatz ueberschreitet die native Speichergroesse.")
        })?;
        Ok(())
    }
}

struct BoundedValueSeed<'budget> {
    budget: &'budget mut RecordBudget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for BoundedValueSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        self.budget.enter_node::<D::Error>(self.depth)?;
        deserializer.deserialize_any(BoundedValueVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

struct BoundedStringSeed<'budget> {
    budget: &'budget mut RecordBudget,
}

impl<'de> DeserializeSeed<'de> for BoundedStringSeed<'_> {
    type Value = String;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_string(BoundedStringVisitor {
            budget: self.budget,
        })
    }
}

struct BoundedStringVisitor<'budget> {
    budget: &'budget mut RecordBudget,
}

impl<'de> Visitor<'de> for BoundedStringVisitor<'_> {
    type Value = String;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine groessenbegrenzte JSON-Zeichenkette")
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.budget
            .charge::<E>(24_usize.saturating_add(value.len()))?;
        Ok(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.budget
            .charge::<E>(24_usize.saturating_add(value.len()))?;
        Ok(value)
    }
}

struct BoundedValueVisitor<'budget> {
    budget: &'budget mut RecordBudget,
    depth: usize,
}

impl<'de> Visitor<'de> for BoundedValueVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("einen groessenbegrenzten JSON-Einzeldatensatz")
    }

    fn visit_bool<E>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("Operational-v2 enthaelt keine endliche JSON-Zahl."))
    }

    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        BoundedValueSeed {
            budget: self.budget,
            depth: self.depth.saturating_add(1),
        }
        .deserialize(deserializer)
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.budget
            .charge::<E>(24_usize.saturating_add(value.len()))?;
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.budget
            .charge::<E>(24_usize.saturating_add(value.len()))?;
        Ok(Value::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(BoundedValueSeed {
            budget: &mut *self.budget,
            depth: self.depth.saturating_add(1),
        })? {
            values.try_reserve(1).map_err(|_| {
                A::Error::custom(
                    "Operational-v2-Einzeldatensatz kann nicht sicher reserviert werden.",
                )
            })?;
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key_seed(BoundedStringSeed {
            budget: &mut *self.budget,
        })? {
            let value = map.next_value_seed(BoundedValueSeed {
                budget: &mut *self.budget,
                depth: self.depth.saturating_add(1),
            })?;
            if values.insert(key.clone(), value).is_some() {
                return Err(A::Error::custom(format!(
                    "Operational-v2-Einzeldatensatz enthaelt den doppelten Schluessel `{key}`."
                )));
            }
        }
        Ok(Value::Object(values))
    }
}

fn bounded_value_seed(budget: &mut RecordBudget) -> BoundedValueSeed<'_> {
    BoundedValueSeed { budget, depth: 0 }
}

struct ScratchDirectory(PathBuf);

impl ScratchDirectory {
    fn create() -> Result<Self> {
        let process_id = std::process::id();
        for _ in 0..1_024 {
            let id = NEXT_SCRATCH_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("zugfolge-operational-v2-{process_id}-{id}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(io_error("Temporaeres Verzeichnis", &path, error)),
            }
        }
        Err(OperationalStreamingError::new(
            "Kein eindeutiges temporaeres Operational-v2-Verzeichnis verfuegbar.",
        ))
    }

    fn database_path(&self) -> PathBuf {
        self.0.join("index.redb")
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
    in_json_string: bool,
    json_string_escaped: bool,
    json_string_bytes: usize,
}

impl<R> HashingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
            in_json_string: false,
            json_string_escaped: false,
            json_string_bytes: 0,
        }
    }

    fn validate_json_string_lengths(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            if !self.in_json_string {
                if *byte == b'"' {
                    self.in_json_string = true;
                    self.json_string_escaped = false;
                    self.json_string_bytes = 0;
                }
                continue;
            }
            if !self.json_string_escaped && *byte == b'"' {
                self.in_json_string = false;
                self.json_string_bytes = 0;
                continue;
            }
            self.json_string_bytes = self.json_string_bytes.checked_add(1).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Operational-v2-JSON-Zeichenkette laeuft ueber",
                )
            })?;
            if self.json_string_bytes > MAX_SINGLE_JSON_STRING_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Operational-v2-JSON-Zeichenkette ueberschreitet die native 1-MiB-Grenze",
                ));
            }
            if self.json_string_escaped {
                self.json_string_escaped = false;
            } else if *byte == b'\\' {
                self.json_string_escaped = true;
            }
        }
        Ok(())
    }

    fn finish(self) -> (u64, String) {
        (self.bytes, digest_hex(self.hasher.finalize()))
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.validate_json_string_lengths(&buffer[..read])?;
        self.hasher.update(&buffer[..read]);
        self.bytes = self
            .bytes
            .checked_add(u64::try_from(read).map_err(io::Error::other)?)
            .ok_or_else(|| io::Error::other("Operational-v2-Dateigroesse laeuft ueber"))?;
        Ok(read)
    }
}

#[derive(Clone, Copy)]
enum SetKind {
    Signals,
    Switches,
    BlockResources,
    RegionBoundaries,
}

impl SetKind {
    fn definition(self) -> TableDefinition<'static, &'static str, ()> {
        match self {
            Self::Signals => SIGNALS,
            Self::Switches => SWITCHES,
            Self::BlockResources => BLOCK_RESOURCES,
            Self::RegionBoundaries => REGION_BOUNDARIES,
        }
    }
}

#[derive(Clone, Copy)]
struct Store<'transaction> {
    transaction: &'transaction WriteTransaction,
}

impl Store<'_> {
    fn initialize(self) -> std::result::Result<(), String> {
        drop(self.transaction.open_table(META).map_err(db_message)?);
        drop(
            self.transaction
                .open_table(DIRECTED_EDGES)
                .map_err(db_message)?,
        );
        drop(
            self.transaction
                .open_table(GEOMETRY_META)
                .map_err(db_message)?,
        );
        drop(
            self.transaction
                .open_table(GEOMETRY_POINTS)
                .map_err(db_message)?,
        );
        drop(self.transaction.open_table(ROUTES).map_err(db_message)?);
        drop(
            self.transaction
                .open_table(INTERLOCKING)
                .map_err(db_message)?,
        );
        drop(self.transaction.open_table(PLATFORMS).map_err(db_message)?);
        for definition in [SIGNALS, SWITCHES, BLOCK_RESOURCES, REGION_BOUNDARIES] {
            drop(
                self.transaction
                    .open_table(definition)
                    .map_err(db_message)?,
            );
        }
        drop(
            self.transaction
                .open_multimap_table(ROUTES_BY_TEMPLATE)
                .map_err(db_message)?,
        );
        drop(
            self.transaction
                .open_multimap_table(INTERLOCKING_BY_TEMPLATE)
                .map_err(db_message)?,
        );
        Ok(())
    }

    fn insert_meta(self, key: &str, value: &str) -> std::result::Result<(), String> {
        let mut table = self.transaction.open_table(META).map_err(db_message)?;
        if table.insert(key, value).map_err(db_message)?.is_some() {
            return Err(format!("doppeltes Operational-v2-Feld `{key}`"));
        }
        Ok(())
    }

    fn insert_edge(self, edge_id: &str, length_mm: i64) -> std::result::Result<(), String> {
        let mut table = self
            .transaction
            .open_table(DIRECTED_EDGES)
            .map_err(db_message)?;
        if table
            .insert(edge_id, &length_mm)
            .map_err(db_message)?
            .is_some()
        {
            return Err(format!("doppelte gerichtete Kante `{edge_id}`"));
        }
        Ok(())
    }

    fn insert_geometry_point(
        self,
        edge_id: &str,
        position: u64,
        canonical_json: &str,
    ) -> std::result::Result<(), String> {
        let mut table = self
            .transaction
            .open_table(GEOMETRY_POINTS)
            .map_err(db_message)?;
        if table
            .insert((edge_id, position), canonical_json)
            .map_err(db_message)?
            .is_some()
        {
            return Err(format!("doppelter Geometriepunkt `{edge_id}:{position}`"));
        }
        Ok(())
    }

    fn insert_geometry_meta(
        self,
        edge_id: &str,
        point_count: u64,
        last_offset_mm: i64,
    ) -> std::result::Result<(), String> {
        let mut table = self
            .transaction
            .open_table(GEOMETRY_META)
            .map_err(db_message)?;
        if table
            .insert(edge_id, &(point_count, last_offset_mm))
            .map_err(db_message)?
            .is_some()
        {
            return Err(format!("doppelte Kantengeometrie `{edge_id}`"));
        }
        Ok(())
    }

    fn insert_route(
        self,
        route_id: &str,
        template_id: &str,
        canonical_json: &str,
    ) -> std::result::Result<(), String> {
        {
            let mut table = self.transaction.open_table(ROUTES).map_err(db_message)?;
            if table
                .insert(route_id, canonical_json)
                .map_err(db_message)?
                .is_some()
            {
                return Err(format!("doppelte Laufwegversion `{route_id}`"));
            }
        }
        let mut index = self
            .transaction
            .open_multimap_table(ROUTES_BY_TEMPLATE)
            .map_err(db_message)?;
        index.insert(template_id, route_id).map_err(db_message)?;
        Ok(())
    }

    fn insert_interlocking(
        self,
        interlocking_id: &str,
        template_id: &str,
        canonical_json: &str,
    ) -> std::result::Result<(), String> {
        {
            let mut table = self
                .transaction
                .open_table(INTERLOCKING)
                .map_err(db_message)?;
            if table
                .insert(interlocking_id, canonical_json)
                .map_err(db_message)?
                .is_some()
            {
                return Err(format!("doppelte Fahrstrassenvorlage `{interlocking_id}`"));
            }
        }
        let mut index = self
            .transaction
            .open_multimap_table(INTERLOCKING_BY_TEMPLATE)
            .map_err(db_message)?;
        index
            .insert(template_id, interlocking_id)
            .map_err(db_message)?;
        Ok(())
    }

    fn insert_platform(
        self,
        platform_id: &str,
        canonical_json: &str,
    ) -> std::result::Result<(), String> {
        let mut table = self.transaction.open_table(PLATFORMS).map_err(db_message)?;
        if table
            .insert(platform_id, canonical_json)
            .map_err(db_message)?
            .is_some()
        {
            return Err(format!("doppeltes Bahnsteigintervall `{platform_id}`"));
        }
        Ok(())
    }

    fn insert_set(self, kind: SetKind, value: &str) -> std::result::Result<(), String> {
        let mut table = self
            .transaction
            .open_table(kind.definition())
            .map_err(db_message)?;
        if table.insert(value, &()).map_err(db_message)?.is_some() {
            return Err("doppelter Wert in Operational-v2-Menge".into());
        }
        Ok(())
    }
}

struct RootSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for RootSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(RootVisitor { store: self.store })
    }
}

struct RootVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for RootVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ein OperationalInfrastructureV2-Objekt")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = BTreeSet::new();
        while let Some(field) = map.next_key::<String>()? {
            if !seen.insert(field.clone()) {
                return Err(A::Error::custom(format!(
                    "doppeltes Operational-v2-Feld `{field}`"
                )));
            }
            match field.as_str() {
                "id" | "rzueLayoutId" => {
                    let value = map.next_value::<String>()?;
                    self.store
                        .insert_meta(&field, &value)
                        .map_err(A::Error::custom)?;
                }
                "directedEdges" => map.next_value_seed(DirectedEdgesSeed { store: self.store })?,
                "edgeGeometries" => {
                    map.next_value_seed(EdgeGeometriesSeed { store: self.store })?
                }
                "routeVersions" => map.next_value_seed(RouteVersionsSeed { store: self.store })?,
                "interlockingRoutes" => {
                    map.next_value_seed(InterlockingRoutesSeed { store: self.store })?
                }
                "signals" => map.next_value_seed(StringSetSeed {
                    store: self.store,
                    kind: SetKind::Signals,
                })?,
                "switches" => map.next_value_seed(StringSetSeed {
                    store: self.store,
                    kind: SetKind::Switches,
                })?,
                "blockResources" => map.next_value_seed(StringSetSeed {
                    store: self.store,
                    kind: SetKind::BlockResources,
                })?,
                "platformIntervals" => {
                    map.next_value_seed(PlatformIntervalsSeed { store: self.store })?
                }
                "regionBoundaries" => map.next_value_seed(StringSetSeed {
                    store: self.store,
                    kind: SetKind::RegionBoundaries,
                })?,
                _ => return Err(A::Error::unknown_field(&field, &REQUIRED_FIELDS)),
            }
        }
        for required in REQUIRED_FIELDS {
            if !seen.contains(required) {
                return Err(A::Error::missing_field(required));
            }
        }
        Ok(())
    }
}

struct DirectedEdgesSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for DirectedEdgesSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(DirectedEdgesVisitor { store: self.store })
    }
}

struct DirectedEdgesVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for DirectedEdgesVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Karte gerichteter Kanten")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(edge_id) = map.next_key::<String>()? {
            let length_mm = map.next_value::<i64>()?;
            if edge_id.is_empty()
                || length_mm <= 0
                || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&length_mm)
            {
                return Err(A::Error::custom(
                    "gerichtete Operational-v2-Kante ist unvollstaendig oder unsicher",
                ));
            }
            self.store
                .insert_edge(&edge_id, length_mm)
                .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}

struct EdgeGeometriesSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for EdgeGeometriesSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(EdgeGeometriesVisitor { store: self.store })
    }
}

struct EdgeGeometriesVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for EdgeGeometriesVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Karte gerichteter Kantengeometrien")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(edge_id) = map.next_key::<String>()? {
            map.next_value_seed(GeometryPointsSeed {
                store: self.store,
                edge_id,
            })?;
        }
        Ok(())
    }
}

struct GeometryPointsSeed<'transaction> {
    store: Store<'transaction>,
    edge_id: String,
}

impl<'de> DeserializeSeed<'de> for GeometryPointsSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(GeometryPointsVisitor {
            store: self.store,
            edge_id: self.edge_id,
        })
    }
}

struct GeometryPointsVisitor<'transaction> {
    store: Store<'transaction>,
    edge_id: String,
}

impl<'de> Visitor<'de> for GeometryPointsVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Folge von Kantengeometriepunkten")
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut position = 0_u64;
        let mut previous_offset = None;
        let mut previous_bearing = None;
        loop {
            let mut budget = RecordBudget::new();
            let Some(value) = sequence.next_element_seed(bounded_value_seed(&mut budget))? else {
                break;
            };
            let (point, canonical_json) =
                canonical_typed::<EdgeGeometryPoint>(value, "Operational-v2-Kantengeometriepunkt")
                    .map_err(A::Error::custom)?;
            let valid = (-900_000_000..=900_000_000).contains(&point.latitude_e7)
                && (-1_800_000_000..=1_800_000_000).contains(&point.longitude_e7)
                && point
                    .bearing_milli_degrees
                    .is_none_or(|bearing| bearing < 360_000)
                && previous_offset.is_none_or(|offset| offset < point.edge_offset_mm)
                && !(position == 0 && point.edge_offset_mm != 0)
                && !(previous_offset.is_some() && previous_bearing.is_none());
            if !valid {
                return Err(A::Error::custom(format!(
                    "Operational-v2-Kantengeometrie `{}` ist ungueltig",
                    self.edge_id
                )));
            }
            self.store
                .insert_geometry_point(&self.edge_id, position, &canonical_json)
                .map_err(A::Error::custom)?;
            previous_offset = Some(point.edge_offset_mm);
            previous_bearing = point.bearing_milli_degrees;
            position = position
                .checked_add(1)
                .ok_or_else(|| A::Error::custom("zu viele Kantengeometriepunkte"))?;
        }
        if position < 2 || previous_bearing.is_some() {
            return Err(A::Error::custom(format!(
                "Operational-v2-Kantengeometrie `{}` ist ungueltig",
                self.edge_id
            )));
        }
        self.store
            .insert_geometry_meta(
                &self.edge_id,
                position,
                previous_offset.expect("zwei Punkte besitzen einen letzten Offset"),
            )
            .map_err(A::Error::custom)
    }
}

struct RouteVersionsSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for RouteVersionsSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(RouteVersionsVisitor { store: self.store })
    }
}

struct RouteVersionsVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for RouteVersionsVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Karte typisierter Laufwegversionen")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(route_id) = map.next_key::<String>()? {
            let mut budget = RecordBudget::new();
            let (route, canonical_json) = canonical_typed::<RouteVersion>(
                map.next_value_seed(bounded_value_seed(&mut budget))?,
                "Operational-v2-Laufwegversion",
            )
            .map_err(A::Error::custom)?;
            if route_id != route.id {
                return Err(A::Error::custom(format!(
                    "Operational-v2-Laufwegschluessel `{route_id}` stimmt nicht mit `{}` ueberein",
                    route.id
                )));
            }
            route.validate().map_err(A::Error::custom)?;
            self.store
                .insert_route(&route.id, &route.template_id, &canonical_json)
                .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}

struct InterlockingRoutesSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for InterlockingRoutesSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(InterlockingRoutesVisitor { store: self.store })
    }
}

struct InterlockingRoutesVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for InterlockingRoutesVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Karte typisierter Fahrstrassenvorlagen")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(interlocking_id) = map.next_key::<String>()? {
            let mut budget = RecordBudget::new();
            let (template, canonical_json) = canonical_typed::<InterlockingRouteTemplate>(
                map.next_value_seed(bounded_value_seed(&mut budget))?,
                "Operational-v2-Fahrstrassenvorlage",
            )
            .map_err(A::Error::custom)?;
            if interlocking_id != template.id
                || template.route_template_id.is_empty()
                || template.path_resources.is_empty()
                || template.overlap_resources.is_empty()
                || template.flank_resources.is_empty()
                || template.authority_end_route_mm <= 0
                || template.release_after_tail_route_mm < 0
                || template.release_after_tail_route_mm > template.authority_end_route_mm
            {
                return Err(A::Error::custom(format!(
                    "Operational-v2-Fahrstrassenvorlage `{interlocking_id}` ist ungueltig"
                )));
            }
            self.store
                .insert_interlocking(&template.id, &template.route_template_id, &canonical_json)
                .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}

struct PlatformIntervalsSeed<'transaction> {
    store: Store<'transaction>,
}

impl<'de> DeserializeSeed<'de> for PlatformIntervalsSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(PlatformIntervalsVisitor { store: self.store })
    }
}

struct PlatformIntervalsVisitor<'transaction> {
    store: Store<'transaction>,
}

impl<'de> Visitor<'de> for PlatformIntervalsVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine Karte typisierter Bahnsteigintervalle")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(platform_id) = map.next_key::<String>()? {
            let mut budget = RecordBudget::new();
            let (_, canonical_json) = canonical_typed::<TrackInterval>(
                map.next_value_seed(bounded_value_seed(&mut budget))?,
                "Operational-v2-Bahnsteigintervall",
            )
            .map_err(A::Error::custom)?;
            self.store
                .insert_platform(&platform_id, &canonical_json)
                .map_err(A::Error::custom)?;
        }
        Ok(())
    }
}

struct StringSetSeed<'transaction> {
    store: Store<'transaction>,
    kind: SetKind,
}

impl<'de> DeserializeSeed<'de> for StringSetSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(StringSetVisitor {
            store: self.store,
            kind: self.kind,
        })
    }
}

struct StringSetVisitor<'transaction> {
    store: Store<'transaction>,
    kind: SetKind,
}

impl<'de> Visitor<'de> for StringSetVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("eine kanonisch sortierte Zeichenkettenmenge")
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut previous: Option<String> = None;
        while let Some(value) = sequence.next_element::<String>()? {
            if value.is_empty()
                || previous
                    .as_ref()
                    .is_some_and(|previous| previous.as_bytes() >= value.as_bytes())
            {
                return Err(A::Error::custom(
                    "Operational-v2-Menge ist nicht in der kanonischen nativen Darstellung",
                ));
            }
            self.store
                .insert_set(self.kind, &value)
                .map_err(A::Error::custom)?;
            previous = Some(value);
        }
        Ok(())
    }
}

fn meta_value(transaction: &ReadTransaction, name: &str) -> Result<String> {
    let table = transaction.open_table(META).map_err(database_error)?;
    let value = table.get(name).map_err(database_error)?.ok_or_else(|| {
        OperationalStreamingError::new(format!("Operational-v2-Feld `{name}` fehlt"))
    })?;
    Ok(value.value().to_owned())
}

fn semantic_error(message: impl Into<String>) -> OperationalStreamingError {
    OperationalStreamingError::new(format!(
        "Statische Operational-v2-Infrastruktur verletzt den nativen Runtimevertrag: {}",
        message.into()
    ))
}

fn typed_record<T: DeserializeOwned>(serialized: &str, what: &str) -> Result<T> {
    serde_json::from_str(serialized).map_err(|error| {
        OperationalStreamingError::new(format!(
            "Temporaerer Operational-v2-Index enthaelt ungueltige {what}: {error}"
        ))
    })
}

fn validate_semantics(transaction: &ReadTransaction, expected_release_id: &str) -> Result<()> {
    require(
        meta_value(transaction, "id")? == expected_release_id,
        "Statische Operational-v2-Infrastruktur verletzt die InfraRelease-ID-Bindung.",
    )?;
    require(
        !meta_value(transaction, "rzueLayoutId")?.is_empty(),
        semantic_error("InfraRelease ist unvollstaendig"),
    )?;

    let directed_edges = transaction
        .open_table(DIRECTED_EDGES)
        .map_err(database_error)?;
    let geometry_meta = transaction
        .open_table(GEOMETRY_META)
        .map_err(database_error)?;
    let routes = transaction.open_table(ROUTES).map_err(database_error)?;
    let interlocking = transaction
        .open_table(INTERLOCKING)
        .map_err(database_error)?;
    let platforms = transaction.open_table(PLATFORMS).map_err(database_error)?;
    let signals = transaction.open_table(SIGNALS).map_err(database_error)?;
    let switches = transaction.open_table(SWITCHES).map_err(database_error)?;
    let block_resources = transaction
        .open_table(BLOCK_RESOURCES)
        .map_err(database_error)?;
    let routes_by_template = transaction
        .open_multimap_table(ROUTES_BY_TEMPLATE)
        .map_err(database_error)?;
    let interlocking_by_template = transaction
        .open_multimap_table(INTERLOCKING_BY_TEMPLATE)
        .map_err(database_error)?;

    require(
        !directed_edges.is_empty().map_err(database_error)?
            && !routes.is_empty().map_err(database_error)?
            && !interlocking.is_empty().map_err(database_error)?
            && !signals.is_empty().map_err(database_error)?
            && !block_resources.is_empty().map_err(database_error)?,
        semantic_error("InfraRelease ist unvollstaendig"),
    )?;
    require(
        directed_edges.len().map_err(database_error)?
            == geometry_meta.len().map_err(database_error)?,
        semantic_error("InfraRelease ist unvollstaendig"),
    )?;
    for entry in directed_edges.iter().map_err(database_error)? {
        let (edge_id, length_mm) = entry.map_err(database_error)?;
        let edge_id = edge_id.value();
        let geometry = geometry_meta
            .get(edge_id)
            .map_err(database_error)?
            .ok_or_else(|| semantic_error(format!("unbekannte Kante `{edge_id}`")))?;
        let (point_count, last_offset_mm) = geometry.value();
        if point_count < 2 || last_offset_mm != length_mm.value() {
            return Err(semantic_error(format!(
                "Kantengeometrie `{edge_id}` endet nicht an der Kantenlaenge"
            )));
        }
    }

    for entry in routes.iter().map_err(database_error)? {
        let (route_id, serialized) = entry.map_err(database_error)?;
        let route_id = route_id.value();
        let route: RouteVersion = typed_record(serialized.value(), "Laufwegversion")?;
        route
            .validate()
            .map_err(|error| semantic_error(error.to_string()))?;
        if route.id != route_id {
            return Err(semantic_error(format!(
                "Laufwegversion `{route_id}` besitzt eine abweichende ID"
            )));
        }
        let mut templates = interlocking_by_template
            .get(route.template_id.as_str())
            .map_err(database_error)?;
        if templates
            .next()
            .transpose()
            .map_err(database_error)?
            .is_none()
        {
            return Err(semantic_error(format!(
                "Laufwegversion `{route_id}` besitzt keine Fahrstrassenvorlage"
            )));
        }
        if let (Some(predecessor_id), Some(transition_route_mm)) =
            (&route.predecessor_id, route.transition_route_mm)
        {
            if predecessor_id == &route.id
                || routes
                    .get(predecessor_id.as_str())
                    .map_err(database_error)?
                    .is_none()
                || transition_route_mm < 0
                || transition_route_mm > route.length_mm()
            {
                return Err(semantic_error(format!(
                    "Laufwegversion `{route_id}` besitzt einen ungueltigen Vorgaenger"
                )));
            }
        }
        for leg in &route.legs {
            let edge_length = directed_edges
                .get(leg.edge_id.as_str())
                .map_err(database_error)?
                .ok_or_else(|| semantic_error(format!("unbekannte Kante `{}`", leg.edge_id)))?;
            if leg.edge_entry_mm < 0
                || leg.edge_exit_mm < 0
                || leg.edge_entry_mm > edge_length.value()
                || leg.edge_exit_mm > edge_length.value()
                || leg.block_ids.iter().any(|block_id| {
                    block_resources
                        .get(block_id.as_str())
                        .map_or(true, |value| value.is_none())
                })
            {
                return Err(semantic_error(format!(
                    "Laufwegversion `{route_id}` besitzt einen ungueltigen Kanten- oder Ressourcenbezug"
                )));
            }
        }
    }

    for entry in interlocking.iter().map_err(database_error)? {
        let (interlocking_id, serialized) = entry.map_err(database_error)?;
        let interlocking_id = interlocking_id.value();
        let template: InterlockingRouteTemplate =
            typed_record(serialized.value(), "Fahrstrassenvorlage")?;
        if template.id != interlocking_id
            || signals
                .get(template.signal_id.as_str())
                .map_err(database_error)?
                .is_none()
            || template.switch_positions.keys().any(|switch_id| {
                switches
                    .get(switch_id.as_str())
                    .map_or(true, |value| value.is_none())
            })
            || template
                .path_resources
                .iter()
                .chain(&template.overlap_resources)
                .chain(&template.flank_resources)
                .any(|resource_id| {
                    block_resources
                        .get(resource_id.as_str())
                        .map_or(true, |value| value.is_none())
                })
        {
            return Err(semantic_error(format!(
                "Fahrstrassenvorlage `{interlocking_id}` besitzt einen unbekannten Signal-, Weichen- oder Ressourcenbezug"
            )));
        }
        let matching_routes = routes_by_template
            .get(template.route_template_id.as_str())
            .map_err(database_error)?;
        let mut found_route = false;
        for route_id in matching_routes {
            found_route = true;
            let route_id = route_id.map_err(database_error)?;
            let route = routes
                .get(route_id.value())
                .map_err(database_error)?
                .ok_or_else(|| semantic_error("Laufwegindex ist unvollstaendig"))?;
            let route: RouteVersion = typed_record(route.value(), "Laufwegversion")?;
            if template.authority_end_route_mm > route.length_mm() {
                return Err(semantic_error(format!(
                    "Fahrstrassenvorlage `{interlocking_id}` ueberschreitet ihren Laufweg"
                )));
            }
        }
        if !found_route {
            return Err(semantic_error(format!(
                "Fahrstrassenvorlage `{interlocking_id}` besitzt keinen Laufweg"
            )));
        }
    }

    for entry in platforms.iter().map_err(database_error)? {
        let (platform_id, serialized) = entry.map_err(database_error)?;
        let platform_id = platform_id.value();
        let interval: TrackInterval = typed_record(serialized.value(), "Bahnsteigintervall")?;
        let edge_length = directed_edges
            .get(interval.edge_id.as_str())
            .map_err(database_error)?;
        if platform_id.is_empty()
            || edge_length.is_none()
            || interval.from_mm < 0
            || interval.from_mm >= interval.to_mm
            || interval.to_mm > edge_length.map_or(0, |length| length.value())
        {
            return Err(semantic_error(format!(
                "Bahnsteigintervall `{platform_id}` ist ungueltig"
            )));
        }
    }
    Ok(())
}

struct CanonicalSink {
    writer: Option<BufWriter<File>>,
    artifact_hasher: Sha256,
    state_hasher: Sha256,
    artifact_bytes: u64,
}

struct CanonicalHashes {
    artifact_bytes: u64,
    artifact_sha256: String,
    state_hash: String,
}

impl CanonicalSink {
    fn new(writer: Option<BufWriter<File>>) -> Self {
        let mut state_hasher = Sha256::new();
        state_hasher.update(format!("{{\"schema\":\"{SCHEMA}\",\"value\":").as_bytes());
        Self {
            writer,
            artifact_hasher: Sha256::new(),
            state_hasher,
            artifact_bytes: 0,
        }
    }

    fn payload(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.artifact_hasher.update(bytes);
        self.state_hasher.update(bytes);
        self.artifact_bytes = self
            .artifact_bytes
            .checked_add(u64::try_from(bytes.len()).map_err(io::Error::other)?)
            .ok_or_else(|| io::Error::other("kanonische Artefaktgroesse laeuft ueber"))?;
        if let Some(writer) = &mut self.writer {
            writer.write_all(bytes)?;
        }
        Ok(())
    }

    fn finish(mut self) -> io::Result<CanonicalHashes> {
        self.state_hasher.update(b"}");
        self.artifact_hasher.update(b"\n");
        self.artifact_bytes = self
            .artifact_bytes
            .checked_add(1)
            .ok_or_else(|| io::Error::other("kanonische Artefaktgroesse laeuft ueber"))?;
        if let Some(writer) = &mut self.writer {
            writer.write_all(b"\n")?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        Ok(CanonicalHashes {
            artifact_bytes: self.artifact_bytes,
            artifact_sha256: digest_hex(self.artifact_hasher.finalize()),
            state_hash: digest_hex(self.state_hasher.finalize()),
        })
    }
}

fn sink_error(error: io::Error) -> OperationalStreamingError {
    OperationalStreamingError::new(format!(
        "Kanonische Operational-v2-Ausgabe ist fehlgeschlagen: {error}"
    ))
}

fn json_string(value: &str) -> Result<String> {
    serde_json::to_string(value).map_err(|error| {
        OperationalStreamingError::new(format!(
            "Operational-v2-Zeichenkette kann nicht kanonisiert werden: {error}"
        ))
    })
}

fn write_string_set(
    transaction: &ReadTransaction,
    sink: &mut CanonicalSink,
    definition: TableDefinition<&str, ()>,
) -> Result<()> {
    let table = transaction.open_table(definition).map_err(database_error)?;
    sink.payload(b"[").map_err(sink_error)?;
    let mut first = true;
    for entry in table.iter().map_err(database_error)? {
        let (value, _) = entry.map_err(database_error)?;
        if !first {
            sink.payload(b",").map_err(sink_error)?;
        }
        first = false;
        sink.payload(json_string(value.value())?.as_bytes())
            .map_err(sink_error)?;
    }
    sink.payload(b"]").map_err(sink_error)
}

fn write_canonical_map(
    transaction: &ReadTransaction,
    sink: &mut CanonicalSink,
    definition: TableDefinition<&str, &str>,
) -> Result<()> {
    let table = transaction.open_table(definition).map_err(database_error)?;
    sink.payload(b"{").map_err(sink_error)?;
    let mut first = true;
    for entry in table.iter().map_err(database_error)? {
        let (key, value) = entry.map_err(database_error)?;
        if !first {
            sink.payload(b",").map_err(sink_error)?;
        }
        first = false;
        sink.payload(json_string(key.value())?.as_bytes())
            .and_then(|()| sink.payload(b":"))
            .and_then(|()| sink.payload(value.value().as_bytes()))
            .map_err(sink_error)?;
    }
    sink.payload(b"}").map_err(sink_error)
}

fn write_directed_edges(transaction: &ReadTransaction, sink: &mut CanonicalSink) -> Result<()> {
    let table = transaction
        .open_table(DIRECTED_EDGES)
        .map_err(database_error)?;
    sink.payload(b"{").map_err(sink_error)?;
    let mut first = true;
    for entry in table.iter().map_err(database_error)? {
        let (edge_id, length_mm) = entry.map_err(database_error)?;
        if !first {
            sink.payload(b",").map_err(sink_error)?;
        }
        first = false;
        sink.payload(json_string(edge_id.value())?.as_bytes())
            .and_then(|()| sink.payload(b":"))
            .and_then(|()| sink.payload(length_mm.value().to_string().as_bytes()))
            .map_err(sink_error)?;
    }
    sink.payload(b"}").map_err(sink_error)
}

fn write_edge_geometries(transaction: &ReadTransaction, sink: &mut CanonicalSink) -> Result<()> {
    let table = transaction
        .open_table(GEOMETRY_POINTS)
        .map_err(database_error)?;
    sink.payload(b"{").map_err(sink_error)?;
    let mut current_edge: Option<String> = None;
    let mut first_edge = true;
    let mut first_point = true;
    for entry in table.iter().map_err(database_error)? {
        let (key, canonical_point) = entry.map_err(database_error)?;
        let (edge_id, _) = key.value();
        if current_edge.as_deref() != Some(edge_id) {
            if current_edge.is_some() {
                sink.payload(b"]").map_err(sink_error)?;
            }
            if !first_edge {
                sink.payload(b",").map_err(sink_error)?;
            }
            first_edge = false;
            sink.payload(json_string(edge_id)?.as_bytes())
                .and_then(|()| sink.payload(b":["))
                .map_err(sink_error)?;
            current_edge = Some(edge_id.to_owned());
            first_point = true;
        }
        if !first_point {
            sink.payload(b",").map_err(sink_error)?;
        }
        first_point = false;
        sink.payload(canonical_point.value().as_bytes())
            .map_err(sink_error)?;
    }
    if current_edge.is_some() {
        sink.payload(b"]").map_err(sink_error)?;
    }
    sink.payload(b"}").map_err(sink_error)
}

fn write_canonical_payload(transaction: &ReadTransaction, sink: &mut CanonicalSink) -> Result<()> {
    sink.payload(b"{\"blockResources\":").map_err(sink_error)?;
    write_string_set(transaction, sink, BLOCK_RESOURCES)?;
    sink.payload(b",\"directedEdges\":").map_err(sink_error)?;
    write_directed_edges(transaction, sink)?;
    sink.payload(b",\"edgeGeometries\":").map_err(sink_error)?;
    write_edge_geometries(transaction, sink)?;
    sink.payload(b",\"id\":").map_err(sink_error)?;
    sink.payload(json_string(&meta_value(transaction, "id")?)?.as_bytes())
        .map_err(sink_error)?;
    sink.payload(b",\"interlockingRoutes\":")
        .map_err(sink_error)?;
    write_canonical_map(transaction, sink, INTERLOCKING)?;
    sink.payload(b",\"platformIntervals\":")
        .map_err(sink_error)?;
    write_canonical_map(transaction, sink, PLATFORMS)?;
    sink.payload(b",\"regionBoundaries\":")
        .map_err(sink_error)?;
    write_string_set(transaction, sink, REGION_BOUNDARIES)?;
    sink.payload(b",\"routeVersions\":").map_err(sink_error)?;
    write_canonical_map(transaction, sink, ROUTES)?;
    sink.payload(b",\"rzueLayoutId\":").map_err(sink_error)?;
    sink.payload(json_string(&meta_value(transaction, "rzueLayoutId")?)?.as_bytes())
        .map_err(sink_error)?;
    sink.payload(b",\"signals\":").map_err(sink_error)?;
    write_string_set(transaction, sink, SIGNALS)?;
    sink.payload(b",\"switches\":").map_err(sink_error)?;
    write_string_set(transaction, sink, SWITCHES)?;
    sink.payload(b"}").map_err(sink_error)
}

fn canonical_hashes(
    transaction: &ReadTransaction,
    output_path: Option<&Path>,
) -> Result<CanonicalHashes> {
    let writer = if let Some(path) = output_path {
        Some(BufWriter::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|error| io_error("Kanonische Operational-v2-Ausgabe", path, error))?,
        ))
    } else {
        None
    };
    let created_output = output_path.is_some();
    let result = (|| {
        let mut sink = CanonicalSink::new(writer);
        write_canonical_payload(transaction, &mut sink)?;
        sink.finish().map_err(sink_error)
    })();
    if result.is_err() && created_output {
        if let Some(path) = output_path {
            let _ = fs::remove_file(path);
        }
    }
    result
}

/// Validiert einen Operational-v2-Korpus ohne Voll-Deserialize und liefert
/// getrennte Bindungen fuer Quellbytes, kanonische Artefaktbytes und Zustand.
///
/// Ist `output_path` gesetzt, wird die kanonische JSON-Darstellung mit
/// abschliessendem Zeilenumbruch mittels `create_new` materialisiert.
pub fn validate_operational_infrastructure_v2_file(
    candidate_path: &Path,
    expected_release_id: &str,
    output_path: Option<&Path>,
) -> Result<Value> {
    require(
        !expected_release_id.trim().is_empty(),
        "Erwartete InfraRelease-ID fehlt.",
    )?;
    let link_metadata = fs::symlink_metadata(candidate_path)
        .map_err(|error| io_error("Operational-v2-Candidate", candidate_path, error))?;
    require(
        link_metadata.file_type().is_file() && !link_metadata.file_type().is_symlink(),
        "Operational-v2-Candidate ist keine regulaere, symlinkfreie Datei.",
    )?;
    let file = File::open(candidate_path)
        .map_err(|error| io_error("Operational-v2-Candidate", candidate_path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("Operational-v2-Candidate-Metadaten", candidate_path, error))?;
    require(
        metadata.is_file() && metadata.len() > 0,
        "Operational-v2-Candidate ist keine nichtleere regulaere Datei.",
    )?;
    require(
        metadata.len() <= u64::try_from(MAX_SAFE_INTEGER).expect("MAX_SAFE_INTEGER ist positiv"),
        "Operational-v2-Candidate ist fuer einen kanonischen JSON-Beleg zu gross.",
    )?;

    let scratch = ScratchDirectory::create()?;
    let mut builder = Database::builder();
    builder.set_cache_size(DATABASE_CACHE_BYTES);
    let database = builder
        .create(scratch.database_path())
        .map_err(database_error)?;
    let mut write_transaction = database.begin_write().map_err(database_error)?;
    write_transaction.set_durability(Durability::None);
    let store = Store {
        transaction: &write_transaction,
    };
    store.initialize().map_err(OperationalStreamingError::new)?;

    let mut reader = HashingReader::new(BufReader::new(file));
    {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        RootSeed { store }
            .deserialize(&mut deserializer)
            .map_err(|error| {
                OperationalStreamingError::new(format!(
                    "Statische Operational-v2-Infrastruktur ist ungueltig: {error}"
                ))
            })?;
        deserializer.end().map_err(|error| {
            OperationalStreamingError::new(format!(
                "Statische Operational-v2-Infrastruktur besitzt ungueltigen Nachlauf: {error}"
            ))
        })?;
    }
    let (source_bytes, source_sha256) = reader.finish();
    require(
        source_bytes == metadata.len(),
        "Operational-v2-Candidate aenderte seine Groesse waehrend der Validierung.",
    )?;
    write_transaction.commit().map_err(database_error)?;

    let read_transaction = database.begin_read().map_err(database_error)?;
    validate_semantics(&read_transaction, expected_release_id)?;
    let hashes = canonical_hashes(&read_transaction, output_path)?;
    require(
        hashes.artifact_bytes
            <= u64::try_from(MAX_SAFE_INTEGER).expect("MAX_SAFE_INTEGER ist positiv"),
        "Kanonisches Operational-v2-Artefakt ist fuer einen JSON-Beleg zu gross.",
    )?;
    require(
        hashes.artifact_sha256 != hashes.state_hash,
        "Byte-SHA-256 und kanonischer Operational-v2-Zustandshash wurden gleichgesetzt.",
    )?;

    Ok(json!({
        "schema": SCHEMA,
        "infraReleaseId": expected_release_id,
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
        "bytes": hashes.artifact_bytes,
        "sha256": hashes.artifact_sha256,
        "stateHash": hashes.state_hash,
        "validationMode": "native-streaming-redb-v1",
    }))
}

/// Prozesslebenslang an die validierten Quellbytes gebundener, dateibasierter
/// Runtime-Store. Der redb-Index liegt in einem atomar neu angelegten,
/// eindeutigen Verzeichnis und wird niemals aus einem fremden Lauf uebernommen.
/// Dadurch bleibt der Heap unabhaengig von der Groesse des Deutschland-Korpus.
pub struct OperationalInfrastructureV2Store {
    // Felder werden in Deklarationsreihenfolge verworfen: erst die Datenbank,
    // danach ihr eindeutig besessenes Verzeichnis.
    database: Database,
    scratch: ScratchDirectory,
    source_path: PathBuf,
    source_bytes: u64,
    source_modified: std::time::SystemTime,
    release_id: String,
    source_sha256: String,
    state_hash: String,
}

impl fmt::Debug for OperationalInfrastructureV2Store {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OperationalInfrastructureV2Store")
            .field("release_id", &self.release_id)
            .field("state_hash", &self.state_hash)
            .field("source_bytes", &self.source_bytes)
            .field("source_path", &self.source_path)
            .field("index_path", &self.scratch.database_path())
            .finish_non_exhaustive()
    }
}

fn runtime_access_error(error: impl fmt::Display) -> OperationalError {
    OperationalError::InfrastructureAccess(error.to_string())
}

fn require_sha256(value: &str, what: &str) -> Result<()> {
    require(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        format!("{what} ist kein kanonischer SHA-256."),
    )
}

/// Validiert die vollstaendige kompakte Bindung und materialisiert daraus
/// einmalig einen kleinen dateibasierten Runtime-Index. Das Quellartefakt muss
/// bereits exakt die kanonische signierte Darstellung sein.
pub fn open_operational_infrastructure_v2_store(
    candidate_path: &Path,
    expected_release_id: &str,
    expected_bytes: u64,
    expected_sha256: &str,
    expected_state_hash: &str,
) -> Result<OperationalInfrastructureV2Store> {
    require(
        candidate_path.is_absolute(),
        "Operational-v2-Runtimepfad ist nicht absolut aufgeloest.",
    )?;
    require(
        !expected_release_id.trim().is_empty(),
        "Erwartete InfraRelease-ID fehlt.",
    )?;
    require(expected_bytes > 0, "Operational-v2-Bytebindung fehlt.")?;
    require_sha256(expected_sha256, "Operational-v2-Bytebindung")?;
    require_sha256(expected_state_hash, "Operational-v2-Zustandsbindung")?;
    require(
        expected_sha256 != expected_state_hash,
        "Byte-SHA-256 und Operational-v2-Zustandshash wurden gleichgesetzt.",
    )?;

    let link_metadata = fs::symlink_metadata(candidate_path)
        .map_err(|error| io_error("Operational-v2-Runtimeartefakt", candidate_path, error))?;
    require(
        link_metadata.file_type().is_file() && !link_metadata.file_type().is_symlink(),
        "Operational-v2-Runtimeartefakt ist keine regulaere, symlinkfreie Datei.",
    )?;
    let source_modified = link_metadata.modified().map_err(|error| {
        io_error(
            "Operational-v2-Runtimeartefakt-Metadaten",
            candidate_path,
            error,
        )
    })?;
    let file = File::open(candidate_path)
        .map_err(|error| io_error("Operational-v2-Runtimeartefakt", candidate_path, error))?;
    let metadata = file.metadata().map_err(|error| {
        io_error(
            "Operational-v2-Runtimeartefakt-Metadaten",
            candidate_path,
            error,
        )
    })?;
    require(
        metadata.is_file() && metadata.len() == expected_bytes,
        "Operational-v2-Runtimeartefakt verletzt die Bytebindung.",
    )?;

    let scratch = ScratchDirectory::create()?;
    let mut builder = Database::builder();
    builder.set_cache_size(DATABASE_CACHE_BYTES);
    let database = builder
        .create(scratch.database_path())
        .map_err(database_error)?;
    let mut write_transaction = database.begin_write().map_err(database_error)?;
    write_transaction.set_durability(Durability::None);
    let store = Store {
        transaction: &write_transaction,
    };
    store.initialize().map_err(OperationalStreamingError::new)?;

    let mut reader = HashingReader::new(BufReader::new(file));
    {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        RootSeed { store }
            .deserialize(&mut deserializer)
            .map_err(|error| {
                OperationalStreamingError::new(format!(
                    "Statische Operational-v2-Infrastruktur ist ungueltig: {error}"
                ))
            })?;
        deserializer.end().map_err(|error| {
            OperationalStreamingError::new(format!(
                "Statische Operational-v2-Infrastruktur besitzt ungueltigen Nachlauf: {error}"
            ))
        })?;
    }
    let (source_bytes, source_sha256) = reader.finish();
    require(
        source_bytes == expected_bytes && source_sha256 == expected_sha256,
        "Operational-v2-Runtimeartefakt verletzt seine signierte Byte-/SHA-256-Bindung.",
    )?;
    write_transaction.commit().map_err(database_error)?;

    let read_transaction = database.begin_read().map_err(database_error)?;
    validate_semantics(&read_transaction, expected_release_id)?;
    let hashes = canonical_hashes(&read_transaction, None)?;
    require(
        hashes.artifact_bytes == source_bytes && hashes.artifact_sha256 == source_sha256,
        "Operational-v2-Runtimeartefakt ist nicht exakt die kanonische signierte Darstellung.",
    )?;
    require(
        hashes.state_hash == expected_state_hash,
        "Operational-v2-Runtimeartefakt verletzt seine signierte Zustandshash-Bindung.",
    )?;
    drop(read_transaction);

    let mut binding_transaction = database.begin_write().map_err(database_error)?;
    binding_transaction.set_durability(Durability::Immediate);
    let binding_store = Store {
        transaction: &binding_transaction,
    };
    binding_store
        .insert_meta("runtimeIndexFormat", "operational-runtime-redb/v1")
        .map_err(OperationalStreamingError::new)?;
    binding_store
        .insert_meta("runtimeSourceBytes", &source_bytes.to_string())
        .map_err(OperationalStreamingError::new)?;
    binding_store
        .insert_meta("runtimeSourceSha256", &source_sha256)
        .map_err(OperationalStreamingError::new)?;
    binding_store
        .insert_meta("runtimeStateHash", &hashes.state_hash)
        .map_err(OperationalStreamingError::new)?;
    binding_transaction.commit().map_err(database_error)?;

    Ok(OperationalInfrastructureV2Store {
        database,
        scratch,
        source_path: candidate_path.to_path_buf(),
        source_bytes,
        source_modified,
        release_id: expected_release_id.to_owned(),
        source_sha256,
        state_hash: expected_state_hash.to_owned(),
    })
}

impl OperationalInfrastructureV2Store {
    fn read_meta(&self, name: &str) -> std::result::Result<String, OperationalError> {
        let transaction = self.database.begin_read().map_err(runtime_access_error)?;
        meta_value(&transaction, name).map_err(runtime_access_error)
    }

    fn read_typed<T: DeserializeOwned>(
        &self,
        definition: TableDefinition<'static, &'static str, &'static str>,
        id: &str,
        what: &str,
    ) -> std::result::Result<Option<T>, OperationalError> {
        let transaction = self.database.begin_read().map_err(runtime_access_error)?;
        let table = transaction
            .open_table(definition)
            .map_err(runtime_access_error)?;
        let serialized = table
            .get(id)
            .map_err(runtime_access_error)?
            .map(|value| value.value().to_owned());
        serialized
            .map(|serialized| typed_record(&serialized, what).map_err(runtime_access_error))
            .transpose()
    }
}

impl OperationalInfrastructure for OperationalInfrastructureV2Store {
    fn release_id(&self) -> &str {
        &self.release_id
    }

    fn binding_identity(&self) -> &str {
        &self.state_hash
    }

    fn validate_attachment(&self) -> std::result::Result<(), OperationalError> {
        let metadata = fs::symlink_metadata(&self.source_path).map_err(runtime_access_error)?;
        if !metadata.file_type().is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != self.source_bytes
            || metadata.modified().map_err(runtime_access_error)? != self.source_modified
            || self.read_meta("runtimeIndexFormat")? != "operational-runtime-redb/v1"
            || self.read_meta("runtimeSourceBytes")? != self.source_bytes.to_string()
            || self.read_meta("runtimeSourceSha256")? != self.source_sha256
            || self.read_meta("runtimeStateHash")? != self.state_hash
            || self.read_meta("id")? != self.release_id
        {
            return Err(OperationalError::ForeignInfrastructureBinding);
        }
        Ok(())
    }

    fn route_version(
        &self,
        id: &str,
    ) -> std::result::Result<Option<RouteVersion>, OperationalError> {
        self.read_typed(ROUTES, id, "Laufwegversion")
    }

    fn interlocking_route(
        &self,
        id: &str,
    ) -> std::result::Result<Option<InterlockingRouteTemplate>, OperationalError> {
        self.read_typed(INTERLOCKING, id, "Fahrstrassenvorlage")
    }

    fn shunting_interlocking_routes(
        &self,
        minimum_authority_end_route_mm: RouteMillimetres,
    ) -> std::result::Result<Vec<InterlockingRouteTemplate>, OperationalError> {
        let transaction = self.database.begin_read().map_err(runtime_access_error)?;
        let table = transaction
            .open_table(INTERLOCKING)
            .map_err(runtime_access_error)?;
        let mut result = Vec::new();
        for entry in table.iter().map_err(runtime_access_error)? {
            let (_, serialized) = entry.map_err(runtime_access_error)?;
            let route: InterlockingRouteTemplate =
                typed_record(serialized.value(), "Fahrstrassenvorlage")
                    .map_err(runtime_access_error)?;
            if route.movement_kind == MovementKind::Shunting
                && route.authority_end_route_mm >= minimum_authority_end_route_mm
            {
                result.push(route);
            }
        }
        Ok(result)
    }

    fn platform_interval(
        &self,
        id: &str,
    ) -> std::result::Result<Option<TrackInterval>, OperationalError> {
        self.read_typed(PLATFORMS, id, "Bahnsteigintervall")
    }

    fn edge_geometry(
        &self,
        edge_id: &str,
    ) -> std::result::Result<Option<Vec<EdgeGeometryPoint>>, OperationalError> {
        let transaction = self.database.begin_read().map_err(runtime_access_error)?;
        let meta = transaction
            .open_table(GEOMETRY_META)
            .map_err(runtime_access_error)?;
        let Some((point_count, _)) = meta
            .get(edge_id)
            .map_err(runtime_access_error)?
            .map(|value| value.value())
        else {
            return Ok(None);
        };
        let points = transaction
            .open_table(GEOMETRY_POINTS)
            .map_err(runtime_access_error)?;
        let mut result =
            Vec::with_capacity(usize::try_from(point_count).map_err(runtime_access_error)?);
        for position in 0..point_count {
            let serialized = points
                .get((edge_id, position))
                .map_err(runtime_access_error)?
                .ok_or_else(|| {
                    runtime_access_error(format!(
                        "Operational-v2-Geometrieindex `{edge_id}:{position}` fehlt"
                    ))
                })?;
            result.push(
                typed_record(serialized.value(), "Kantengeometriepunkt")
                    .map_err(runtime_access_error)?,
            );
        }
        Ok(Some(result))
    }
}
