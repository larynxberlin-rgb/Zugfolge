//! Der Rohgraph — Topologie, Geometrie und Tags aus einem OSM-PBF-Extract.
//!
//! **M1.2.** Ein OSM-Weg ist keine Kante: Er trägt hunderte Stützpunkte, von
//! denen die meisten nichts als die Kurvenform beschreiben. Der Rohgraph
//! trennt beides — er macht aus jedem betrieblich bedeutsamen Punkt einen
//! [`RawNode`] und aus dem Wegstück dazwischen eine [`RawEdge`] mit ihrer
//! vollen Geometrie. Das ist bewusst noch nicht der Betriebsgraph aus M1.1:
//! Welcher Punkt ein Bahnhof, welcher eine Blockstelle wird, entscheiden
//! Netzfilter (M1.3) und Fahrstraßenableitung (M1.7), nicht der Import.
//!
//! **Wann ein Knoten bedeutsam wird.** Ein Knoten wird zum eigenen
//! [`RawNode`] — statt nur ein Punkt auf der Kurve einer [`RawEdge`] zu
//! bleiben —, wenn mindestens eines gilt:
//!
//! - er ist Anfang oder Ende eines Wegs (jeder Weg endet irgendwo, und sei es
//!   im Nirgendwo eines Prellbocks),
//! - er verbindet zwei oder mehr Wege (eine Verzweigung),
//! - er trägt selbst einen `railway`-Tag (eine Weiche, ein Prellbock, eine
//!   Blockkennzeichnung — betrieblich bedeutsam, auch wenn nur ein Weg ihn
//!   berührt).
//!
//! Alle anderen Knoten liefern nur ihre Koordinate zur Geometrie ihrer Kante.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::import::element::{OsmNode, OsmNodeId, OsmWay, OsmWayId};
use crate::import::error::ImportError;
use crate::operating_point::Coordinate;
use crate::provenance::SourceId;

/// Kennung einer [`RawEdge`] — vergeben in der Reihenfolge, in der Wege
/// (aufsteigend nach ihrer OSM-Kennung) und ihre Abschnitte gebildet werden.
/// Das macht die Vergabe unabhängig davon, in welcher Reihenfolge der
/// Extract seine Blöcke schreibt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RawEdgeId(u64);

impl RawEdgeId {
    const fn new(value: u64) -> Self {
        Self(value)
    }

    /// Die laufende Nummer.
    pub const fn value(self) -> u64 {
        self.0
    }
}

impl fmt::Display for RawEdgeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "e{}", self.0)
    }
}

/// Ein betrieblich bedeutsamer Punkt des Rohgraphen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawNode {
    id: OsmNodeId,
    coordinate: Coordinate,
    tags: BTreeMap<String, String>,
}

impl RawNode {
    /// Die OSM-Kennung, aus der der Knoten entstand.
    pub const fn id(&self) -> OsmNodeId {
        self.id
    }

    /// Die Lage.
    pub const fn coordinate(&self) -> Coordinate {
        self.coordinate
    }

    /// Die OSM-Tags dieses Knotens, unverändert aus dem Extract.
    pub const fn tags(&self) -> &BTreeMap<String, String> {
        &self.tags
    }
}

/// Ein Wegabschnitt zwischen zwei bedeutsamen Knoten.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawEdge {
    id: RawEdgeId,
    way: OsmWayId,
    from: OsmNodeId,
    to: OsmNodeId,
    geometry: Vec<Coordinate>,
    tags: BTreeMap<String, String>,
}

impl RawEdge {
    /// Die Kennung innerhalb dieses Rohgraphen.
    pub const fn id(&self) -> RawEdgeId {
        self.id
    }

    /// Der OSM-Weg, aus dem dieser Abschnitt stammt.
    pub const fn way(&self) -> OsmWayId {
        self.way
    }

    /// Der Startknoten, in Richtung der OSM-Knotenfolge des Wegs.
    pub const fn from(&self) -> OsmNodeId {
        self.from
    }

    /// Der Zielknoten.
    pub const fn to(&self) -> OsmNodeId {
        self.to
    }

    /// Der volle Streckenverlauf, einschließlich beider Endpunkte —
    /// mindestens zwei Punkte.
    pub fn geometry(&self) -> &[Coordinate] {
        &self.geometry
    }

