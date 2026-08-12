# Releasegebundene Zugkartenprojektion

## Zweck und Sicherheitsgrenze

Die regionale Simulation führt die autoritative Betriebsposition eines Zuges
als ganzzahlige Millimeterposition entlang seines bestätigten Fahrwegs. Diese
Zahl ist noch keine Kartenkoordinate. Die Zugkartenprojektion verbindet sie nur
dann mit einem sichtbaren Gleis, wenn der Jahreslauf die vollständige Kette

`Zuglauf -> bestätigter Trassenbeleg -> spielbares Segment -> geordnete
Konfliktressource -> eindeutige Gleisspanne -> Releasegeometrie`

nachgewiesen hat. Fehlende oder mehrdeutige Spannen bleiben ungelöst. Der
Compiler wählt niemals ein bloß gleich nummeriertes oder räumlich nächstes
Gleis. Damit kann ein Zug zeitweise in der erklärten Liste erscheinen, ohne auf
der Karte gezeichnet zu werden. Das ist ein beabsichtigtes Fail-closed-Verhalten
und kein Anlass für Pseudokoordinaten.

## Öffentliches Laufzeitartefakt

Der Jahreslauf erzeugt `train-map-projection.sqlite` neben
`read-model.sqlite`, Basemap und Infrastruktur-PMTiles unter derselben
unveränderlichen Releasewurzel. Die Datei ist an genau eine `world_id` und eine
`infrastructure_release_id` gebunden. Sie enthält ausschließlich:

- ganzzahlige Gleisgeometrie und Segmentrichtung;
- eindeutig nachgewiesene Ressourcen-zu-Gleisspannen;
- Zuglauf-ID, kumulative Millimeterspanne und Ressourcen-ID.

Trassenbeleg-ID und interne numerische Routennummer werden beim Bauen geprüft,
aber nicht ausgeliefert. Der produktive Adapter öffnet SQLite read-only,
deaktiviert Erweiterungen und vertraute Schemas und prüft Header, Tabellen- und
Spalten-Allowlist, die exakte Vier-Tabellen-/Zwei-Index-Schema-Allowlist, den
gepinnten Schema-SQL-Hash, Fremdschlüssel sowie Schnell- und
Integritätsprüfung. Stimmen Welt und Infrastruktur-Release des
Livemap-Detailkatalogs nicht exakt überein, startet die Projektion nicht.

Die Laufzeit interpoliert Breite, Länge, Gleisoffset und Richtung ausschließlich
ganzzahlig. Gleitkommazahlen aus dem Jahreslauf gelangen nicht in den
zustandsrelevanten Pfad.

## Infrastrukturzustände

Die gleiche nachgewiesene Ressourcen-zu-Gleis-Zuordnung projiziert reale
Betriebsabweichungen auf die Karte:

| Fachwirkung | Kartenstatus |
|---|---|
| Sperrung | `closure` |
| Langsamfahrstelle oder Eingleisigkeit | `restriction` |
| autoritativ als geplante Baustelle klassifiziert | `construction` |

Freitext, Ursachenbezeichnung oder bloß ein geplantes Datum reichen für eine
Baustellenschraffur nicht aus. Nicht gleisbezogene Wirkungen und nicht
aufgelöste Ressourcen erzeugen keinen Objektstatus. Wird eine Störung entfernt,
entfernt derselbe regionale Fanout auch die daraus abgeleiteten sparsamen
Gleiszustände.

## Jahreslauf 2026.1

Die geprüfte Ausgabe liegt in
`var/derived/germany-2026/map-release/public/train-map-projection.sqlite`; der
maschinenlesbare Nachweis liegt daneben als
`train-map-projection-report.json`. Der Compiler bilanziert jede
Ressourcenmillimeter genau einer der Mengen *aufgelöst*, *mehrdeutig* oder
*fehlend* zu.

Der reale Stand 2026.1 lautet:

- 1.654 betriebliche Ressourcen, davon 69 vollständig, 831 teilweise und 754
  nicht georeferenziert;
- 5.436.720.000 mm Ressourcenlänge, davon 1.549.332.958 mm eindeutig
  aufgelöst (28,49 %), 299.106.352 mm mehrdeutig und 3.588.280.690 mm ohne
  hinreichenden Geometrienachweis;
- alle 1.634 Deployment-Züge besitzen einen nachgewiesenen Trassen- und
  Ressourcengang; davon sind 1.570 wenigstens teilweise und 64 gar nicht
  georeferenzierbar;
- über alle Zugwege sind 19.827.912.046 von 85.936.059.000 mm eindeutig
  georeferenziert (23,07 %); kein vollständiger Zugweg ist bereits lückenlos.

Diese Zahlen sind keine Qualitätsklasse des Betriebsgraphen. Die konservative
B-Logik kann auch auf einer Ressource zuverlässig disponieren, deren sichtbare
Gleisgeometrie noch nicht eindeutig bewiesen ist. Die Kartenprojektion darf
diese Lücke nicht durch eine scheinbar genaue Position verdecken.

## Weg zu höherer Abdeckung

Die bereits vorhandene Streckennummer und Kilometrierung allein reichen nicht
für eine deutliche sichere Steigerung: Sie unterscheiden in vielen Bereichen
weder Parallelgleise noch Abzweige und Überleitverbindungen. Der nächste
sinnvolle Jahreslauf-Baustein ist deshalb ein gesonderter topologischer
Pfadnachweis zwischen den georeferenzierten Betriebsstellen. Er muss je
Ressource eine einzige zusammenhängende, richtungskonsistente OSM-Gleiskette
finden und konkurrierende Ketten als mehrdeutig ablehnen. Gleisscharfe neue
Evidenz oder eine interne Planprüfung kann solche Gleichstände zusätzlich
auflösen; sie darf die öffentliche Quellen- und Rechtehülle nicht umgehen.

Bis ein solcher Nachweis implementiert und unabhängig geprüft ist, bleibt die
vorliegende Abdeckung bewusst unverändert fail-closed.
