//! Ereignisgesteuerter Simulationskern und Transportvertrag der Livemap.
//!
//! Der Kern ist absichtlich rein: Kommandos hinein, Ereignisse hinaus. Er kennt
//! weder Datenbank noch Netzwerk oder Systemuhr. Alle Zeiten sind Sekunden seit
//! der Weltepoche und jeder zustandsrelevante Wert ist ganzzahlig.
#![allow(
    missing_docs,
    reason = "öffentliche Felder sind durch ihre Typen und die Modul-Spezifikation beschrieben"
)]

use std::collections::{BTreeMap, BTreeSet};
use zugfolge_determinism::{StateHash, StateHasher};

/// Stabile Kennung einer Welt.
pub type WorldId = u64;
/// Stabile Kennung einer Region.
pub type RegionId = u32;
/// Stabile Kennung einer Zugfahrt.
pub type TrainRunId = u64;
/// Simulationssekunden seit der Weltepoche.
pub type SimTime = i64;

/// Das zulässige Materialisierungsfenster (48 bis 72 Stunden).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MaterializationWindow {
    hours: u8,
}

/// Kompakte Vorlage eines wiederkehrenden Verkehrsangebots. Die Route trägt
/// relative Sekunden; erst der rollierende Materialisierer erzeugt Fahrten.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceTemplate {
    pub service_id: u64,
    pub world_id: WorldId,
    pub region_id: RegionId,
    pub operator: String,
    pub train_number: String,
    pub category: TrainCategory,
    pub first_departure: SimTime,
    pub interval_seconds: u32,
    pub last_departure: SimTime,
    pub relative_route: Vec<Waypoint>,
}

/// Rollierender Erzeuger des 48–72-Stunden-Fensters.
#[derive(Default)]
pub struct RollingMaterializer {
    emitted: BTreeSet<(u64, SimTime)>,
}
impl RollingMaterializer {
    /// Liefert ausschließlich bisher nicht erzeugte Fahrten im aktuellen Fenster.
    pub fn materialize(
        &mut self,
        now: SimTime,
        window: MaterializationWindow,
        services: &[ServiceTemplate],
    ) -> Result<Vec<TrainRun>, SimError> {
        let mut runs = Vec::new();
        for service in services {
            if service.interval_seconds == 0 || service.relative_route.is_empty() {
                return Err(SimError::InvalidRoute);
            }
            let interval = i64::from(service.interval_seconds);
            let mut departure = service.first_departure;
            if departure < now {
                departure =
                    departure.saturating_add((now.saturating_sub(departure) / interval) * interval);
                while departure < now {
                    departure = departure.saturating_add(interval);
                }
            }
            while departure <= service.last_departure
                && departure <= now.saturating_add(window.seconds())
            {
                if self.emitted.insert((service.service_id, departure)) {
                    let route = service
                        .relative_route
                        .iter()
                        .cloned()
                        .map(|mut point| {
                            point.arrival = point.arrival.saturating_add(departure);
                            point.departure = point.departure.saturating_add(departure);
                            point
                        })
                        .collect();
                    let id = service.service_id.rotate_left(19)
                        ^ u64::from_be_bytes(departure.to_be_bytes());
                    runs.push(TrainRun {
                        world_id: service.world_id,
                        id,
                        region_id: service.region_id,
                        operator: service.operator.clone(),
                        train_number: service.train_number.clone(),
                        category: service.category.clone(),
                        route,
                        next_waypoint: 0,
                        delay_seconds: 0,
                        position_mm: 0,
                        speed_mm_per_second: 0,
                        status: OperatingStatus::Planned,
                    });
                }
                departure = departure.saturating_add(interval);
            }
        }
        Ok(runs)
    }
}

impl MaterializationWindow {
    /// Erzeugt ein geprüftes Fenster.
    pub fn new(hours: u8) -> Result<Self, SimError> {
        if (48..=72).contains(&hours) {
            Ok(Self { hours })
        } else {
            Err(SimError::InvalidWindow)
        }
    }
    /// Fensterlänge in Sekunden.
    #[must_use]
    pub fn seconds(self) -> SimTime {
        i64::from(self.hours) * 3_600
    }
}

/// Öffentlicher Betriebszustand einer Zugfahrt.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum OperatingStatus {
    Planned,
    Running,
    Waiting,
    AtPlatform,
    Completed,
    Cancelled,
}

/// Öffentliche Zugart.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum TrainCategory {
    Regional,
    LongDistance,
    Freight,
    EmptyStock,
    Engineering,
}

/// Ein Punkt des Fahrwegs. Zeiten sind absolut und monoton.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Waypoint {
    /// Betriebsstellenkennung.
    pub operating_point: String,
    /// Position entlang der Gesamtstrecke in Millimetern.
    pub position_mm: i64,
    /// Planmäßige Ankunft.
    pub arrival: SimTime,
    /// Mindesthaltezeit in Sekunden.
    pub minimum_dwell_seconds: u32,
    /// Planmäßige Abfahrt.
    pub departure: SimTime,
}

/// Vollständig materialisierte Zugfahrt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrainRun {
    pub world_id: WorldId,
    pub id: TrainRunId,
    pub region_id: RegionId,
    pub operator: String,
    pub train_number: String,
    pub category: TrainCategory,
    pub route: Vec<Waypoint>,
    pub next_waypoint: usize,
    pub delay_seconds: i64,
    pub position_mm: i64,
    pub speed_mm_per_second: u32,
    pub status: OperatingStatus,
}

impl TrainRun {
    fn validate(&self) -> Result<(), SimError> {
        if self.route.is_empty() || self.next_waypoint >= self.route.len() {
            return Err(SimError::InvalidRoute);
        }
        for pair in self.route.windows(2) {
            if pair[0].position_mm > pair[1].position_mm || pair[0].departure > pair[1].arrival {
                return Err(SimError::InvalidRoute);
            }
        }
        Ok(())
    }
}

