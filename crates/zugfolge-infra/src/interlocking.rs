//! Fahrstraßen- und Durchrutschwegableitung im Bahnhofskopf — **M1.7**.
//!
//! `docs/daten.md` 1 nennt Fahrstraßen, Durchrutschwege und Flankenschutz als
//! den schwersten Einzelposten in M1: OSM führt sie nicht als Objekte, sie
//! müssen aus **Weichenlage und Signalstandort** erzeugt werden. Der Spike aus
//! M0.3 hat gezeigt, warum das so teuer ist (`docs/infrastruktur.md` 1): Der
//! Bahnhofskopf braucht **Ausschlussmengen** statt einzelner Ressourcen —
//! zwei Fahrstraßen, die sich eine Weiche oder ein Fahrwegelement teilen,
//! schließen einander aus, zwei über getrennte Elemente dürfen gleichzeitig
//! gestellt werden. Genau daran hängt die Kapazität eines Knotens.
//!
//! ## Das Modell des Bahnhofskopfs
//!
//! Der Kopf ist ein kleiner Graph: [`HeadElement`]e sind die belegbaren Stücke
//! Gleis, [`HeadNode`]s ihre Verbindungspunkte. Ein Knoten ist ein Endpunkt
//! (zur freien Strecke oder ans Gleisende), ein Stoß oder eine [`Switch`] —
//! eine Weiche mit Spitze, Stamm- und Zweiggleis. Durch eine Weiche führt ein
//! Fahrweg nur von der Spitze auf **eines** der beiden Zweige, nie von einem
//! Zweig auf den anderen; genau diese Bindung macht die [`SwitchPosition`]
//! einer Fahrstraße aus. Ein [`HeadSignal`] steht an einem Knotenende eines
//! Elements und gibt eine Fahrt in dieses Element frei — es ist der Beginn
//! einer Fahrstraße.
//!
//! ## Was abgeleitet wird
//!
//! [`derive_interlocking_routes`] zählt von jedem Signal aus alle Fahrwege
//! durch den Weichenfächer auf. Jede [`InterlockingRoute`] hält fest, welche
//! Elemente sie belegt und welche Weichen sie in welche Lage zwingt. Endet die
//! Fahrstraße an einem Signal, folgt der **[`OverlapPath`]** (Durchrutschweg)
//! dahinter — der Weg, der bei Bremsversagen frei bleiben muss, geradeaus über
//! die Grundstellung der folgenden Weichen bis zu einer Mindestlänge. Endet sie
//! am Prellbock oder Gleisende, gibt es keinen Durchrutschweg: der Endpunkt
//! selbst deckt.
//!
//! Aus dem Vergleich der belegten Elemente und der geforderten Weichenlagen
//! entsteht die **Ausschlussmenge** je Fahrstraße: die Fahrstraßen, die nicht
//! gleichzeitig mit ihr gestellt werden dürfen. Das ist die Konfliktressource,
//! die der Spike offengelassen hat (M3.1, M3.3).
//!
//! **Was diese Datei nicht ist: ein Import.** Wie M1.5 und M1.6 liefert M1.7
//! nur das Verfahren. Die Weichenlage und die Signalstandorte werden aus einem
//! genehmigten Extract gelesen, sobald ein eigener Import sie bereitstellt;
//! [`StationHead`] beschreibt den Kopf, gleich woher seine Daten stammen.

use std::collections::{BTreeMap, BTreeSet};

use crate::coverage::QualityClass;
use crate::error::InfraError;
use crate::identity::{
    HeadElementId, HeadNodeId, HeadSignalId, InterlockingRouteId, OperatingPointId, SwitchId,
};
use crate::provenance::Provenance;
use crate::units::Length;

/// Die Lage einer Weiche in einer Fahrstraße.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SwitchPosition {
    /// Grundstellung — der Fahrweg läuft von der Spitze auf das Stammgleis,
    /// geradeaus.
    Normal,
    /// Abzweigende Lage — der Fahrweg läuft von der Spitze auf das Zweiggleis.
    Reverse,
}

impl SwitchPosition {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Reverse => "reverse",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Normal => "Grundstellung",
            Self::Reverse => "abzweigend",
        }
    }
}

/// Die Art eines Knotens im Bahnhofskopf.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HeadNodeKind {
    /// Endpunkt — genau ein Element trifft hier auf die Außenwelt: die freie
    /// Strecke zu einem Nachbarn oder ein Gleisende (Prellbock).
    Terminus,
    /// Stoß — zwei Elemente stoßen aneinander, ohne Weiche.
    Joint,
    /// Weiche — drei Elemente treffen zusammen: Spitze, Stammgleis, Zweiggleis.
    Switch,
}

impl HeadNodeKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Terminus => "terminus",
            Self::Joint => "joint",
            Self::Switch => "switch",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Terminus => "Endpunkt",
            Self::Joint => "Stoß",
            Self::Switch => "Weiche",
        }
    }

    /// Wie viele Elemente an einem Knoten dieser Art zusammentreffen müssen.
    pub const fn required_degree(self) -> usize {
        match self {
            Self::Terminus => 1,
            Self::Joint => 2,
            Self::Switch => 3,
        }
    }
}

/// Ein Knoten im Bahnhofskopf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadNode {
    id: HeadNodeId,
    kind: HeadNodeKind,
}

impl HeadNode {
    /// Ein Knoten mit Kennung und Art.
    pub const fn new(id: HeadNodeId, kind: HeadNodeKind) -> Self {
        Self { id, kind }
    }

    /// Die Kennung.
    pub const fn id(&self) -> HeadNodeId {
        self.id
    }

    /// Die Art.
    pub const fn kind(&self) -> HeadNodeKind {
        self.kind
    }
}

