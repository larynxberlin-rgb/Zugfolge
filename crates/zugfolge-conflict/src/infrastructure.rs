//! Die Infrastruktursicht der Konfliktengine.
//!
//! Der Betriebsgraph (M1.1) sagt, wo Gleise liegen. Für Sperrzeiten reicht das
//! nicht: Es braucht die **Blockteilung** eines Streckengleises (M1.6), die
//! **Fahrstraßen und ihre Ausschlussmengen** im Bahnhofskopf (M1.7) und die
//! **Sperrzeitparameter** je Betriebsstelle (M3.1). [`Infrastructure`] bündelt
//! genau diese vier Dinge und sonst nichts.
//!
//! ## Die konservative Annahme
//!
//! Ist für ein Streckengleis keine Blockteilung hinterlegt, gilt **das ganze
//! Gleis als ein Block**. Das kostet Kapazität, aber nie Sicherheit — und es
//! macht sichtbar, wo Daten fehlen, statt die Lücke als freie Fahrt zu
//! verkaufen. Dieselbe Haltung wie bei den virtuellen Blöcken aus M1.6.
//!
//! Ein Bahnhofsgleis wird **nicht** in Blöcke zerlegt: Auf ihm steht ein Zug,
//! und zwei Züge stehen dort nie gleichzeitig. Es ist als Ganzes eine
//! Konfliktressource.

use std::collections::BTreeMap;

use zugfolge_infra::{
    BlockSection, InterlockingPlan, Length, OperatingGraph, OperatingPointId, Track, TrackId,
    TrackOwner,
};

use crate::error::ConflictError;
use crate::resource::{ConflictResource, ResourceExclusions};
use crate::signalling::SignallingModel;

/// Ein Stück Gleis, das genau eine Konfliktressource belegt.
///
/// Anfang und Ende sind Positionen entlang der Kilometrierung des Gleises,
/// unabhängig von der Fahrtrichtung — `start` ist immer kleiner als `end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceSpan {
    resource: ConflictResource,
    start: Length,
    end: Length,
}

impl ResourceSpan {
    /// Die belegte Konfliktressource.
    pub const fn resource(&self) -> ConflictResource {
        self.resource
    }

    /// Der Anfang entlang der Kilometrierung.
    pub const fn start(&self) -> Length {
        self.start
    }

    /// Das Ende entlang der Kilometrierung.
    pub const fn end(&self) -> Length {
        self.end
    }

    /// Die Ausdehnung.
    pub fn length(&self) -> Length {
        self.end - self.start
    }
}

/// Alles, was die Konfliktengine über das Netz wissen muss.
#[derive(Clone, Debug)]
pub struct Infrastructure {
    graph: OperatingGraph,
    blocks: BTreeMap<TrackId, Vec<BlockSection>>,
    interlocking: BTreeMap<OperatingPointId, InterlockingPlan>,
    exclusions: ResourceExclusions,
    signalling: SignallingModel,
}

impl Infrastructure {
    /// Beginnt den Bau über einem geprüften Betriebsgraphen.
    pub fn builder(graph: OperatingGraph) -> InfrastructureBuilder {
        InfrastructureBuilder {
            graph,
            blocks: BTreeMap::new(),
            interlocking: BTreeMap::new(),
            signalling: SignallingModel::default(),
        }
    }

    /// Der zugrunde liegende Betriebsgraph.
    pub const fn graph(&self) -> &OperatingGraph {
        &self.graph
    }

    /// Die Sperrzeitparameter.
    pub const fn signalling(&self) -> &SignallingModel {
        &self.signalling
    }

    /// Die Ausschlussbeziehungen der Fahrstraßen.
    pub const fn exclusions(&self) -> &ResourceExclusions {
        &self.exclusions
    }

    /// Der Fahrstraßenplan einer Betriebsstelle, sofern bekannt.
    pub fn interlocking(&self, point: OperatingPointId) -> Option<&InterlockingPlan> {
        self.interlocking.get(&point)
    }

    /// Ein Gleis.
    ///
    /// # Errors
    ///
    /// [`ConflictError::UnknownTrack`], wenn das Gleis nicht im Graphen steht.
    pub fn track(&self, id: TrackId) -> Result<&Track, ConflictError> {
        self.graph.track(id).ok_or(ConflictError::UnknownTrack(id))
    }

