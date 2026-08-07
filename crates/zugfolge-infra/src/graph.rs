//! Der Betriebsgraph — die Bausteine als geprüftes Ganzes.
//!
//! Einzelne Betriebsstellen, Kanten, Gleise und Bahnsteige prüfen sich selbst.
//! Was sie **nicht** prüfen können, ist ihr Verhältnis zueinander: dass eine
//! Kante an einer Betriebsstelle endet, die es gibt; dass ein Bahnsteig an
//! einem Gleis liegt, das existiert; dass keine Betriebsstelle vom Netz
//! getrennt ist. Genau das tut [`OperatingGraphBuilder::build`], und zwar
//! vollständig, bevor irgendetwas den Graphen benutzen kann.
//!
//! Das ist Absicht: Ein `InfraRelease` ist unveränderlich (M1.12). Ein Fehler,
//! der beim Bauen nicht auffällt, fällt sonst zum ersten Mal auf, wenn eine
//! Welt schon drei Monate darauf läuft — und dann ist er nicht mehr behebbar,
//! ohne die Welt anzufassen.
//!
//! ## Der Fingerabdruck
//!
//! Der Graph implementiert [`DeterministicModel`] mit dem Kommandotyp
//! [`core::convert::Infallible`]. Das ist keine Verlegenheitslösung, sondern
//! die Aussage selbst: **Der Betriebsgraph nimmt keine Kommandos entgegen.** Er
//! ist ein Artefakt, kein Zustand. Was er beisteuert, ist ein kanonischer
//! Fingerabdruck — die Prüfsumme, mit der eine Welt ihren Infrastrukturstand
//! pinnt und ein Replay ihn wiedererkennt.

use core::convert::Infallible;
use std::collections::BTreeMap;

use zugfolge_determinism::{DeterministicModel, SimTime, StateHasher};

use crate::canonical::Canonical;
use crate::edge::TrackEdge;
use crate::error::InfraError;
use crate::identity::{OperatingPointId, PlatformId, TrackEdgeId, TrackId};
use crate::operating_point::OperatingPoint;
use crate::platform::Platform;
use crate::provenance::Confidence;
use crate::track::{Track, TrackOwner};

/// Ein geprüfter, unveränderlicher Betriebsgraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatingGraph {
    operating_points: BTreeMap<OperatingPointId, OperatingPoint>,
    edges: BTreeMap<TrackEdgeId, TrackEdge>,
    tracks: BTreeMap<TrackId, Track>,
    platforms: BTreeMap<PlatformId, Platform>,
    tracks_by_owner: BTreeMap<TrackOwner, Vec<TrackId>>,
    platforms_by_track: BTreeMap<TrackId, Vec<PlatformId>>,
    edges_by_point: BTreeMap<OperatingPointId, Vec<TrackEdgeId>>,
}

impl OperatingGraph {
    /// Beginnt den Bau eines Betriebsgraphen.
    pub fn builder() -> OperatingGraphBuilder {
        OperatingGraphBuilder::default()
    }

    /// Alle Betriebsstellen, nach Kennung geordnet.
    pub fn operating_points(&self) -> impl Iterator<Item = &OperatingPoint> {
        self.operating_points.values()
    }

    /// Alle Kanten, nach Kennung geordnet.
    pub fn edges(&self) -> impl Iterator<Item = &TrackEdge> {
        self.edges.values()
    }

    /// Alle Gleise, nach Kennung geordnet.
    pub fn tracks(&self) -> impl Iterator<Item = &Track> {
        self.tracks.values()
    }

    /// Alle Bahnsteige, nach Kennung geordnet.
    pub fn platforms(&self) -> impl Iterator<Item = &Platform> {
        self.platforms.values()
    }

    /// Eine Betriebsstelle zu ihrer Kennung.
    pub fn operating_point(&self, id: OperatingPointId) -> Option<&OperatingPoint> {
        self.operating_points.get(&id)
    }

    /// Eine Kante zu ihrer Kennung.
    pub fn edge(&self, id: TrackEdgeId) -> Option<&TrackEdge> {
        self.edges.get(&id)
    }

    /// Ein Gleis zu seiner Kennung.
    pub fn track(&self, id: TrackId) -> Option<&Track> {
        self.tracks.get(&id)
    }

    /// Ein Bahnsteig zu seiner Kennung.
    pub fn platform(&self, id: PlatformId) -> Option<&Platform> {
        self.platforms.get(&id)
    }

