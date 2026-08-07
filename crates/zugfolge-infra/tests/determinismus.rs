//! Der Fingerabdruck des Betriebsgraphen.
//!
//! Ein `InfraRelease` ist erst dann ein Artefakt, wenn zwei Läufe, zwei
//! Betriebssysteme und zwei Jahre denselben Fingerabdruck ergeben. Der
//! Golden-Master hier ist der Nachweis dafür — die CI erzeugt ihn auf Linux
//! **und** auf Windows und vergleicht gegen dieselbe Datei.
//!
//! Ein geänderter Golden-Master ist entweder eine bewusste Änderung des
//! Modells oder ein Fehler. Beides muss im Commit begründet werden.

use zugfolge_determinism::{
    DeterministicModel, Scenario, WorldSeed, assert_deterministic, assert_golden, golden_path,
};
use zugfolge_infra::{
    BandProfile, Confidence, Coordinate, Electrification, Gradient, Length, OperatingGraph,
    OperatingGraphBuilder, OperatingPoint, OperatingPointCode, OperatingPointId,
    OperatingPointKind, PowerSystem, ProtectionSystem, Provenance, SourceId, Speed, SpeedLimit,
    Track, TrackEdge, TrackEdgeId, TrackId, TrackOwner, TrainProtection, reference_network,
};

#[test]
fn zwei_laeufe_ergeben_denselben_zustand() {
    let szenario = Scenario::new(WorldSeed::new(1, 1));
    let hash = assert_deterministic::<OperatingGraph, _>("betriebsgraph", &szenario, |_seed| {
        reference_network()
    });
    assert_eq!(hash.to_hex().len(), 64);
}

#[test]
fn der_golden_master_haelt() {
    assert_golden(
        golden_path!("operating-graph"),
        reference_network().state_hash(),
    );
}

#[test]
fn der_fingerabdruck_haengt_nicht_an_der_einfuegereihenfolge() {
    // Ein Import (M1.2) liest seine Quelle in der Reihenfolge, in der sie
    // geschrieben ist. Hinge der Fingerabdruck daran, wäre er als Prüfsumme
    // eines Infrastruktur-Release wertlos.
    let vorwaerts = baue([1_u32, 2, 3], [101_u32, 201, 301, 1001, 2001]);
    let rueckwaerts = baue([3, 2, 1], [2001, 1001, 301, 201, 101]);
    assert_eq!(vorwaerts.state_hash(), rueckwaerts.state_hash());
    assert_eq!(vorwaerts, rueckwaerts);
}

#[test]
fn ein_geaendertes_netz_ergibt_einen_anderen_fingerabdruck() {
    // Die Gegenprobe: Ohne sie prüfte der Golden-Master nur, dass irgendetwas
    // stabil ist — nicht, dass er das Netz beschreibt.
    let netz = baue([1_u32, 2, 3], [101_u32, 201, 301, 1001, 2001]);
    let kuerzer = OperatingGraphBuilder::new()
        .operating_point(punkt(1, "AA"))
        .operating_point(punkt(2, "BB"))
        .edge(kante(1, 1, 2))
        .track(gleis(
            101,
            TrackOwner::OperatingPoint(OperatingPointId::new(1)),
        ))
        .track(gleis(
            201,
            TrackOwner::OperatingPoint(OperatingPointId::new(2)),
        ))
        .track(gleis(1001, TrackOwner::Edge(TrackEdgeId::new(1))))
        .build()
        .expect("gültiges Netz");
    assert_ne!(netz.state_hash(), kuerzer.state_hash());
}

/// Baut dasselbe Dreipunktnetz in wählbarer Einfügereihenfolge.
fn baue(punkte: [u32; 3], gleise: [u32; 5]) -> OperatingGraph {
    let mut builder = OperatingGraphBuilder::new();
    for id in punkte {
        builder = builder.operating_point(punkt(id, kuerzel(id)));
    }
    builder = builder.edge(kante(1, 1, 2)).edge(kante(2, 2, 3));
    for id in gleise {
        builder = builder.track(gleis(id, ort(id)));
    }
    builder.build().expect("gültiges Netz")
}

fn kuerzel(id: u32) -> &'static str {
    match id {
        1 => "AA",
        2 => "BB",
        _ => "CC",
    }
}

fn ort(gleis: u32) -> TrackOwner {
    match gleis {
        1001 => TrackOwner::Edge(TrackEdgeId::new(1)),
        2001 => TrackOwner::Edge(TrackEdgeId::new(2)),
        101 => TrackOwner::OperatingPoint(OperatingPointId::new(1)),
        201 => TrackOwner::OperatingPoint(OperatingPointId::new(2)),
        _ => TrackOwner::OperatingPoint(OperatingPointId::new(3)),
    }
}

fn herkunft() -> Provenance {
    Provenance::new(
        SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
        Confidence::Surveyed,
    )
}

fn punkt(id: u32, code: &str) -> OperatingPoint {
    OperatingPoint::new(
        OperatingPointId::new(id),
        OperatingPointCode::new(code).expect("gültiges Kürzel"),
        format!("Betriebsstelle {id}"),
        OperatingPointKind::Station,
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
        LAENGE,
        herkunft(),
    )
    .expect("gültige Kante")
}

const LAENGE: Length = Length::from_metres(4_000);

fn gleis(id: u32, owner: TrackOwner) -> Track {
    Track::builder(TrackId::new(id), owner, "Gleis 1", LAENGE)
        .speed(
            BandProfile::uniform(
                "vmax",
                LAENGE,
                SpeedLimit::uniform(Speed::from_km_h(100)).expect("positiv"),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::uniform("neigung", LAENGE, Gradient::LEVEL, herkunft())
                .expect("Profil deckt das Gleis"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                LAENGE,
                Electrification::Overhead(PowerSystem::Ac15kV),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(
            BandProfile::uniform(
                "zugsicherung",
                LAENGE,
                TrainProtection::single(ProtectionSystem::Pzb),
                herkunft(),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis")
}