    /// Die Konfliktressourcen eines Gleises, in Richtung der Kilometrierung
    /// geordnet und lückenlos.
    ///
    /// Ein Bahnhofsgleis liefert genau eine Ressource über seine volle Länge,
    /// ein Streckengleis seine Blockabschnitte — und ohne hinterlegte
    /// Blockteilung ebenfalls genau eine über die volle Länge.
    ///
    /// # Errors
    ///
    /// [`ConflictError::UnknownTrack`], wenn das Gleis nicht im Graphen steht.
    pub fn spans_of(&self, id: TrackId) -> Result<Vec<ResourceSpan>, ConflictError> {
        let track = self.track(id)?;
        if matches!(track.owner(), TrackOwner::OperatingPoint(_)) {
            return Ok(vec![ResourceSpan {
                resource: ConflictResource::Track(id),
                start: Length::ZERO,
                end: track.length(),
            }]);
        }

        match self.blocks.get(&id) {
            Some(sections) if !sections.is_empty() => Ok(sections
                .iter()
                .enumerate()
                .map(|(ordinal, section)| ResourceSpan {
                    resource: ConflictResource::Block {
                        track: id,
                        ordinal: u32::try_from(ordinal).unwrap_or(u32::MAX),
                    },
                    start: section.start(),
                    end: section.end(),
                })
                .collect()),
            _ => Ok(vec![ResourceSpan {
                resource: ConflictResource::Block {
                    track: id,
                    ordinal: 0,
                },
                start: Length::ZERO,
                end: track.length(),
            }]),
        }
    }

    /// Wie viele Blockabschnitte für ein Gleis hinterlegt sind.
    pub fn block_count(&self, id: TrackId) -> usize {
        self.blocks.get(&id).map_or(0, Vec::len)
    }
}

/// Der Erbauer einer [`Infrastructure`].
#[derive(Clone, Debug)]
pub struct InfrastructureBuilder {
    graph: OperatingGraph,
    blocks: BTreeMap<TrackId, Vec<BlockSection>>,
    interlocking: BTreeMap<OperatingPointId, InterlockingPlan>,
    signalling: SignallingModel,
}

impl InfrastructureBuilder {
    /// Hinterlegt die Blockteilung eines Streckengleises (M1.6).
    #[must_use]
    pub fn blocks(mut self, track: TrackId, sections: Vec<BlockSection>) -> Self {
        self.blocks.insert(track, sections);
        self
    }

    /// Hinterlegt den Fahrstraßenplan eines Bahnhofskopfs (M1.7).
    #[must_use]
    pub fn interlocking(mut self, plan: InterlockingPlan) -> Self {
        self.interlocking.insert(plan.operating_point(), plan);
        self
    }

    /// Setzt die Sperrzeitparameter.
    #[must_use]
    pub fn signalling(mut self, signalling: SignallingModel) -> Self {
        self.signalling = signalling;
        self
    }

