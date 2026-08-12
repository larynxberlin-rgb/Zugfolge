# Releasegebundene Zugkartenprojektion

## Zweck und Sicherheitsgrenze

Die regionale Simulation führt die autoritative Betriebsposition eines Zuges
als ganzzahlige Millimeterposition entlang seines bestätigten Fahrwegs. Diese
Zahl ist noch keine Kartenkoordinate. Eine **exakte** Zugkartenposition
verbindet sie nur dann mit einem sichtbaren Gleis, wenn der Jahreslauf die
vollständige Kette

`Zuglauf -> bestätigter Trassenbeleg -> spielbares Segment -> geordnete
Konfliktressource -> eindeutige Gleisspanne -> Releasegeometrie`

nachgewiesen hat. Fehlende oder mehrdeutige Spannen bleiben für Exact ungelöst.
Der Compiler wählt niemals ein bloß gleich nummeriertes oder räumlich nächstes
Gleis. Diese Exact-Grenze bleibt das beabsichtigte Fail-closed-Verhalten für
alle betrieblichen Verbraucher.

E27 erlaubt daneben eine **geschätzte** Zugkartenposition. Sie ist ein eigener,
gekennzeichneter Ausgabetyp der Livemap und keine schwächere Form von Exact.
Sie darf eine Lücke in der Kartendarstellung schließen, aber niemals eine
Gleisbelegung, Fahrstraße oder Infrastrukturqualität behaupten.

## Getrennter Ausgabe- und Prioritätsvertrag (E27)

Der öffentliche Kartenvertrag unterscheidet genau drei Ergebnisse:

| Ergebnis | Zulässige Aussage | Unzulässige Aussage |
|---|---|---|
| `mapPosition: PublicMapPosition` | Weltkontext des Livefeeds, `infrastructureReleaseId`, bestätigte `resourceId`, `trackId`, gleisscharfer ganzzahliger Offset und daraus abgeleitete E7-Koordinate | fremder Release, räumlich nur angenähertes Gleis |
| `mapEstimate: PublicMapEstimate` | derselbe Weltkontext und derselbe Release, bestätigte `resourceId`, Methode und geschätzte E7-Koordinate | `trackId`, gleisscharfer Offset oder Behauptung einer konkreten Gleisbelegung |
| keine Kartenposition | Zug bleibt, soweit sichtbar, in Liste und Fahrtkette | stiller Fallback auf fremde Releases, OSM-Nähe oder Laufzeit-KI |

Die `resourceId` eines Estimate ist die autoritative Bindung an die aktuelle
Betriebsressource. Sie dient ausschließlich dazu, die richtige
Darstellungsprojektion zu wählen, und behauptet weder ein Gleis noch einen
gleisscharfen Offset. Sobald Exact vorliegt, hat es ausnahmslos Vorrang.

Nur ohne Exact und außerhalb eines `ExternalLeg` gilt diese deterministische
Reihenfolge:

1. **Orientierter amtlicher Korridor:** Ein zum selben InfraRelease gehörender
   amtlicher Korridor nimmt den bestätigten, ganzzahligen Ressourcenfortschritt
   nur auf, wenn Korridor und Richtung eindeutig gebunden sind. Die Orientierung
   ist im Release durch Ankerhalte nachgewiesen. Parallele oder
   widersprüchliche Korridore bleiben ungelöst; bloße räumliche Nähe ist kein
   Auswahlkriterium.
2. **Resourcegebundener Ankerhalt:** Ist die Korridorprojektion nicht eindeutig,
   darf der im gepinnten Release genau dieser `resourceId` eindeutig zugeordnete
   Ankerhalt verwendet werden. Das ist eine zustandslose Artefaktzuordnung,
   kein zuletzt beobachteter Serverstand. Fehlt eine eindeutige Zuordnung,
   gibt es keine Kartenposition.

Beide Wege sind deterministische Read-only-Projektionen aus gepinnten
Artefakten. Sie rufen weder externe Quellen noch KI zur Laufzeit auf und
schreiben kein Domain-Event oder Simulationsergebnis zurück. Ein `ExternalLeg`
erhält auch auf der weltweiten Basiskarte niemals ein Estimate.

Der Methodenwert `topological-track` bleibt für einen künftigen, gegen eine
eindeutige Gleiskette bewiesenen Darstellungspfad reserviert. Auch er wäre
weiterhin ein rein visuelles `PublicMapEstimate`, nie Exact. Der reale
Jahresstand 2026.1 erzeugt diese Methode noch nicht; seine bindende Reihenfolge
lautet Exact → `route-corridor` → `anchor-hold` → keine Kartenposition.

## Harte Verbrauchsgrenze

| Verbraucher | Exact | Estimate |
|---|---:|---:|
| Livemap-Darstellung und zugängliches Detailpanel | ja | ja, ausdrücklich gekennzeichnet |
| Fahrdienstleitung und Fahrstraßen | nur autoritative Betriebsdaten; Kartenkoordinate ist keine Eingabe | nie |
| Konfliktressourcen, Sperrzeiten und Laufwegsuche | nur autoritative Betriebsdaten; Kartenkoordinate ist keine Eingabe | nie |
| Trassenbestellung und Bestellbarkeit | nur qualifizierter Betriebsgraph | nie |
| Infrastruktur-Qualitätsklasse | nur dimensionierte Evidenz des Jahreslaufs | nie |

