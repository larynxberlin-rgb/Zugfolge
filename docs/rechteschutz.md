# Rechteschutz — Lizenz, CLA, Schichten, Marke

Ergebnis von **M0.5**. Die andere Richtung zum Rechte-Gate: [`rechte.md`](rechte.md)
klärt, welche fremden Daten wir **nutzen** dürfen; dieses Dokument, was wir
**schützen** — der eigene Quelltext, die eigene Marke, die proprietären
Schichten. Die Begründungen stehen in [`geschaeft.md`](geschaeft.md) 4 und 5
(E16, E6); hier steht die **Umsetzung und ihre Durchsetzung**.

---

## 1. Lizenz und Rechteinhaber

Der Quelltext steht unter **PolyForm Shield 1.0.0** — Source Available, nicht
Open Source (E16). Der Volltext liegt in [`LICENSE`](../LICENSE).

PolyForm Shield gewährt seine Rechte erst, wenn der Lizenzgeber **benannt** ist.
`LICENSE` trägt deshalb oben die Zeile `Required Notice: Copyright 2026 Sebastian
Barowski (larynxberlin@icloud.com)` — damit ist der Rechteinhaber benannt und die
Lizenz **wirksam**. Die `Licensor Line of Business:` daneben schützt zusätzlich
die Discontinued-Products-Klausel, indem sie das Geschäftsfeld benennt. Der
Abschnitt „Notices" der Lizenz verpflichtet jeden, der die Software weitergibt,
diese `Required Notice:`-Zeile mitzugeben.

Dass GitHubs Auto-Erkennung PolyForm Shield eventuell nicht als bekannte Lizenz
ausweist, ist kosmetisch — rechtlich gilt die Datei, nicht das Abzeichen. Die
CI wacht über die Lizenzkennung in den Manifesten: Der Wächter `language`
erzwingt `LicenseRef-PolyForm-Shield-1.0.0`, jede fremde Kennung bricht die CI.

---

## 2. Contributor License Agreement

Ab dem ersten fremden Beitrag gilt das [CLA](../CLA.md). Ohne es behielten
Beitragende das Urheberrecht an ihrem Code, und schon der erste fremde Pull
Request machte Relizenzierung, kommerzielle Lizenzvergabe und jede spätere
Lizenzänderung unmöglich.

Das CLA nimmt dem Beitragenden nichts — er behält alle eigenen Rechte — und
räumt dem Inhaber zusätzlich die Rechte zur Verwendung im Projekt ein. Der
Inhaber ist dieselbe natürliche Person wie in `LICENSE`: Sebastian Barowski.
Annahme über `Signed-off-by` in der Commit-Nachricht; Beiträge ohne angenommenes
CLA werden nicht übernommen. Ziffer 4 des CLA verlangt ausdrücklich, dass keine
Copyleft-lizenzierten Anteile eingebracht werden — das ist die menschliche
Vorstufe zum Lizenz-Scan aus M0.2.

---

## 3. Schichtentrennung — der eigentliche Kopierschutz

Eine Eisenbahnsimulation ohne Infrastruktur-Release, ohne Balancing und ohne
Marke ist kein Produkt, sondern ein Motor ohne Fahrzeug. Diese Trennung schützt
zuverlässiger als jeder Lizenztext (E16). Proprietäre Laufzeitdaten bleiben
außerhalb des öffentlichen Repositoriums. Sichtbare UI-Zeichen und ausdrücklich
veröffentlichte Designbeispiele liegen dagegen im Design-System, unter
[`brand/`](brand/README.md) und [`ui-redesign/`](ui-redesign/README.md).
Die generierte Einstiegsaufnahme liegt als UI-Asset in `apps/game-web/public/`.
Das ändert weder die Projektlizenz noch die gesonderte Behandlung der Marke.

| Schicht | Behandlung | Durchsetzung |
|---------|------------|--------------|
| Quelltext | PolyForm Shield 1.0.0 | `LICENSE`, Wächter `language` |
| Marke „Zugfolge", Wortmarke, Monogramm | Markenrecht an der benutzten Kennzeichnung, alle Rechte vorbehalten, nie mitlizenziert | keine Registrierung (Inhaberentscheidung), siehe unten |
| `EconomyRelease`, Fahrzeugkatalog, Balancing | proprietär, nicht öffentlich | `.gitignore` + Wächter `layer-separation` |
| Weltdaten und Betriebshistorie | proprietär, nie öffentlich | `.gitignore` + Wächter `layer-separation` |
| OSM-abgeleitete Daten (`InfraRelease`) | ODbL — nicht durch die Projektlizenz überschreibbar; getrennte Datenebene | `.gitignore` + Wächter `layer-separation`; siehe [`rechte.md`](rechte.md) 5 |

**Warum ein Wächter neben `.gitignore`.** `.gitignore` ist eine Bitte, kein
Riegel — eine Datei mit `git add -f` landet trotzdem im Baum. Der Wächter
`layer-separation` ist der Riegel: Liegt eine Datei in einem proprietären Pfad
(`data/economy/`, `data/balancing/`, `data/worlds/`, `assets/brand/`, eine
`*.economyrelease.json` und die weiteren aus dem Kopf der `.gitignore`), bricht
die CI — unabhängig davon, was `.gitignore` sagt. So ist das versehentliche
Veröffentlichen einer proprietären Schicht nicht bloß unerwünscht, sondern
strukturell nicht möglich. Für eine begründete Ausnahme steht die sichtbare
Marke `guards:allow layer-separation` im Code, die im Review auffällt.

**Grenze der automatischen Prüfung.** Der Wächter liest nur Textdateien.
Rohdaten als Binärformat (`*.pbf`, `*.pmtiles`, `*.tif`) erreichen ihn nicht;
die fängt allein `.gitignore` ab. Der teuerste Fall — ein als Text abgelegter
`EconomyRelease`, eine Balancing-Tabelle, ein Fahrzeugkatalog — wird vom Wächter
gefangen.

**Keine Markenregistrierung.** Die Wortmarke „Zugfolge" wird bewusst **nicht**
als Marke angemeldet (Entscheidung des Inhabers). Der Schutz ruht auf dem
Markenrecht an der tatsächlich benutzten Kennzeichnung und darauf, dass die Marke
nie mitlizenziert wird (E6, E16, E17) — nicht auf einer Registrierung. Der
Kopierschutz trägt ohnehin über die Schichtentrennung, nicht über ein Register.

---

## 4. Abhängigkeiten und ODbL

- **Lizenz-Scan** (M0.2, CI): `cargo-deny` und `pnpm licenses list` gegen eine
  kurze Allowlist; Copyleft im Abhängigkeitsbaum bricht die CI. Ausnahmen nur
  namentlich mit erzwungener Begründung in `tools/guards/guards.config.json`.
- **ODbL** sticht die Projektlizenz für OSM-abgeleitete Daten und wird als
  getrennte Datenebene geführt — Einzelheiten in [`rechte.md`](rechte.md) 5 und
  [`daten.md`](daten.md) 2.

---

> Begründete technische Einschätzung, keine Rechtsberatung. CLA und
> ODbL-Abgrenzung gehören vor Veröffentlichung anwaltlich geprüft (geschaeft.md 4).