/// Entscheidung, die an jedem betrieblichen Ereignis eingeschoben werden kann.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchDecision {
    Proceed,
    HoldUntil(SimTime),
    Cancel,
}

/// Fachlicher Ereignistyp am Dispositionsentscheidungspunkt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchTrigger {
    Arrival,
    Departure,
}

/// Austauschbare Dispositionsschnittstelle für M7.
pub trait Dispatcher {
    /// Entscheidet ohne Seiteneffekt über das nächste Ereignis.
    fn decide(
        &self,
        train: &TrainRun,
        event_at: SimTime,
        trigger: DispatchTrigger,
    ) -> DispatchDecision;
}

/// Konservatives Standardverhalten: negative Verspätung wird nicht durch
/// vorzeitige Abfahrt realisiert; ansonsten fährt der Zug weiter.
pub struct ConservativeDispatcher;
impl Dispatcher for ConservativeDispatcher {
    fn decide(
        &self,
        train: &TrainRun,
        event_at: SimTime,
        _trigger: DispatchTrigger,
    ) -> DispatchDecision {
        let waypoint = &train.route[train.next_waypoint];
        DispatchDecision::HoldUntil(event_at.max(waypoint.departure + train.delay_seconds.max(0)))
    }
}

/// Ein von außen protokollierbarer Befehl.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Materialize(TrainRun),
    AdvanceTo(SimTime),
    AddDelay {
        train_run_id: TrainRunId,
        seconds: u32,
    },
    ConfirmHandover {
        token: u64,
        target_region: RegionId,
    },
}

/// Ereignisse sind die einzige Ausgabe des Kerns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventKind {
    Materialized {
        train_run_id: TrainRunId,
    },
    Arrived {
        train_run_id: TrainRunId,
        operating_point: String,
    },
    Departed {
        train_run_id: TrainRunId,
        operating_point: String,
    },
    DelayChanged {
        train_run_id: TrainRunId,
        delay_seconds: i64,
    },
    HandoverRequested {
        train_run_id: TrainRunId,
        token: u64,
        target_region: RegionId,
    },
    HandoverCompleted {
        train_run_id: TrainRunId,
        token: u64,
        target_region: RegionId,
    },
    Completed {
        train_run_id: TrainRunId,
    },
}