    /// Prüft die Bezüge und baut die Infrastruktursicht.
    ///
    /// # Errors
    ///
    /// - [`ConflictError::UnknownTrack`], wenn eine Blockteilung ein Gleis
    ///   nennt, das der Graph nicht kennt, oder ein Blockabschnitt auf einem
    ///   anderen Gleis liegt als dem, unter dem er abgelegt ist.
    /// - [`ConflictError::BlocksOnStationTrack`], wenn für ein Bahnhofsgleis
    ///   eine Blockteilung hinterlegt ist — sie bliebe wirkungslos.
    /// - [`ConflictError::UnknownOperatingPoint`], wenn ein Fahrstraßenplan
    ///   eine Betriebsstelle nennt, die der Graph nicht kennt.
    pub fn build(self) -> Result<Infrastructure, ConflictError> {
        for (id, sections) in &self.blocks {
            let Some(track) = self.graph.track(*id) else {
                return Err(ConflictError::UnknownTrack(*id));
            };
            if sections.iter().any(|section| section.track() != *id) {
                return Err(ConflictError::UnknownTrack(*id));
            }
            if matches!(track.owner(), TrackOwner::OperatingPoint(_)) {
                return Err(ConflictError::BlocksOnStationTrack(*id));
            }
        }
        for point in self.interlocking.keys() {
            if self.graph.operating_point(*point).is_none() {
                return Err(ConflictError::UnknownOperatingPoint(*point));
            }
        }

        let exclusions = self
            .interlocking
            .values()
            .fold(ResourceExclusions::new(), |menge, plan| {
                menge.with_plan(plan)
            });

        Ok(Infrastructure {
            graph: self.graph,
            blocks: self.blocks,
            interlocking: self.interlocking,
            exclusions,
            signalling: self.signalling,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Infrastructure;
    use crate::error::ConflictError;
    use crate::resource::ConflictResource;
    use zugfolge_infra::{Length, OperatingPointId, TrackId, reference_network};

    #[test]
    fn ein_bahnhofsgleis_ist_eine_einzige_ressource() {
        let infra = Infrastructure::builder(reference_network())
            .build()
            .expect("gültige Infrastruktur");
        let spans = infra.spans_of(TrackId::new(101)).expect("bekanntes Gleis");
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0].resource(),
            ConflictResource::Track(TrackId::new(101))
        );
        assert_eq!(spans[0].start(), Length::ZERO);
        assert_eq!(spans[0].end(), Length::from_metres(800));
    }

    #[test]
    fn ein_streckengleis_ohne_blockteilung_gilt_als_ein_block() {
        // Die konservative Annahme: lieber ein zu großer Block als eine
        // Datenlücke, die als freie Fahrt durchgeht.
        let infra = Infrastructure::builder(reference_network())
            .build()
            .expect("gültige Infrastruktur");
        let spans = infra.spans_of(TrackId::new(1001)).expect("bekanntes Gleis");
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0].resource(),
            ConflictResource::Block {
                track: TrackId::new(1001),
                ordinal: 0
            }
        );
        assert_eq!(infra.block_count(TrackId::new(1001)), 0);
    }

    #[test]
    fn die_blockteilung_zerlegt_das_streckengleis_lueckenlos() {
        let infra = crate::example::reference_infrastructure();
        let spans = infra.spans_of(TrackId::new(1001)).expect("bekanntes Gleis");
        assert!(spans.len() > 1, "die Kante ist nicht geteilt");
        assert_eq!(spans[0].start(), Length::ZERO);
        assert_eq!(
            spans.last().expect("mindestens ein Span").end(),
            infra
                .track(TrackId::new(1001))
                .expect("bekanntes Gleis")
                .length()
        );
        for paar in spans.windows(2) {
            assert_eq!(
                paar[0].end(),
                paar[1].start(),
                "Lücke zwischen zwei Blöcken"
            );
        }
    }

    #[test]
    fn eine_blockteilung_am_bahnhofsgleis_faellt_beim_bau_auf() {
        // Sie bliebe wirkungslos — und wirkungslose Daten sind schlimmer als
        // fehlende, weil sie aussehen, als täten sie etwas.
        let netz = reference_network();
        let gleis = netz.track(TrackId::new(101)).expect("Bahnhofsgleis");
        let abschnitte = zugfolge_infra::derive_block_sections(
            gleis,
            &[],
            zugfolge_infra::DEFAULT_MAX_BLOCK_LENGTH,
            zugfolge_infra::SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
        )
        .expect("gültige Blockableitung");

        let ergebnis = Infrastructure::builder(netz)
            .blocks(TrackId::new(101), abschnitte)
            .build();
        assert!(matches!(
            ergebnis,
            Err(ConflictError::BlocksOnStationTrack(track)) if track == TrackId::new(101)
        ));
    }

    #[test]
    fn ein_unbekanntes_gleis_faellt_beim_bau_auf() {
        let ergebnis = Infrastructure::builder(reference_network())
            .blocks(TrackId::new(9999), Vec::new())
            .build();
        assert!(matches!(ergebnis, Err(ConflictError::UnknownTrack(_))));
    }

    #[test]
    fn eine_unbekannte_betriebsstelle_faellt_beim_bau_auf() {
        let plan = crate::example::reference_interlocking_plan(OperatingPointId::new(99));
        let ergebnis = Infrastructure::builder(reference_network())
            .interlocking(plan)
            .build();
        assert!(matches!(
            ergebnis,
            Err(ConflictError::UnknownOperatingPoint(_))
        ));
    }
}