/// Ein Fahrwegelement — das kleinste belegbare Stück Gleis im Bahnhofskopf.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadElement {
    id: HeadElementId,
    ends: [HeadNodeId; 2],
    length: Length,
}

impl HeadElement {
    /// Ein Element zwischen zwei Knoten.
    ///
    /// # Errors
    ///
    /// - [`InfraError::SelfLoopHeadElement`], wenn beide Enden derselbe Knoten
    ///   sind.
    /// - [`InfraError::NonPositiveLength`], wenn die Länge nicht positiv ist.
    pub fn new(
        id: HeadElementId,
        from: HeadNodeId,
        to: HeadNodeId,
        length: Length,
    ) -> Result<Self, InfraError> {
        if from == to {
            return Err(InfraError::SelfLoopHeadElement(id));
        }
        if !length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Fahrwegelement",
                value: length,
            });
        }
        Ok(Self {
            id,
            ends: [from, to],
            length,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> HeadElementId {
        self.id
    }

    /// Die beiden Knoten, zwischen denen das Element liegt.
    pub const fn ends(&self) -> [HeadNodeId; 2] {
        self.ends
    }

    /// Die Länge.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Der andere Knoten, wenn `node` einer der beiden Enden ist.
    fn other_end(&self, node: HeadNodeId) -> Option<HeadNodeId> {
        if self.ends[0] == node {
            Some(self.ends[1])
        } else if self.ends[1] == node {
            Some(self.ends[0])
        } else {
            None
        }
    }

    /// Ob der Knoten ein Ende dieses Elements ist.
    fn touches(&self, node: HeadNodeId) -> bool {
        self.ends[0] == node || self.ends[1] == node
    }
}

/// Eine Weiche — die Fahrwegverzweigung im Bahnhofskopf.
///
/// Die drei Elemente sind Spitze (`point`), Stammgleis (`normal`) und
/// Zweiggleis (`reverse`). Ein Fahrweg läuft von der Spitze auf das Stamm- oder
/// das Zweiggleis, nie von einem Zweig auf den anderen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switch {
    id: SwitchId,
    node: HeadNodeId,
    point: HeadElementId,
    normal: HeadElementId,
    reverse: HeadElementId,
}

impl Switch {
    /// Eine Weiche an einem Knoten mit Spitze, Stamm- und Zweiggleis.
    pub const fn new(
        id: SwitchId,
        node: HeadNodeId,
        point: HeadElementId,
        normal: HeadElementId,
        reverse: HeadElementId,
    ) -> Self {
        Self {
            id,
            node,
            point,
            normal,
            reverse,
        }
    }

    /// Die Kennung.
    pub const fn id(&self) -> SwitchId {
        self.id
    }

    /// Der Knoten, an dem die Weiche liegt.
    pub const fn node(&self) -> HeadNodeId {
        self.node
    }

    /// Das Spitzenelement.
    pub const fn point(&self) -> HeadElementId {
        self.point
    }

    /// Das Stammgleis (Grundstellung).
    pub const fn normal(&self) -> HeadElementId {
        self.normal
    }

    /// Das Zweiggleis (abzweigende Lage).
    pub const fn reverse(&self) -> HeadElementId {
        self.reverse
    }

    /// Die Lage, in der ein Zweigelement befahren wird.
    fn position_of(&self, branch: HeadElementId) -> Option<SwitchPosition> {
        if branch == self.normal {
            Some(SwitchPosition::Normal)
        } else if branch == self.reverse {
            Some(SwitchPosition::Reverse)
        } else {
            None
        }
    }
}

/// Ein Signal im Bahnhofskopf.
///
/// Das Signal steht am Knotenende `node` des Elements `element` und gibt eine
/// Fahrt vom Knoten in dieses Element frei. Es ist zugleich der Beginn einer
/// Fahrstraße und — für eine ankommende Fahrt — deren Ziel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadSignal {
    id: HeadSignalId,
    node: HeadNodeId,
    element: HeadElementId,
}

impl HeadSignal {
    /// Ein Signal am Knotenende `node` des Elements `element`.
    pub const fn new(id: HeadSignalId, node: HeadNodeId, element: HeadElementId) -> Self {
        Self { id, node, element }
    }

    /// Die Kennung.
    pub const fn id(&self) -> HeadSignalId {
        self.id
    }

    /// Der Knoten, an dem das Signal steht.
    pub const fn node(&self) -> HeadNodeId {
        self.node
    }

    /// Das Element, in das das Signal die Fahrt freigibt.
    pub const fn element(&self) -> HeadElementId {
        self.element
    }
}

/// Ein geprüfter Bahnhofskopf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StationHead {
    operating_point: OperatingPointId,
    nodes: BTreeMap<HeadNodeId, HeadNode>,
    elements: BTreeMap<HeadElementId, HeadElement>,
    switches: BTreeMap<SwitchId, Switch>,
    signals: BTreeMap<HeadSignalId, HeadSignal>,
    provenance: Provenance,
    elements_by_node: BTreeMap<HeadNodeId, Vec<HeadElementId>>,
    switch_by_node: BTreeMap<HeadNodeId, SwitchId>,
    signal_by_place: BTreeMap<(HeadNodeId, HeadElementId), HeadSignalId>,
}

impl StationHead {
    /// Beginnt den Bau eines Bahnhofskopfs.
    pub fn builder(
        operating_point: OperatingPointId,
        provenance: Provenance,
    ) -> StationHeadBuilder {
        StationHeadBuilder {
            operating_point,
            provenance,
            nodes: Vec::new(),
            elements: Vec::new(),
            switches: Vec::new(),
            signals: Vec::new(),
        }
    }

    /// Die Betriebsstelle, zu deren Kopf dieser Fächer gehört.
    pub const fn operating_point(&self) -> OperatingPointId {
        self.operating_point
    }