/// Weltgebundenes, lückenlos sequenziertes Domain-Ereignis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainEvent {
    pub world_id: WorldId,
    pub sequence: u64,
    pub at: SimTime,
    pub kind: EventKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingHandover {
    train_run_id: TrainRunId,
    target_region: RegionId,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ScheduledKind {
    Arrive,
    Depart,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ScheduledEvent {
    at: SimTime,
    train_run_id: TrainRunId,
    waypoint: usize,
    kind: ScheduledKind,
}

/// Regionaler Single-Writer. Nur diese Instanz verändert ihre Zugfahrten.
pub struct Simulation<D: Dispatcher> {
    world_id: WorldId,
    region_id: RegionId,
    now: SimTime,
    sequence: u64,
    window: MaterializationWindow,
    trains: BTreeMap<TrainRunId, TrainRun>,
    pending_handovers: BTreeMap<u64, PendingHandover>,
    schedule: BTreeSet<ScheduledEvent>,
    delay_rules: BTreeMap<(TrainRunId, usize), DelayRule>,
    resource_owners: BTreeMap<String, TrainRunId>,
    dispatcher: D,
}

impl<D: Dispatcher> Simulation<D> {
    /// Erzeugt einen regionalen Writer mit explizitem Zeitgeber.
    #[must_use]
    pub fn new(
        world_id: WorldId,
        region_id: RegionId,
        now: SimTime,
        window: MaterializationWindow,
        dispatcher: D,
    ) -> Self {
        Self {
            world_id,
            region_id,
            now,
            sequence: 0,
            window,
            trains: BTreeMap::new(),
            pending_handovers: BTreeMap::new(),
            schedule: BTreeSet::new(),
            delay_rules: BTreeMap::new(),
            resource_owners: BTreeMap::new(),
            dispatcher,
        }
    }

    /// Wendet genau einen Befehl deterministisch an.
    pub fn apply(&mut self, command: Command) -> Result<Vec<DomainEvent>, SimError> {
        let mut kinds = Vec::new();
        match command {
            Command::Materialize(train) => {
                train.validate()?;
                if train.world_id != self.world_id {
                    return Err(SimError::WrongWorld);
                }
                if train.region_id != self.region_id {
                    return Err(SimError::WrongRegion);
                }
                let first = train.route[train.next_waypoint].arrival;
                if first < self.now || first > self.now + self.window.seconds() {
                    return Err(SimError::OutsideWindow);
                }
                let id = train.id;
                if self.trains.insert(id, train).is_some() {
                    return Err(SimError::DuplicateTrain);
                }
                let next_waypoint = self.trains[&id].next_waypoint;
                let first = &self.trains[&id].route[next_waypoint];
                self.schedule.insert(ScheduledEvent {
                    at: first.arrival,
                    train_run_id: id,
                    waypoint: next_waypoint,
                    kind: ScheduledKind::Arrive,
                });
                kinds.push((self.now, EventKind::Materialized { train_run_id: id }));
            }
            Command::AdvanceTo(target) => {
                if target < self.now {
                    return Err(SimError::TimeReversal);
                }
                self.advance(target, &mut kinds);
            }
            Command::AddDelay {
                train_run_id,
                seconds,
            } => {
                let delay_seconds = {
                    let train = self
                        .trains
                        .get_mut(&train_run_id)
                        .ok_or(SimError::UnknownTrain)?;
                    train.delay_seconds = train.delay_seconds.saturating_add(i64::from(seconds));
                    train.delay_seconds
                };
                self.reschedule_train(train_run_id)?;
                kinds.push((
                    self.now,
                    EventKind::DelayChanged {
                        train_run_id,
                        delay_seconds,
                    },
                ));
            }
            Command::ConfirmHandover {
                token,
                target_region,
            } => {
                let pending = self
                    .pending_handovers
                    .get(&token)
                    .ok_or(SimError::UnknownHandover)?;
                if pending.target_region != target_region {
                    return Err(SimError::WrongRegion);
                }
                let pending = self
                    .pending_handovers
                    .remove(&token)
                    .ok_or(SimError::UnknownHandover)?;
                self.trains.remove(&pending.train_run_id);
                kinds.push((
                    self.now,
                    EventKind::HandoverCompleted {
                        train_run_id: pending.train_run_id,
                        token,
                        target_region,
                    },
                ));
            }
        }
        Ok(self.events(kinds))
    }

    fn advance(&mut self, target: SimTime, kinds: &mut Vec<(SimTime, EventKind)>) {
        while let Some(event) = self
            .schedule
            .first()
            .copied()
            .filter(|event| event.at <= target)
        {
            self.schedule.remove(&event);
            self.now = event.at;
            self.process_scheduled(event, kinds);
        }
        self.now = target;
        for train in self.trains.values_mut() {
            if train.status == OperatingStatus::Running {
                interpolate(train, target);
            }
        }
    }

    fn process_scheduled(&mut self, event: ScheduledEvent, kinds: &mut Vec<(SimTime, EventKind)>) {
        let Some(train) = self.trains.get_mut(&event.train_run_id) else {
            return;
        };
        if matches!(
            train.status,
            OperatingStatus::Completed | OperatingStatus::Cancelled
        ) || train.next_waypoint != event.waypoint
        {
            return;
        }
        let waypoint = &train.route[event.waypoint];
        match event.kind {
            ScheduledKind::Arrive => {
                if let Some(rule) = self.delay_rules.get(&(event.train_run_id, event.waypoint)) {
                    train.delay_seconds = i64::from(propagate_delay(
                        u32::try_from(train.delay_seconds.max(0)).unwrap_or(u32::MAX),
                        rule.recovery_seconds,
                        waypoint
                            .departure
                            .saturating_sub(waypoint.arrival)
                            .try_into()
                            .unwrap_or(u32::MAX),
                        waypoint.minimum_dwell_seconds,
                        rule.connection_arrival_delay_seconds,
                        rule.maximum_connection_wait_seconds,
                    ));
                }
                train.position_mm = waypoint.position_mm;
                train.speed_mm_per_second = 0;
                train.status = OperatingStatus::AtPlatform;
                kinds.push((
                    event.at,
                    EventKind::Arrived {
                        train_run_id: train.id,
                        operating_point: waypoint.operating_point.clone(),
                    },
                ));
                match self
                    .dispatcher
                    .decide(train, event.at, DispatchTrigger::Arrival)
                {
                    DispatchDecision::Cancel => train.status = OperatingStatus::Cancelled,
                    DispatchDecision::Proceed => {
                        self.schedule_departure(event.train_run_id, event.waypoint, event.at)
                    }
                    DispatchDecision::HoldUntil(until) => self.schedule_departure(
                        event.train_run_id,
                        event.waypoint,
                        until.max(event.at),
                    ),
                }
            }
            ScheduledKind::Depart => {
                match self
                    .dispatcher
                    .decide(train, event.at, DispatchTrigger::Departure)
                {
                    DispatchDecision::Cancel => {
                        train.status = OperatingStatus::Cancelled;
                        return;
                    }
                    DispatchDecision::HoldUntil(until) if until > event.at => {
                        self.schedule.insert(ScheduledEvent { at: until, ..event });
                        return;
                    }
                    DispatchDecision::Proceed | DispatchDecision::HoldUntil(_) => {}
                }
                let point = waypoint.operating_point.clone();
                kinds.push((
                    event.at,
                    EventKind::Departed {
                        train_run_id: train.id,
                        operating_point: point,
                    },
                ));
                if event.waypoint + 1 == train.route.len() {
                    train.status = OperatingStatus::Completed;
                    kinds.push((
                        event.at,
                        EventKind::Completed {
                            train_run_id: train.id,
                        },
                    ));
                } else {
                    train.next_waypoint += 1;
                    train.status = OperatingStatus::Running;
                    let next = &train.route[train.next_waypoint];
                    self.schedule.insert(ScheduledEvent {
                        at: next.arrival.saturating_add(train.delay_seconds),
                        train_run_id: train.id,
                        waypoint: train.next_waypoint,
                        kind: ScheduledKind::Arrive,
                    });
                }
            }
        }
    }

    fn schedule_departure(
        &mut self,
        train_run_id: TrainRunId,
        waypoint: usize,
        requested: SimTime,
    ) {
        let train = &self.trains[&train_run_id];
        let point = &train.route[waypoint];
        let at = requested
            .max(
                point
                    .arrival
                    .saturating_add(i64::from(point.minimum_dwell_seconds)),
            )
            .max(point.departure.saturating_add(train.delay_seconds.max(0)));
        if at > self.now {
            if let Some(train) = self.trains.get_mut(&train_run_id) {
                train.status = OperatingStatus::Waiting;
            }
        }
        self.schedule.insert(ScheduledEvent {
            at,
            train_run_id,
            waypoint,
            kind: ScheduledKind::Depart,
        });
    }

    fn reschedule_train(&mut self, train_run_id: TrainRunId) -> Result<(), SimError> {
        let train = self
            .trains
            .get(&train_run_id)
            .ok_or(SimError::UnknownTrain)?;
        let delay = train.delay_seconds;
        let waypoint = train.next_waypoint;
        let status = train.status;
        self.schedule
            .retain(|event| event.train_run_id != train_run_id);
        if matches!(status, OperatingStatus::Planned | OperatingStatus::Running) {
            let at = train.route[waypoint]
                .arrival
                .saturating_add(delay)
                .max(self.now);
            self.schedule.insert(ScheduledEvent {
                at,
                train_run_id,
                waypoint,
                kind: ScheduledKind::Arrive,
            });
        } else if matches!(
            status,
            OperatingStatus::AtPlatform | OperatingStatus::Waiting
        ) {
            let at = train.route[waypoint]
                .departure
                .saturating_add(delay.max(0))
                .max(self.now);
            self.schedule.insert(ScheduledEvent {
                at,
                train_run_id,
                waypoint,
                kind: ScheduledKind::Depart,
            });
        }
        Ok(())
    }

    /// Hinterlegt die veröffentlichte Propagationsregel eines Halts.
    pub fn set_delay_rule(
        &mut self,
        train_run_id: TrainRunId,
        waypoint: usize,
        rule: DelayRule,
    ) -> Result<(), SimError> {
        let train = self
            .trains
            .get(&train_run_id)
            .ok_or(SimError::UnknownTrain)?;
        if waypoint >= train.route.len() {
            return Err(SimError::InvalidRoute);
        }
        self.delay_rules.insert((train_run_id, waypoint), rule);
        Ok(())
    }

    fn events(&mut self, kinds: Vec<(SimTime, EventKind)>) -> Vec<DomainEvent> {
        kinds
            .into_iter()
            .map(|(at, kind)| {
                self.sequence += 1;
                DomainEvent {
                    world_id: self.world_id,
                    sequence: self.sequence,
                    at,
                    kind,
                }
            })
            .collect()
    }

    /// Fordert eine atomare Übergabe an. Bis zur Bestätigung bleibt der Zug im
    /// Besitz der Quellregion.
    pub fn request_handover(
        &mut self,
        train_run_id: TrainRunId,
        target_region: RegionId,
    ) -> Result<DomainEvent, SimError> {
        if !self.trains.contains_key(&train_run_id) {
            return Err(SimError::UnknownTrain);
        }
        let token = self.sequence.saturating_add(1)
            ^ train_run_id.rotate_left(17)
            ^ u64::from(target_region);
        self.pending_handovers.insert(
            token,
            PendingHandover {
                train_run_id,
                target_region,
            },
        );
        Ok(self
            .events(vec![(
                self.now,
                EventKind::HandoverRequested {
                    train_run_id,
                    token,
                    target_region,
                },
            )])
            .remove(0))
    }

    /// Öffentlicher Snapshot für einen neuen Livemap-Client.
    #[must_use]
    pub fn snapshot(&self) -> LiveSnapshot {
        LiveSnapshot {
            world_id: self.world_id,
            sequence: self.sequence,
            at: self.now,
            trains: self.trains.values().map(PublicTrain::from).collect(),
        }
    }

    /// Entfernt beendete Fahrten, deren letzte Planabfahrt vor der Grenze liegt.
    pub fn dematerialize_before(&mut self, before: SimTime) -> Vec<TrainRunId> {
        let removed: Vec<_> = self
            .trains
            .iter()
            .filter(|(_, train)| {
                matches!(
                    train.status,
                    OperatingStatus::Completed | OperatingStatus::Cancelled
                ) && train
                    .route
                    .last()
                    .is_some_and(|point| point.departure < before)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in &removed {
            self.trains.remove(id);
            self.schedule.retain(|event| event.train_run_id != *id);
            self.resource_owners.retain(|_, owner| owner != id);
        }
        removed
    }

    /// Kanonischer Zustand für Replay-/Bitgleichheitsprüfungen.
    #[must_use]
    pub fn canonical_state(&self) -> String {
        let mut out = format!(
            "{}|{}|{}|{}",
            self.world_id, self.region_id, self.now, self.sequence
        );
        for train in self.trains.values() {
            out.push_str(&format!(
                "|{}:{}:{}:{}:{}",
                train.id,
                train.next_waypoint,
                train.delay_seconds,
                train.position_mm,
                train.status as u8
            ));
        }
        out
    }

    /// Plattformunabhängiger Fingerabdruck des vollständigen Writer-Zustands.
    #[must_use]
    pub fn state_hash(&self) -> StateHash {
        let mut hasher = StateHasher::new("regional-simulation/v1");
        hasher
            .uint("world", self.world_id)
            .uint("region", u64::from(self.region_id))
            .int("now", self.now)
            .uint("sequence", self.sequence);
        for (id, train) in &self.trains {
            hasher
                .uint("train-id", *id)
                .uint(
                    "waypoint",
                    u64::try_from(train.next_waypoint).unwrap_or(u64::MAX),
                )
                .int("delay", train.delay_seconds)
                .int("position", train.position_mm)
                .uint("status", train.status as u64);
        }
        for event in &self.schedule {
            hasher
                .int("event-at", event.at)
                .uint("event-train", event.train_run_id)
                .uint(
                    "event-waypoint",
                    u64::try_from(event.waypoint).unwrap_or(u64::MAX),
                )
                .uint("event-kind", event.kind as u64);
        }
        hasher.finish()
    }
}

fn interpolate(train: &mut TrainRun, at: SimTime) {
    let next = &train.route[train.next_waypoint];
    let (start_position, start_time) = if train.next_waypoint == 0 {
        (0, 0)
    } else {
        let previous = &train.route[train.next_waypoint - 1];
        (
            previous.position_mm,
            previous.departure + train.delay_seconds,
        )
    };
    let end_time = next.arrival + train.delay_seconds;
    let duration = end_time.saturating_sub(start_time).max(1);
    let elapsed = at.saturating_sub(start_time).clamp(0, duration);
    let distance = next.position_mm.saturating_sub(start_position);
    train.position_mm = start_position.saturating_add(distance.saturating_mul(elapsed) / duration);
    train.speed_mm_per_second = u32::try_from(distance / duration).unwrap_or(u32::MAX);
    train.status = OperatingStatus::Running;
}

/// Ausschließlich öffentliche Livemap-Daten (E9).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicTrain {
    pub id: TrainRunId,
    pub operator: String,
    pub train_number: String,
    pub category: TrainCategory,
    pub position_mm: i64,
    pub speed_mm_per_second: u32,
    pub delay_seconds: i64,
    pub next_operating_point: String,
    pub status: OperatingStatus,
}
impl From<&TrainRun> for PublicTrain {
    fn from(train: &TrainRun) -> Self {
        Self {
            id: train.id,
            operator: train.operator.clone(),
            train_number: train.train_number.clone(),
            category: train.category.clone(),
            position_mm: train.position_mm,
            speed_mm_per_second: train.speed_mm_per_second,
            delay_seconds: train.delay_seconds,
            next_operating_point: train.route[train.next_waypoint].operating_point.clone(),
            status: train.status,
        }
    }
}

/// Initialsnapshot des sequenzierten Livemap-Protokolls.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveSnapshot {
    pub world_id: WorldId,
    pub sequence: u64,
    pub at: SimTime,
    pub trains: Vec<PublicTrain>,
}
/// Sequenzdelta; Clients müssen bei einer Lücke einen Snapshot nachladen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveDelta {
    pub world_id: WorldId,
    pub sequence: u64,
    pub at: SimTime,
    pub changed: Vec<PublicTrain>,
    pub removed: Vec<TrainRunId>,
}

/// Clientseitiges, transportneutrales Delta-Modell.
pub struct LiveView {
    pub world_id: WorldId,
    pub sequence: u64,
    pub at: SimTime,
    pub trains: BTreeMap<TrainRunId, PublicTrain>,
}
impl LiveView {
    #[must_use]
    pub fn from_snapshot(snapshot: LiveSnapshot) -> Self {
        Self {
            world_id: snapshot.world_id,
            sequence: snapshot.sequence,
            at: snapshot.at,
            trains: snapshot.trains.into_iter().map(|t| (t.id, t)).collect(),
        }
    }
    pub fn apply(&mut self, delta: LiveDelta) -> Result<(), SimError> {
        if delta.world_id != self.world_id {
            return Err(SimError::WrongWorld);
        }
        if delta.sequence != self.sequence + 1 {
            return Err(SimError::SequenceGap);
        }
        for train in delta.changed {
            self.trains.insert(train.id, train);
        }
        for id in delta.removed {
            self.trains.remove(&id);
        }
        self.sequence = delta.sequence;
        self.at = delta.at;
        Ok(())
    }
}

/// Zustandsbehafteter Publisher, der aus Kern-Snapshots lückenlose Livemap-
/// Deltas erzeugt. Seine Sequenz ist bewusst vom Domain-Event-Log getrennt:
/// ein Delta kann mehrere Domain-Ereignisse zusammenfassen.
pub struct DeltaPublisher {
    world_id: WorldId,
    sequence: u64,
    previous: BTreeMap<TrainRunId, PublicTrain>,
}

impl DeltaPublisher {
    /// Beginnt mit dem Initialsnapshot eines Clients.
    #[must_use]
    pub fn new(snapshot: &LiveSnapshot) -> Self {
        Self {
            world_id: snapshot.world_id,
            sequence: 0,
            previous: snapshot
                .trains
                .iter()
                .cloned()
                .map(|train| (train.id, train))
                .collect(),
        }
    }

    /// Erzeugt das nächste Delta, einschließlich expliziter Löschungen.
    pub fn publish(&mut self, snapshot: &LiveSnapshot) -> Result<LiveDelta, SimError> {
        if snapshot.world_id != self.world_id {
            return Err(SimError::WrongWorld);
        }
        let current: BTreeMap<_, _> = snapshot
            .trains
            .iter()
            .cloned()
            .map(|train| (train.id, train))
            .collect();
        let changed = current
            .iter()
            .filter(|(id, train)| self.previous.get(id) != Some(*train))
            .map(|(_, train)| train.clone())
            .collect();
        let removed = self
            .previous
            .keys()
            .filter(|id| !current.contains_key(id))
            .copied()
            .collect();
        self.sequence = self.sequence.saturating_add(1);
        self.previous = current;
        Ok(LiveDelta {
            world_id: self.world_id,
            sequence: self.sequence,
            at: snapshot.at,
            changed,
            removed,
        })
    }
}

/// Übergabeinhalt zwischen zwei regionalen Writern.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HandoverEnvelope {
    pub world_id: WorldId,
    pub source_region: RegionId,
    pub target_region: RegionId,
    pub token: u64,
    pub train: TrainRun,
    /// In der Zielregion vor Bestätigung atomar zu reservierende Ressourcen.
    pub resources: Vec<String>,
}

