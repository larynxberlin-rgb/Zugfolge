//! Rahmenverträge mit Kapazitätsdeckel — **M3.8**.
//!
//! `docs/infrastruktur.md` 4 (Kapazitätsschutz und Markteintritt, E4):
//! „**Rahmenvertragsdeckel** — Rahmenverträge binden nur einen begrenzten
//! Anteil der Kapazität eines Korridors." Ohne diesen Deckel bänden
//! Früheinsteiger einen Korridor mehrperiodig vollständig, und kein Neuling
//! käme je hinein — das größte soziale Risiko einer Welt ohne Wipes.
//!
//! Ein [`FrameworkAgreement`] ist eine mehrperiodige Kapazitätszusage: Anders
//! als eine einzelne Trasse ([`crate::ServicePattern`]) bindet er keine
//! konkrete Zeitlage, sondern einen Anteil an einer Menge von
//! Konfliktressourcen — dem Korridor.
//!
//! ## Warum die Kapazität eines Korridors ein externer Wert ist
//!
//! Wie viele Trassen ein Korridor trägt, hängt von Sperrzeiten,
//! Zugcharakteristik und Verkehrsmischung ab — das Ergebnis von M3.1 bis
//! M3.4, nicht eine Zahl, die dieses Modul selbst herleitet. Der Deckel
//! bezieht sich deshalb auf eine **vorgegebene** Kapazität je Ressource
//! ([`FrameworkCapacityLedger::with_capacity`]) und rechnet in Basispunkten
//! (1 % = 100 Basispunkte), damit die Rechnung ganzzahlig bleibt
//! (Invariante 3) — der Deckel rundet dabei **ab**: Ein Deckel, der aufrundet,
//! wäre keiner.

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::error::ConflictError;
use crate::resource::ConflictResource;

/// Die Kennung eines Rahmenvertrags.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameworkAgreementId(u32);

impl FrameworkAgreementId {
    /// Kennung aus ihrer Nummer.
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Die Nummer.
    pub const fn value(self) -> u32 {
        self.0
    }
}

impl fmt::Display for FrameworkAgreementId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "RA{}", self.0)
    }
}

/// Eine mehrperiodige Kapazitätszusage, gedeckelt zum Schutz gegen Landgrab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameworkAgreement {
    id: FrameworkAgreementId,
    corridor: BTreeSet<ConflictResource>,
    cap_basis_points: u32,
}