    /// Die Gleise einer Kante oder einer Betriebsstelle, nach Kennung geordnet.
    pub fn tracks_of(&self, owner: TrackOwner) -> impl Iterator<Item = &Track> {
        self.tracks_by_owner
            .get(&owner)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|id| self.tracks.get(id))
    }

    /// Die Bahnsteige an einem Gleis, nach Kennung geordnet.
    pub fn platforms_of(&self, track: TrackId) -> impl Iterator<Item = &Platform> {
        self.platforms_by_track
            .get(&track)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|id| self.platforms.get(id))
    }

    /// Die Kanten, die an einer Betriebsstelle enden, nach Kennung geordnet.
    pub fn edges_at(&self, point: OperatingPointId) -> impl Iterator<Item = &TrackEdge> {
        self.edges_by_point
            .get(&point)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|id| self.edges.get(id))
    }

    /// Die Betriebsstellen, die von einer aus über genau eine Kante erreichbar
    /// sind.
    pub fn neighbours(&self, point: OperatingPointId) -> impl Iterator<Item = OperatingPointId> {
        self.edges_at(point)
            .filter_map(move |edge| edge.other_end(point))
    }

    /// Anzahl der Betriebsstellen.
    pub fn operating_point_count(&self) -> usize {
        self.operating_points.len()
    }

    /// Anzahl der Kanten.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Anzahl der Gleise.
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Anzahl der Bahnsteige.
    pub fn platform_count(&self) -> usize {
        self.platforms.len()
    }

    /// Der schwächste Vertrauensgrad aller Gleisattribute des Graphen.
    ///
    /// Die eigentliche Abdeckungsmessung — je Attribut und je Streckenabschnitt
    /// — ist M1.4. Dies ist die eine Zahl darüber, und sie ist bewusst
    /// pessimistisch: Ein einziges angenommenes Attribut färbt den ganzen
    /// Graphen.
    pub fn confidence(&self) -> Confidence {
        self.tracks
            .values()
            .map(Track::confidence)
            .fold(Confidence::Surveyed, Confidence::weakest)
    }
}

impl DeterministicModel for OperatingGraph {
    /// Der Betriebsgraph nimmt keine Kommandos entgegen — er ist ein
    /// unveränderliches Artefakt.
    type Command = Infallible;

    const SCHEMA: &'static str = "operating-graph/v1";

    fn apply(&mut self, _at: SimTime, command: &Infallible) {
        // `Infallible` hat keine Werte: Dieser Zweig ist nicht erreichbar, und
        // der Compiler weiß das.
        match *command {}
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher.seq("betriebsstellen", self.operating_points.len());
        for betriebsstelle in self.operating_points.values() {
            betriebsstelle.write_canonical("betriebsstelle", hasher);
        }

        hasher.seq("kanten", self.edges.len());
        for kante in self.edges.values() {
            kante.write_canonical("kante", hasher);
        }

        hasher.seq("gleise", self.tracks.len());
        for gleis in self.tracks.values() {
            gleis.write_canonical("gleis", hasher);
        }

        hasher.seq("bahnsteige", self.platforms.len());
        for bahnsteig in self.platforms.values() {
            bahnsteig.write_canonical("bahnsteig", hasher);
        }
    }
}

/// Der Erbauer eines [`OperatingGraph`].
///
/// Die Reihenfolge der Aufrufe spielt keine Rolle: Geprüft und geordnet wird
/// erst in [`OperatingGraphBuilder::build`]. Ein Import (M1.2) liest seine
/// Quelle in der Reihenfolge, in der sie geschrieben ist — nicht in der, in der
/// der Graph sie braucht.
#[derive(Clone, Debug, Default)]
pub struct OperatingGraphBuilder {
    operating_points: Vec<OperatingPoint>,
    edges: Vec<TrackEdge>,
    tracks: Vec<Track>,
    platforms: Vec<Platform>,
}

impl OperatingGraphBuilder {
    /// Ein leerer Erbauer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Nimmt eine Betriebsstelle auf.
    #[must_use]
    pub fn operating_point(mut self, point: OperatingPoint) -> Self {
        self.operating_points.push(point);
        self
    }

    /// Nimmt eine Kante auf.
    #[must_use]
    pub fn edge(mut self, edge: TrackEdge) -> Self {
        self.edges.push(edge);
        self
    }

    /// Nimmt ein Gleis auf.
    #[must_use]
    pub fn track(mut self, track: Track) -> Self {
        self.tracks.push(track);
        self
    }

    /// Nimmt einen Bahnsteig auf.
    #[must_use]
    pub fn platform(mut self, platform: Platform) -> Self {
        self.platforms.push(platform);
        self
    }