    /// Alle Knoten, nach Kennung geordnet.
    pub fn nodes(&self) -> impl Iterator<Item = &HeadNode> {
        self.nodes.values()
    }

    /// Alle Fahrwegelemente, nach Kennung geordnet.
    pub fn elements(&self) -> impl Iterator<Item = &HeadElement> {
        self.elements.values()
    }

    /// Alle Weichen, nach Kennung geordnet.
    pub fn switches(&self) -> impl Iterator<Item = &Switch> {
        self.switches.values()
    }

    /// Alle Signale, nach Kennung geordnet.
    pub fn signals(&self) -> impl Iterator<Item = &HeadSignal> {
        self.signals.values()
    }

    /// Ein Element zu seiner Kennung.
    pub fn element(&self, id: HeadElementId) -> Option<&HeadElement> {
        self.elements.get(&id)
    }

    /// Die Herkunft der Kopfdaten.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Die von einem Knoten wegführenden Fahrten: für jedes erreichbare
    /// Nachbarelement die Weichenlage, die es verlangt. `via` ist das Element,
    /// über das der Knoten erreicht wurde.
    fn onward(
        &self,
        node: HeadNodeId,
        via: HeadElementId,
    ) -> Vec<(HeadElementId, Option<(SwitchId, SwitchPosition)>)> {
        let kind = self.nodes.get(&node).map(HeadNode::kind);
        match kind {
            Some(HeadNodeKind::Terminus) | None => Vec::new(),
            Some(HeadNodeKind::Joint) => self
                .elements_by_node
                .get(&node)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|element| **element != via)
                .map(|element| (*element, None))
                .collect(),
            Some(HeadNodeKind::Switch) => {
                let Some(switch) = self
                    .switch_by_node
                    .get(&node)
                    .and_then(|id| self.switches.get(id))
                else {
                    return Vec::new();
                };
                if via == switch.point {
                    vec![
                        (switch.normal, Some((switch.id, SwitchPosition::Normal))),
                        (switch.reverse, Some((switch.id, SwitchPosition::Reverse))),
                    ]
                } else if let Some(position) = switch.position_of(via) {
                    // Von einem Zweig geht es nur auf die Spitze, und dabei
                    // steht die Weiche in der Lage dieses Zweigs.
                    vec![(switch.point, Some((switch.id, position)))]
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn signal_at(&self, node: HeadNodeId, element: HeadElementId) -> Option<HeadSignalId> {
        self.signal_by_place.get(&(node, element)).copied()
    }
}

/// Der Erbauer eines [`StationHead`].
#[derive(Clone, Debug)]
pub struct StationHeadBuilder {
    operating_point: OperatingPointId,
    provenance: Provenance,
    nodes: Vec<HeadNode>,
    elements: Vec<HeadElement>,
    switches: Vec<Switch>,
    signals: Vec<HeadSignal>,
}

impl StationHeadBuilder {
    /// Nimmt einen Knoten auf.
    #[must_use]
    pub fn node(mut self, node: HeadNode) -> Self {
        self.nodes.push(node);
        self
    }

    /// Nimmt ein Fahrwegelement auf.
    #[must_use]
    pub fn element(mut self, element: HeadElement) -> Self {
        self.elements.push(element);
        self
    }

    /// Nimmt eine Weiche auf.
    #[must_use]
    pub fn switch(mut self, switch: Switch) -> Self {
        self.switches.push(switch);
        self
    }

    /// Nimmt ein Signal auf.
    #[must_use]
    pub fn signal(mut self, signal: HeadSignal) -> Self {
        self.signals.push(signal);
        self
    }

    /// Prüft alle Bezüge und baut den Bahnhofskopf.
    ///
    /// # Errors
    ///
    /// Eine der Kopf-Varianten von [`InfraError`] — von der doppelt vergebenen
    /// Kennung über das Element ins Leere bis zur Weiche, die nicht genau die
    /// drei Elemente an ihrem Knoten nennt. Gemeldet wird der erste Fund.
    pub fn build(self) -> Result<StationHead, InfraError> {
        let nodes = sammle(self.nodes, HeadNode::id, InfraError::DuplicateHeadNode)?;
        let elements = sammle(
            self.elements,
            HeadElement::id,
            InfraError::DuplicateHeadElement,
        )?;
        if elements.is_empty() {
            return Err(InfraError::EmptyStationHead);
        }
        let switches = sammle(self.switches, Switch::id, InfraError::DuplicateSwitch)?;
        let signals = sammle(
            self.signals,
            HeadSignal::id,
            InfraError::DuplicateHeadSignal,
        )?;

        let mut elements_by_node: BTreeMap<HeadNodeId, Vec<HeadElementId>> = BTreeMap::new();
        for element in elements.values() {
            for ende in element.ends() {
                if !nodes.contains_key(&ende) {
                    return Err(InfraError::UnknownElementNode {
                        element: element.id(),
                        node: ende,
                    });
                }
                elements_by_node.entry(ende).or_default().push(element.id());
            }
        }

        for node in nodes.values() {
            let degree = elements_by_node.get(&node.id()).map_or(0, Vec::len);
            if degree != node.kind().required_degree() {
                return Err(InfraError::HeadNodeDegree {
                    node: node.id(),
                    kind: node.kind().label(),
                    expected: node.kind().required_degree(),
                    actual: degree,
                });
            }
        }

        let mut switch_by_node: BTreeMap<HeadNodeId, SwitchId> = BTreeMap::new();
        for switch in switches.values() {
            let ist_weiche = nodes
                .get(&switch.node())
                .is_some_and(|node| node.kind() == HeadNodeKind::Switch);
            let drei = [switch.point(), switch.normal(), switch.reverse()];
            let verschieden = drei[0] != drei[1] && drei[1] != drei[2] && drei[0] != drei[2];
            let liegen_am_knoten = drei.iter().all(|element| {
                elements
                    .get(element)
                    .is_some_and(|el| el.touches(switch.node()))
            });
            if !ist_weiche || !verschieden || !liegen_am_knoten {
                return Err(InfraError::SwitchNodeMismatch {
                    switch: switch.id(),
                });
            }
            switch_by_node.insert(switch.node(), switch.id());
        }

        // Jeder Weichenknoten braucht genau eine Weiche.
        for node in nodes.values() {
            if node.kind() == HeadNodeKind::Switch && !switch_by_node.contains_key(&node.id()) {
                return Err(InfraError::HeadNodeDegree {
                    node: node.id(),
                    kind: node.kind().label(),
                    expected: HeadNodeKind::Switch.required_degree(),
                    actual: 0,
                });
            }
        }

        let mut signal_by_place: BTreeMap<(HeadNodeId, HeadElementId), HeadSignalId> =
            BTreeMap::new();
        for signal in signals.values() {
            let passt = elements
                .get(&signal.element())
                .is_some_and(|element| element.touches(signal.node()));
            if !passt || !nodes.contains_key(&signal.node()) {
                return Err(InfraError::SignalPlacement {
                    signal: signal.id(),
                });
            }
            signal_by_place.insert((signal.node(), signal.element()), signal.id());
        }

        Ok(StationHead {
            operating_point: self.operating_point,
            nodes,
            elements,
            switches,
            signals,
            provenance: self.provenance,
            elements_by_node,
            switch_by_node,
            signal_by_place,
        })
    }
}

/// Wo eine Fahrstraße endet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteDestination {
    /// An einem Signal — dahinter folgt ein Durchrutschweg.
    Signal(HeadSignalId),
    /// An einem Endpunkt (Prellbock oder freie Strecke) — der Endpunkt selbst
    /// deckt, es gibt keinen Durchrutschweg.
    Terminus(HeadNodeId),
}

/// Der Durchrutschweg hinter dem Zielsignal einer Fahrstraße.
///
/// Der Weg, der bei Bremsversagen frei bleiben muss (`docs/glossar.md`). Er
/// führt geradeaus über die Grundstellung der folgenden Weichen bis zur
/// verlangten Mindestlänge oder bis zum nächsten Endpunkt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlapPath {
    elements: Vec<HeadElementId>,
    switches: BTreeMap<SwitchId, SwitchPosition>,
    length: Length,
}

impl OverlapPath {
    /// Die belegten Elemente, in Fahrtrichtung geordnet.
    pub fn elements(&self) -> &[HeadElementId] {
        &self.elements
    }

