use crate::{
    ConductorError, InteriorPlaceKindV1,
    interior::{capacity, fail, key, zero_capacity},
    interior_types::*,
};
use std::collections::BTreeMap;
use zugfolge_demand::{ComfortClassV1, SpaceNeedsV1, TrainCapacityV1};
use zugfolge_fleet::{SeatTypeV1, SeatingDensityV1, release_catalog::AuthorityVehicleAsset};
use zugfolge_sim::operational::Direction;

fn rect(x: i64, y: i64, l: i64, w: i64) -> InteriorRectV1 {
    InteriorRectV1 {
        x_mm: x,
        y_mm: y,
        length_mm: l,
        width_mm: w,
    }
}
fn overlap(a: &InteriorRectV1, b: &InteriorRectV1) -> bool {
    a.x_mm < b.x_mm + b.length_mm
        && b.x_mm < a.x_mm + a.length_mm
        && a.y_mm < b.y_mm + b.width_mm
        && b.y_mm < a.y_mm + a.width_mm
}
fn deck_name(d: InteriorDeckIdV1) -> &'static str {
    match d {
        InteriorDeckIdV1::Main => "main",
        InteriorDeckIdV1::Lower => "lower",
        InteriorDeckIdV1::Upper => "upper",
    }
}
struct Floor {
    body: InteriorBodyV1,
    deck: InteriorDeckIdV1,
    begin: i64,
    end: i64,
    reserved: Vec<InteriorRectV1>,
    node_x: BTreeMap<i64, String>,
}
impl Floor {
    fn point(&self, x: i64, y: i64) -> InteriorPointV1 {
        InteriorPointV1 {
            vehicle_id: self.body.vehicle_id.clone(),
            body_id: self.body.body_id.clone(),
            deck_id: self.deck,
            x_mm: x,
            y_mm: y,
        }
    }
    fn node(&mut self, layout: &mut InteriorLayoutV1, x: i64) -> String {
        if let Some(id) = self.node_x.get(&x) {
            return id.clone();
        }
        let point = self.point(x, i64::from(self.body.width_mm) / 2);
        let id = key(
            "node",
            &[
                &self.body.vehicle_id,
                &self.body.body_id,
                deck_name(self.deck),
                &x.to_string(),
            ],
        );
        layout.nodes.push(InteriorNodeV1 {
            node_id: id.clone(),
            point,
        });
        self.node_x.insert(x, id.clone());
        id
    }
    fn obstacle(
        &mut self,
        layout: &mut InteriorLayoutV1,
        kind: InteriorObstacleKindV1,
        r: InteriorRectV1,
    ) -> String {
        let id = key(
            "obstacle",
            &[
                &self.body.vehicle_id,
                &self.body.body_id,
                deck_name(self.deck),
                &format!("{kind:?}"),
                &r.x_mm.to_string(),
                &r.y_mm.to_string(),
            ],
        );
        layout.obstacles.push(InteriorObstacleV1 {
            obstacle_id: id.clone(),
            vehicle_id: self.body.vehicle_id.clone(),
            body_id: self.body.body_id.clone(),
            deck_id: self.deck,
            kind,
            rect: r.clone(),
        });
        self.reserved.push(r);
        id
    }
    fn free(&self, r: &InteriorRectV1) -> bool {
        r.x_mm >= self.begin
            && r.x_mm + r.length_mm <= self.end
            && !self.reserved.iter().any(|other| overlap(r, other))
    }
    fn allocate(&mut self, length: i64, width: i64, step: i64) -> Option<InteriorRectV1> {
        let middle = i64::from(self.body.width_mm) / 2;
        for x in (self.begin..=self.end - length).step_by(usize::try_from(step).ok()?) {
            for y in [100, middle + 500] {
                if y + width
                    > if y == 100 {
                        middle - 500
                    } else {
                        i64::from(self.body.width_mm) - 100
                    }
                {
                    continue;
                }
                let r = rect(x, y, length, width);
                if self.free(&r) {
                    return Some(r);
                }
            }
        }
        None
    }
}
fn interaction(
    layout: &mut InteriorLayoutV1,
    kind: InteriorInteractionKindV1,
    target: String,
    node: String,
) {
    layout.interactions.push(InteriorInteractionV1 {
        interaction_id: key("interaction", &[&target]),
        kind,
        target_id: target,
        node_id: node,
    });
}
fn edge(
    layout: &mut InteriorLayoutV1,
    from: String,
    to: String,
    kind: InteriorEdgeKindV1,
    length: u64,
    accessible: bool,
) {
    layout.edges.push(InteriorEdgeV1 {
        edge_id: key("edge", &[&from, &to]),
        from_node_id: from,
        to_node_id: to,
        kind,
        length_mm: length.max(1),
        wheelchair_accessible: accessible,
    });
}