Estimate darf insbesondere keine Klasse C aufwerten, fehlende Gleiszuordnung
kaschieren oder einen Abschnitt spielbar machen. Gelb, Bernstein und Rot sind
keine Genauigkeitsfarben. Die Darstellung verwendet denselben Zugmarker wie
Exact und ergänzt auf dem Korridor `≈`, beim gehaltenen Anker `?`, einen neutral
achromatischen Ring und einen zugänglichen Erklärungstext.

## Öffentliches Laufzeitartefakt für Exact und Estimate

Der Jahreslauf erzeugt `train-map-projection.sqlite` neben
`read-model.sqlite`, Basemap und Infrastruktur-PMTiles unter derselben
unveränderlichen Releasewurzel. Die Datei ist an genau eine `world_id` und eine
`infrastructure_release_id` gebunden. Sie enthält ausschließlich:

- ganzzahlige Gleisgeometrie und Segmentrichtung;
- eindeutig nachgewiesene Ressourcen-zu-Gleisspannen;
- orientierte Darstellungskorridore und releasegebundene Ankerpfade, die nie
  ein konkretes Gleis behaupten;
- Zuglauf-ID, kumulative Millimeterspanne und Ressourcen-ID.

Trassenbeleg-ID und interne numerische Routennummer werden beim Bauen geprüft,
aber nicht ausgeliefert. Der produktive Adapter öffnet SQLite read-only,
deaktiviert Erweiterungen und vertraute Schemas und prüft Header, Tabellen- und
Spalten-Allowlist, die exakte Sechs-Tabellen-/Drei-Index-Schema-Allowlist, den
gepinnten Schema-SQL-Hash, Fremdschlüssel sowie Schnell- und
Integritätsprüfung. Stimmen Welt und Infrastruktur-Release des
Livemap-Detailkatalogs nicht exakt überein, startet die Projektion nicht.

Die Laufzeit interpoliert Breite, Länge, Gleisoffset und Richtung ausschließlich
ganzzahlig. Gleitkommazahlen aus dem Jahreslauf gelangen nicht in den
zustandsrelevanten Pfad.

## Infrastrukturzustände

Nur die nachgewiesene Exact-Ressourcen-zu-Gleis-Zuordnung projiziert reale
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
`train-map-projection-report.json`. Der Compiler bilanziert jeden
Ressourcenmillimeter sowohl im unveränderten Exact-Nachweis als auch genau
einer disjunkten Anzeigeart *confirmed*, *estimated* oder *held*.

Der reale Stand 2026.1 lautet:

- 1.654 betriebliche Ressourcen und 2.406 releasegebundene Darstellungspfade;
- 5.436.720.000 mm Ressourcenlänge, davon 1.549.332.958 mm bestätigt
  (28,49 %), 3.427.017.042 mm bewegt geschätzt (63,03 %) und 460.370.000 mm
  am Anker gehalten (8,48 %);
- alle 1.634 Deployment-Züge besitzen einen nachgewiesenen Trassen- und
  Ressourcengang;
- über alle Zugwege sind 19.827.912.046 von 85.936.059.000 mm bestätigt,
  65.402.274.954 mm bewegt geschätzt und 705.872.000 mm am Anker gehalten.

Diese Zahlen sind keine Qualitätsklasse des Betriebsgraphen. Die konservative
B-Logik kann auch auf einer Ressource zuverlässig disponieren, deren sichtbare
Gleisgeometrie noch nicht eindeutig bewiesen ist. Estimate überbrückt diese
Lücke ausschließlich sichtbar und gekennzeichnet; es verbessert weder den
Exact-Nachweis noch die betriebliche Datenqualität.

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
vorliegende Exact-Abdeckung bewusst unverändert fail-closed.

## Abnahmebeweise und offene Grenze

Vor der produktiven Freigabe bleibt trotz der folgenden automatisierten
Nachweise die manuelle Browser- und Spielabnahme für Kontrast, mehrere
Zoomstufen, Tastatur und Screenreader offen.

Der reale v2-Jahreskatalog, ein byteidentischer Reproduktionslauf sowie
Compiler-, Runtime-, Protokoll-, Karten- und Paneltests belegen:

- den diskriminierten Vertrag ohne stillen Exact-Fallback;
- die Priorität Exact → eindeutiger Korridor → releasegebundener Anker;
- den konservativen Ankerfall bei Korridormehrdeutigkeit;
- Fail-closed-Verhalten bei Release-Mismatch und für `ExternalLeg`;
- unveränderte Markeridentität sowie getrennte optische Kennzeichnung.

Diese Dokumententscheidung schließt keinen Milestone und ersetzt keinen
realen Release-, Signatur- oder Spielabnahmabeweis.