    /// Die OSM-Tags des Wegs, unverändert aus dem Extract.
    pub const fn tags(&self) -> &BTreeMap<String, String> {
        &self.tags
    }
}

/// Topologie, Geometrie und Tags eines OSM-PBF-Extracts — das Ergebnis von
/// M1.2. Noch kein Betriebsgraph: Was zum EBO-Netz gehört, entscheidet erst
/// der Netzfilter (M1.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawGraph {
    source: SourceId,
    nodes: BTreeMap<OsmNodeId, RawNode>,
    edges: Vec<RawEdge>,
}

impl RawGraph {
    /// Die Quelle, aus der dieser Rohgraph importiert wurde.
    pub const fn source(&self) -> &SourceId {
        &self.source
    }

    /// Die bedeutsamen Knoten, aufsteigend nach ihrer OSM-Kennung.
    pub fn nodes(&self) -> impl Iterator<Item = &RawNode> {
        self.nodes.values()
    }

    /// Ein einzelner Knoten über seine OSM-Kennung.
    pub fn node(&self, id: OsmNodeId) -> Option<&RawNode> {
        self.nodes.get(&id)
    }

    /// Die Kanten, in der Reihenfolge ihrer Vergabe.
    pub fn edges(&self) -> &[RawEdge] {
        &self.edges
    }

    /// Anzahl der Knoten.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Anzahl der Kanten.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Baut einen neuen Rohgraphen aus einer Teilmenge der Kanten dieses
    /// Graphen — für Stufen, die aus einem vorhandenen Rohgraphen einen neuen
    /// ableiten, statt selbst zu importieren. Der Netzfilter (M1.3) ist der
    /// erste solche Fall.
    ///
    /// Nur die Kanten, für die `keep` wahr liefert, bleiben erhalten; die
    /// Knotenmenge wird auf die Endpunkte der verbleibenden Kanten verkürzt.
    /// Ein Knoten, der ausschließlich zu verworfenen Kanten gehörte, wäre
    /// sonst ein Punkt ohne Anschluss — kein Fund, den eine spätere Stufe
    /// noch einmal treffen müsste.
    pub fn subgraph(&self, keep: impl Fn(&RawEdge) -> bool) -> RawGraph {
        let edges: Vec<RawEdge> = self
            .edges
            .iter()
            .filter(|edge| keep(edge))
            .cloned()
            .collect();

        let mut used_node_ids: BTreeSet<OsmNodeId> = BTreeSet::new();
        for edge in &edges {
            used_node_ids.insert(edge.from);
            used_node_ids.insert(edge.to);
        }

        let nodes = used_node_ids
            .into_iter()
            .filter_map(|id| self.nodes.get(&id).cloned().map(|node| (id, node)))
            .collect();

        RawGraph {
            source: self.source.clone(),
            nodes,
            edges,
        }
    }
}

