//! Ganzzahliger, reproduzierbarer Zufallsstrom.

/// Ein benannter Zufallsstrom, erzeugt über [`crate::WorldSeed::substream`].
///
/// Das Verfahren ist SplitMix64: schnell, zustandsarm und — der Punkt —
/// vollständig in Ganzzahlarithmetik definiert. Es gibt bewusst **keine**
/// Methode, die eine Gleitkommazahl liefert. Wer eine Wahrscheinlichkeit
/// braucht, zieht sie ganzzahlig, etwa `rng.below(10_000) < 137` für
/// 1,37 Prozent. Das ist keine Umständlichkeit, sondern Invariante 3.
///
/// Der Strom ist reproduzierbar, aber **nicht** kryptografisch. Er darf
/// niemals Schlüssel, Token oder Losnummern mit Geldwert erzeugen.
#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
}

/// Ungerader Schrittweitenparameter von SplitMix64 (goldener Schnitt in 64 Bit).
const GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;
const MIX_1: u64 = 0xBF58_476D_1CE4_E5B9;
const MIX_2: u64 = 0x94D0_49BB_1331_11EB;

impl Rng {
    /// Erzeugt einen Strom aus einem bereits abgeleiteten Zustandswert.
    ///
    /// Bewusst nicht öffentlich: Ein Strom entsteht ausschließlich aus einem
    /// [`crate::WorldSeed`] und einem benannten [`crate::Substream`]. Sonst
    /// entstünden Ströme, die niemand nachvollziehen kann.
    pub(crate) const fn from_state(state: u64) -> Self {
        Self { state }
    }

    /// Liefert die nächsten 64 Zufallsbits und rückt den Strom vor.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(GAMMA);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(MIX_1);
        z = (z ^ (z >> 27)).wrapping_mul(MIX_2);
        z ^ (z >> 31)
    }

    /// Gleichverteilte Zahl aus `0..bound`, ohne Modulo-Verzerrung.
    ///
    /// Verfahren nach Lemire: Multiplikation in 128 Bit statt Restbildung.
    /// Der Rückweisungszweig wird nur betreten, wenn das Ergebnis sonst
    /// verzerrt wäre; er ist der Grund, warum die Anzahl gezogener Wörter je
    /// Aufruf schwanken darf, ohne den Determinismus zu verletzen — sie hängt
    /// allein vom Strominhalt ab, nicht von der Laufzeitumgebung.
    ///
    /// # Panics
    ///
    /// Wenn `bound` null ist. Ein leerer Wertebereich ist immer ein Fehler in
    /// der aufrufenden Regel, nie ein zulässiger Betriebsfall.
    pub fn below(&mut self, bound: u64) -> u64 {
        #![allow(
            clippy::cast_possible_truncation,
            reason = "gewollte Trennung der 128-Bit-Multiplikation in obere und untere Hälfte"
        )]
        assert!(bound > 0, "below(0) hat keinen Wertebereich");

        let mut product = u128::from(self.next_u64()) * u128::from(bound);
        let mut low = product as u64;
        if low < bound {
            let threshold = bound.wrapping_neg() % bound;
            while low < threshold {
                product = u128::from(self.next_u64()) * u128::from(bound);
                low = product as u64;
            }
        }
        (product >> 64) as u64
    }

    /// Mischt `items` an Ort und Stelle (Fisher-Yates, rückwärts).
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        let mut index = items.len();
        while index > 1 {
            index -= 1;
            let upper = u64::try_from(index + 1).expect("Länge passt in 64 Bit");
            let other = usize::try_from(self.below(upper)).expect("Index passt in usize");
            items.swap(index, other);
        }
    }

    /// Zufällige Permutation von `0..count`.
    ///
    /// Der Vergabekalender einer Welt (`docs/wirtschaft.md` 3.3) verlangt
    /// ausdrücklich eine **Permutation, keine Ziehung**: Die Fenster stehen
    /// fest und gleichmäßig, nur die Zuordnung ist zufällig. Deshalb steht das
    /// Verfahren hier und nicht in jedem Aufrufer neu.
    pub fn permutation(&mut self, count: usize) -> Vec<usize> {
        let mut items: Vec<usize> = (0..count).collect();
        self.shuffle(&mut items);
        items
    }

    /// Wählt ein Element gleichverteilt aus; `None` bei leerer Menge.
    pub fn choose<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        let count = u64::try_from(items.len()).ok()?;
        if count == 0 {
            return None;
        }
        let index = usize::try_from(self.below(count)).ok()?;
        items.get(index)
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    fn strom() -> Rng {
        Rng::from_state(0x0123_4567_89AB_CDEF)
    }

    #[test]
    fn folge_ist_reproduzierbar() {
        let mut erster_lauf = strom();
        let mut zweiter_lauf = strom();
        let erste: Vec<u64> = (0..8).map(|_| erster_lauf.next_u64()).collect();
        let zweite: Vec<u64> = (0..8).map(|_| zweiter_lauf.next_u64()).collect();
        assert_eq!(erste, zweite);
        assert_eq!(erste.len(), 8);
    }

    #[test]
    fn folge_schreitet_fort() {
        let mut rng = strom();
        let erster = rng.next_u64();
        let zweiter = rng.next_u64();
        assert_ne!(erster, zweiter, "der Strom bleibt stehen");
    }

    #[test]
    fn below_bleibt_unter_der_schranke() {
        let mut rng = strom();
        for bound in [1_u64, 2, 3, 7, 100, u64::MAX] {
            for _ in 0..200 {
                assert!(rng.below(bound) < bound, "Schranke {bound} verletzt");
            }
        }
    }

    #[test]
    fn below_deckt_kleinen_wertebereich_vollstaendig_ab() {
        let mut rng = strom();
        let mut gesehen = [false; 3];
        for _ in 0..500 {
            let index = usize::try_from(rng.below(3)).expect("kleiner Index");
            gesehen[index] = true;
        }
        assert!(
            gesehen.iter().all(|&b| b),
            "below(3) erreicht nicht alle Werte"
        );
    }

    #[test]
    #[should_panic(expected = "below(0)")]
    fn below_null_ist_ein_fehler() {
        strom().below(0);
    }

    #[test]
    fn permutation_ist_eine_permutation() {
        let mut rng = strom();
        let mut permutation = rng.permutation(64);
        assert_eq!(permutation.len(), 64);
        permutation.sort_unstable();
        assert_eq!(permutation, (0..64).collect::<Vec<usize>>());
    }

    #[test]
    fn permutation_mischt_tatsaechlich() {
        let mut rng = strom();
        let permutation = rng.permutation(64);
        assert_ne!(
            permutation,
            (0..64).collect::<Vec<usize>>(),
            "die Permutation hat nichts verändert"
        );
    }

    #[test]
    fn permutation_von_null_und_eins_ist_stabil() {
        let mut rng = strom();
        assert!(rng.permutation(0).is_empty());
        assert_eq!(rng.permutation(1), vec![0]);
    }

    #[test]
    fn choose_liefert_nur_vorhandene_elemente() {
        let mut rng = strom();
        let werte = ["a", "b", "c"];
        for _ in 0..50 {
            let gewaehlt = rng.choose(&werte).expect("nicht leer");
            assert!(werte.contains(gewaehlt));
        }
        let leer: [&str; 0] = [];
        assert!(rng.choose(&leer).is_none());
    }
}