    /// Prüft alle Bezüge und baut den Graphen.
    ///
    /// # Errors
    ///
    /// Eine der Varianten von [`InfraError`], die den Graphen betreffen — von
    /// der doppelt vergebenen Kennung bis zur Betriebsstelle ohne Anschluss.
    /// Gemeldet wird der **erste** Fund; der vollständige Bericht über alle
    /// Mängel eines Imports ist die Abdeckungsmessung aus M1.4, nicht diese
    /// Prüfung.
    pub fn build(self) -> Result<OperatingGraph, InfraError> {
        let operating_points = sammle(self.operating_points, OperatingPoint::id, |id| {
            InfraError::DuplicateOperatingPoint(id)
        })?;
        if operating_points.is_empty() {
            return Err(InfraError::EmptyGraph);
        }
        pruefe_kuerzel(&operating_points)?;

        let edges = sammle(self.edges, TrackEdge::id, InfraError::DuplicateEdge)?;
        let tracks = sammle(self.tracks, Track::id, InfraError::DuplicateTrack)?;
        let platforms = sammle(self.platforms, Platform::id, InfraError::DuplicatePlatform)?;

        let mut edges_by_point: BTreeMap<OperatingPointId, Vec<TrackEdgeId>> = BTreeMap::new();
        for edge in edges.values() {
            for ende in [edge.from(), edge.to()] {
                if !operating_points.contains_key(&ende) {
                    return Err(InfraError::UnknownEdgeEndpoint {
                        edge: edge.id(),
                        point: ende,
                    });
                }
            }
            if edge.from() == edge.to() {
                return Err(InfraError::SelfLoopEdge(edge.id()));
            }
            for ende in [edge.from(), edge.to()] {
                edges_by_point.entry(ende).or_default().push(edge.id());
            }
        }

        let mut tracks_by_owner: BTreeMap<TrackOwner, Vec<TrackId>> = BTreeMap::new();
        for track in tracks.values() {
            let bekannt = match track.owner() {
                TrackOwner::Edge(id) => edges.contains_key(&id),
                TrackOwner::OperatingPoint(id) => operating_points.contains_key(&id),
            };
            if !bekannt {
                return Err(InfraError::UnknownTrackOwner(track.id()));
            }
            tracks_by_owner
                .entry(track.owner())
                .or_default()
                .push(track.id());
        }
        pruefe_gleisbezeichnungen(&tracks_by_owner, &tracks)?;

        let mut platforms_by_track: BTreeMap<TrackId, Vec<PlatformId>> = BTreeMap::new();
        for platform in platforms.values() {
            let Some(track) = tracks.get(&platform.track()) else {
                return Err(InfraError::UnknownPlatformTrack {
                    platform: platform.id(),
                    track: platform.track(),
                });
            };
            if track.owner().operating_point().is_none() {
                return Err(InfraError::PlatformOnLine {
                    platform: platform.id(),
                    track: track.id(),
                });
            }
            if platform.end() > track.length() {
                return Err(InfraError::PlatformOutsideTrack {
                    platform: platform.id(),
                    end: platform.end(),
                    track_length: track.length(),
                });
            }
            platforms_by_track
                .entry(platform.track())
                .or_default()
                .push(platform.id());
        }

        for edge in edges.values() {
            if !tracks_by_owner.contains_key(&TrackOwner::Edge(edge.id())) {
                return Err(InfraError::EdgeWithoutTrack(edge.id()));
            }
        }
        for point in operating_points.values() {
            if !tracks_by_owner.contains_key(&TrackOwner::OperatingPoint(point.id())) {
                return Err(InfraError::OperatingPointWithoutTrack(point.id()));
            }
            if !edges_by_point.contains_key(&point.id()) {
                return Err(InfraError::IsolatedOperatingPoint(point.id()));
            }
        }

        Ok(OperatingGraph {
            operating_points,
            edges,
            tracks,
            platforms,
            tracks_by_owner,
            platforms_by_track,
            edges_by_point,
        })
    }
}

/// Legt Bausteine unter ihrer Kennung ab und meldet die erste Doppelvergabe.
fn sammle<T, K, F, E>(items: Vec<T>, kennung: K, doppelt: E) -> Result<BTreeMap<F, T>, InfraError>
where
    K: Fn(&T) -> F,
    F: Ord + Copy,
    E: Fn(F) -> InfraError,
{
    let mut abgelegt = BTreeMap::new();
    for item in items {
        let id = kennung(&item);
        if abgelegt.insert(id, item).is_some() {
            return Err(doppelt(id));
        }
    }
    Ok(abgelegt)
}

/// Ein Betriebsstellenkürzel bezeichnet genau eine Betriebsstelle.
fn pruefe_kuerzel(
    operating_points: &BTreeMap<OperatingPointId, OperatingPoint>,
) -> Result<(), InfraError> {
    let mut gesehen: BTreeMap<&str, OperatingPointId> = BTreeMap::new();
    for point in operating_points.values() {
        if let Some(erste) = gesehen.insert(point.code().as_str(), point.id()) {
            return Err(InfraError::DuplicateOperatingPointCode {
                code: point.code().as_str().to_owned(),
                first: erste,
                second: point.id(),
            });
        }
    }
    Ok(())
}

/// Zwei Gleise am selben Ort dürfen nicht gleich heißen — sonst ist jede
/// Gleisangabe im Fahrplan mehrdeutig.
fn pruefe_gleisbezeichnungen(
    tracks_by_owner: &BTreeMap<TrackOwner, Vec<TrackId>>,
    tracks: &BTreeMap<TrackId, Track>,
) -> Result<(), InfraError> {
    for gleise in tracks_by_owner.values() {
        let mut gesehen: BTreeMap<&str, TrackId> = BTreeMap::new();
        for id in gleise {
            let Some(track) = tracks.get(id) else {
                continue;
            };
            if let Some(erstes) = gesehen.insert(track.designation(), track.id()) {
                return Err(InfraError::DuplicateTrackDesignation {
                    designation: track.designation().to_owned(),
                    first: erstes,
                    second: track.id(),
                });
            }
        }
    }
    Ok(())
}