impl<D: Dispatcher> Simulation<D> {
    /// Erzeugt die vollständige Übergabe, ohne den Zug in der Quelle zu löschen.
    pub fn prepare_handover(
        &mut self,
        train_run_id: TrainRunId,
        target_region: RegionId,
    ) -> Result<(HandoverEnvelope, DomainEvent), SimError> {
        let train = self
            .trains
            .get(&train_run_id)
            .ok_or(SimError::UnknownTrain)?
            .clone();
        let event = self.request_handover(train_run_id, target_region)?;
        let EventKind::HandoverRequested { token, .. } = event.kind else {
            return Err(SimError::UnknownHandover);
        };
        Ok((
            HandoverEnvelope {
                world_id: self.world_id,
                source_region: self.region_id,
                target_region,
                token,
                train,
                resources: Vec::new(),
            },
            event,
        ))
    }

    /// Wie [`Self::prepare_handover`], einschließlich der ersten Belegung in
    /// der Zielregion.
    pub fn prepare_handover_with_resources(
        &mut self,
        train_run_id: TrainRunId,
        target_region: RegionId,
        resources: Vec<String>,
    ) -> Result<(HandoverEnvelope, DomainEvent), SimError> {
        let (mut envelope, event) = self.prepare_handover(train_run_id, target_region)?;
        envelope.resources = resources;
        Ok((envelope, event))
    }

