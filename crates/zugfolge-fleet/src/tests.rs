use super::*;
use zugfolge_infra::{
    Confidence, Facility, FacilityCatalog, FleetCompetence, OpeningHours, Provenance, SourceId,
    TrackId,
};

fn interior(seats: u16) -> InteriorConfiguration {
    InteriorConfiguration {
        first_class_seats: 0,
        second_class_seats: seats,
        density: SeatingDensity::Standard,
        seat_type: SeatType::Row,
        multipurpose: MultipurposeArea {
            bicycles: 8,
            pushchairs: 4,
            wheelchairs: 2,
            standing: 40,
        },
        toilets: 1,
        accessible_toilets: 1,
        amenities: BTreeSet::from([Amenity::PassengerInformation]),
    }
}

fn configuration(doors: u8, width: u16, seats: u16) -> VehicleConfiguration {
    VehicleConfiguration::new(
        StructuralConfiguration::new(doors, width, Length::from_metres(70)).unwrap(),
        interior(seats),
    )
    .unwrap()
}

fn facilities() -> FacilityCatalog {
    let graph = zugfolge_infra::reference_network();
    let class = FleetClass::new("423").unwrap();
    let workshop = Facility::new(
        FacilityId::new(77),
        TrackId::new(311),
        "Bw Sandberg",
        FacilityKind::Workshop,
        1,
        OpeningHours::Continuous,
        Length::from_metres(100),
        FleetCompetence::single(class),
        Provenance::new(SourceId::new("test").unwrap(), Confidence::Assumed),
    )
    .unwrap();
    FacilityCatalog::builder()
        .facility(workshop)
        .build(&graph)
        .unwrap()
}

#[derive(Default)]
struct Ledger {
    debited: i64,
}
impl ConversionLedger for Ledger {
    fn debit_conversion(
        &mut self,
        _: WorldId,
        _: VehicleId,
        _: ConversionId,
        amount: i64,
    ) -> Result<(), FleetError> {
        self.debited = self.debited.saturating_add(amount);
        Ok(())
    }
}

#[test]
fn mehr_und_breitere_tueren_verkuerzen_die_haltezeit() {
    let narrow = configuration(2, 1_000, 100);
    let wide = configuration(4, 1_300, 80);
    assert!(wide.dwell_time_seconds(80, 60, 1) < narrow.dwell_time_seconds(80, 60, 1));
}

#[test]
fn werkstattumbau_belegt_kapazitaet_kostet_und_aendert_nur_den_innenraum() {
    let mut vehicle = Vehicle::new(
        5,
        9,
        FleetClass::new("423").unwrap(),
        Length::from_metres(70),
        configuration(4, 1_300, 100),
    )
    .unwrap();
    let structural = vehicle.configuration().structural().clone();
    let mut schedule = WorkshopSchedule::default();
    let mut ledger = Ledger::default();
    schedule
        .schedule(
            5,
            1,
            &vehicle,
            FacilityId::new(77),
            1_000,
            interior(80),
            ConversionQuote {
                cost_cents: 250_000,
                duration_seconds: 3_600,
            },
            &facilities(),
        )
        .unwrap();
    let other = Vehicle::new(
        5,
        10,
        FleetClass::new("423").unwrap(),
        Length::from_metres(70),
        configuration(4, 1_300, 90),
    )
    .unwrap();
    assert_eq!(
        schedule.schedule(
            5,
            2,
            &other,
            FacilityId::new(77),
            2_000,
            interior(70),
            ConversionQuote {
                cost_cents: 1,
                duration_seconds: 60
            },
            &facilities()
        ),
        Err(FleetError::CapacityExhausted)
    );
    assert_eq!(
        schedule.complete(5, 1, 4_599, &mut vehicle, &mut ledger),
        Err(FleetError::OrderNotDue)
    );
    schedule
        .complete(5, 1, 4_600, &mut vehicle, &mut ledger)
        .unwrap();
    assert_eq!(ledger.debited, 250_000);
    assert_eq!(vehicle.configuration().structural(), &structural);
    assert_eq!(vehicle.configuration().interior().second_class_seats, 80);
}

#[test]
fn bauliche_merkmale_sind_keine_umbauparameter() {
    let config = configuration(3, 1_200, 100);
    let target = interior(75);
    assert_eq!(config.structural().door_count_per_side(), 3);
    assert_eq!(target.second_class_seats, 75);
}
