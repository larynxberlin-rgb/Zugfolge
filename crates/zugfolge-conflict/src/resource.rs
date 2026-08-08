//! Konfliktressourcen und ihre Verträglichkeit — die Grundlage von M3.1.
//!
//! > **Harte Invariante 1:** Keine zwei Züge dürfen zur gleichen Zeit
//! > inkompatible Belegungen derselben Konfliktressource besitzen.
//!
//! `docs/infrastruktur.md` 1 zählt auf, worum zwei Zugfahrten konkurrieren
//! können: Blockabschnitte, Fahrstraßen samt Weichen und kreuzenden
//! Bewegungen, eingleisige Gegenfahrten, Bahnsteig- und
//! Bahnhofskopfbelegungen, Anlagen. Das ist **eine** Aufzählung, kein Dutzend
//! Sonderregeln — [`ConflictResource`] fasst sie zusammen.
//!
//! ## Zwei Konfliktarten, ein Ressourcenmodell
//!
//! Der Spike aus M0.3 hat den entscheidenden Befund geliefert: Ob aus einer
//! Überschneidung ein Zugfolgefall oder eine Gegenfahrt wird, entscheidet die
//! Infrastruktur, nicht der Prüfer. Auf der zweigleisigen Strecke ist jedes
//! Richtungsgleis eine eigene Ressource, auf dem eingleisigen Abschnitt teilen
//! beide Richtungen sich eine — die Fallunterscheidung fällt damit aus dem
//! Netz heraus.
//!
//! ## Und die Lücke, die er offengelassen hat
//!
//! Zwei Fahrstraßen desselben Bahnhofskopfs sind **verschiedene** Ressourcen
//! und schließen einander trotzdem aus, sobald sie ein Fahrwegelement oder
//! eine Weiche teilen. „Gleiche Ressource" reicht als Regel deshalb nicht;
//! es braucht die **Ausschlussmenge** aus M1.7. [`ResourceExclusions`] trägt
//! sie, und zwar als eigener Baustein neben der Ressource: Die Ressource
//! selbst weiß nicht, mit wem sie sich verträgt — das weiß das Stellwerk.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use zugfolge_determinism::StateHasher;
use zugfolge_infra::{
    FacilityId, InterlockingPlan, InterlockingRouteId, OperatingPointId, TrackId,
};

/// Etwas, worum zwei Zugfahrten konkurrieren können.
///
/// Die Reihenfolge der Varianten ist Teil der Sortierung und damit des
/// Zustands-Hashes; sie folgt der Aufzählung in `docs/infrastruktur.md` 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConflictResource {
    /// Ein Blockabschnitt eines Gleises, benannt über sein Gleis und seine
    /// laufende Nummer entlang der Kilometrierung (M1.6).
    Block {
        /// Das Gleis, auf dem der Block liegt.
        track: TrackId,
        /// Die laufende Nummer des Blocks entlang der Kilometrierung, ab null.
        ordinal: u32,
    },
    /// Ein Gleis als Ganzes — das Bahnhofs- oder Bahnsteiggleis, auf dem ein
    /// Zug hält oder wendet. Es ist nicht in Blöcke zerlegt, weil auf ihm nie
    /// zwei Züge zugleich stehen dürfen.
    Track(TrackId),
    /// Eine Fahrstraße durch einen Bahnhofskopf (M1.7). Zwei Fahrstraßen
    /// desselben Kopfs sind verschiedene Ressourcen und können einander
    /// trotzdem ausschließen — siehe [`ResourceExclusions`].
    Route {
        /// Die Betriebsstelle, deren Bahnhofskopf die Fahrstraße gehört.
        point: OperatingPointId,
        /// Die Fahrstraße.
        route: InterlockingRouteId,
    },
    /// Eine Anlage aus dem Anlagenkataster (M1.11). `docs/betrieb.md` 4:
    /// Anlagen laufen durch dieselbe Konfliktengine wie der Fahrweg — kein
    /// zweites System.
    Facility(FacilityId),
}

