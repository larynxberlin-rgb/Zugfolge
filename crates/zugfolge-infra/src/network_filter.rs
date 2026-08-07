//! Netzfilter — **M1.3**.
//!
//! Der Rohgraph aus M1.2 führt jeden Weg mit einem `railway`-Tag, gleich
//! welchem Wert — Straßenbahn, U-Bahn und Stromschienennetz eingeschlossen.
//! Der Netzfilter wählt daraus das EBO-Netz aus (E14, `docs/produkt.md`):
//! ausschließlich `railway=rail` in Regelspur, ohne Stromschiene. Tram,
//! Stadtbahn, U-Bahn, Schmalspur, Standseil- und Einschienenbahnen fallen
//! heraus.
//!
//! **Was bleibt.** Betriebs-, Abstell- und Anschlussgleise sind
//! `railway=rail` wie jedes Hauptgleis — ihre Art entscheidet erst die
//! fachliche Abbildung nach `Track` (M1.1), nicht dieser Filter. Er verwirft
//! nichts über ein `service`-Tag; würde er es tun, verlöre das Netz genau die
//! Konfliktressourcen, die später Zusatzfahrten, Abstellung und Versorgung
//! tragen (M5).
//!
//! **Die Grenzen zur EBO.**
//!
//! - **Nur `railway=rail`.** Jeder andere Wert — auch einer, den diese Datei
//!   nicht ausdrücklich nennt — fällt heraus. Das ist die sichere Richtung:
//!   Ein unbekannter Wert wird nicht stillschweigend als Eisenbahn behandelt.
//! - **Nur Regelspur.** Das `gauge`-Tag muss fehlen (dann gilt Regelspur als
//!   Normalfall des deutschen Netzes) oder 1435 mm nennen. Schmalspur wird in
//!   OSM sowohl über `railway=narrow_gauge` als auch über `railway=rail` mit
//!   abweichendem `gauge` geführt — der Filter erwischt beide Formen.
//! - **Keine Stromschiene.** `electrified=rail` bezeichnet in OSM die
//!   Stromschiene, nicht die Oberleitung (`docs/betriebsgraph.md` 2). Die
//!   Bauart, nicht das System, entscheidet — genau die Unterscheidung, die
//!   [`Electrification`](crate::Electrification) trägt.
//!
//! Das Ergebnis ist wieder ein [`RawGraph`] — noch kein
//! [`OperatingGraph`](crate::OperatingGraph). Welches Gleis ein Hauptgleis
//! wird und wie die Attribute in Bänder zerfallen, entscheidet die fachliche
//! Abbildung, die auf M1.3 folgt.

use std::collections::BTreeMap;

use crate::import::{RawEdge, RawEdgeId, RawGraph};

/// Die Regelspur, auf die der Netzfilter beschränkt (E14).
const STANDARD_GAUGE_MM: i64 = 1_435;

/// OSM-`railway`-Werte, die nicht zur EBO gehören und deshalb verworfen
/// werden. Diese Liste ist Dokumentation und Testfixture — die eigentliche
/// Regel in [`classify`] ist strenger: Sie lässt ausschließlich `rail` zu und
/// verwirft damit auch jeden Wert, der hier nicht steht.
pub const EXCLUDED_RAILWAY_VALUES: &[&str] = &[
    "tram",
    "light_rail",
    "subway",
    "narrow_gauge",
    "funicular",
    "monorail",
];

/// Warum eine Kante den Netzfilter nicht besteht.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ExclusionReason {
    /// Kein `railway`-Tag. Der Rohgraph sollte das nicht liefern (M1.2 lässt
    /// nur `railway`-Wege ein) — der Filter prüft es trotzdem, statt sich
    /// blind auf die vorige Stufe zu verlassen.
    MissingRailwayTag,
    /// Der `railway`-Wert ist nicht `rail` — Straßenbahn, Stadtbahn, U-Bahn,
    /// Schmalspur-Kennzeichnung, Standseil- oder Einschienenbahn oder ein
    /// anderer, hier nicht vorgesehener Wert.
    NotRail(String),
    /// Die Spurweite weicht von 1435 mm ab oder lässt sich nicht lesen.
    Gauge(String),
    /// Die Elektrifizierung ist eine Stromschiene (`electrified=rail`).
    ThirdRail,
}

impl core::fmt::Display for ExclusionReason {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::MissingRailwayTag => formatter.write_str("kein railway-Tag"),
            Self::NotRail(wert) => write!(formatter, "railway='{wert}', nicht 'rail'"),
            Self::Gauge(wert) => write!(formatter, "gauge='{wert}', nicht 1435 mm"),
            Self::ThirdRail => formatter.write_str("Stromschiene (electrified=rail)"),
        }
    }
}

/// Liest die Spurweite aus einem OSM-`gauge`-Tag, in Millimetern.
///
/// Mehrspurige Angaben (`"1435;1000"`) nennen die Regelspur zuerst — das ist
/// die OSM-Konvention für Mehrschienengleise. Ein nicht lesbarer Wert gilt
/// als abweichend, nicht als Regelspur: Ein unlesbares Attribut freizusprechen
/// wäre eine stillschweigende Annahme ohne Quelle.
fn parse_gauge_mm(raw: &str) -> Option<i64> {
    raw.split(';').next()?.trim().parse::<i64>().ok()
}

