//! Reproduzierbare M4.11-Lastmessung; nur dieser aeussere Harnisch liest die Uhr.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use zugfolge_sim::{
    Command, ConservativeDispatcher, MaterializationWindow, OperatingStatus, Simulation,
    TrainCategory, TrainRun, Waypoint, load_report,
};

struct TrackingAllocator;

static CURRENT_ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);
static PEAK_ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

fn record_allocation(bytes: usize) {
    let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
    let current = CURRENT_ALLOCATED_BYTES
        .fetch_add(bytes, Ordering::Relaxed)
        .saturating_add(bytes);
    PEAK_ALLOCATED_BYTES.fetch_max(current, Ordering::Relaxed);
}

fn record_deallocation(bytes: usize) {
    let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
    let _ = CURRENT_ALLOCATED_BYTES.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(bytes))
    });
}

// SAFETY: Alle Operationen werden unveraendert an den System-Allocator
// weitergereicht; die atomaren Zaehler beobachten lediglich die Layoutgroesse.
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: Der Aufrufer garantiert ein gueltiges Layout gemaess GlobalAlloc.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record_deallocation(layout.size());
        // SAFETY: Pointer und Layout stammen aus dem zugehoerigen System-Allocator.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: Pointer und Layout stammen aus dem zugehoerigen System-Allocator.
        let replacement = unsafe { System.realloc(pointer, layout, new_size) };
        if !replacement.is_null() {
            record_deallocation(layout.size());
            record_allocation(new_size);
        }
        replacement
    }
}

#[global_allocator]
static GLOBAL_ALLOCATOR: TrackingAllocator = TrackingAllocator;

#[allow(
    clippy::disallowed_methods,
    reason = "M4.11 misst im aeusseren Last-Harnisch reale Laufzeit; die Simulationszeit des Kerns bleibt explizit"
)]
fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let comparison = arguments.first().is_some_and(|value| value == "comparison");
    let value_offset = usize::from(comparison);
    let train_count = arguments
        .get(value_offset)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(180_000);
    let waypoint_count = arguments
        .get(value_offset + 1)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(10);
    if waypoint_count < 2 {
        eprintln!("waypoint_count muss mindestens 2 sein");
        std::process::exit(2);
    }
    let mut simulation = Simulation::new(
        1,
        1,
        0,
        MaterializationWindow::new(72).expect("Fenster"),
        ConservativeDispatcher,
    );
    let started = Instant::now();
    let mut events = 0_u64;
    for id in 1..=train_count {
        let route = (0..waypoint_count)
            .map(|step| {
                let second = 60 + i64::from(step) * 600;
                Waypoint {
                    operating_point: format!("B{step}"),
                    position_mm: i64::from(step) * 10_000_000,
                    arrival: second,
                    minimum_dwell_seconds: 30,
                    departure: second + 30,
                }
            })
            .collect();
        events = events.saturating_add(
            u64::try_from(
                simulation
                    .apply(Command::Materialize(TrainRun {
                        world_id: 1,
                        id,
                        region_id: 1,
                        operator: "Last-EVU".into(),
                        train_number: format!("L{id}"),
                        category: TrainCategory::Regional,
                        route,
                        next_waypoint: 0,
                        delay_seconds: 0,
                        position_mm: 0,
                        speed_mm_per_second: 0,
                        status: OperatingStatus::Planned,
                    }))
                    .expect("Materialisierung")
                    .len(),
            )
            .expect("Ereigniszahl"),
        );
    }
    events = events.saturating_add(
        u64::try_from(
            simulation
                .apply(Command::AdvanceTo(86_400))
                .expect("Simulation")
                .len(),
        )
        .expect("Ereigniszahl"),
    );
    let micros = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    let report = load_report(events, micros);
    println!(
        "train_runs={train_count} waypoints_per_train={waypoint_count} events={} elapsed_us={} events_per_second={} peak_tracked_heap_bytes={} target_met={}",
        report.events,
        report.elapsed_micros,
        report.events_per_second,
        PEAK_ALLOCATED_BYTES.load(Ordering::Relaxed),
        report.target_met
    );
    if !comparison && (train_count < 120_000 || events < 2_000_000 || !report.target_met) {
        std::process::exit(1);
    }
}