impl FrameworkAgreement {
    /// Ein Rahmenvertrag über einem Korridor, mit seinem Kapazitätsanteil in
    /// Basispunkten.
    ///
    /// # Errors
    ///
    /// - [`ConflictError::EmptyCorridor`], wenn der Korridor keine einzige
    ///   Ressource nennt.
    /// - [`ConflictError::InvalidCapacityShare`], wenn der Anteil außerhalb
    ///   von 1 bis 10 000 Basispunkten liegt.
    pub fn new(
        id: FrameworkAgreementId,
        corridor: BTreeSet<ConflictResource>,
        cap_basis_points: u32,
    ) -> Result<Self, ConflictError> {
        if corridor.is_empty() {
            return Err(ConflictError::EmptyCorridor(id));
        }
        if cap_basis_points == 0 || cap_basis_points > 10_000 {
            return Err(ConflictError::InvalidCapacityShare(cap_basis_points));
        }
        Ok(Self {
            id,
            corridor,
            cap_basis_points,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> FrameworkAgreementId {
        self.id
    }

    /// Der Korridor — die Konfliktressourcen, über die sich dieser
    /// Rahmenvertrag erstreckt.
    pub const fn corridor(&self) -> &BTreeSet<ConflictResource> {
        &self.corridor
    }

    /// Der Kapazitätsanteil in Basispunkten (1 % = 100).
    pub const fn cap_basis_points(&self) -> u32 {
        self.cap_basis_points
    }

    /// Ob eine Ressource zum Korridor dieses Rahmenvertrags gehört.
    pub fn covers(&self, resource: ConflictResource) -> bool {
        self.corridor.contains(&resource)
    }
}

/// Das Kapazitätsbuch: vorgegebene Kapazität je Ressource, registrierte
/// Rahmenverträge und ihre gebundene Kapazität.
#[derive(Clone, Debug, Default)]
pub struct FrameworkCapacityLedger {
    capacity: BTreeMap<ConflictResource, u32>,
    agreements: BTreeMap<FrameworkAgreementId, FrameworkAgreement>,
    committed: BTreeMap<(FrameworkAgreementId, ConflictResource), u32>,
}

impl FrameworkCapacityLedger {
    /// Ein leeres Kapazitätsbuch.
    pub fn new() -> Self {
        Self::default()
    }

    /// Legt die Gesamtkapazität einer Ressource für diese Fahrplanperiode
    /// fest — die Zahl der Trassen, die sie insgesamt trägt.
    #[must_use]
    pub fn with_capacity(mut self, resource: ConflictResource, slots: u32) -> Self {
        self.capacity.insert(resource, slots);
        self
    }

    /// Die vorgegebene Kapazität einer Ressource — null, wenn keine
    /// hinterlegt ist.
    pub fn capacity_of(&self, resource: ConflictResource) -> u32 {
        self.capacity.get(&resource).copied().unwrap_or(0)
    }

    /// Registriert einen Rahmenvertrag.
    ///
    /// # Errors
    ///
    /// [`ConflictError::DuplicateFrameworkAgreement`], wenn die Kennung
    /// bereits vergeben ist.
    pub fn register(&mut self, agreement: FrameworkAgreement) -> Result<(), ConflictError> {
        let id = agreement.id();
        if self.agreements.insert(id, agreement).is_some() {
            return Err(ConflictError::DuplicateFrameworkAgreement(id));
        }
        Ok(())
    }

    /// Der Kapazitätsdeckel eines Rahmenvertrags auf einer Ressource — der
    /// ganzzahlige, **abgerundete** Anteil seines Basispunktwerts an der
    /// Gesamtkapazität. Null, wenn der Rahmenvertrag unbekannt ist oder die
    /// Ressource nicht zu seinem Korridor gehört.
    pub fn cap_of(&self, agreement: FrameworkAgreementId, resource: ConflictResource) -> u32 {
        let Some(agreement) = self.agreements.get(&agreement) else {
            return 0;
        };
        if !agreement.covers(resource) {
            return 0;
        }
        let anteil = u64::from(self.capacity_of(resource))
            .saturating_mul(u64::from(agreement.cap_basis_points()))
            / 10_000;
        u32::try_from(anteil).unwrap_or(u32::MAX)
    }

    /// Wie viel Kapazität ein Rahmenvertrag auf einer Ressource bereits
    /// gebunden hat.
    pub fn committed_of(&self, agreement: FrameworkAgreementId, resource: ConflictResource) -> u32 {
        self.committed
            .get(&(agreement, resource))
            .copied()
            .unwrap_or(0)
    }

    /// Wie viel Kapazität einem Rahmenvertrag auf einer Ressource noch bleibt.
    pub fn remaining(&self, agreement: FrameworkAgreementId, resource: ConflictResource) -> u32 {
        self.cap_of(agreement, resource)
            .saturating_sub(self.committed_of(agreement, resource))
    }

    /// Bindet eine Trasse eines Rahmenvertrags auf den genannten Ressourcen.
    ///
    /// Nur Ressourcen, die zum Korridor des Rahmenvertrags gehören, verbrauchen
    /// Kapazität — alle anderen werden übergangen. Die Bindung ist **alles
    /// oder nichts**: Sprengt eine einzige betroffene Ressource ihren Deckel,
    /// bindet keine.
    ///
    /// # Errors
    ///
    /// - [`ConflictError::UnknownFrameworkAgreement`], wenn die Kennung nicht
    ///   registriert ist.
    /// - [`ConflictError::FrameworkCapacityExceeded`], wenn der Deckel auf
    ///   mindestens einer betroffenen Ressource bereits ausgeschöpft ist.
    pub fn try_commit(
        &mut self,
        agreement_id: FrameworkAgreementId,
        resources: &BTreeSet<ConflictResource>,
    ) -> Result<(), ConflictError> {
        let agreement = self
            .agreements
            .get(&agreement_id)
            .ok_or(ConflictError::UnknownFrameworkAgreement(agreement_id))?;
        let betroffen: Vec<ConflictResource> = resources
            .iter()
            .copied()
            .filter(|resource| agreement.covers(*resource))
            .collect();

        for &resource in &betroffen {
            if self.remaining(agreement_id, resource) == 0 {
                return Err(ConflictError::FrameworkCapacityExceeded {
                    agreement: agreement_id,
                    resource,
                });
            }
        }

        for resource in betroffen {
            let eintrag = self.committed.entry((agreement_id, resource)).or_insert(0);
            *eintrag = eintrag.saturating_add(1);
        }
        Ok(())
    }

    /// Gibt zuvor gebundene Kapazität frei — etwa bei Rückgabe einer Trasse.
    ///
    /// Ressourcen ohne gebundene Kapazität bleiben unverändert; das ist kein
    /// Fehler.
    pub fn release(
        &mut self,
        agreement_id: FrameworkAgreementId,
        resources: &BTreeSet<ConflictResource>,
    ) {
        for resource in resources {
            if let Some(wert) = self.committed.get_mut(&(agreement_id, *resource)) {
                *wert = wert.saturating_sub(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameworkAgreement, FrameworkAgreementId, FrameworkCapacityLedger};
    use crate::error::ConflictError;
    use crate::resource::ConflictResource;
    use std::collections::BTreeSet;
    use zugfolge_infra::TrackId;

    fn ressource(nummer: u32) -> ConflictResource {
        ConflictResource::Track(TrackId::new(nummer))
    }

    fn korridor(nummern: &[u32]) -> BTreeSet<ConflictResource> {
        nummern.iter().copied().map(ressource).collect()
    }

    #[test]
    fn ein_rahmenvertrag_ohne_korridor_faellt_auf() {
        let ergebnis = FrameworkAgreement::new(FrameworkAgreementId::new(1), BTreeSet::new(), 100);
        assert!(matches!(ergebnis, Err(ConflictError::EmptyCorridor(_))));
    }

    #[test]
    fn ein_unzulaessiger_kapazitaetsanteil_faellt_auf() {
        assert!(matches!(
            FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 0),
            Err(ConflictError::InvalidCapacityShare(0))
        ));
        assert!(matches!(
            FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 10_001),
            Err(ConflictError::InvalidCapacityShare(10_001))
        ));
        assert!(
            FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 10_000).is_ok()
        );
    }

    #[test]
    fn der_deckel_ist_der_abgerundete_anteil_der_kapazitaet() {
        let mut buch = FrameworkCapacityLedger::new().with_capacity(ressource(1), 10);
        let vertrag = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 3_333)
            .expect("gültig");
        let id = vertrag.id();
        buch.register(vertrag).expect("Registrierung gelingt");

        // 10 * 33,33 % = 3,333 — abgerundet 3, nie 4.
        assert_eq!(buch.cap_of(id, ressource(1)), 3);
    }

    #[test]
    fn eine_ressource_ausserhalb_des_korridors_hat_keinen_deckel() {
        let mut buch = FrameworkCapacityLedger::new().with_capacity(ressource(2), 100);
        let vertrag = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 5_000)
            .expect("gültig");
        let id = vertrag.id();
        buch.register(vertrag).expect("Registrierung gelingt");
        assert_eq!(buch.cap_of(id, ressource(2)), 0);
    }

    #[test]
    fn ein_rahmenvertrag_kann_seinen_deckel_nicht_ueberschreiten() {
        let mut buch = FrameworkCapacityLedger::new().with_capacity(ressource(1), 4);
        let vertrag = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 5_000)
            .expect("gültig");
        let id = vertrag.id();
        buch.register(vertrag).expect("Registrierung gelingt");

        // Deckel = 4 * 50 % = 2.
        let eine = korridor(&[1]);
        buch.try_commit(id, &eine).expect("erste Bindung gelingt");
        buch.try_commit(id, &eine).expect("zweite Bindung gelingt");
        assert_eq!(buch.remaining(id, ressource(1)), 0);

        let ergebnis = buch.try_commit(id, &eine);
        assert!(matches!(
            ergebnis,
            Err(ConflictError::FrameworkCapacityExceeded { .. })
        ));
        assert_eq!(
            buch.committed_of(id, ressource(1)),
            2,
            "die dritte Bindung darf nicht zählen"
        );
    }