    /// Nimmt eine Übergabe in der Zielregion an. Erst die erfolgreiche
    /// Materialisierung ist die Bestätigung an die Quelle.
    pub fn accept_handover(&mut self, envelope: &HandoverEnvelope) -> Result<Command, SimError> {
        if envelope.world_id != self.world_id {
            return Err(SimError::WrongWorld);
        }
        if envelope.target_region != self.region_id {
            return Err(SimError::WrongRegion);
        }
        if envelope
            .resources
            .iter()
            .any(|resource| self.resource_owners.contains_key(resource))
        {
            return Err(SimError::ResourceOccupied);
        }
        let mut train = envelope.train.clone();
        train.region_id = self.region_id;
        train.world_id = self.world_id;
        train.route[train.next_waypoint].arrival =
            train.route[train.next_waypoint].arrival.max(self.now);
        self.apply(Command::Materialize(train))?;
        for resource in &envelope.resources {
            self.resource_owners
                .insert(resource.clone(), envelope.train.id);
        }
        Ok(Command::ConfirmHandover {
            token: envelope.token,
            target_region: self.region_id,
        })
    }
}

/// Replay eines vollständigen Kommandologs.
pub fn replay<D: Dispatcher>(
    simulation: &mut Simulation<D>,
    commands: Vec<Command>,
) -> Result<Vec<DomainEvent>, SimError> {
    let mut events = Vec::new();
    for command in commands {
        events.extend(simulation.apply(command)?);
    }
    Ok(events)
}