    /// Die Weichen, die der Durchrutschweg in eine Lage zwingt.
    pub const fn switches(&self) -> &BTreeMap<SwitchId, SwitchPosition> {
        &self.switches
    }

    /// Die überdeckte Länge.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Ob der Durchrutschweg leer ist — dann endet die Fahrstraße an einem
    /// deckenden Endpunkt.
    pub fn is_empty(&self) -> bool {
        self.elements.is_empty()
    }
}

/// Eine Fahrstraße durch einen Bahnhofskopf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterlockingRoute {
    id: InterlockingRouteId,
    from_signal: HeadSignalId,
    elements: Vec<HeadElementId>,
    switches: BTreeMap<SwitchId, SwitchPosition>,
    destination: RouteDestination,
    overlap: OverlapPath,
    class: QualityClass,
    excludes: BTreeSet<InterlockingRouteId>,
}

impl InterlockingRoute {
    /// Die Kennung.
    pub const fn id(&self) -> InterlockingRouteId {
        self.id
    }

    /// Das Signal, an dem die Fahrstraße beginnt.
    pub const fn from_signal(&self) -> HeadSignalId {
        self.from_signal
    }

    /// Die belegten Elemente, in Fahrtrichtung geordnet.
    pub fn elements(&self) -> &[HeadElementId] {
        &self.elements
    }

    /// Die Weichen, die die Fahrstraße in eine Lage zwingt.
    pub const fn switches(&self) -> &BTreeMap<SwitchId, SwitchPosition> {
        &self.switches
    }

    /// Wo die Fahrstraße endet.
    pub const fn destination(&self) -> RouteDestination {
        self.destination
    }

    /// Der Durchrutschweg hinter dem Zielsignal.
    pub const fn overlap(&self) -> &OverlapPath {
        &self.overlap
    }

    /// Die Qualitätsklasse — aus dem Vertrauensgrad der Kopfdaten.
    pub const fn class(&self) -> QualityClass {
        self.class
    }

    /// Die Ausschlussmenge: die Fahrstraßen, die nicht gleichzeitig mit dieser
    /// gestellt werden dürfen.
    pub const fn excludes(&self) -> &BTreeSet<InterlockingRouteId> {
        &self.excludes
    }
}

/// Das Ergebnis der Fahrstraßenableitung für einen Bahnhofskopf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterlockingPlan {
    operating_point: OperatingPointId,
    routes: BTreeMap<InterlockingRouteId, InterlockingRoute>,
}

impl InterlockingPlan {
    /// Die Betriebsstelle des Kopfs.
    pub const fn operating_point(&self) -> OperatingPointId {
        self.operating_point
    }

    /// Alle Fahrstraßen, nach Kennung geordnet.
    pub fn routes(&self) -> impl Iterator<Item = &InterlockingRoute> {
        self.routes.values()
    }

    /// Eine Fahrstraße zu ihrer Kennung.
    pub fn route(&self, id: InterlockingRouteId) -> Option<&InterlockingRoute> {
        self.routes.get(&id)
    }

    /// Anzahl der Fahrstraßen.
    pub fn route_count(&self) -> usize {
        self.routes.len()
    }