impl ConflictResource {
    /// Stabile Kennung der Art, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Block { .. } => "block",
            Self::Track(_) => "track",
            Self::Route { .. } => "route",
            Self::Facility(_) => "facility",
        }
    }

    /// Deutsche Bezeichnung der Art für Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Block { .. } => "Blockabschnitt",
            Self::Track(_) => "Gleis",
            Self::Route { .. } => "Fahrstraße",
            Self::Facility(_) => "Anlage",
        }
    }

    /// Ob die Ressource überhaupt in eine Ausschlussbeziehung geraten kann.
    ///
    /// Nur Fahrstraßen können das: Alle anderen Ressourcen sind entweder
    /// dieselbe oder unabhängig.
    pub const fn may_exclude(self) -> bool {
        matches!(self, Self::Route { .. })
    }

    /// Schreibt die Ressource in den Zustands-Hash.
    pub(crate) fn write_canonical(self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.tag());
        match self {
            Self::Block { track, ordinal } => {
                hasher.uint("track", u64::from(track.value()));
                hasher.uint("ordinal", u64::from(ordinal));
            }
            Self::Track(track) => {
                hasher.uint("track", u64::from(track.value()));
            }
            Self::Route { point, route } => {
                hasher.uint("point", u64::from(point.value()));
                hasher.uint("route", u64::from(route.value()));
            }
            Self::Facility(facility) => {
                hasher.uint("facility", u64::from(facility.value()));
            }
        }
    }
}

impl fmt::Display for ConflictResource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Block { track, ordinal } => write!(formatter, "{track} Block {ordinal}"),
            Self::Track(track) => write!(formatter, "{track}"),
            Self::Route { point, route } => write!(formatter, "{point} {route}"),
            Self::Facility(facility) => write!(formatter, "{facility}"),
        }
    }
}

/// Die Ausschlussbeziehungen zwischen Fahrstraßen, aus M1.7 übernommen.
///
/// Ohne sie prüft der Konfliktprüfer nur die halbe Wahrheit: Zwei Züge, die in
/// derselben Betriebsstelle verschiedene Bahnsteiggleise benutzen, gelten
/// sonst immer als verträglich — in Wirklichkeit schließen sich ihre
/// Fahrstraßen womöglich aus, weil sie sich eine Weiche teilen. Genau das war
/// der schwerste offene Punkt des Spikes aus M0.3.
///
/// Der Aufbau ist bewusst getrennt von [`ConflictResource`]: Die Ressource ist
/// eine Kennung, die Verträglichkeit eine Eigenschaft des Stellwerks. Wer den
/// Bahnhofskopf nicht kennt, prüft ohne diese Beziehungen weiter — und
/// bekommt dieselben Blockkonflikte, nur eben nicht die des Kopfs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResourceExclusions {
    /// Je Betriebsstelle die Ausschlussmenge jeder Fahrstraße.
    per_point:
        BTreeMap<OperatingPointId, BTreeMap<InterlockingRouteId, BTreeSet<InterlockingRouteId>>>,
}

impl ResourceExclusions {
    /// Ohne jede bekannte Ausschlussbeziehung.
    pub fn new() -> Self {
        Self::default()
    }

    /// Übernimmt die Ausschlussmengen eines Bahnhofskopfs (M1.7).
    pub fn with_plan(mut self, plan: &InterlockingPlan) -> Self {
        let point = plan.operating_point();
        let eintrag = self.per_point.entry(point).or_default();
        for route in plan.routes() {
            eintrag.insert(route.id(), route.excludes().clone());
        }
        self
    }

    /// Ob zwei Ressourcen einander ausschließen, obwohl sie verschieden sind.
    ///
    /// Für zwei **gleiche** Ressourcen ist die Frage sinnlos — die schließen
    /// sich immer aus; das entscheidet der Prüfer vor dem Aufruf.
    pub fn excludes(&self, first: ConflictResource, second: ConflictResource) -> bool {
        let (
            ConflictResource::Route {
                point: erster_bahnhof,
                route: erste,
            },
            ConflictResource::Route {
                point: zweiter_bahnhof,
                route: zweite,
            },
        ) = (first, second)
        else {
            return false;
        };
        if erster_bahnhof != zweiter_bahnhof {
            return false;
        }
        self.per_point
            .get(&erster_bahnhof)
            .and_then(|fahrstrassen| fahrstrassen.get(&erste))
            .is_some_and(|ausschluss| ausschluss.contains(&zweite))
    }