/// Baut den Rohgraph aus den geparsten OSM-Elementen.
///
/// Nur Wege mit einem `railway`-Tag — gleich welchem Wert — gehen ein. Die
/// engere Auswahl nach Spurweite, Betriebsart und Netzausschlussliste ist
/// M1.3; hier zählt allein, ob der Extract das Element als
/// Eisenbahnelement führt.
///
/// # Errors
///
/// [`ImportError::DegenerateWay`], wenn ein railway-Weg weniger als zwei
/// Knoten hat, oder [`ImportError::DanglingNodeReference`], wenn er einen
/// Knoten nennt, den der Extract nicht enthält.
pub(crate) fn build_raw_graph(
    source: SourceId,
    osm_nodes: &BTreeMap<OsmNodeId, OsmNode>,
    osm_ways: &BTreeMap<OsmWayId, OsmWay>,
) -> Result<RawGraph, ImportError> {
    let mut railway_ways = Vec::new();
    for way in osm_ways.values() {
        if !way.tags.contains_key("railway") {
            continue;
        }
        if way.nodes.len() < 2 {
            return Err(ImportError::DegenerateWay(way.id));
        }
        for node_id in &way.nodes {
            if !osm_nodes.contains_key(node_id) {
                return Err(ImportError::DanglingNodeReference {
                    way: way.id,
                    node: *node_id,
                });
            }
        }
        railway_ways.push(way);
    }

    let mut reference_counts: BTreeMap<OsmNodeId, u32> = BTreeMap::new();
    for way in &railway_ways {
        for node_id in &way.nodes {
            *reference_counts.entry(*node_id).or_insert(0) += 1;
        }
    }

    let is_significant = |node_id: OsmNodeId| -> bool {
        reference_counts.get(&node_id).copied().unwrap_or(0) >= 2
            || osm_nodes
                .get(&node_id)
                .is_some_and(|node| node.tags.contains_key("railway"))
    };

    let mut edges = Vec::new();
    let mut used_node_ids: BTreeSet<OsmNodeId> = BTreeSet::new();
    let mut next_edge_id: u64 = 1;

    for way in &railway_ways {
        let last_index = way.nodes.len() - 1;
        let mut segment_start = 0_usize;
        for index in 1..=last_index {
            let node_id = way.nodes[index];
            if index == last_index || is_significant(node_id) {
                let from_id = way.nodes[segment_start];
                let geometry = way.nodes[segment_start..=index]
                    .iter()
                    .map(|id| osm_nodes[id].coordinate)
                    .collect::<Vec<_>>();
                used_node_ids.insert(from_id);
                used_node_ids.insert(node_id);
                edges.push(RawEdge {
                    id: RawEdgeId::new(next_edge_id),
                    way: way.id,
                    from: from_id,
                    to: node_id,
                    geometry,
                    tags: way.tags.clone(),
                });
                next_edge_id += 1;
                segment_start = index;
            }
        }
    }

    let nodes = used_node_ids
        .into_iter()
        .map(|id| {
            let osm_node = &osm_nodes[&id];
            (
                id,
                RawNode {
                    id,
                    coordinate: osm_node.coordinate,
                    tags: osm_node.tags.clone(),
                },
            )
        })
        .collect();

    Ok(RawGraph {
        source,
        nodes,
        edges,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::build_raw_graph;
    use crate::import::element::{OsmNode, OsmNodeId, OsmWay, OsmWayId};
    use crate::operating_point::Coordinate;
    use crate::provenance::SourceId;

    fn quelle() -> SourceId {
        SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung")
    }

    fn punkt(id: i64, laengengrad: i32) -> (OsmNodeId, OsmNode) {
        (
            OsmNodeId::new(id),
            OsmNode {
                id: OsmNodeId::new(id),
                coordinate: Coordinate::new(510_000_000, laengengrad).expect("gültige Lage"),
                tags: BTreeMap::new(),
            },
        )
    }

    #[test]
    fn eine_verzweigung_teilt_den_weg_in_zwei_kanten() {
        let mut nodes = BTreeMap::new();
        // N1 -- N2 -- N3, mit N2 als Verzweigungspunkt zu N4.
        for (id, laengengrad) in [(1, 0), (2, 1_000_000), (3, 2_000_000), (4, 1_500_000)] {
            let (id, node) = punkt(id, laengengrad);
            nodes.insert(id, node);
        }

        let mut tags = BTreeMap::new();
        tags.insert("railway".to_owned(), "rail".to_owned());

        let mut ways = BTreeMap::new();
        ways.insert(
            OsmWayId::new(10),
            OsmWay {
                id: OsmWayId::new(10),
                nodes: vec![OsmNodeId::new(1), OsmNodeId::new(2), OsmNodeId::new(3)],
                tags: tags.clone(),
            },
        );
        ways.insert(
            OsmWayId::new(11),
            OsmWay {
                id: OsmWayId::new(11),
                nodes: vec![OsmNodeId::new(2), OsmNodeId::new(4)],
                tags,
            },
        );

        let graph = build_raw_graph(quelle(), &nodes, &ways).expect("gültiger Rohgraph");
        assert_eq!(
            graph.node_count(),
            4,
            "N1, N3, N4 sind Endpunkte, N2 zusätzlich die Verzweigung — alle vier werden Knoten"
        );
        assert_eq!(
            graph.edge_count(),
            3,
            "Weg 10 zerfällt bei N2 in zwei Abschnitte, Weg 11 bleibt einer"
        );
        assert!(
            graph.node(OsmNodeId::new(2)).is_some(),
            "die Verzweigung wird ein Knoten"
        );
    }

    #[test]
    fn ein_nicht_eisenbahn_weg_wird_verworfen() {
        let mut nodes = BTreeMap::new();
        for (id, laengengrad) in [(1, 0), (2, 1_000_000)] {
            let (id, node) = punkt(id, laengengrad);
            nodes.insert(id, node);
        }
        let mut tags = BTreeMap::new();
        tags.insert("highway".to_owned(), "residential".to_owned());
        let mut ways = BTreeMap::new();
        ways.insert(
            OsmWayId::new(20),
            OsmWay {
                id: OsmWayId::new(20),
                nodes: vec![OsmNodeId::new(1), OsmNodeId::new(2)],
                tags,
            },
        );

        let graph = build_raw_graph(quelle(), &nodes, &ways).expect("gültiger Rohgraph");
        assert_eq!(graph.node_count(), 0);
        assert_eq!(graph.edge_count(), 0);
    }

    #[test]
    fn ein_teilgraph_behaelt_nur_die_endpunkte_seiner_kanten() {
        let mut nodes = BTreeMap::new();
        for (id, laengengrad) in [(1, 0), (2, 1_000_000), (4, 1_500_000)] {
            let (id, node) = punkt(id, laengengrad);
            nodes.insert(id, node);
        }
        // N3 braucht einen eigenen railway-Tag, um trotz fehlender Verzweigung
        // ein eigener Knoten zu werden — sonst bliebe er nur Geometriepunkt
        // seines Wegs, und der Teilgraph hätte nichts zu verkürzen.
        let mut n3_tags = BTreeMap::new();
        n3_tags.insert("railway".to_owned(), "switch".to_owned());
        nodes.insert(
            OsmNodeId::new(3),
            OsmNode {
                id: OsmNodeId::new(3),
                coordinate: Coordinate::new(510_000_000, 2_000_000).expect("gültige Lage"),
                tags: n3_tags,
            },
        );

        let mut rail = BTreeMap::new();
        rail.insert("railway".to_owned(), "rail".to_owned());
        let mut tram = BTreeMap::new();
        tram.insert("railway".to_owned(), "tram".to_owned());

        let mut ways = BTreeMap::new();
        ways.insert(
            OsmWayId::new(10),
            OsmWay {
                id: OsmWayId::new(10),
                nodes: vec![OsmNodeId::new(1), OsmNodeId::new(2)],
                tags: rail,
            },
        );
        ways.insert(
            OsmWayId::new(11),
            OsmWay {
                id: OsmWayId::new(11),
                nodes: vec![OsmNodeId::new(2), OsmNodeId::new(3), OsmNodeId::new(4)],
                tags: tram,
            },
        );

        let graph = build_raw_graph(quelle(), &nodes, &ways).expect("gültiger Rohgraph");
        assert_eq!(graph.node_count(), 4);
        assert_eq!(
            graph.edge_count(),
            3,
            "Weg 11 zerfällt bei N3 zusätzlich in zwei Abschnitte"
        );

        let teilgraph =
            graph.subgraph(|edge| edge.tags().get("railway").map(String::as_str) == Some("rail"));

        assert_eq!(teilgraph.edge_count(), 1);
        assert_eq!(
            teilgraph.node_count(),
            2,
            "N3 und N4 hingen nur an der verworfenen Straßenbahnkante"
        );
        assert!(teilgraph.node(OsmNodeId::new(1)).is_some());
        assert!(teilgraph.node(OsmNodeId::new(2)).is_some());
        assert!(teilgraph.node(OsmNodeId::new(4)).is_none());
        assert_eq!(teilgraph.source(), graph.source());
    }

    #[test]
    fn ein_fehlender_knoten_wird_gemeldet() {
        let nodes = BTreeMap::new();
        let mut tags = BTreeMap::new();
        tags.insert("railway".to_owned(), "rail".to_owned());
        let mut ways = BTreeMap::new();
        ways.insert(
            OsmWayId::new(30),
            OsmWay {
                id: OsmWayId::new(30),
                nodes: vec![OsmNodeId::new(1), OsmNodeId::new(2)],
                tags,
            },
        );

        let fehler = build_raw_graph(quelle(), &nodes, &ways).expect_err("fehlender Knoten");
        assert!(matches!(
            fehler,
            crate::import::error::ImportError::DanglingNodeReference { .. }
        ));
    }
}