/// Prüft die Tags einer Kante gegen den Netzfilter.
///
/// # Errors
///
/// Der [`ExclusionReason`], aus dem die Kante herausfällt.
pub fn classify(tags: &BTreeMap<String, String>) -> Result<(), ExclusionReason> {
    let railway = tags
        .get("railway")
        .ok_or(ExclusionReason::MissingRailwayTag)?;
    if railway != "rail" {
        return Err(ExclusionReason::NotRail(railway.clone()));
    }

    if let Some(gauge) = tags.get("gauge") {
        match parse_gauge_mm(gauge) {
            Some(STANDARD_GAUGE_MM) => {}
            _ => return Err(ExclusionReason::Gauge(gauge.clone())),
        }
    }

    if tags.get("electrified").map(String::as_str) == Some("rail") {
        return Err(ExclusionReason::ThirdRail);
    }

    Ok(())
}

/// Das Ergebnis eines Netzfilterlaufs: der gefilterte Rohgraph und jede
/// verworfene Kante mit ihrem Grund.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkFilterOutcome {
    graph: RawGraph,
    exclusions: Vec<(RawEdgeId, ExclusionReason)>,
}

impl NetworkFilterOutcome {
    /// Der gefilterte Rohgraph — nur noch Kanten, die den Netzfilter
    /// bestehen, und nur noch die Knoten, die daran hängen.
    pub const fn graph(&self) -> &RawGraph {
        &self.graph
    }

    /// Jede verworfene Kante mit ihrem Grund, in der Reihenfolge des
    /// Eingabegraphen.
    pub fn exclusions(&self) -> &[(RawEdgeId, ExclusionReason)] {
        &self.exclusions
    }
}

/// Ob eine Kante des Rohgraphen den Netzfilter besteht.
fn admissible(edge: &RawEdge) -> bool {
    classify(edge.tags()).is_ok()
}

/// Wendet den Netzfilter aus M1.3 auf einen Rohgraphen an.
pub fn filter_network(graph: &RawGraph) -> NetworkFilterOutcome {
    let mut exclusions = Vec::new();
    for edge in graph.edges() {
        if let Err(reason) = classify(edge.tags()) {
            exclusions.push((edge.id(), reason));
        }
    }

    let filtered = graph.subgraph(admissible);

    NetworkFilterOutcome {
        graph: filtered,
        exclusions,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{EXCLUDED_RAILWAY_VALUES, ExclusionReason, classify};

    fn tags(paare: &[(&str, &str)]) -> BTreeMap<String, String> {
        paare
            .iter()
            .map(|(schluessel, wert)| ((*schluessel).to_owned(), (*wert).to_owned()))
            .collect()
    }

    #[test]
    fn nur_railway_rail_besteht_den_filter() {
        for wert in EXCLUDED_RAILWAY_VALUES {
            let kante = tags(&[("railway", wert)]);
            assert_eq!(
                classify(&kante),
                Err(ExclusionReason::NotRail((*wert).to_owned())),
                "'{wert}' sollte herausfallen"
            );
        }
        assert_eq!(classify(&tags(&[("railway", "rail")])), Ok(()));
    }

    #[test]
    fn eine_kante_ohne_railway_tag_faellt_auf() {
        let kante = tags(&[("highway", "residential")]);
        assert_eq!(classify(&kante), Err(ExclusionReason::MissingRailwayTag));
    }

    #[test]
    fn schmalspur_faellt_ueber_die_spurweite() {
        // Schmalspur wird in OSM auch als `railway=rail` mit abweichendem
        // `gauge` geführt, nicht nur über `railway=narrow_gauge`.
        let kante = tags(&[("railway", "rail"), ("gauge", "1000")]);
        assert_eq!(
            classify(&kante),
            Err(ExclusionReason::Gauge("1000".to_owned()))
        );
    }

    #[test]
    fn regelspur_ohne_gauge_tag_gilt_als_zulaessig() {
        assert_eq!(classify(&tags(&[("railway", "rail")])), Ok(()));
    }

    #[test]
    fn eine_mehrspurige_angabe_nennt_die_regelspur_zuerst() {
        let kante = tags(&[("railway", "rail"), ("gauge", "1435;1000")]);
        assert_eq!(classify(&kante), Ok(()));
    }

    #[test]
    fn eine_unlesbare_spurweite_faellt_auf() {
        let kante = tags(&[("railway", "rail"), ("gauge", "sehr breit")]);
        assert!(matches!(classify(&kante), Err(ExclusionReason::Gauge(_))));
    }

    #[test]
    fn stromschiene_faellt_ueber_die_elektrifizierung() {
        let kante = tags(&[("railway", "rail"), ("electrified", "rail")]);
        assert_eq!(classify(&kante), Err(ExclusionReason::ThirdRail));
    }

    #[test]
    fn oberleitung_ist_keine_stromschiene() {
        let kante = tags(&[("railway", "rail"), ("electrified", "contact_line")]);
        assert_eq!(classify(&kante), Ok(()));
    }

    #[test]
    fn betriebs_und_abstellgleise_bleiben_erhalten() {
        // Der Filter kennt kein `service`-Tag — er verwirft nicht danach.
        for dienst in ["yard", "siding", "spur", "crossover"] {
            let kante = tags(&[("railway", "rail"), ("service", dienst)]);
            assert_eq!(
                classify(&kante),
                Ok(()),
                "service='{dienst}' bleibt erhalten"
            );
        }
    }
}