pub(crate) fn generate(
    binding: &InteriorLayoutBindingV1,
    selected: Vec<(
        &AuthorityVehicleAsset,
        &InteriorVehicleGeometryV1,
        Option<String>,
    )>,
    total: TrainCapacityV1,
) -> Result<InteriorLayoutV1, ConductorError> {
    let mut layout = InteriorLayoutV1 {
        schema_version: LAYOUT_SCHEMA.into(),
        binding: binding.clone(),
        layout_id: key(
            "layout",
            &[
                &binding.formation_id,
                &binding.geometry_policy_hash,
                &binding.mobilization_snapshot_hash,
            ],
        ),
        layout_hash: String::new(),
        capacity: total,
        vehicles: vec![],
        passenger_places: vec![],
        special_bays: vec![],
        obstacles: vec![],
        nodes: vec![],
        edges: vec![],
        interactions: vec![],
        doors: vec![],
        seats: vec![],
        entrance_node_id: String::new(),
    };
    let mut floors: Vec<Floor> = vec![];
    let mut formation_offset = 0_u64;
    for (asset, profile, configuration_hash) in selected {
        let passenger = asset.vehicle_configuration.is_some();
        let reversed = asset.orientation == Direction::Against;
        let mut vehicle = InteriorVehicleV1 {
            vehicle_id: asset.id.clone(),
            vehicle_type_id: asset.vehicle_type_id,
            configuration: asset.vehicle_configuration.clone(),
            configuration_hash,
            art_family: profile.art_family.clone(),
            capacity: asset
                .vehicle_configuration
                .as_ref()
                .map_or_else(zero_capacity, capacity),
            bodies: vec![],
        };
        let mut offset = 0;
        let floor_start = floors.len();
        for (index, policy) in profile.bodies.iter().enumerate() {
            let front_cab = index == 0 && asset.technical.control_stands.front;
            let rear_cab = index + 1 == profile.bodies.len() && asset.technical.control_stands.rear;
            let body = InteriorBodyV1 {
                body_id: policy.body_id.clone(),
                vehicle_id: asset.id.clone(),
                length_mm: policy.length_mm,
                width_mm: policy.width_mm,
                vehicle_offset_mm: offset,
                formation_offset_mm: formation_offset
                    + u64::from(if reversed {
                        u32::try_from(asset.technical.length_mm).expect("begrenzt")
                            - offset
                            - policy.length_mm
                    } else {
                        offset
                    }),
                reversed,
                deck_ids: policy.deck_ids.clone(),
                entrance_deck_id: policy.entrance_deck_id,
                passenger_accessible: passenger,
                front_gangway: policy.front_gangway && !front_cab,
                rear_gangway: policy.rear_gangway && !rear_cab,
                gap_after_mm: policy.gap_after_mm,
            };
            for &deck in &body.deck_ids {
                let length = i64::from(body.length_mm);
                let width = i64::from(body.width_mm);
                let begin = if front_cab { 2500 } else { 600 };
                let end = length - if rear_cab { 2500 } else { 600 };
                let mut floor = Floor {
                    body: body.clone(),
                    deck,
                    begin,
                    end,
                    reserved: vec![],
                    node_x: BTreeMap::new(),
                };
                let mut door_intervals = vec![];
                if passenger && deck == body.entrance_deck_id {
                    for &center in &policy.door_positions_mm {
                        let door_width = i64::from(
                            asset
                                .vehicle_configuration
                                .as_ref()
                                .expect("Konfiguration")
                                .structural
                                .door_width_mm,
                        );
                        let x = i64::from(center);
                        if x - door_width / 2 < begin || x + door_width / 2 > end {
                            return Err(fail(
                                "interior_door_cab_overlap",
                                Some(&asset.id),
                                Some(&body.body_id),
                            ));
                        }
                        floor
                            .reserved
                            .push(rect(x - door_width / 2, 100, door_width, width - 200));
                        door_intervals.push((x - door_width / 2, x + door_width / 2));
                        let node = floor.node(&mut layout, x);
                        if layout.entrance_node_id.is_empty() {
                            layout.entrance_node_id = node.clone();
                        }
                        for (side, y) in [("left", 0), ("right", width - 100)] {
                            let id = key("door", &[&asset.id, &body.body_id, side, &x.to_string()]);
                            layout.doors.push(InteriorDoorV1 {
                                door_id: id.clone(),
                                vehicle_id: asset.id.clone(),
                                body_id: body.body_id.clone(),
                                deck_id: deck,
                                side: side.into(),
                                rect: rect(x - door_width / 2, y, door_width, 100),
                                node_id: node.clone(),
                            });
                            interaction(
                                &mut layout,
                                InteriorInteractionKindV1::Door,
                                id,
                                node.clone(),
                            );
                        }
                    }
                }
                door_intervals.sort_unstable();
                for y in [0, width - 100] {
                    let mut cursor = 0;
                    for &(start, end) in &door_intervals {
                        if start > cursor {
                            floor.obstacle(
                                &mut layout,
                                InteriorObstacleKindV1::Wall,
                                rect(cursor, y, start - cursor, 100),
                            );
                        }
                        cursor = end;
                    }
                    if cursor < length {
                        floor.obstacle(
                            &mut layout,
                            InteriorObstacleKindV1::Wall,
                            rect(cursor, y, length - cursor, 100),
                        );
                    }
                }
                for (x, cab, open) in [
                    (0, front_cab, body.front_gangway),
                    (length - 100, rear_cab, body.rear_gangway),
                ] {
                    if cab {
                        let r = rect(
                            if x == 0 { 100 } else { length - 2000 },
                            100,
                            1900,
                            width - 200,
                        );
                        let id = floor.obstacle(&mut layout, InteriorObstacleKindV1::Cab, r);
                        if passenger {
                            let node = floor.node(&mut layout, if x == 0 { begin } else { end });
                            interaction(&mut layout, InteriorInteractionKindV1::Cab, id, node);
                        }
                    }
                    if open && passenger {
                        floor.obstacle(
                            &mut layout,
                            InteriorObstacleKindV1::Wall,
                            rect(x, 100, 100, width / 2 - 600),
                        );
                        floor.obstacle(
                            &mut layout,
                            InteriorObstacleKindV1::Wall,
                            rect(x, width / 2 + 500, 100, width / 2 - 600),
                        );
                    } else {
                        floor.obstacle(
                            &mut layout,
                            InteriorObstacleKindV1::Wall,
                            rect(x, 100, 100, width - 200),
                        );
                    }
                }
                if passenger {
                    floor.node(&mut layout, begin);
                    floor.node(&mut layout, end);
                    for stair in &policy.stairs {
                        let r = rect(i64::from(stair.at_mm) - 1000, 100, 2000, 900);
                        if !floor.free(&r) {
                            return Err(fail(
                                "interior_stair_geometry_conflict",
                                Some(&asset.id),
                                Some(&body.body_id),
                            ));
                        }
                        let id = floor.obstacle(&mut layout, InteriorObstacleKindV1::Stair, r);
                        let node = floor.node(&mut layout, i64::from(stair.at_mm));
                        interaction(&mut layout, InteriorInteractionKindV1::Stair, id, node);
                    }
                }
                floors.push(floor);
            }
            offset += policy.length_mm + policy.gap_after_mm;
            vehicle.bodies.push(body);
        }
        if let Some(config) = &asset.vehicle_configuration {
            let interior = &config.interior;
            let selected_floors = &mut floors[floor_start..];
            let modules = [
                (
                    InteriorObstacleKindV1::AccessibleToilet,
                    InteriorInteractionKindV1::AccessibleToilet,
                    u32::from(interior.accessible_toilets),
                    2200,
                    900,
                    None,
                ),
                (
                    InteriorObstacleKindV1::Toilet,
                    InteriorInteractionKindV1::Toilet,
                    u32::from(interior.toilets - interior.accessible_toilets),
                    1600,
                    800,
                    None,
                ),
                (
                    InteriorObstacleKindV1::Wheelchair,
                    InteriorInteractionKindV1::Wheelchair,
                    u32::from(interior.multipurpose.wheelchairs),
                    1400,
                    900,
                    Some(SpaceNeedsV1::Wheelchair),
                ),
                (
                    InteriorObstacleKindV1::Bicycle,
                    InteriorInteractionKindV1::Bicycle,
                    u32::from(interior.multipurpose.bicycles),
                    1600,
                    600,
                    Some(SpaceNeedsV1::Bicycle),
                ),
                (
                    InteriorObstacleKindV1::Stroller,
                    InteriorInteractionKindV1::Stroller,
                    u32::from(interior.multipurpose.pushchairs),
                    1100,
                    700,
                    Some(SpaceNeedsV1::Stroller),
                ),
            ];
            for (kind, interaction_kind, count, length, width, need) in modules {
                for _ in 0..count {
                    let mut found = false;
                    for floor in selected_floors
                        .iter_mut()
                        .filter(|f| f.deck == f.body.entrance_deck_id)
                    {
                        if let Some(r) = floor.allocate(length, width, 100) {
                            let point =
                                floor.point(r.x_mm + r.length_mm / 2, r.y_mm + r.width_mm / 2);
                            let id = floor.obstacle(&mut layout, kind, r);
                            let node = floor.node(&mut layout, point.x_mm);
                            let target = if let Some(space_need) = need {
                                let space_id = key("space", &[&id]);
                                layout.special_bays.push(InteriorSpecialBayV1 {
                                    space_id: space_id.clone(),
                                    vehicle_id: point.vehicle_id,
                                    body_id: point.body_id,
                                    deck_id: point.deck_id,
                                    x_mm: point.x_mm,
                                    y_mm: point.y_mm,
                                    space_need,
                                });
                                space_id
                            } else {
                                id
                            };
                            interaction(&mut layout, interaction_kind, target, node);
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        return Err(fail(
                            "interior_special_area_capacity_gap",
                            Some(&asset.id),
                            None,
                        ));
                    }
                }
            }
            let pitch = match interior.density {
                SeatingDensityV1::Dense => 700,
                SeatingDensityV1::Standard => 850,
                SeatingDensityV1::Spacious => 1000,
            };
            let seat_depth = if interior.seat_type == SeatTypeV1::Folding {
                450
            } else {
                500
            };
            for (comfort, count, kind) in [
                (
                    ComfortClassV1::Premium,
                    u32::from(interior.first_class_seats),
                    InteriorPlaceKindV1::Seat,
                ),
                (
                    ComfortClassV1::Standard,
                    u32::from(interior.second_class_seats),
                    InteriorPlaceKindV1::Seat,
                ),
                (
                    ComfortClassV1::Standard,
                    u32::from(interior.multipurpose.standing),
                    InteriorPlaceKindV1::Standing,
                ),
            ] {
                for _ in 0..count {
                    let mut found = false;
                    for floor in selected_floors.iter_mut() {
                        let middle = i64::from(floor.body.width_mm) / 2;
                        let length = if kind == InteriorPlaceKindV1::Seat {
                            seat_depth
                        } else {
                            500
                        };
                        let width = if kind == InteriorPlaceKindV1::Seat {
                            450
                        } else {
                            500
                        };
                        let step = if kind == InteriorPlaceKindV1::Seat {
                            pitch
                                + if interior.seat_type == SeatTypeV1::FaceToFace {
                                    250
                                } else {
                                    0
                                }
                        } else {
                            100
                        };
                        'position: for x in (floor.begin..=floor.end - length)
                            .step_by(usize::try_from(step).expect("positiv"))
                        {
                            for y in [100, 100 + width, middle + 500, middle + 500 + width] {
                                if (y < middle && y + width > middle - 500)
                                    || y + width > i64::from(floor.body.width_mm) - 100
                                {
                                    continue;
                                }
                                let r = rect(x, y, length, width);
                                if !floor.free(&r) {
                                    continue;
                                }
                                // Die komplette Sitzreihe reserviert ihren Dichteabstand; Stehplätze dürfen keine Beinfreiheit belegen.
                                let reservation = rect(
                                    x,
                                    y,
                                    if kind == InteriorPlaceKindV1::Seat {
                                        step
                                    } else {
                                        length
                                    },
                                    width,
                                );
                                if !floor.free(&reservation) {
                                    continue;
                                }
                                let place_id = key(
                                    "place",
                                    &[
                                        &asset.id,
                                        &floor.body.body_id,
                                        deck_name(floor.deck),
                                        &x.to_string(),
                                        &y.to_string(),
                                    ],
                                );
                                if kind == InteriorPlaceKindV1::Seat {
                                    let obstacle_id = floor.obstacle(
                                        &mut layout,
                                        InteriorObstacleKindV1::Seat,
                                        r.clone(),
                                    );
                                    let facing = if interior.seat_type == SeatTypeV1::FaceToFace
                                        && (x - floor.begin) / step % 2 == 1
                                    {
                                        InteriorSeatFacingV1::Backward
                                    } else {
                                        InteriorSeatFacingV1::Forward
                                    };
                                    layout.seats.push(InteriorSeatV1 {
                                        place_id: place_id.clone(),
                                        obstacle_id,
                                        facing,
                                    });
                                }
                                floor.reserved.push(reservation);
                                let mut needs = vec![SpaceNeedsV1::Ordinary];
                                if interior.multipurpose.bicycles > 0 {
                                    needs.push(SpaceNeedsV1::Bicycle);
                                }
                                if interior.multipurpose.pushchairs > 0 {
                                    needs.push(SpaceNeedsV1::Stroller);
                                }
                                if interior.multipurpose.wheelchairs > 0 {
                                    needs.push(SpaceNeedsV1::Wheelchair);
                                }
                                needs.sort();
                                layout.passenger_places.push(InteriorPassengerPlaceV2 {
                                    place_id: place_id.clone(),
                                    vehicle_id: asset.id.clone(),
                                    body_id: floor.body.body_id.clone(),
                                    deck_id: floor.deck,
                                    x_mm: x + length / 2,
                                    y_mm: y + width / 2,
                                    comfort_class: comfort,
                                    kind,
                                    space_needs: needs,
                                });
                                let node = floor.node(&mut layout, x + length / 2);
                                interaction(
                                    &mut layout,
                                    InteriorInteractionKindV1::Passenger,
                                    place_id,
                                    node,
                                );
                                found = true;
                                break 'position;
                            }
                        }
                        if found {
                            break;
                        }
                    }
                    if !found {
                        return Err(fail(
                            if kind == InteriorPlaceKindV1::Seat {
                                "interior_seat_capacity_gap"
                            } else {
                                "interior_standing_capacity_gap"
                            },
                            Some(&asset.id),
                            None,
                        ));
                    }
                }
            }
        }
        formation_offset += u64::try_from(asset.technical.length_mm).expect("positiv");
        layout.vehicles.push(vehicle);
    }
    for floor in &floors {
        let entries: Vec<_> = floor.node_x.iter().collect();
        for pair in entries.windows(2) {
            edge(
                &mut layout,
                pair[0].1.clone(),
                pair[1].1.clone(),
                InteriorEdgeKindV1::Walk,
                u64::try_from(pair[1].0 - pair[0].0).expect("sortiert"),
                true,
            );
        }
    }
    for vehicle in &layout.vehicles.clone() {
        for body in &vehicle.bodies {
            if body.deck_ids.len() == 2 {
                let lower = floors
                    .iter()
                    .find(|f| {
                        f.body.vehicle_id == vehicle.vehicle_id
                            && f.body.body_id == body.body_id
                            && f.deck == InteriorDeckIdV1::Lower
                    })
                    .expect("Deck");
                let upper = floors
                    .iter()
                    .find(|f| {
                        f.body.vehicle_id == vehicle.vehicle_id
                            && f.body.body_id == body.body_id
                            && f.deck == InteriorDeckIdV1::Upper
                    })
                    .expect("Deck");
                let stair_nodes: Vec<_> = layout
                    .interactions
                    .iter()
                    .filter(|i| i.kind == InteriorInteractionKindV1::Stair)
                    .map(|i| i.node_id.clone())
                    .collect();
                for (&x, node) in &lower.node_x {
                    if stair_nodes.contains(node) {
                        edge(
                            &mut layout,
                            node.clone(),
                            upper.node_x[&x].clone(),
                            InteriorEdgeKindV1::Stair,
                            3000,
                            false,
                        );
                    }
                }
            }
        }
    }
    let mut ordered: Vec<_> = layout
        .vehicles
        .iter()
        .flat_map(|v| v.bodies.iter())
        .filter(|b| b.passenger_accessible)
        .cloned()
        .collect();
    ordered.sort_by_key(|b| b.formation_offset_mm);
    for pair in ordered.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        let a_open = if a.reversed {
            a.front_gangway
        } else {
            a.rear_gangway
        };
        let b_open = if b.reversed {
            b.rear_gangway
        } else {
            b.front_gangway
        };
        // Nur unmittelbar benachbarte, ausdrücklich offene Kästen erhalten eine Kante.
        let gap = b
            .formation_offset_mm
            .saturating_sub(a.formation_offset_mm + u64::from(a.length_mm));
        if a_open && b_open && gap <= 3000 {
            let af = floors
                .iter()
                .find(|f| {
                    f.body.vehicle_id == a.vehicle_id
                        && f.body.body_id == a.body_id
                        && f.deck == a.entrance_deck_id
                })
                .expect("Deck");
            let bf = floors
                .iter()
                .find(|f| {
                    f.body.vehicle_id == b.vehicle_id
                        && f.body.body_id == b.body_id
                        && f.deck == b.entrance_deck_id
                })
                .expect("Deck");
            let ax = if a.reversed { af.begin } else { af.end };
            let bx = if b.reversed { bf.end } else { bf.begin };
            edge(
                &mut layout,
                af.node_x[&ax].clone(),
                bf.node_x[&bx].clone(),
                InteriorEdgeKindV1::Gangway,
                gap + u64::try_from(if a.reversed {
                    ax
                } else {
                    i64::from(a.length_mm) - ax
                })
                .expect("positiv")
                    + u64::try_from(if b.reversed {
                        i64::from(b.length_mm) - bx
                    } else {
                        bx
                    })
                    .expect("positiv"),
                true,
            );
        }
    }
    layout
        .passenger_places
        .sort_by(|a, b| a.place_id.cmp(&b.place_id));
    layout
        .special_bays
        .sort_by(|a, b| a.space_id.cmp(&b.space_id));
    layout.nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    layout.edges.sort_by(|a, b| a.edge_id.cmp(&b.edge_id));
    layout
        .interactions
        .sort_by(|a, b| a.interaction_id.cmp(&b.interaction_id));
    layout
        .obstacles
        .sort_by(|a, b| a.obstacle_id.cmp(&b.obstacle_id));
    layout.doors.sort_by(|a, b| a.door_id.cmp(&b.door_id));
    layout.seats.sort_by(|a, b| a.place_id.cmp(&b.place_id));
    Ok(layout)
}
