# ADR-0022: Infrastruktur- und Fahrplandaten werden jährlich zum realen Fahrplanwechsel aktualisiert

- **Status:** Angenommen — bindend (entspricht E22)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../daten.md](../daten.md) ·
  [../rechte.md](../rechte.md) · [../milestones.md](../milestones.md)
- **Betrifft Milestones:** M9 (Betriebsreife), M14.2
- **Verwandte ADRs:** [ADR-0010](0010-trassenfinder-nur-kalibrierwerkzeug.md) ·
  [ADR-0003](0003-fahrplanperiode-als-weltparameter.md) ·
  [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md)

## Kontext

Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes (siehe
`CLAUDE.md`). Das reale Schienennetz der Pilotregion steht damit nicht still:
Betriebsstellen entstehen oder entfallen, Elektrifizierung und
Streckenführung ändern sich, jeweils zum realen Fahrplanwechsel. Ohne einen
Mechanismus, der damit mithält, veraltet die Pilotregion sichtbar gegenüber
ihrem realen Vorbild — ein Widerspruch zum hohen betrieblichen und
infrastrukturellen Realismus, den das Projekt beansprucht.

Der Jahreslauf braucht dafür reproduzierbar gepinnte und rechtlich
freigegebene Eingaben. Öffentliche Erreichbarkeit allein genügt nicht:
Insbesondere die Trassenfinder-Infrastruktur-API besitzt keine veröffentlichten
Nutzungsbedingungen und bleibt deshalb interne Lineagereferenz, nicht
Releaseinput. Der offizielle DB-InfraGO-Open-Data-Datensatz übernimmt die
amtliche Betriebsstellen- und Streckenattributebene.

## Entscheidung

Das Spiel hält mit dem jährlichen realen Fahrplanwechsel mit: Infrastruktur-
und Fahrplandaten werden **einmal jährlich** neu gezogen und zu einem neuen,
versionierten `InfraRelease` verarbeitet. E26 erweitert den ursprünglichen
Pilotregionsschnitt auf einen vollständig sichtbaren Deutschland-Korpus und
eine getrennte Welt-Basemap. Welche Quellen einen konkreten Jahresstand tragen,
entscheidet daher nicht mehr eine fest verdrahtete Zweierliste, sondern der
geprüfte, versionierte Quellkatalog. Für 2026.3 bindet der Mindestbestand exakt
die fünf freigegebenen Pflichtquellen Deutschland-OSM-PBF,
DB-InfraGO-Open-Data, GTFS.DE, Copernicus DEM und OpenStation. Betriebspunkte
werden direkt aus dem DB-InfraGO-Adapter materialisiert, ohne
Trassenfinder-Gegenprüfung oder Fallback.

Ausdrücklich **nicht** erfasst: die von der Trassenfinder-API berechneten
Fahrzeit- und Trassenpreiswerte (Routensuche). Die bleiben, wie in E10/ADR-0010
entschieden, reine Kalibrierreferenz der Entwicklung — niemals Import, niemals
Laufzeitquelle. E10s Laufzeitverbot gilt unverändert für die gesamte
Trassenfinder-API. Historische Stammdaten und daraus erzeugte Derivate bleiben
interne Lineageprüfung und werden nicht als GTFS- oder Open-Data-Ableitung
umetikettiert.

Ein neues `InfraRelease` ersetzt keine laufende Welt sofort. Es wird zum
nächsten `Periodenwechsel` (Ende der laufenden Fahrplanperiode, ADR-0003)
wirksam — demselben Zeitpunkt, zu dem ohnehin Trassenvergabe und Verträge neu
ausgerichtet werden. Der genaue Übernahmemechanismus für eine laufende Welt
ist Gegenstand der in M9 auszuarbeitenden Teilabschnitte, nicht dieser
Entscheidung.

Der Jahreslauf endet in einem transportneutralen Karten- und
Infrastrukturpaket. Dieses darf vorab geprüft und über Odoo in einen getrennten
Game-Stagingbereich übertragen werden. Ohne echte Release-Signatur bleibt
`activationEligible=false`; weder Paketbildung noch Odoo-Upload oder Staging
setzen eine Welt um. Damit bleibt der jährliche Neubau vom sicherheitskritischen
Periodenwechsel getrennt.

## Begründung

Eine Welt, die niemals zurückgesetzt wird, aber ihr reales Vorbild ignoriert,
verliert genau den Realismus, der das Projekt trägt (E19: Realismus dient dem
Spiel). Der jährliche Fahrplanwechsel ist der natürliche, real vorgegebene
Takt dafür — kein selbst erfundenes Intervall. Ein versionierter Quellkatalog,
Byte-/SHA-Capture und create-new-Ausgaben halten diesen Takt reproduzierbar,
ohne die in ADR-0010 begründete Ablehnung eines Laufzeitdiensts zu berühren.

## Konsequenzen

- **Erleichtert:** Die Pilotregion bleibt über die gesamte Weltlaufzeit
  (E18: 6–18 Monate oder unbefristet) gegenüber dem realen Netz aktuell, ohne
  dass das Spiel selbst zurückgesetzt werden muss. Zwei sich ergänzende,
  bereits einzeln geprüfte Importquellen statt einer.
- **Kostet / schränkt ein:** Der `InfraRelease`-Bau (M1.2–M1.13) muss
  wiederholbar gegen neue Jahresdaten laufen, nicht nur einmalig. Für eine
  bereits laufende Welt braucht es ein noch auszuarbeitendes
  Übernahmeverfahren, das Invariante 1 über den Wechsel hinweg nicht verletzt.
- **Invarianten:** Berührt keine harte Invariante unmittelbar; stützt die
  Reproduzierbarkeit (Invariante 3), weil jedes `InfraRelease` weiterhin
  unveränderlich und versioniert bleibt, auch bei jährlicher Neuerzeugung.
- **Milestones:** M9 (Betriebsreife) — jährliche Aktualisierung und
  Übernahme in laufende Welten sind dort als eigener Teilabschnitt zu planen.