    /// Ob sich zwei Fahrstraßen ausschließen.
    pub fn conflict(&self, first: InterlockingRouteId, second: InterlockingRouteId) -> bool {
        self.routes
            .get(&first)
            .is_some_and(|route| route.excludes.contains(&second))
    }

    /// Die Ausschlussmenge einer Fahrstraße.
    pub fn exclusion_set(&self, id: InterlockingRouteId) -> Option<&BTreeSet<InterlockingRouteId>> {
        self.routes.get(&id).map(InterlockingRoute::excludes)
    }
}

/// Eine noch nicht nummerierte Fahrstraße, wie sie die Aufzählung liefert.
struct RawRoute {
    from_signal: HeadSignalId,
    elements: Vec<HeadElementId>,
    switches: Vec<(SwitchId, SwitchPosition)>,
    destination: RouteDestination,
    overlap_seed: Option<(HeadNodeId, HeadElementId)>,
}

/// Der laufende Zustand der Fahrstraßenaufzählung von einem Signal aus.
struct RouteWalk<'a> {
    head: &'a StationHead,
    from_signal: HeadSignalId,
    elements: Vec<HeadElementId>,
    switches: Vec<(SwitchId, SwitchPosition)>,
    out: Vec<RawRoute>,
}

impl RouteWalk<'_> {
    /// Setzt die Fahrstraße von `via` aus fort, nachdem sie an `node`
    /// angekommen ist.
    fn extend(&mut self, node: HeadNodeId, via: HeadElementId) {
        if self.head.nodes.get(&node).map(HeadNode::kind) == Some(HeadNodeKind::Terminus) {
            self.out.push(RawRoute {
                from_signal: self.from_signal,
                elements: self.elements.clone(),
                switches: self.switches.clone(),
                destination: RouteDestination::Terminus(node),
                overlap_seed: None,
            });
            return;
        }

        for (next, switch) in self.head.onward(node, via) {
            if self.elements.contains(&next) {
                // Kein Element zweimal — das schließt Kreise aus.
                continue;
            }
            if let Some(signal) = self.head.signal_at(node, next) {
                // Die Fahrstraße endet vor diesem Signal; die Weiche dieses
                // Knotens wird für den dahinterliegenden Durchrutschweg gestellt.
                let mut switches = self.switches.clone();
                if let Some(sw) = switch {
                    switches.push(sw);
                }
                self.out.push(RawRoute {
                    from_signal: self.from_signal,
                    elements: self.elements.clone(),
                    switches,
                    destination: RouteDestination::Signal(signal),
                    overlap_seed: Some((node, next)),
                });
            } else {
                self.elements.push(next);
                if let Some(sw) = switch {
                    self.switches.push(sw);
                }
                if let Some(weiter) = self
                    .head
                    .elements
                    .get(&next)
                    .and_then(|element| element.other_end(node))
                {
                    self.extend(weiter, next);
                }
                if switch.is_some() {
                    self.switches.pop();
                }
                self.elements.pop();
            }
        }
    }
}

/// Verfolgt den Durchrutschweg hinter einem Zielsignal geradeaus.
fn walk_overlap(
    head: &StationHead,
    node: HeadNodeId,
    first: HeadElementId,
    overlap_length: Length,
    route_elements: &BTreeSet<HeadElementId>,
) -> OverlapPath {
    let mut elements = Vec::new();
    let mut switches: BTreeMap<SwitchId, SwitchPosition> = BTreeMap::new();
    let mut visited = route_elements.clone();
    let mut accumulated = Length::ZERO;
    let mut at = node;
    let mut current = first;

    loop {
        if visited.contains(&current) {
            break;
        }
        let Some(element) = head.elements.get(&current) else {
            break;
        };
        visited.insert(current);
        elements.push(current);
        accumulated = accumulated + element.length();
        if accumulated >= overlap_length {
            break;
        }
        let Some(next_node) = element.other_end(at) else {
            break;
        };
        // Geradeaus weiter: die erste (Grundstellungs-)Fortsetzung.
        let Some((next, switch)) = head.onward(next_node, current).into_iter().next() else {
            break;
        };
        if let Some((id, position)) = switch {
            switches.insert(id, position);
        }
        at = next_node;
        current = next;
    }

    OverlapPath {
        elements,
        switches,
        length: accumulated,
    }
}

/// Die von einer Fahrstraße samt Durchrutschweg belegten Ressourcen.
struct Locked {
    elements: BTreeSet<HeadElementId>,
    switches: BTreeMap<SwitchId, SwitchPosition>,
}

impl Locked {
    fn of(route: &InterlockingRoute) -> Self {
        let mut elements: BTreeSet<HeadElementId> = route.elements.iter().copied().collect();
        elements.extend(route.overlap.elements.iter().copied());
        let mut switches = route.switches.clone();
        for (id, position) in &route.overlap.switches {
            switches.entry(*id).or_insert(*position);
        }
        Self { elements, switches }
    }

    /// Ob sich zwei Belegungen ausschließen: ein gemeinsames Element, oder eine
    /// gemeinsame Weiche in unterschiedlicher Lage.
    fn conflicts_with(&self, other: &Self) -> bool {
        if self.elements.intersection(&other.elements).next().is_some() {
            return true;
        }
        self.switches.iter().any(|(id, position)| {
            other
                .switches
                .get(id)
                .is_some_and(|andere| andere != position)
        })
    }
}

