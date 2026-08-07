//! Der Betriebsgraph als Ganzes: Bezüge, Abfragen und die Fehler, die beim
//! Bauen auffallen müssen.
//!
//! Die Einzelbausteine prüfen sich selbst — das steht in ihren Modultests. Hier
//! geht es um das, was erst im Verbund falsch sein kann: eine Kante ins Leere,
//! ein Bahnsteig am falschen Gleis, eine Betriebsstelle ohne Anschluss. Jeder
//! dieser Fälle ist einer, den der Import aus M1.2 in echten Daten finden wird.

use zugfolge_infra::{BandProfile, Coordinate, Gradient};
use zugfolge_infra::{
    Confidence, Electrification, InfraError, Length, OperatingGraphBuilder, OperatingPoint,
    OperatingPointCode, OperatingPointId, OperatingPointKind, Platform, PlatformId, PowerSystem,
    ProtectionSystem, Provenance, SourceId, Speed, SpeedLimit, Track, TrackDirection, TrackEdge,
    TrackEdgeId, TrackId, TrackKind, TrackOwner, TrainProtection,
};

fn herkunft() -> Provenance {
    Provenance::new(
        SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
        Confidence::Surveyed,
    )
}

fn punkt(id: u32, code: &str, kind: OperatingPointKind) -> OperatingPoint {
    OperatingPoint::new(
        OperatingPointId::new(id),
        OperatingPointCode::new(code).expect("gültiges Kürzel"),
        format!("Betriebsstelle {id}"),
        kind,
        Coordinate::new(510_000_000, 120_000_000).expect("Punkt liegt auf der Erde"),
        herkunft(),
    )
    .expect("gültige Betriebsstelle")
}

fn kante(id: u32, from: u32, to: u32) -> TrackEdge {
    TrackEdge::new(
        TrackEdgeId::new(id),
        OperatingPointId::new(from),
        OperatingPointId::new(to),
        format!("Kante {id}"),
        Length::from_metres(4_000),
        herkunft(),
    )
    .expect("gültige Kante")
}