    /// Alle Ressourcen, die diese Ressource ausschließt — ohne sie selbst.
    ///
    /// Der Konfliktprüfer braucht die Menge, nicht nur die Frage: Er muss
    /// wissen, in welche fremden Belegungsbücher er zusätzlich schauen soll.
    pub fn excluded_by(&self, resource: ConflictResource) -> Vec<ConflictResource> {
        let ConflictResource::Route { point, route } = resource else {
            return Vec::new();
        };
        self.per_point
            .get(&point)
            .and_then(|fahrstrassen| fahrstrassen.get(&route))
            .map(|ausschluss| {
                ausschluss
                    .iter()
                    .map(|andere| ConflictResource::Route {
                        point,
                        route: *andere,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Wie viele Bahnhofsköpfe hinterlegt sind.
    pub fn point_count(&self) -> usize {
        self.per_point.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{ConflictResource, ResourceExclusions};
    use crate::example::reference_interlocking_plan;
    use zugfolge_infra::{FacilityId, InterlockingRouteId, OperatingPointId, TrackId};

    #[test]
    fn ressourcen_sind_unterscheidbar_und_lesbar() {
        let block = ConflictResource::Block {
            track: TrackId::new(1001),
            ordinal: 2,
        };
        assert_eq!(block.to_string(), "G1001 Block 2");
        assert_eq!(block.label(), "Blockabschnitt");
        assert_eq!(
            ConflictResource::Track(TrackId::new(101)).to_string(),
            "G101"
        );
        assert_eq!(
            ConflictResource::Facility(FacilityId::new(7)).to_string(),
            "Anl7"
        );
        assert_ne!(block, ConflictResource::Track(TrackId::new(1001)));
    }

    #[test]
    fn nur_fahrstrassen_koennen_sich_ausschliessen() {
        assert!(
            ConflictResource::Route {
                point: OperatingPointId::new(3),
                route: InterlockingRouteId::new(1),
            }
            .may_exclude()
        );
        assert!(!ConflictResource::Track(TrackId::new(301)).may_exclude());
        assert!(!ConflictResource::Facility(FacilityId::new(1)).may_exclude());
    }

    #[test]
    fn die_ausschlussmenge_kommt_aus_dem_bahnhofskopf() {
        // Das ist die Lücke, die der Spike aus M0.3 offengelassen hat: Zwei
        // verschiedene Fahrstraßen desselben Kopfs, die sich eine Weiche
        // teilen, dürfen nicht gleichzeitig gestellt werden.
        let plan = reference_interlocking_plan(OperatingPointId::new(3));
        let ausschluss = ResourceExclusions::new().with_plan(&plan);
        assert_eq!(ausschluss.point_count(), 1);

        let mut gefunden = false;
        for erste in plan.routes() {
            for zweite in plan.routes() {
                let a = ConflictResource::Route {
                    point: plan.operating_point(),
                    route: erste.id(),
                };
                let b = ConflictResource::Route {
                    point: plan.operating_point(),
                    route: zweite.id(),
                };
                assert_eq!(
                    ausschluss.excludes(a, b),
                    plan.conflict(erste.id(), zweite.id())
                );
                gefunden |= ausschluss.excludes(a, b);
            }
        }
        assert!(gefunden, "der Kopf hat keine einzige Ausschlussbeziehung");
    }

    #[test]
    fn zwei_bahnhoefe_teilen_keine_ausschlussmenge() {
        let plan = reference_interlocking_plan(OperatingPointId::new(3));
        let ausschluss = ResourceExclusions::new().with_plan(&plan);
        let erste = plan
            .routes()
            .next()
            .expect("mindestens eine Fahrstraße")
            .id();
        assert!(!ausschluss.excludes(
            ConflictResource::Route {
                point: plan.operating_point(),
                route: erste,
            },
            ConflictResource::Route {
                point: OperatingPointId::new(99),
                route: erste,
            },
        ));
    }
}