/// Lokale Zeitangabe mit explizitem UTC-Offset. Der Kern ordnet nie selbst eine
/// Zeitzone zu; dadurch sind doppelte bzw. fehlende DST-Stunden eindeutig.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ZonedInstant {
    pub unix_seconds: i64,
    pub utc_offset_seconds: i32,
}
impl ZonedInstant {
    /// Eindeutige lokale Sekunde; der Offset ist Bestandteil der Identität.
    #[must_use]
    pub fn local_seconds(self) -> i64 {
        self.unix_seconds
            .saturating_add(i64::from(self.utc_offset_seconds))
    }
}

/// Ergebnis der expliziten Auflösung einer lokalen Sekunde an einer
/// Zeitumstellung. Der Kern rät weder bei Lücken noch bei Doppelstunden.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalTimeResolution {
    Unique(ZonedInstant),
    Gap,
    Ambiguous {
        earlier: ZonedInstant,
        later: ZonedInstant,
    },
}

/// Löst eine lokale Sekunde gegen die Offsets vor und nach einem bekannten
/// UTC-Übergang auf. Fahrplanperioden selbst bleiben stets auf UTC/Weltzeit.
#[must_use]
pub fn resolve_local_time(
    local_seconds: i64,
    transition_unix_seconds: i64,
    offset_before: i32,
    offset_after: i32,
) -> LocalTimeResolution {
    let before = ZonedInstant {
        unix_seconds: local_seconds.saturating_sub(i64::from(offset_before)),
        utc_offset_seconds: offset_before,
    };
    let after = ZonedInstant {
        unix_seconds: local_seconds.saturating_sub(i64::from(offset_after)),
        utc_offset_seconds: offset_after,
    };
    let before_valid = before.unix_seconds < transition_unix_seconds;
    let after_valid = after.unix_seconds >= transition_unix_seconds;
    match (before_valid, after_valid) {
        (true, true) => {
            if before.unix_seconds <= after.unix_seconds {
                LocalTimeResolution::Ambiguous {
                    earlier: before,
                    later: after,
                }
            } else {
                LocalTimeResolution::Ambiguous {
                    earlier: after,
                    later: before,
                }
            }
        }
        (true, false) => LocalTimeResolution::Unique(before),
        (false, true) => LocalTimeResolution::Unique(after),
        (false, false) => LocalTimeResolution::Gap,
    }
}

/// Lastmessung ohne Wanduhr: Der Aufrufer liefert die gemessene Dauer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoadReport {
    pub events: u64,
    pub elapsed_micros: u64,
    pub events_per_second: u64,
    pub target_met: bool,
}
#[must_use]
pub fn load_report(events: u64, elapsed_micros: u64) -> LoadReport {
    let events_per_second = if elapsed_micros == 0 {
        u64::MAX
    } else {
        events.saturating_mul(1_000_000) / elapsed_micros
    };
    LoadReport {
        events,
        elapsed_micros,
        events_per_second,
        target_met: events_per_second >= 200,
    }
}

/// Regelbasierte Verspätungsfortpflanzung an einem Halt. Planreserve und der
/// über die Mindesthaltezeit hinausgehende Aufenthalt bauen Verspätung ab; ein
/// gesicherter Anschluss kann sie bis zur festgelegten Wartezeit erhöhen.
#[must_use]
pub fn propagate_delay(
    incoming_delay_seconds: u32,
    recovery_seconds: u32,
    scheduled_dwell_seconds: u32,
    minimum_dwell_seconds: u32,
    connection_arrival_delay_seconds: Option<u32>,
    maximum_connection_wait_seconds: u32,
) -> u32 {
    let dwell_resistance = scheduled_dwell_seconds.saturating_sub(minimum_dwell_seconds);
    let after_resistance = incoming_delay_seconds
        .saturating_sub(recovery_seconds)
        .saturating_sub(dwell_resistance);
    let connection_wait = connection_arrival_delay_seconds
        .unwrap_or(0)
        .min(maximum_connection_wait_seconds);
    after_resistance.max(connection_wait)
}

