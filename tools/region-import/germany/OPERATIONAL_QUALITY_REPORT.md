# Getrennter Operational-v2-Qualitaetsbericht

Der Deutschlandrelease besitzt zwei unabhaengige, miteinander gehashte
Qualitaetsachsen:

1. `zugfolge-static-map-quality/v2` beschreibt die zehn sichtbaren
   Kartenlayer ehrlich als A/B/C und bindet seinerseits den detaillierten
   `zugfolge-final-infrastructure-quality-report/v1`. Seine Claims verneinen
   Operational-Release und Produktionsaktivierung.
2. `zugfolge-operational-infrastructure-quality-report/v1` qualifiziert nur den
   nativen, vollstaendig geschlossenen Operational-v2-Graphen. Seine operative
   Bilanz ist A=0, B=1, C=0 und `unresolvedRequired=0`.

Der zweite Bericht bindet die exakten Bytes des ersten per SHA-256, spiegelt
zusätzlich dessen eingebetteten Byte-/SHA-Beleg des nicht ausgelieferten
Detailberichts und gibt dieselben Feature- und Gleislängenklassen einschließlich
C weiterhin aus. Der Manifestcompiler prüft beide Bindungen gegen die
tatsächlich übergebenen Static-Map-v2-Dateibytes. Der Bericht setzt zugleich
`mapClassCReclassified=false` und `mapObjectsRemoved=false`. Dadurch bleiben
beispielsweise ungebundene Karten-Bahnsteigpunkte oder rueckgebaute Signale
sichtbar und ehrlich C, ohne als ungeschlossene Objekte des separaten
Operational-Graphen zu gelten.

Das Operational-Gate akzeptiert nur ein erneut bytegeprueftes
`zugfolge-synthetic-operational-closure-receipt/v2`. Dieses bindet Policy,
Jahresspezifikation, sechs operative Kartenlayer und drei freie
Fahrwegeingaben: `gtfs-snapshot`, `timetable-route-report` und die vollstaendigen
gepinnten `timetable-routes`. Die oeffentliche `timetableRouteEvidence` weist
CC-BY-4.0, Snapshot-/Datei-/Archiv-SHA, die vollstaendige ausgewählte
Segmentabdeckung und `externalOperationalNetworkProvenance=false` aus. Das
Receipt bindet außerdem Candidate, Ableitungsbericht,
materialisiertes Artefakt, beide nativen Streaming-Receipts und Zustand. Die
oeffentliche Projektion behauptet keine realen Stellwerksfakten. Sie weist
ausdruecklich aus, dass das Operational-v2-Artefakt synthetische
Betriebsdetails ausliefert
(`syntheticOperationalDetailsShipped=true`), beobachtete und synthetische
Objekte dieselben Laufzeit-Collections teilen
(`observedAndSyntheticObjectsShareRuntimeCollections=true`) und keine
objektweise Lineage ausgeliefert wird
(`objectLevelProvenanceShipped=false`).

`operationalQualityEligible=true` ist kein Signatur- oder Aktivierungsbeleg.
Der Bericht setzt deshalb `signatureImplied=false` und
`activationImplied=false`; Rechte-, Paket-, Signatur-, Testwelt-, Last- und
Staginggates bleiben unveraendert nachgelagert.

## Jahreslauf 2026.4

```text
node tools/region-import/germany/run-synthetic-operational-closure.mjs \
  tools/region-import/germany/synthetic-operational-closure.annual-2026.4.json \
  var/derived/germany-2026.4/synthetic-operational-closure-receipt.json

node tools/region-import/germany/run-operational-quality-report.mjs \
  tools/region-import/germany/operational-quality.annual-2026.4.json \
  var/derived/germany-2026.4/operational-infrastructure-quality.json
```

Der Lauf scheitert fail-closed, solange Closure-Receipt, Operational-v2-
Artefakt oder einer der darin gehashten Inputs fehlt beziehungsweise von seinen
gebundenen Bytes abweicht. Die Ausgabe wird atomar geschrieben und ein
vorhandenes Ziel nicht ueberschrieben.
