# ADR-0025: Gebietsüberschreitende Fahrten bleiben eine Fahrtkette mit deterministischem Außenlauf

- **Status:** Angenommen — bindend (entspricht E25)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../infrastruktur.md](../infrastruktur.md) · [../mitteldeutschland-alpha.md](../mitteldeutschland-alpha.md) · [GitHub-Issue #192](https://github.com/larynxberlin-rgb/Zugfolge/issues/192)
- **Betrifft Milestones:** M3.4, M4.5, M9.2, M9.3, M14.1, später M14.2–M14.4
- **Verwandte ADRs:** [ADR-0005](0005-rust-kern-typescript-plattform.md), [ADR-0009](0009-vollstaendige-transparenz-livemap.md), [ADR-0014](0014-netzabgrenzung-nur-ebo.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0022](0022-jaehrliche-infrastrukturaktualisierung.md), [ADR-0024](0024-erweiterter-alpha-schnitt.md)

## Kontext

Ein GTFS-Zuglauf kann vor dem Spielgebiet beginnen, es verlassen oder nach
einem Außenabschnitt wieder eintreten. Das freigegebene InfraRelease enthält
außerhalb seiner Grenze absichtlich weder bestellbare Konfliktressourcen noch
ausreichend qualifizierte Fahrstraßen. Drei naheliegende Umsetzungen sind
unbrauchbar: Das Abschneiden am Kartenrand erfindet einen falschen Endbahnhof
und löst Fahrzeug- und Personalbindungen zu früh; eine detaillierte
Außensimulation würde nicht freigegebene Infrastruktur zur Spielwahrheit
machen; das vollständige Verwerfen solcher Linien ließe wesentliche Teile des
realen SPNV-Angebots verschwinden.

Zugleich muss die Planung für interessierte Laien logisch bleiben. Ein Spieler
kann nur dort Trassen, Halte und Umläufe entscheiden, wo die Welt echte
Ressourcen besitzt. Er muss aber vor dem Antrag erkennen, wann sein Zug am
Grenzportal ankommen oder bereitstehen muss, wie lange Fahrzeug und Personal
außerhalb gebunden bleiben und wann eine Rückkehr möglich ist.

## Entscheidung

**Jeder gebietsüberschreitende GTFS-Zuglauf wird offline als zusammenhängende
`JourneyChain` aus `PlayableLeg`, `BoundaryPortal` und `ExternalLeg`
kompiliert; der Spieler disponiert nur `PlayableLeg`, jedoch stets gegen die
sichtbaren, unveränderlichen Grenzfenster der ganzen Fahrtkette.**

Ein `PlayableLeg` verweist ausschließlich auf qualifizierte Knoten, Kanten und
Konfliktressourcen des gepinnten InfraRelease. Ein `BoundaryPortal` ist eine
benannte, versionierte betriebliche Schnittstelle und besitzt Einfahr-,
Ausfahr- und Mindestübergabezeiten. Ein `ExternalLeg` enthält keine erfundene
Außentopologie. Es bindet Zugfahrt, Fahrzeug und gegebenenfalls Personaldienst
bis zu einer festen Rückkehr oder einem festen Außenende, übernimmt die
Verspätung ganzzahlig und verwendet nur im Release gepinnte Kosten.

Die Planungsoberfläche zeigt den Außenlauf als schraffierten, nicht
bearbeitbaren Abschnitt. Für den regionalen Antrag gelten serverseitig
verbindliche `BoundaryPlanningWindow`: bei Einfahrt die früheste und späteste
Abfahrbereitschaft am ersten inneren Halt, bei Ausfahrt die früheste und
späteste Ankunft am letzten inneren Halt. Der Spieler wählt weiterhin Laufweg,
Halte und eine zulässige
Zeitlage innerhalb des Gebiets; die Engine verwirft Kandidaten, die den
Außenanschluss nicht erreichen. Die Grenzzeit ist damit eine verständliche
Randbedingung, kein unsichtbarer Automatismus.

Im Simulationskern besitzt die `ExternalZone` den Zug während des Außenlaufs
als deterministischer Single-Writer. Die regionale Quelle löscht ihn erst nach
bestätigter Annahme. Bei der Rückkehr reserviert die Zielregion zuerst die
angegebenen realen Konfliktressourcen; sind sie belegt, wartet der Zug sichtbar
am Portal außerhalb. Ein Außenereignis allein erzeugt keine Pönale,
Präqualifikationsfolge oder versteckte Optimierung zugunsten eines Spielers.

Nur Fahrtketten mit benannten Portalen, monotonen Zeiten, qualifiziertem
innerem Abschnitt und vollständiger Außenbindung sind in einem Spielerlos
bestellbar. Ein lediglich als `first-outside` erkannter Schnitt bleibt als
interne Builddiagnose erhalten und gelangt weder in den freigegebenen
InfraRelease noch in Spielerartefakte. Gehört er zu einer erforderlichen
Fahrtkette des Korpusscopes, blockiert er den Kandidaten. Frei geplante neue
Linien dürfen am Portal enden; einen Außenlauf kann der Spieler nur aus einer
qualifizierten, im Fahrplanrelease enthaltenen Fortsetzung auswählen.

## Begründung

Die Fahrtkette bewahrt die reale betriebliche Identität, ohne das Spielgebiet
durch ungesicherte Daten auszuweiten. Grenzfenster machen die verbleibende
Spielerentscheidung konkret: Der Spieler optimiert den eigenen Laufweg und
seine Reserven, kann aber nicht den externen Fahrplan umschreiben. Derselbe
Vertrag skaliert von Variante B auf Deutschland: innere Regionsgrenzen nutzen
die vollständige Writer-Übergabe, nur die Grenze des freigegebenen Weltgebiets
nutzt eine `ExternalZone`.

## Konsequenzen

- **Erleichtert:** Reale Liniennamen, Umläufe, Anschlüsse und Fahrzeugbindungen
  bleiben nachvollziehbar; Planung und Livemap können Innen-, Außen- und
  Wartezustand klar unterscheiden.
- **Kostet / schränkt ein:** Der jährliche Releasebau braucht Portalkatalog,
  Außenzeitprüfung, Umlauf-/Bindungsnachweis und einen eigenen
  Qualifizierungsbericht. Nicht nachweisbare Durchbindungen bleiben interne
  Buildbefunde; im verbindlichen Korpusscope verhindern sie die Freigabe.
- **Invarianten:** `world_id`, Releasekennung und Fahrtkettenkennung begleiten
  jedes Leg und jedes Ereignis. Zeiten, Kosten und Fortschritt bleiben
  Ganzzahlen. Keine externe Quelle liegt im heißen Pfad. Die Zielregion
  bestätigt erst nach Ressourcenprüfung, sodass Invariante 1 erhalten bleibt.
- **Milestones:** M14.1 muss Journey-Chain-Coverage und Grenzfehler ausweisen;
  M9.2 startet den Eigenbetrieb nur mit qualifizierten Ketten. Deutschlandweite
  Regionalisierung ersetzt die `ExternalZone` schrittweise durch echte
  Regional-Writer, ohne den Spieler- oder Fahrplanvertrag zu ändern.

## Verworfene Alternativen

1. **Linie am letzten inneren Halt beenden:** verworfen, weil Fahrplan,
   Fahrzeugfreigabe, Wende und Fahrgastinformation falsch würden.
2. **Außennetz abstrakt als erfundene Kanten simulieren:** verworfen, weil
   daraus scheinbar bestellbare Kapazität ohne Rechte- und Qualitätsnachweis
   entstünde.
3. **Alle grenzüberschreitenden Fahrten ausschließen:** verworfen, weil das
   reale Angebot und wichtige Umläufe an der Regionsgrenze auseinanderfielen.