/// Leitet die Fahrstraßen und Durchrutschwege eines Bahnhofskopfs aus seiner
/// Weichenlage und seinen Signalen ab.
///
/// `overlap_length` ist die Mindestlänge, die ein Durchrutschweg hinter einem
/// Zielsignal frei halten muss.
///
/// # Errors
///
/// [`InfraError::NonPositiveLength`], wenn `overlap_length` nicht positiv ist.
pub fn derive_interlocking_routes(
    head: &StationHead,
    overlap_length: Length,
) -> Result<InterlockingPlan, InfraError> {
    if !overlap_length.is_positive() {
        return Err(InfraError::NonPositiveLength {
            what: "Durchrutschweglänge",
            value: overlap_length,
        });
    }

    // Von jedem Signal aus alle Fahrwege aufzählen.
    let mut raw: Vec<RawRoute> = Vec::new();
    for signal in head.signals.values() {
        let Some(element) = head.elements.get(&signal.element()) else {
            continue;
        };
        let Some(next_node) = element.other_end(signal.node()) else {
            continue;
        };
        let mut walk = RouteWalk {
            head,
            from_signal: signal.id(),
            elements: vec![signal.element()],
            switches: Vec::new(),
            out: Vec::new(),
        };
        walk.extend(next_node, signal.element());
        raw.append(&mut walk.out);
    }

    // Stabile Reihenfolge unabhängig vom Aufzählungsweg: nach Startsignal und
    // Elementfolge. Daran hängen die vergebenen Kennungen.
    raw.sort_by(|a, b| (a.from_signal, &a.elements).cmp(&(b.from_signal, &b.elements)));

    let class = QualityClass::from_confidence(head.provenance().confidence());
    let mut ordered: Vec<InterlockingRoute> = Vec::with_capacity(raw.len());
    for (index, route) in raw.into_iter().enumerate() {
        let id = InterlockingRouteId::new(u32::try_from(index + 1).unwrap_or(u32::MAX));
        let route_elements: BTreeSet<HeadElementId> = route.elements.iter().copied().collect();
        let overlap = match route.overlap_seed {
            Some((node, first)) => walk_overlap(head, node, first, overlap_length, &route_elements),
            None => OverlapPath {
                elements: Vec::new(),
                switches: BTreeMap::new(),
                length: Length::ZERO,
            },
        };
        ordered.push(InterlockingRoute {
            id,
            from_signal: route.from_signal,
            elements: route.elements,
            switches: route.switches.into_iter().collect(),
            destination: route.destination,
            overlap,
            class,
            excludes: BTreeSet::new(),
        });
    }

    // Ausschlussmengen aus den belegten Ressourcen.
    let locked: Vec<Locked> = ordered.iter().map(Locked::of).collect();
    let mut excludes: Vec<BTreeSet<InterlockingRouteId>> = vec![BTreeSet::new(); ordered.len()];
    for (i, links) in locked.iter().enumerate() {
        for (j, rechts) in locked.iter().enumerate() {
            if i != j && links.conflicts_with(rechts) {
                excludes[i].insert(ordered[j].id);
            }
        }
    }
    for (route, menge) in ordered.iter_mut().zip(excludes) {
        route.excludes = menge;
    }

    let routes = ordered.into_iter().map(|route| (route.id, route)).collect();

    Ok(InterlockingPlan {
        operating_point: head.operating_point(),
        routes,
    })
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

#[cfg(test)]
mod tests {
    use super::{
        HeadElement, HeadNode, HeadNodeKind, HeadSignal, RouteDestination, StationHead, Switch,
        SwitchPosition, derive_interlocking_routes,
    };
    use crate::coverage::QualityClass;
    use crate::error::InfraError;
    use crate::identity::{
        HeadElementId, HeadNodeId, HeadSignalId, InterlockingRouteId, OperatingPointId, SwitchId,
    };
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::units::Length;

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            confidence,
        )
    }

    fn node(id: u32, kind: HeadNodeKind) -> HeadNode {
        HeadNode::new(HeadNodeId::new(id), kind)
    }

    fn element(id: u32, from: u32, to: u32, laenge_m: i64) -> HeadElement {
        HeadElement::new(
            HeadElementId::new(id),
            HeadNodeId::new(from),
            HeadNodeId::new(to),
            Length::from_metres(laenge_m),
        )
        .expect("gültiges Element")
    }

    fn signal(id: u32, node: u32, element: u32) -> HeadSignal {
        HeadSignal::new(
            HeadSignalId::new(id),
            HeadNodeId::new(node),
            HeadElementId::new(element),
        )
    }

    /// Ein Überleitkopf einer zweigleisigen Strecke mit zwei Bahnsteiggleisen
    /// und einer Verbindung zwischen den beiden Streckengleisen.
    ///
    /// ```text
    ///   LWa ─eWa─ (W1) ─e1─ P1        LWb ─eWb─ (W2) ─e2─ P2
    ///                  \                            /
    ///                   ╰────────── eC ────────────╯
    /// ```
    /// W1: Spitze eWa, Stamm e1, Zweig eC. W2: Spitze eWb, Stamm e2, Zweig eC.
    fn ueberleitkopf() -> StationHead {
        StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus)) // LWa
            .node(node(2, HeadNodeKind::Terminus)) // LWb
            .node(node(3, HeadNodeKind::Switch)) // W1
            .node(node(4, HeadNodeKind::Switch)) // W2
            .node(node(5, HeadNodeKind::Terminus)) // P1
            .node(node(6, HeadNodeKind::Terminus)) // P2
            .element(element(10, 1, 3, 300)) // eWa: LWa–W1
            .element(element(11, 2, 4, 300)) // eWb: LWb–W2
            .element(element(12, 3, 5, 400)) // e1: W1–P1
            .element(element(13, 4, 6, 400)) // e2: W2–P2
            .element(element(14, 3, 4, 120)) // eC: W1–W2
            .switch(Switch::new(
                SwitchId::new(1),
                HeadNodeId::new(3),
                HeadElementId::new(10), // point eWa
                HeadElementId::new(12), // normal e1
                HeadElementId::new(14), // reverse eC
            ))
            .switch(Switch::new(
                SwitchId::new(2),
                HeadNodeId::new(4),
                HeadElementId::new(11), // point eWb
                HeadElementId::new(13), // normal e2
                HeadElementId::new(14), // reverse eC
            ))
            .signal(signal(1, 1, 10)) // Einfahrt von LWa in eWa
            .signal(signal(2, 2, 11)) // Einfahrt von LWb in eWb
            .build()
            .expect("gültiger Bahnhofskopf")
    }

    #[test]
    fn der_kopf_liefert_die_erwarteten_fahrstrassen() {
        let plan = derive_interlocking_routes(&ueberleitkopf(), Length::from_metres(100))
            .expect("gültige Ableitung");
        // Von LWa: nach P1 (gerade) und nach LWb (über die Verbindung). Von LWb
        // symmetrisch. Vier Fahrstraßen.
        assert_eq!(plan.route_count(), 4);
    }

    #[test]
    fn eine_fahrstrasse_haelt_ihre_weichenlagen_fest() {
        let plan = derive_interlocking_routes(&ueberleitkopf(), Length::from_metres(100))
            .expect("gültige Ableitung");
        // Die Fahrt von LWa nach P1 läuft gerade über W1 (Grundstellung) und
        // rührt W2 nicht an.
        let nach_p1 = plan
            .routes()
            .find(|route| route.elements() == [HeadElementId::new(10), HeadElementId::new(12)])
            .expect("Fahrstraße LWa → P1");
        assert_eq!(
            nach_p1.destination(),
            RouteDestination::Terminus(HeadNodeId::new(5))
        );
        assert_eq!(
            nach_p1.switches().get(&SwitchId::new(1)),
            Some(&SwitchPosition::Normal)
        );
        assert!(nach_p1.switches().get(&SwitchId::new(2)).is_none());
        // Ein Endpunkt deckt selbst — kein Durchrutschweg.
        assert!(nach_p1.overlap().is_empty());

        // Die Überleitfahrt von LWa nach LWb zwingt beide Weichen in die
        // abzweigende Lage.
        let ueberleit = plan
            .routes()
            .find(|route| {
                route.elements()
                    == [
                        HeadElementId::new(10),
                        HeadElementId::new(14),
                        HeadElementId::new(11),
                    ]
            })
            .expect("Fahrstraße LWa → LWb");
        assert_eq!(
            ueberleit.switches().get(&SwitchId::new(1)),
            Some(&SwitchPosition::Reverse)
        );
        assert_eq!(
            ueberleit.switches().get(&SwitchId::new(2)),
            Some(&SwitchPosition::Reverse)
        );
    }

    #[test]
    fn parallele_fahrten_schliessen_sich_nicht_aus() {
        let plan = derive_interlocking_routes(&ueberleitkopf(), Length::from_metres(100))
            .expect("gültige Ableitung");
        let nach_p1 = plan
            .routes()
            .find(|route| route.elements() == [HeadElementId::new(10), HeadElementId::new(12)])
            .expect("LWa → P1");
        let nach_p2 = plan
            .routes()
            .find(|route| route.elements() == [HeadElementId::new(11), HeadElementId::new(13)])
            .expect("LWb → P2");
        // LWa → P1 und LWb → P2 teilen kein Element und keine Weiche: beide
        // dürfen gleichzeitig gestellt werden. Das ist der Sinn der
        // Ausschlussmenge — sie sperrt nur, was sich wirklich in die Quere kommt.
        assert!(!plan.conflict(nach_p1.id(), nach_p2.id()));
        assert!(!nach_p1.excludes().contains(&nach_p2.id()));
    }

    #[test]
    fn kreuzende_fahrten_schliessen_sich_aus() {
        let plan = derive_interlocking_routes(&ueberleitkopf(), Length::from_metres(100))
            .expect("gültige Ableitung");
        let nach_p1 = plan
            .routes()
            .find(|route| route.elements() == [HeadElementId::new(10), HeadElementId::new(12)])
            .expect("LWa → P1");
        let ueberleit = plan
            .routes()
            .find(|route| {
                route.elements()
                    == [
                        HeadElementId::new(10),
                        HeadElementId::new(14),
                        HeadElementId::new(11),
                    ]
            })
            .expect("LWa → LWb");
        // Beide beginnen auf eWa und verlangen W1 in unterschiedlicher Lage —
        // sie schließen sich aus.
        assert!(plan.conflict(nach_p1.id(), ueberleit.id()));
        assert!(plan.conflict(ueberleit.id(), nach_p1.id()));
    }

    /// Ein Kopf mit einem Zielsignal, hinter dem ein Durchrutschweg liegt.
    ///
    /// ```text
    ///   LW ─eW─ (W1) ─eThru─ (J) ─[Sig1]─ eBeyond ─ LE
    ///                \─eSide─ P2
    /// ```
    fn kopf_mit_durchrutschweg() -> StationHead {
        StationHead::builder(OperatingPointId::new(2), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus)) // LW
            .node(node(2, HeadNodeKind::Switch)) // W1
            .node(node(3, HeadNodeKind::Joint)) // J
            .node(node(4, HeadNodeKind::Terminus)) // LE
            .node(node(5, HeadNodeKind::Terminus)) // P2
            .element(element(10, 1, 2, 200)) // eW: LW–W1
            .element(element(11, 2, 3, 400)) // eThru: W1–J
            .element(element(12, 3, 4, 500)) // eBeyond: J–LE
            .element(element(13, 2, 5, 300)) // eSide: W1–P2
            .switch(Switch::new(
                SwitchId::new(1),
                HeadNodeId::new(2),
                HeadElementId::new(10), // point eW
                HeadElementId::new(11), // normal eThru
                HeadElementId::new(13), // reverse eSide
            ))
            .signal(signal(1, 1, 10)) // Einfahrt von LW
            .signal(signal(2, 3, 12)) // Ausfahrsignal am Stoß J in eBeyond
            .build()
            .expect("gültiger Bahnhofskopf")
    }

    #[test]
    fn eine_fahrstrasse_am_signal_traegt_einen_durchrutschweg() {
        let plan = derive_interlocking_routes(&kopf_mit_durchrutschweg(), Length::from_metres(300))
            .expect("gültige Ableitung");
        let am_signal = plan
            .routes()
            .find(|route| matches!(route.destination(), RouteDestination::Signal(_)))
            .expect("Fahrstraße bis zum Ausfahrsignal");
        // Belegt eW und eThru, endet vor Sig2 am Stoß.
        assert_eq!(
            am_signal.elements(),
            [HeadElementId::new(10), HeadElementId::new(11)]
        );
        assert_eq!(
            am_signal.destination(),
            RouteDestination::Signal(HeadSignalId::new(2))
        );
        // Der Durchrutschweg reicht in eBeyond hinein und ist so lang wie dieses
        // Element (500 m ≥ 300 m verlangte Mindestlänge).
        assert_eq!(am_signal.overlap().elements(), [HeadElementId::new(12)]);
        assert_eq!(am_signal.overlap().length(), Length::from_metres(500));
        assert!(!am_signal.overlap().is_empty());
    }

    #[test]
    fn die_ableitung_ist_wiederholbar() {
        let kopf = ueberleitkopf();
        let erste =
            derive_interlocking_routes(&kopf, Length::from_metres(100)).expect("gültige Ableitung");
        let zweite =
            derive_interlocking_routes(&kopf, Length::from_metres(100)).expect("gültige Ableitung");
        assert_eq!(erste, zweite);
    }

    #[test]
    fn die_klasse_folgt_dem_vertrauensgrad_der_kopfdaten() {
        let angenommen =
            StationHead::builder(OperatingPointId::new(3), herkunft(Confidence::Assumed))
                .node(node(1, HeadNodeKind::Terminus))
                .node(node(2, HeadNodeKind::Terminus))
                .element(element(10, 1, 2, 200))
                .signal(signal(1, 1, 10))
                .build()
                .expect("gültiger Bahnhofskopf");
        let plan = derive_interlocking_routes(&angenommen, Length::from_metres(100))
            .expect("gültige Ableitung");
        assert!(plan.routes().all(|route| route.class() == QualityClass::C));
    }

    #[test]
    fn eine_weiche_ohne_ihre_drei_elemente_faellt_auf() {
        let fehler = StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus))
            .node(node(2, HeadNodeKind::Switch))
            .node(node(3, HeadNodeKind::Terminus))
            .node(node(4, HeadNodeKind::Terminus))
            .element(element(10, 1, 2, 200))
            .element(element(11, 2, 3, 200))
            .element(element(12, 2, 4, 200))
            .switch(Switch::new(
                SwitchId::new(1),
                HeadNodeId::new(2),
                HeadElementId::new(10),
                HeadElementId::new(11),
                HeadElementId::new(11), // Zweig gleich Stamm — ungültig
            ))
            .build()
            .expect_err("eine Weiche muss drei verschiedene Elemente nennen");
        assert!(matches!(fehler, InfraError::SwitchNodeMismatch { .. }));
    }

    #[test]
    fn ein_falscher_knotengrad_faellt_auf() {
        let fehler = StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus))
            .node(node(2, HeadNodeKind::Terminus))
            .node(node(3, HeadNodeKind::Terminus)) // Endpunkt ohne Element
            .element(element(10, 1, 2, 200))
            .build()
            .expect_err("ein Endpunkt braucht genau ein Element");
        assert!(matches!(fehler, InfraError::HeadNodeDegree { .. }));
    }

    #[test]
    fn ein_element_ins_leere_faellt_auf() {
        let fehler = StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus))
            .element(element(10, 1, 99, 200))
            .build()
            .expect_err("Knoten 99 gibt es nicht");
        assert!(matches!(fehler, InfraError::UnknownElementNode { .. }));
    }

    #[test]
    fn ein_signal_ohne_element_faellt_auf() {
        let fehler = StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus))
            .node(node(2, HeadNodeKind::Terminus))
            .element(element(10, 1, 2, 200))
            .signal(signal(1, 2, 99)) // Element 99 gibt es nicht
            .build()
            .expect_err("das Signal steht an keinem vorhandenen Element");
        assert!(matches!(fehler, InfraError::SignalPlacement { .. }));
    }

    #[test]
    fn ein_leerer_kopf_faellt_auf() {
        let fehler = StationHead::builder(OperatingPointId::new(1), herkunft(Confidence::Surveyed))
            .node(node(1, HeadNodeKind::Terminus))
            .build()
            .expect_err("ein Kopf ohne Element ist keiner");
        assert!(matches!(fehler, InfraError::EmptyStationHead));
    }

    #[test]
    fn eine_nicht_positive_durchrutschweglaenge_faellt_auf() {
        let fehler = derive_interlocking_routes(&ueberleitkopf(), Length::ZERO)
            .expect_err("eine Durchrutschweglänge von null ist keine");
        assert!(matches!(fehler, InfraError::NonPositiveLength { .. }));
    }

    #[test]
    fn unbekannte_kennungen_liefern_nichts() {
        let plan = derive_interlocking_routes(&ueberleitkopf(), Length::from_metres(100))
            .expect("gültige Ableitung");
        assert!(plan.route(InterlockingRouteId::new(999)).is_none());
        assert!(plan.exclusion_set(InterlockingRouteId::new(999)).is_none());
        assert!(!plan.conflict(InterlockingRouteId::new(999), InterlockingRouteId::new(1)));
    }
}