fn gleis(id: u32, owner: TrackOwner, bezeichnung: &str, laenge: Length) -> Track {
    Track::builder(TrackId::new(id), owner, bezeichnung, laenge)
        .kind(TrackKind::ThroughMainTrack)
        .direction(TrackDirection::Bidirectional)
        .speed(
            BandProfile::uniform(
                "vmax",
                laenge,
                SpeedLimit::uniform(Speed::from_km_h(100)).expect("positiv"),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::uniform("neigung", laenge, Gradient::LEVEL, herkunft())
                .expect("Profil deckt das Gleis"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                laenge,
                Electrification::Overhead(PowerSystem::Ac15kV),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(
            BandProfile::uniform(
                "zugsicherung",
                laenge,
                TrainProtection::single(ProtectionSystem::Pzb),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis")
}

fn bahnsteig(id: u32, gleis: u32, start: Length, laenge: Length) -> Platform {
    Platform::new(
        PlatformId::new(id),
        TrackId::new(gleis),
        format!("Bahnsteig {id}"),
        start,
        laenge,
        Length::from_millimetres(760),
        herkunft(),
    )
    .expect("gültiger Bahnsteig")
}

/// Zwei Bahnhöfe, eine Kante, je ein Gleis — das kleinste vollständige Netz.
fn minimalnetz() -> OperatingGraphBuilder {
    OperatingGraphBuilder::new()
        .operating_point(punkt(1, "AA", OperatingPointKind::Station))
        .operating_point(punkt(2, "BB", OperatingPointKind::Station))
        .edge(kante(1, 1, 2))
        .track(gleis(
            101,
            TrackOwner::OperatingPoint(OperatingPointId::new(1)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .track(gleis(
            201,
            TrackOwner::OperatingPoint(OperatingPointId::new(2)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .track(gleis(
            1001,
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Streckengleis",
            Length::from_metres(4_000),
        ))
}

#[test]
fn ein_vollstaendiges_netz_wird_angenommen() {
    let netz = minimalnetz().build().expect("das Minimalnetz ist gültig");
    assert_eq!(netz.operating_point_count(), 2);
    assert_eq!(netz.edge_count(), 1);
    assert_eq!(netz.track_count(), 3);
    assert_eq!(netz.platform_count(), 0);
}

#[test]
fn ein_leerer_graph_ist_kein_netz() {
    assert_eq!(
        OperatingGraphBuilder::new().build().unwrap_err(),
        InfraError::EmptyGraph
    );
}

#[test]
fn eine_kante_ins_leere_faellt_auf() {
    let fehler = minimalnetz()
        .edge(kante(2, 1, 99))
        .track(gleis(
            2001,
            TrackOwner::Edge(TrackEdgeId::new(2)),
            "Streckengleis",
            Length::from_metres(4_000),
        ))
        .build()
        .expect_err("Betriebsstelle 99 gibt es nicht");
    assert_eq!(
        fehler,
        InfraError::UnknownEdgeEndpoint {
            edge: TrackEdgeId::new(2),
            point: OperatingPointId::new(99),
        }
    );
}

#[test]
fn eine_kante_auf_sich_selbst_faellt_auf() {
    let fehler = minimalnetz()
        .edge(kante(2, 1, 1))
        .track(gleis(
            2001,
            TrackOwner::Edge(TrackEdgeId::new(2)),
            "Streckengleis",
            Length::from_metres(4_000),
        ))
        .build()
        .expect_err("eine Kante von A nach A ist keine Strecke");
    assert_eq!(fehler, InfraError::SelfLoopEdge(TrackEdgeId::new(2)));
}

#[test]
fn eine_doppelt_vergebene_kennung_faellt_auf() {
    let fehler = minimalnetz()
        .track(gleis(
            101,
            TrackOwner::OperatingPoint(OperatingPointId::new(1)),
            "Gleis 2",
            Length::from_metres(500),
        ))
        .build()
        .expect_err("Gleis 101 gibt es schon");
    assert_eq!(fehler, InfraError::DuplicateTrack(TrackId::new(101)));
}

#[test]
fn ein_doppelt_vergebenes_kuerzel_faellt_auf() {
    let fehler = OperatingGraphBuilder::new()
        .operating_point(punkt(1, "AA", OperatingPointKind::Station))
        .operating_point(punkt(2, "AA", OperatingPointKind::Station))
        .build()
        .expect_err("ein Kürzel bezeichnet genau eine Betriebsstelle");
    assert!(matches!(
        fehler,
        InfraError::DuplicateOperatingPointCode { .. }
    ));
}

#[test]
fn zwei_gleiche_gleisbezeichnungen_am_selben_ort_fallen_auf() {
    let fehler = minimalnetz()
        .track(gleis(
            102,
            TrackOwner::OperatingPoint(OperatingPointId::new(1)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .build()
        .expect_err("zweimal 'Gleis 1' im selben Bahnhof macht jede Gleisangabe mehrdeutig");
    assert!(matches!(
        fehler,
        InfraError::DuplicateTrackDesignation { .. }
    ));
}

#[test]
fn gleiche_gleisbezeichnungen_an_verschiedenen_orten_sind_richtig() {
    // In jedem Bahnhof gibt es ein 'Gleis 1' — das ist keine Doppelvergabe,
    // sondern der Normalfall. Eine Regel, die das verböte, wäre unbrauchbar.
    let netz = minimalnetz().build().expect("das Minimalnetz ist gültig");
    assert_eq!(netz.track_count(), 3);
}

#[test]
fn ein_bahnsteig_an_einem_unbekannten_gleis_faellt_auf() {
    let fehler = minimalnetz()
        .platform(bahnsteig(1, 999, Length::ZERO, Length::from_metres(140)))
        .build()
        .expect_err("Gleis 999 gibt es nicht");
    assert_eq!(
        fehler,
        InfraError::UnknownPlatformTrack {
            platform: PlatformId::new(1),
            track: TrackId::new(999),
        }
    );
}

#[test]
fn ein_bahnsteig_auf_freier_strecke_faellt_auf() {
    let fehler = minimalnetz()
        .platform(bahnsteig(1, 1001, Length::ZERO, Length::from_metres(140)))
        .build()
        .expect_err("Bahnsteige gehören in eine Betriebsstelle");
    assert_eq!(
        fehler,
        InfraError::PlatformOnLine {
            platform: PlatformId::new(1),
            track: TrackId::new(1001),
        }
    );
}

#[test]
fn ein_ueber_das_gleis_hinausragender_bahnsteig_faellt_auf() {
    let fehler = minimalnetz()
        .platform(bahnsteig(
            1,
            101,
            Length::from_metres(400),
            Length::from_metres(200),
        ))
        .build()
        .expect_err("der Bahnsteig endet bei 600 m, das Gleis schon bei 500 m");
    assert_eq!(
        fehler,
        InfraError::PlatformOutsideTrack {
            platform: PlatformId::new(1),
            end: Length::from_metres(600),
            track_length: Length::from_metres(500),
        }
    );
}

#[test]
fn eine_kante_ohne_gleis_faellt_auf() {
    let fehler = OperatingGraphBuilder::new()
        .operating_point(punkt(1, "AA", OperatingPointKind::Station))
        .operating_point(punkt(2, "BB", OperatingPointKind::Station))
        .edge(kante(1, 1, 2))
        .track(gleis(
            101,
            TrackOwner::OperatingPoint(OperatingPointId::new(1)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .track(gleis(
            201,
            TrackOwner::OperatingPoint(OperatingPointId::new(2)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .build()
        .expect_err("auf einer Kante ohne Gleis könnte niemand fahren");
    assert_eq!(fehler, InfraError::EdgeWithoutTrack(TrackEdgeId::new(1)));
}

#[test]
fn eine_betriebsstelle_ohne_gleis_faellt_auf() {
    let fehler = minimalnetz()
        .operating_point(punkt(3, "CC", OperatingPointKind::Halt))
        .build()
        .expect_err("in einer Betriebsstelle ohne Gleis könnte kein Zug stehen");
    assert_eq!(
        fehler,
        InfraError::OperatingPointWithoutTrack(OperatingPointId::new(3))
    );
}

#[test]
fn eine_abgehaengte_betriebsstelle_faellt_auf() {
    let fehler = minimalnetz()
        .operating_point(punkt(3, "CC", OperatingPointKind::Halt))
        .track(gleis(
            301,
            TrackOwner::OperatingPoint(OperatingPointId::new(3)),
            "Gleis 1",
            Length::from_metres(500),
        ))
        .build()
        .expect_err("eine Betriebsstelle ohne Kante ist vom Netz getrennt");
    assert_eq!(
        fehler,
        InfraError::IsolatedOperatingPoint(OperatingPointId::new(3))
    );
}

#[test]
fn ein_gleis_ohne_ort_faellt_auf() {
    let fehler = minimalnetz()
        .track(gleis(
            9001,
            TrackOwner::Edge(TrackEdgeId::new(77)),
            "Streckengleis",
            Length::from_metres(4_000),
        ))
        .build()
        .expect_err("Kante 77 gibt es nicht");
    assert_eq!(fehler, InfraError::UnknownTrackOwner(TrackId::new(9001)));
}

#[test]
fn die_abfragen_liefern_in_fester_reihenfolge() {
    let netz = minimalnetz()
        .platform(bahnsteig(2, 101, Length::ZERO, Length::from_metres(140)))
        .platform(bahnsteig(
            1,
            101,
            Length::from_metres(200),
            Length::from_metres(140),
        ))
        .build()
        .expect("das Netz ist gültig");

    // Eingefügt wurde Bahnsteig 2 vor Bahnsteig 1 — geliefert wird nach
    // Kennung. Ohne diese Ordnung hinge jede spätere Ausgabe an der
    // Einfügereihenfolge.
    let bahnsteige: Vec<_> = netz
        .platforms_of(TrackId::new(101))
        .map(zugfolge_infra::Platform::id)
        .collect();
    assert_eq!(bahnsteige, vec![PlatformId::new(1), PlatformId::new(2)]);

    let gleise: Vec<_> = netz
        .tracks_of(TrackOwner::OperatingPoint(OperatingPointId::new(1)))
        .map(Track::id)
        .collect();
    assert_eq!(gleise, vec![TrackId::new(101)]);

    let nachbarn: Vec<_> = netz.neighbours(OperatingPointId::new(1)).collect();
    assert_eq!(nachbarn, vec![OperatingPointId::new(2)]);
    assert_eq!(netz.edges_at(OperatingPointId::new(2)).count(), 1);
}

#[test]
fn unbekannte_kennungen_liefern_nichts_statt_zu_scheitern() {
    let netz = minimalnetz().build().expect("das Netz ist gültig");
    assert!(netz.track(TrackId::new(999)).is_none());
    assert!(netz.operating_point(OperatingPointId::new(99)).is_none());
    assert!(netz.edge(TrackEdgeId::new(99)).is_none());
    assert!(netz.platform(PlatformId::new(99)).is_none());
    assert_eq!(netz.platforms_of(TrackId::new(999)).count(), 0);
    assert_eq!(netz.edges_at(OperatingPointId::new(99)).count(), 0);
}