/// Versionierbare Regelwiderstände eines konkreten Halts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DelayRule {
    pub recovery_seconds: u32,
    pub connection_arrival_delay_seconds: Option<u32>,
    pub maximum_connection_wait_seconds: u32,
}

/// Fehler des reinen Kernvertrags.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SimError {
    InvalidWindow,
    InvalidRoute,
    WrongWorld,
    WrongRegion,
    OutsideWindow,
    DuplicateTrain,
    UnknownTrain,
    TimeReversal,
    UnknownHandover,
    SequenceGap,
    ResourceOccupied,
}

/// Prüft, dass jede aktive Fahrt höchstens einmal vorkommt (Hilfsinvariante des Single-Writers).
#[must_use]
pub fn unique_train_ids(trains: &[TrainRun]) -> bool {
    trains.iter().map(|t| t.id).collect::<BTreeSet<_>>().len() == trains.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn train(world_id: WorldId, id: TrainRunId) -> TrainRun {
        TrainRun {
            world_id,
            id,
            region_id: 7,
            operator: "Elbtalbahn".into(),
            train_number: format!("RE {id}"),
            category: TrainCategory::Regional,
            route: vec![
                Waypoint {
                    operating_point: "Leipzig Hbf".into(),
                    position_mm: 10_000,
                    arrival: 100,
                    minimum_dwell_seconds: 30,
                    departure: 130,
                },
                Waypoint {
                    operating_point: "Halle Hbf".into(),
                    position_mm: 50_000_000,
                    arrival: 3_700,
                    minimum_dwell_seconds: 30,
                    departure: 3_730,
                },
            ],
            next_waypoint: 0,
            delay_seconds: 0,
            position_mm: 0,
            speed_mm_per_second: 0,
            status: OperatingStatus::Planned,
        }
    }
    fn sim() -> Simulation<ConservativeDispatcher> {
        Simulation::new(
            42,
            7,
            0,
            MaterializationWindow::new(48).unwrap(),
            ConservativeDispatcher,
        )
    }

    #[test]
    fn replay_is_bit_identical() {
        let commands = vec![
            Command::Materialize(train(42, 1)),
            Command::AddDelay {
                train_run_id: 1,
                seconds: 60,
            },
            Command::AdvanceTo(160),
            Command::AdvanceTo(4_000),
        ];
        let mut a = sim();
        let mut b = sim();
        assert_eq!(replay(&mut a, commands.clone()), replay(&mut b, commands));
        assert_eq!(a.canonical_state(), b.canonical_state());
    }
    #[test]
    fn handover_needs_confirmation() {
        let mut s = sim();
        s.apply(Command::Materialize(train(42, 1))).unwrap();
        let event = s.request_handover(1, 8).unwrap();
        let EventKind::HandoverRequested { token, .. } = event.kind else {
            panic!()
        };
        assert_eq!(s.snapshot().trains.len(), 1);
        s.apply(Command::ConfirmHandover {
            token,
            target_region: 8,
        })
        .unwrap();
        assert!(s.snapshot().trains.is_empty());
    }
    #[test]
    fn false_handover_confirmation_does_not_destroy_request() {
        let mut source = sim();
        source.apply(Command::Materialize(train(42, 1))).unwrap();
        let event = source.request_handover(1, 8).unwrap();
        let EventKind::HandoverRequested { token, .. } = event.kind else {
            panic!()
        };
        assert_eq!(
            source.apply(Command::ConfirmHandover {
                token,
                target_region: 9
            }),
            Err(SimError::WrongRegion)
        );
        source
            .apply(Command::ConfirmHandover {
                token,
                target_region: 8,
            })
            .unwrap();
    }

    #[test]
    fn two_regions_complete_the_confirmation_protocol() {
        let mut source = sim();
        let mut target = Simulation::new(
            42,
            8,
            0,
            MaterializationWindow::new(48).unwrap(),
            ConservativeDispatcher,
        );
        source.apply(Command::Materialize(train(42, 1))).unwrap();
        let (envelope, _) = source.prepare_handover(1, 8).unwrap();
        let confirmation = target.accept_handover(&envelope).unwrap();
        assert_eq!(source.snapshot().trains.len(), 1);
        source.apply(confirmation).unwrap();
        assert!(source.snapshot().trains.is_empty());
        assert_eq!(target.snapshot().trains.len(), 1);
    }
    #[test]
    fn target_confirms_handover_only_after_resource_reservation() {
        let mut source = sim();
        let mut target = Simulation::new(
            42,
            8,
            0,
            MaterializationWindow::new(48).unwrap(),
            ConservativeDispatcher,
        );
        source.apply(Command::Materialize(train(42, 1))).unwrap();
        let (envelope, _) = source
            .prepare_handover_with_resources(1, 8, vec!["block:L-H:1".into()])
            .unwrap();
        target.accept_handover(&envelope).unwrap();
        assert_eq!(
            target.accept_handover(&envelope),
            Err(SimError::ResourceOccupied)
        );
    }
    #[test]
    fn delta_rejects_gaps_and_other_worlds() {
        let mut view = LiveView::from_snapshot(sim().snapshot());
        assert_eq!(
            view.apply(LiveDelta {
                world_id: 42,
                sequence: 2,
                at: 1,
                changed: vec![],
                removed: vec![]
            }),
            Err(SimError::SequenceGap)
        );
        assert_eq!(
            view.apply(LiveDelta {
                world_id: 9,
                sequence: 1,
                at: 1,
                changed: vec![],
                removed: vec![]
            }),
            Err(SimError::WrongWorld)
        );
    }
    #[test]
    fn publisher_emits_changes_and_removals_with_own_sequence() {
        let mut simulation = sim();
        simulation
            .apply(Command::Materialize(train(42, 1)))
            .unwrap();
        let initial = simulation.snapshot();
        let mut publisher = DeltaPublisher::new(&initial);
        simulation
            .apply(Command::AddDelay {
                train_run_id: 1,
                seconds: 60,
            })
            .unwrap();
        let changed = publisher.publish(&simulation.snapshot()).unwrap();
        assert_eq!(changed.sequence, 1);
        assert_eq!(changed.changed.len(), 1);
        let (envelope, _) = simulation.prepare_handover(1, 8).unwrap();
        simulation
            .apply(Command::ConfirmHandover {
                token: envelope.token,
                target_region: 8,
            })
            .unwrap();
        let removed = publisher.publish(&simulation.snapshot()).unwrap();
        assert_eq!(removed.sequence, 2);
        assert_eq!(removed.removed, vec![1]);
    }

    #[test]
    fn large_time_jump_processes_every_event_at_its_own_time() {
        let mut simulation = sim();
        simulation
            .apply(Command::Materialize(train(42, 1)))
            .unwrap();
        let events = simulation.apply(Command::AdvanceTo(10_000)).unwrap();
        assert_eq!(
            events.iter().map(|event| event.at).collect::<Vec<_>>(),
            vec![100, 130, 3_700, 3_730, 3_730]
        );
        assert_eq!(
            simulation.snapshot().trains[0].status,
            OperatingStatus::Completed
        );
    }
    #[test]
    fn dst_fallback_is_unambiguous() {
        let summer = ZonedInstant {
            unix_seconds: 1_635_641_400,
            utc_offset_seconds: 7_200,
        };
        let winter = ZonedInstant {
            unix_seconds: 1_635_645_000,
            utc_offset_seconds: 3_600,
        };
        assert_eq!(summer.local_seconds(), winter.local_seconds());
        assert_ne!(summer.unix_seconds, winter.unix_seconds);
    }
    #[test]
    fn spring_gap_and_autumn_ambiguity_are_explicit() {
        assert_eq!(
            resolve_local_time(15_000, 10_000, 3_600, 7_200),
            LocalTimeResolution::Gap
        );
        assert!(matches!(
            resolve_local_time(15_000, 10_000, 7_200, 3_600),
            LocalTimeResolution::Ambiguous { .. }
        ));
    }
    #[test]
    fn load_target_is_explicit() {
        assert!(load_report(2_000_000, 10_000_000_000).target_met);
        assert!(!load_report(199, 1_000_000).target_met);
    }
    #[test]
    fn delay_uses_resistances_and_connection_wait() {
        assert_eq!(propagate_delay(300, 90, 120, 60, Some(240), 180), 180);
        assert_eq!(propagate_delay(300, 90, 120, 60, None, 180), 150);
    }
    #[test]
    fn configured_delay_rule_changes_the_running_train() {
        let mut simulation = sim();
        simulation
            .apply(Command::Materialize(train(42, 1)))
            .unwrap();
        simulation
            .set_delay_rule(
                1,
                0,
                DelayRule {
                    recovery_seconds: 30,
                    connection_arrival_delay_seconds: Some(120),
                    maximum_connection_wait_seconds: 90,
                },
            )
            .unwrap();
        simulation
            .apply(Command::AddDelay {
                train_run_id: 1,
                seconds: 180,
            })
            .unwrap();
        simulation.apply(Command::AdvanceTo(400)).unwrap();
        assert_eq!(simulation.snapshot().trains[0].delay_seconds, 150);
    }

    #[test]
    fn two_hundred_trains_run_for_twenty_four_hours() {
        let mut simulation = sim();
        for id in 1..=200 {
            let mut run = train(42, id);
            run.route[0].arrival += i64::try_from(id).unwrap();
            run.route[0].departure += i64::try_from(id).unwrap();
            run.route[1].arrival += i64::try_from(id).unwrap();
            run.route[1].departure += i64::try_from(id).unwrap();
            simulation.apply(Command::Materialize(run)).unwrap();
        }
        for hour in 1..=24 {
            simulation
                .apply(Command::AdvanceTo(i64::from(hour) * 3_600))
                .unwrap();
        }
        assert_eq!(simulation.snapshot().trains.len(), 200);
        assert!(
            simulation
                .snapshot()
                .trains
                .iter()
                .all(|train| train.status == OperatingStatus::Completed)
        );
    }
    #[test]
    fn materialization_is_bounded() {
        let mut s = sim();
        let mut t = train(42, 2);
        t.route[0].arrival = 72 * 3_600 + 1;
        assert_eq!(
            s.apply(Command::Materialize(t)),
            Err(SimError::OutsideWindow)
        );
    }
    #[test]
    fn rolling_materializer_emits_each_run_once() {
        let service = ServiceTemplate {
            service_id: 9,
            world_id: 42,
            region_id: 7,
            operator: "EVU".into(),
            train_number: "RE 9".into(),
            category: TrainCategory::Regional,
            first_departure: 0,
            interval_seconds: 3_600,
            last_departure: 200_000,
            relative_route: train(42, 9).route,
        };
        let mut materializer = RollingMaterializer::default();
        let first = materializer
            .materialize(
                0,
                MaterializationWindow::new(48).unwrap(),
                std::slice::from_ref(&service),
            )
            .unwrap();
        assert_eq!(first.len(), 49);
        let second = materializer
            .materialize(3_600, MaterializationWindow::new(48).unwrap(), &[service])
            .unwrap();
        assert_eq!(second.len(), 1);
    }
}