    #[test]
    fn eine_bindung_ist_alles_oder_nichts() {
        let mut buch = FrameworkCapacityLedger::new()
            .with_capacity(ressource(1), 10)
            .with_capacity(ressource(2), 10);
        let vertrag =
            FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1, 2]), 10_000)
                .expect("gültig");
        let id = vertrag.id();
        buch.register(vertrag).expect("Registrierung gelingt");

        // Ressource 2 wird bis zum Deckel ausgeschöpft ...
        for _ in 0..10 {
            buch.try_commit(id, &korridor(&[2]))
                .expect("Bindung gelingt");
        }
        assert_eq!(buch.remaining(id, ressource(2)), 0);
        assert_eq!(buch.committed_of(id, ressource(1)), 0);

        // ... eine Trasse über beide Ressourcen darf dann keine von beiden binden.
        let ergebnis = buch.try_commit(id, &korridor(&[1, 2]));
        assert!(matches!(
            ergebnis,
            Err(ConflictError::FrameworkCapacityExceeded { .. })
        ));
        assert_eq!(
            buch.committed_of(id, ressource(1)),
            0,
            "eine zurückgewiesene Bindung darf keine Teilwirkung hinterlassen"
        );
    }

    #[test]
    fn freigabe_gibt_kapazitaet_zurueck() {
        let mut buch = FrameworkCapacityLedger::new().with_capacity(ressource(1), 10);
        let vertrag = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 10_000)
            .expect("gültig");
        let id = vertrag.id();
        buch.register(vertrag).expect("Registrierung gelingt");

        let eine = korridor(&[1]);
        buch.try_commit(id, &eine).expect("Bindung gelingt");
        assert_eq!(buch.committed_of(id, ressource(1)), 1);
        buch.release(id, &eine);
        assert_eq!(buch.committed_of(id, ressource(1)), 0);
    }

    #[test]
    fn ein_unbekannter_rahmenvertrag_faellt_bei_bindung_auf() {
        let mut buch = FrameworkCapacityLedger::new();
        let ergebnis = buch.try_commit(FrameworkAgreementId::new(99), &korridor(&[1]));
        assert!(matches!(
            ergebnis,
            Err(ConflictError::UnknownFrameworkAgreement(_))
        ));
    }

    #[test]
    fn zwei_rahmenvertraege_haben_getrennte_deckel_auf_derselben_ressource() {
        let mut buch = FrameworkCapacityLedger::new().with_capacity(ressource(1), 10);
        let a = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 5_000)
            .expect("gültig");
        let b = FrameworkAgreement::new(FrameworkAgreementId::new(2), korridor(&[1]), 5_000)
            .expect("gültig");
        buch.register(a).expect("Registrierung gelingt");
        buch.register(b).expect("Registrierung gelingt");

        let eine = korridor(&[1]);
        for _ in 0..5 {
            buch.try_commit(FrameworkAgreementId::new(1), &eine)
                .expect("Bindung gelingt");
        }
        assert!(
            buch.try_commit(FrameworkAgreementId::new(1), &eine)
                .is_err()
        );
        // Der zweite Rahmenvertrag ist von der Ausschöpfung des ersten unberührt.
        assert!(buch.try_commit(FrameworkAgreementId::new(2), &eine).is_ok());
    }

    #[test]
    fn ein_registrierter_rahmenvertrag_faellt_bei_wiederholung_auf() {
        let mut buch = FrameworkCapacityLedger::new();
        let vertrag = FrameworkAgreement::new(FrameworkAgreementId::new(1), korridor(&[1]), 5_000)
            .expect("gültig");
        buch.register(vertrag.clone())
            .expect("erste Registrierung gelingt");
        assert!(matches!(
            buch.register(vertrag),
            Err(ConflictError::DuplicateFrameworkAgreement(_))
        ));
    }
}
