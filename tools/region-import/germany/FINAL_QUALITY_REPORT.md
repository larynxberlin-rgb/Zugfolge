# Deterministischer Gesamtqualitaetsbericht Deutschland

`run-final-quality-report.mjs` liest genau die zehn sichtbaren Kartenlayer des
fertigen Deutschland-Korpus. Der Bericht zaehlt A/B/C pro Layer; fuer Gleise
zaehlt er zusaetzlich die Laenge je Klasse und bewertet die acht Dimensionen
Topologie, Vmax, Neigung, Elektrifizierung, Gleiszahl, Signale, Block und
Konfliktressourcen.

Die beiden Achsen bleiben getrennt:

- `evidenceByState` beschreibt, ob ein Wert beobachtet, amtlich beobachtet,
  durch zwei Quellen bestaetigt, aus dem Hoehenmodell beziehungsweise der
  Topologie abgeleitet oder nicht belegt ist.
- `operationalHandlingByState` beschreibt, ob das Spiel den belegten Wert
  direkt verwendet, eine konservative Regel anwendet, eine sichtbare sichere
  Annahme setzt oder die Dimension ungeloest bleibt.

Damit kann eine sichere Annahme Klasse B ermoeglichen, ohne als Datenwahrheit
ausgegeben zu werden. Klasse A verlangt je Layer einen akzeptierten Beleg und
alle im Eingabevertrag genannten Dimensionen. Eine Einzelquelle, eine
automatische Ableitung oder ein KI-Urteil reicht nie. Klasse C bleibt sichtbar,
aber `orderable=false` ist zwingend.

Der Gleisbericht verbindet die finalen Trackfeatures mit den realen Signal-,
Block- und Konfliktressourcenlayern. Ein vorhandenes Attribut allein gilt nicht
als Block- oder Ressourcennachweis. Interne Stationsplan-Rohdaten und deren
Abrufkennungen werden weder gelesen noch ausgegeben.

Der zur Karte ausgelieferte Bericht enthaelt absichtlich weder interne
Quelldateinamen und Source-IDs noch Eingabe- oder Evidenzhashes. Seine
Dimensionszustaende bleiben fachlich lesbar; die SHA-256 der fertigen
`quality.json` wird nur vom Baukommando als externe Reproduzierbarkeitsangabe
ausgegeben.

`declaredQualityClassFeatureCount` zeigt die im Layer gespeicherte Klasse.
`qualityClassFeatureCount` und bei Gleisen `qualityClassLengthMm` sind die
wirksame Berichtsklasse. Findet der Querschnitt eine ungeloeste Pflichtdimension
in einem als B deklarierten Gleis, stuft der Bericht es fail-closed auf C herab
und weist die Abweichung unter `qualityClassificationCorrections` aus. Der
Bericht veraendert die Quelldatei dabei nicht.

## Reproduzierbarer Lauf

```text
node tools/region-import/germany/run-final-quality-report.mjs \
  tools/region-import/germany/final-quality-inputs.example.json \
  var/derived/germany-2026/semantic-tile-inputs-final-v1 \
  var/derived/germany-2026/map-release/public/quality.json
```

Der Ausgabepfad darf nicht existieren. Der Builder schreibt erst eine
`.building`-Datei, synchronisiert sie und benennt sie nach vollstaendigem Lauf
um. Zeitstempel fehlen bewusst, damit derselbe Inputsatz byteidentische Ausgabe
erzeugt. Der Bericht bewahrt nur die oeffentlich benoetigte Dateigroesse je
Layer; private Provenienzinformationen verbleiben in den vorgelagerten
Release-Artefakten.
