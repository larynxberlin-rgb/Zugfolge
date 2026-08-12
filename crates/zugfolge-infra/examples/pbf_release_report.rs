//! Fuehrt die echte PBF-Import- und EBO-Filterstufe fuer ein Releaseartefakt aus.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::File;
use std::io::{BufReader, BufWriter};

use serde_json::json;
use sha2::{Digest, Sha256};
use zugfolge_infra::{RawGraph, SourceId, filter_network, import_pbf};

fn digest(value: &[serde_json::Value]) -> Result<String, serde_json::Error> {
    let encoded = serde_json::to_vec(value)?;
    let hash = Sha256::digest(encoded);
    Ok(hash.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn edge_quality(tags: &BTreeMap<String, String>) -> &'static str {
    let complete = tags
        .get("maxspeed")
        .is_some_and(|value| !value.trim().is_empty())
        && tags
            .get("electrified")
            .is_some_and(|value| !value.trim().is_empty())
        && (tags
            .get("usage")
            .is_some_and(|value| !value.trim().is_empty())
            || tags
                .get("service")
                .is_some_and(|value| !value.trim().is_empty()));
    if complete && tags.get("zugfolge:validated").map(String::as_str) == Some("yes") {
        "A"
    } else if complete {
        "B"
    } else {
        "C"
    }
}

fn integer_sqrt(value: i128) -> i128 {
    if value <= 1 {
        return value;
    }
    let mut estimate = value;
    loop {
        let next = (estimate + value / estimate) / 2;
        if next >= estimate {
            return estimate;
        }
        estimate = next;
    }
}

fn coordinate_distance_mm(
    left: zugfolge_infra::Coordinate,
    right: zugfolge_infra::Coordinate,
) -> i64 {
    let latitude = (i128::from(left.latitude_e7()) - i128::from(right.latitude_e7())) * 11_132;
    let longitude = (i128::from(left.longitude_e7()) - i128::from(right.longitude_e7())) * 6_999;
    let micro_mm = integer_sqrt(latitude * latitude + longitude * longitude);
    i64::try_from((micro_mm + 500) / 1_000).unwrap_or(i64::MAX)
}

fn components(graph: &RawGraph) -> usize {
    let mut neighbours: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    for edge in graph.edges() {
        neighbours
            .entry(edge.from().value())
            .or_default()
            .insert(edge.to().value());
        neighbours
            .entry(edge.to().value())
            .or_default()
            .insert(edge.from().value());
    }
    let mut unseen: BTreeSet<i64> = neighbours.keys().copied().collect();
    let mut count = 0_usize;
    while let Some(start) = unseen.pop_first() {
        count += 1;
        let mut queue = VecDeque::from([start]);
        while let Some(node) = queue.pop_front() {
            if let Some(adjacent) = neighbours.get(&node) {
                for next in adjacent {
                    if unseen.remove(next) {
                        queue.push_back(*next);
                    }
                }
            }
        }
    }
    count
}

fn quality(graph: &RawGraph) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::from([("A", 0_usize), ("B", 0_usize), ("C", 0_usize)]);
    for edge in graph.edges() {
        let tags = edge.tags();
        let class = edge_quality(tags);
        *counts.entry(class).or_default() += 1;
    }
    counts
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let input = arguments
        .next()
        .ok_or("usage: pbf_release_report INPUT.pbf SOURCE_ID OUTPUT.json")?;
    let source_id = arguments.next().ok_or("source id fehlt")?;
    let output = arguments.next().ok_or("output path fehlt")?;
    if arguments.next().is_some() {
        return Err("zu viele Argumente".into());
    }

    let source = SourceId::new(source_id)?;
    let mut reader = BufReader::new(File::open(&input)?);
    let raw = import_pbf(&mut reader, source)?;
    let filtered = filter_network(&raw);
    let ebo = filtered.graph();

    let mut exclusion_counts: BTreeMap<String, usize> = BTreeMap::new();
    for (_, reason) in filtered.exclusions() {
        *exclusion_counts.entry(reason.to_string()).or_default() += 1;
    }
    let signal_nodes = ebo
        .nodes()
        .filter(|node| {
            node.tags()
                .get("railway")
                .is_some_and(|value| value == "signal")
                || node
                    .tags()
                    .keys()
                    .any(|key| key.starts_with("railway:signal:"))
        })
        .count();
    let switch_nodes = ebo
        .nodes()
        .filter(|node| node.tags().get("railway").map(String::as_str) == Some("switch"))
        .count();

    let signal_node_ids: BTreeSet<i64> = ebo
        .nodes()
        .filter(|node| {
            node.tags()
                .get("railway")
                .is_some_and(|value| value == "signal")
                || node
                    .tags()
                    .keys()
                    .any(|key| key.starts_with("railway:signal:"))
        })
        .map(|node| node.id().value())
        .collect();
    let switch_node_ids: BTreeSet<i64> = ebo
        .nodes()
        .filter(|node| node.tags().get("railway").map(String::as_str) == Some("switch"))
        .map(|node| node.id().value())
        .collect();
    let mut incident_edges: BTreeMap<i64, Vec<(u64, String)>> = BTreeMap::new();
    let mut blocks = Vec::with_capacity(ebo.edge_count());
    for edge in ebo.edges() {
        let class = edge_quality(edge.tags());
        let length_mm: i64 = edge
            .geometry()
            .windows(2)
            .map(|pair| coordinate_distance_mm(pair[0], pair[1]))
            .sum();
        let edge_id = edge.id().value();
        incident_edges
            .entry(edge.from().value())
            .or_default()
            .push((edge_id, class.to_owned()));
        incident_edges
            .entry(edge.to().value())
            .or_default()
            .push((edge_id, class.to_owned()));
        blocks.push(json!({
            "blockId": format!("osm-block-e{edge_id}"),
            "edgeId": edge_id,
            "sourceWayId": edge.way().value(),
            "fromNodeId": edge.from().value(),
            "toNodeId": edge.to().value(),
            "lengthMm": length_mm,
            "boundarySignalCount": usize::from(signal_node_ids.contains(&edge.from().value()))
                + usize::from(signal_node_ids.contains(&edge.to().value())),
            "qualityClass": class,
            "orderable": class != "C",
        }));
    }
    let mut interlocking_routes = Vec::new();
    for node_id in switch_node_ids {
        let mut edges = incident_edges.remove(&node_id).unwrap_or_default();
        edges.sort_by_key(|(edge_id, _)| *edge_id);
        edges.dedup_by_key(|(edge_id, _)| *edge_id);
        let conflict_edge_ids: Vec<u64> = edges.iter().map(|(edge_id, _)| *edge_id).collect();
        let class = if edges.iter().all(|(_, quality)| quality != "C") {
            "B"
        } else {
            "C"
        };
        for origin in &edges {
            for destination in &edges {
                if origin.0 == destination.0 {
                    continue;
                }
                interlocking_routes.push(json!({
                    "routeId": format!("osm-route-n{node_id}-e{}-e{}", origin.0, destination.0),
                    "switchNodeId": node_id,
                    "originEdgeId": origin.0,
                    "destinationEdgeId": destination.0,
                    "conflictEdgeIds": conflict_edge_ids,
                    "qualityClass": class,
                    "orderable": class != "C",
                }));
            }
        }
    }
    let block_hash = digest(&blocks)?;
    let interlocking_hash = digest(&interlocking_routes)?;
    let block_count = blocks.len();
    let interlocking_route_count = interlocking_routes.len();

    let report = json!({
        "schema": "zugfolge-pbf-release-report/v1",
        "sourceId": ebo.source().as_str(),
        "raw": {
            "nodes": raw.node_count(),
            "edges": raw.edge_count(),
            "checksum": raw.checksum(),
        },
        "eboFilter": {
            "nodes": ebo.node_count(),
            "edges": ebo.edge_count(),
            "checksum": ebo.checksum(),
            "excludedEdges": filtered.exclusions().len(),
            "exclusionCounts": exclusion_counts,
        },
        "topology": {
            "connectedComponents": components(ebo),
            "signalNodes": signal_nodes,
            "switchNodes": switch_nodes,
            "conservativeConflictResources": ebo.edge_count(),
        },
        "derivations": {
            "policy": "OSM-Kanten enden an betrieblich bedeutsamen Punkten. Sie bilden konservative Blockressourcen; Fahrstrassen durch Weichenknoten sperren alle inzidenten Kanten.",
            "blocksHash": block_hash.clone(),
            "interlockingRoutesHash": interlocking_hash.clone(),
            "blocks": blocks,
            "interlockingRoutes": interlocking_routes,
        },
        "quality": {
            "classes": quality(ebo),
            "classCOrderable": false,
        },
    });
    serde_json::to_writer_pretty(BufWriter::new(File::create(&output)?), &report)?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "rawNodes": raw.node_count(),
            "rawEdges": raw.edge_count(),
            "eboNodes": ebo.node_count(),
            "eboEdges": ebo.edge_count(),
            "blockCount": block_count,
            "interlockingRouteCount": interlocking_route_count,
            "blocksHash": block_hash,
            "interlockingRoutesHash": interlocking_hash,
        }))?
    );
    Ok(())
}
