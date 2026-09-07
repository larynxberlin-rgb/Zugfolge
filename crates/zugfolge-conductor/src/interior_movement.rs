use crate::{
    ConductorError,
    interior::{fail, require, verify_layout},
    interior_types::*,
};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};

fn same_floor(a: &InteriorPointV1, b: &InteriorPointV1) -> bool {
    a.vehicle_id == b.vehicle_id && a.body_id == b.body_id && a.deck_id == b.deck_id
}
fn orientation(a: (i64, i64), b: (i64, i64), c: (i64, i64)) -> i128 {
    i128::from(b.0 - a.0) * i128::from(c.1 - a.1) - i128::from(b.1 - a.1) * i128::from(c.0 - a.0)
}
fn crosses(a: (i64, i64), b: (i64, i64), c: (i64, i64), d: (i64, i64)) -> bool {
    if a.0.max(b.0) < c.0.min(d.0)
        || c.0.max(d.0) < a.0.min(b.0)
        || a.1.max(b.1) < c.1.min(d.1)
        || c.1.max(d.1) < a.1.min(b.1)
    {
        return false;
    }
    let (ab_c, ab_d, cd_a, cd_b) = (
        orientation(a, b, c),
        orientation(a, b, d),
        orientation(c, d, a),
        orientation(c, d, b),
    );
    (ab_c == 0 || ab_d == 0 || ab_c.signum() != ab_d.signum())
        && (cd_a == 0 || cd_b == 0 || cd_a.signum() != cd_b.signum())
}
fn intersects(a: &InteriorPointV1, b: &InteriorPointV1, r: &InteriorRectV1, radius: i64) -> bool {
    let x = r.x_mm - radius;
    let y = r.y_mm - radius;
    let right = r.x_mm + r.length_mm + radius;
    let bottom = r.y_mm + r.width_mm + radius;
    let inside =
        |p: &InteriorPointV1| p.x_mm >= x && p.x_mm <= right && p.y_mm >= y && p.y_mm <= bottom;
    if inside(a) || inside(b) {
        return true;
    }
    let corners = [(x, y), (right, y), (right, bottom), (x, bottom)];
    (0..4).any(|i| {
        crosses(
            (a.x_mm, a.y_mm),
            (b.x_mm, b.y_mm),
            corners[i],
            corners[(i + 1) % 4],
        )
    })
}
pub(crate) fn clear_segment(
    layout: &InteriorLayoutV1,
    from: &InteriorPointV1,
    to: &InteriorPointV1,
    wheelchair: bool,
) -> bool {
    if !same_floor(from, to) {
        return false;
    }
    let Some(body) = layout.vehicles.iter().flat_map(|v| &v.bodies).find(|b| {
        b.vehicle_id == from.vehicle_id
            && b.body_id == from.body_id
            && b.deck_ids.contains(&from.deck_id)
            && b.passenger_accessible
    }) else {
        return false;
    };
    let radius = if wheelchair { 450 } else { 290 };
    if [from, to].into_iter().any(|p| {
        p.x_mm < radius
            || p.y_mm < radius
            || p.x_mm > i64::from(body.length_mm) - radius
            || p.y_mm > i64::from(body.width_mm) - radius
    }) {
        return false;
    }
    !layout
        .obstacles
        .iter()
        .filter(|o| {
            o.vehicle_id == from.vehicle_id
                && o.body_id == from.body_id
                && o.deck_id == from.deck_id
        })
        .any(|o| intersects(from, to, &o.rect, radius))
}
fn reached(layout: &InteriorLayoutV1, wheelchair: bool) -> BTreeSet<&str> {
    let mut adjacency: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in &layout.edges {
        if !wheelchair || edge.wheelchair_accessible {
            adjacency
                .entry(&edge.from_node_id)
                .or_default()
                .push(&edge.to_node_id);
            adjacency
                .entry(&edge.to_node_id)
                .or_default()
                .push(&edge.from_node_id);
        }
    }
    let mut seen = BTreeSet::from([layout.entrance_node_id.as_str()]);
    let mut queue = VecDeque::from([layout.entrance_node_id.as_str()]);
    while let Some(node) = queue.pop_front() {
        for &next in adjacency.get(node).into_iter().flatten() {
            if seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen
}
pub(crate) fn validate_connectivity(layout: &InteriorLayoutV1) -> Result<(), ConductorError> {
    let nodes: BTreeMap<_, _> = layout
        .nodes
        .iter()
        .map(|n| (n.node_id.as_str(), &n.point))
        .collect();
    require(
        !nodes.is_empty()
            && nodes.len() == layout.nodes.len()
            && nodes.contains_key(layout.entrance_node_id.as_str())
            && !layout.doors.is_empty(),
        "interior_entrance_missing",
    )?;
    let mut edge_ids = BTreeSet::new();
    for edge in &layout.edges {
        require(
            edge_ids.insert(&edge.edge_id) && edge.length_mm > 0 && edge.length_mm <= 1_000_000,
            "invalid_interior_edge",
        )?;
        let from = nodes
            .get(edge.from_node_id.as_str())
            .ok_or_else(|| fail("interior_edge_node_missing", None, None))?;
        let to = nodes
            .get(edge.to_node_id.as_str())
            .ok_or_else(|| fail("interior_edge_node_missing", None, None))?;
        if edge.kind == InteriorEdgeKindV1::Walk {
            require(
                clear_segment(layout, from, to, edge.wheelchair_accessible),
                "interior_walk_edge_collision",
            )?;
        }
    }
    let seen = reached(layout, false);
    require(
        nodes.keys().all(|node| seen.contains(node))
            && layout
                .interactions
                .iter()
                .all(|i| seen.contains(i.node_id.as_str())),
        "formation_passenger_area_disconnected",
    )?;
    let accessible = reached(layout, true);
    require(
        layout
            .interactions
            .iter()
            .filter(|i| {
                matches!(
                    i.kind,
                    InteriorInteractionKindV1::Wheelchair
                        | InteriorInteractionKindV1::AccessibleToilet
                )
            })
            .all(|i| accessible.contains(i.node_id.as_str())),
        "interior_accessible_area_disconnected",
    )
}

pub fn find_interior_path(
    input: &FindInteriorPathInputV1,
) -> Result<InteriorPathV1, ConductorError> {
    require(
        input.schema_version == "conductor-interior-path-input/v1",
        "unsupported_interior_path_schema",
    )?;
    verify_layout(&input.layout, &input.expected_layout_hash)?;
    validate_connectivity(&input.layout)?;
    let mut adjacency: BTreeMap<&str, Vec<(&str, &InteriorEdgeV1)>> = BTreeMap::new();
    for edge in &input.layout.edges {
        if !input.wheelchair || edge.wheelchair_accessible {
            adjacency
                .entry(&edge.from_node_id)
                .or_default()
                .push((&edge.to_node_id, edge));
            adjacency
                .entry(&edge.to_node_id)
                .or_default()
                .push((&edge.from_node_id, edge));
        }
    }
    require(
        input
            .layout
            .nodes
            .iter()
            .any(|n| n.node_id == input.from_node_id)
            && input
                .layout
                .nodes
                .iter()
                .any(|n| n.node_id == input.to_node_id),
        "interior_path_node_missing",
    )?;
    let mut distance = BTreeMap::from([(input.from_node_id.as_str(), 0_u64)]);
    let mut previous: BTreeMap<&str, (&str, &str)> = BTreeMap::new();
    let mut queue = BinaryHeap::from([Reverse((0_u64, input.from_node_id.as_str()))]);
    while let Some(Reverse((cost, node))) = queue.pop() {
        if distance.get(node) != Some(&cost) {
            continue;
        }
        if node == input.to_node_id {
            break;
        }
        for &(next, edge) in adjacency.get(node).into_iter().flatten() {
            let candidate = cost + edge.length_mm;
            if distance.get(next).is_none_or(|old| candidate < *old) {
                distance.insert(next, candidate);
                previous.insert(next, (node, &edge.edge_id));
                queue.push(Reverse((candidate, next)));
            }
        }
    }
    let length_mm = *distance
        .get(input.to_node_id.as_str())
        .ok_or_else(|| fail("interior_path_unreachable", None, None))?;
    let mut node_ids = vec![input.to_node_id.clone()];
    let mut edge_ids = vec![];
    let mut cursor = input.to_node_id.as_str();
    while cursor != input.from_node_id {
        let (node, edge) = previous[cursor];
        node_ids.push(node.into());
        edge_ids.push(edge.into());
        cursor = node;
    }
    node_ids.reverse();
    edge_ids.reverse();
    Ok(InteriorPathV1 {
        schema_version: "interior-path/v1".into(),
        layout_hash: input.expected_layout_hash.clone(),
        node_ids,
        edge_ids,
        length_mm,
    })
}
pub fn check_interior_movement(
    input: &CheckInteriorMovementInputV1,
) -> Result<InteriorMovementResultV1, ConductorError> {
    require(
        input.schema_version == "conductor-interior-movement-input/v1",
        "unsupported_interior_movement_schema",
    )?;
    verify_layout(&input.layout, &input.expected_layout_hash)?;
    validate_connectivity(&input.layout)?;
    let allowed = if let Some(id) = &input.transition_edge_id {
        input
            .layout
            .edges
            .iter()
            .find(|edge| &edge.edge_id == id)
            .is_some_and(|edge| {
                if edge.kind == InteriorEdgeKindV1::Walk
                    || input.wheelchair && !edge.wheelchair_accessible
                {
                    return false;
                }
                let from = input
                    .layout
                    .nodes
                    .iter()
                    .find(|n| n.node_id == edge.from_node_id);
                let to = input
                    .layout
                    .nodes
                    .iter()
                    .find(|n| n.node_id == edge.to_node_id);
                match (from, to) {
                    (Some(a), Some(b)) => {
                        (input.from == a.point && input.to == b.point)
                            || (input.from == b.point && input.to == a.point)
                    }
                    _ => false,
                }
            })
    } else {
        clear_segment(&input.layout, &input.from, &input.to, input.wheelchair)
    };
    Ok(InteriorMovementResultV1 {
        schema_version: "interior-movement-result/v1".into(),
        layout_hash: input.expected_layout_hash.clone(),
        allowed,
        issue: if allowed {
            None
        } else {
            Some("interior_movement_blocked".into())
        },
    })
}
pub fn find_interior_path_json(json: &str) -> Result<String, ConductorError> {
    require(json.len() <= 128 * 1024 * 1024, "interior_input_size_limit")?;
    Ok(serde_json::to_string(&find_interior_path(
        &serde_json::from_str(json)?,
    )?)?)
}
pub fn check_interior_movement_json(json: &str) -> Result<String, ConductorError> {
    require(json.len() <= 128 * 1024 * 1024, "interior_input_size_limit")?;
    Ok(serde_json::to_string(&check_interior_movement(
        &serde_json::from_str(json)?,
    )?)?)
}
