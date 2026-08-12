# ADR-0026: Die selbst gehostete Weltkarte ist das Spielzentrum; der Deutschland-Korpus ist vollständig sichtbar

- **Status:** Angenommen — bindend (entspricht E26); der Exact-only-Satz zur sichtbaren Zugposition ist teilweise durch [ADR-0027](0027-geschaetzte-zugkartenposition-nur-visuell.md) abgelöst
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../design.md](../design.md) · [../daten.md](../daten.md) · [../deutschland-infracorpus.md](../deutschland-infracorpus.md)
- **Betrifft Milestones:** M4.7, M4.8, M9.3, M9.10, M14.2
- **Verwandte ADRs:** [ADR-0009](0009-vollstaendige-transparenz-livemap.md), [ADR-0014](0014-netzabgrenzung-nur-ebo.md), [ADR-0017](0017-design-domaenensprache-achromatisch-dunkel.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0022](0022-jaehrliche-infrastrukturaktualisierung.md), [ADR-0025](0025-gebietsueberschreitende-fahrtketten.md), [ADR-0027](0027-geschaetzte-zugkartenposition-nur-visuell.md)

## Kontext

Die frühere Livemap-Probe zeichnete einige Linien und leitete Bildkoordinaten
aus `positionMm` ab. Sie bewies Stream und Sequenzwiederaufnahme, aber weder
eine geografisch richtige Karte noch ein deutschlandweites, anklickbares
Infrastrukturmodell. Zugleich besitzt das Spiel drei verschiedene Grenzen:
Die Weltkarte soll Orientierung überall erlauben, der Infrastrukturstand soll
Deutschland vollständig erfassen, und nur ein kleinerer, qualifizierter Teil
ist in einer Welt spielbar. Werden diese Grenzen vermischt, verschwinden
sichtbare Strecken beim Alpha-Zuschnitt oder unzureichende Daten werden
versehentlich bestellbar.

Öffentliche OSM-Kachelserver sind kein Produktionsbackend für ein dauerhaftes
Spiel und dürfen nicht für einen Weltbestand vorgeladen werden. APN-Skizzen
können Bahnhöfe intern plausibilisieren, bilden aber weder freie Strecke noch
eine alleinige Datenwahrheit ab. Schließlich ist eine vermeintlich genaue
Topologie ohne gesicherte Gleiszuordnung gefährlicher als ein sichtbares,
konservatives B-Modell.

## Entscheidung

**Die interaktive, vollständig selbst gehostete Weltkarte ist die primäre
Spieloberfläche. Sie legt einen vollständigen, jährlich neu gebauten
Deutschland-`InfraCorpus` über eine weltweite dunkle OSM-Vektorbasiskarte;
`visible`, `modelled` und `playable` sind drei unabhängige, explizite
Freigaben.**

Basiskarte und deutsche Infrastruktur werden als getrennte, hashbenannte
PMTiles-Artefakte ausgeliefert. Stil, Glyphen, Sprites und Kacheln liegen auf
demselben Ursprung wie die Anwendung; es gibt keinen stillen Rückfall auf
öffentliche Kartenanbieter. Der Server liefert Byte-Ranges und unveränderliche
Cacheheader. OSM-Attribution bleibt sichtbar.

Der Deutschland-Korpus umfasst das EBO-Netz vollständig, auch außerhalb der
aktuellen Weltregion. Ein Objekt kann sichtbar, aber nicht betrieblich
modelliert sein; ein modelliertes Objekt kann sichtbar und simuliert, aber in
der aktuellen Welt nicht spielbar sein. Nur `playable=true`, vollständige
Konfliktressourcen und eine Qualität A oder B erlauben Bestellung und
Fahrdienstleitung. Klasse B ist eine regelkonforme, konservative Nachbildung
und kein Makel. Klasse A verlangt dimensionsbezogene Evidenz; eine einzelne
Quelle, ein KI-Ergebnis oder ein Tag darf A nie allein erzeugen.

Die Karte zeigt mit dem Zoom zunehmend Korridore, Betriebsstellen,
Einzelgleise, Bahnsteige, Blöcke, Weichen, Signale und Anlagen. Jedes sichtbare
Fachobjekt besitzt eine stabile, releasegebundene Kennung und ist anklickbar.
Große Details liegen in einem unveränderlichen Objektkatalog und werden erst
beim Klick geladen. Bahnhofstafel und FIS sind Darstellungen derselben
serverautoritativen Fahrplan-/Liveprojektion, keine eigene Datenwahrheit.
Eigene Züge dürfen serverseitig autorisierte Zusatzdaten zeigen; öffentliche
Zugdetails enthalten nie Kosten-, Fahrzeug-, Personal- oder Vertragskennungen.

Eine Zugposition erscheint nur bei bestätigter `trackId`, ganzzahligem Offset
und aus dem gepinnten Release abgeleiteter E7-Koordinate. Fehlt diese Zuordnung,
bleibt die Fahrt in der Liste sichtbar, aber ohne erfundenen Kartenpunkt.

> **Historische Teilablösung durch E27/ADR-0027:** Dieser Absatz bleibt als
> ursprünglicher Entscheidungsstand sichtbar. Sein Exact- und
> Betriebssicherheitsvertrag gilt unverändert; nur die Darstellung darf bei
> fehlendem Exact nun eine getrennte, releasegebundene und eindeutig als
> geschätzt markierte Position verwenden. Eine solche Schätzung wird niemals
> betriebliche Wahrheit.

Betriebszustände überlagern das neutrale Netz: Einschränkung bernsteinfarben
und gestrichelt, Sperrung rot und unterbrochen, Baustelle rot-weiß gemustert.
Farbe steht nie allein. Die visuelle Sprache bleibt generisch eisenbahntypisch;
Fallblattanzeige und FIS übernehmen weder Logo, Hausschrift noch konkrete
Firmenoberfläche eines realen Betreibers.

Der jährliche KI-Arbeitslauf ist durch einen festen Prompt, gepinnte Quellen,
Quellhashes, deterministische Compiler und einen unabhängigen Holdout
reproduzierbar. APN darf gemäß Projektfreigabe automatisiert intern prüfen,
wird aber aus dem öffentlichen Release und dessen Attribution entfernt und ist
nie allein A-fähig. Eine KI darf Widersprüche priorisieren und Prüfaufgaben
erzeugen; Sicherheitslogik, Fahrstraßen und Konfliktressourcen entstehen aus
versionierten Regeln und Tests.

## Begründung

Die Karte wird damit tatsächlich zum Dreh- und Angelpunkt: dieselbe räumliche
Sprache verbindet Orientierung, Fahrplan, Betrieb, Störung und Detailwissen.
Die Dreiteilung verhindert zugleich, dass Vollständigkeit mit Spielbarkeit
verwechselt wird. Deutschland kann vollständig geladen und erkundet werden,
ohne Klasse C oder eine noch nicht freigegebene Region zu betrieblicher
Wahrheit zu erklären.

Selbsthosting gibt Zugfolge einen unveränderlichen Kartenstand je Welt,
kontrollierbare Gestaltung und einen ausfallfreien Replaypfad. Der jährliche
Compiler ersetzt die unrealistische Erwartung eines kleinen manuellen Updates
durch einen prüfbaren, KI-unterstützten Neubau, ohne KI zum Laufzeitdienst oder
Sicherheitsentscheider zu machen.

## Konsequenzen

- **Erleichtert:** Deutschlandweite Sichtbarkeit ab der Alpha, stabile Deep
  Links auf jedes Objekt, einheitliche Detailansichten, reproduzierbare
  Jahreswechsel und spätere regionale Freischaltungen ohne neuen Kartenclient.
- **Kostet:** Planet- und Deutschland-Build, Speicher, CDN/Range-Serving,
  Objektkatalog, Quellpflege, Holdout und jährliche Fachprüfung bleiben
  Betriebsaufgaben. Ein Repositorytest ersetzt keinen vollständigen Jahreslauf.
- **Sicherheit:** Öffentliche Feeds werden per Allowlist redigiert; Owner-Daten
  werden serverseitig autorisiert. Die Karte erfindet weder Koordinaten noch
  Signalbilder oder Weichenlagen.
- **Rechte:** ODbL- und CC-BY-Ebenen bleiben getrennt nachvollziehbar. Kein
  Datenimport ohne Registerfreigabe, keine öffentlichen Runtime-Tiles.
- **Invarianten:** `world_id` und `infrastructureReleaseId` begleiten Details
  und Positionen. Geozahlen und Zustandswerte bleiben ganzzahlig im
  autoritativen Pfad. Externe Quellen liegen nur im Jahresbau, nie im heißen
  Pfad.
- **Abnahme:** Der reale Deutschland-Jahreslauf 2026.1 mit gepinnten
  Großquellen, zehn semantischen Layern, Qualitätsreport, vollständiger
  interner Planprüfung und selbst gehosteten Kartenartefakten ist ausgeführt;
  das 14,4-GB-Transportpaket ist verifiziert und testinstalliert. Der Kandidat
  vergibt bewusst kein A und bleibt unsigniert
  `activationEligible=false`. M14.2 ist deshalb **in Arbeit**, nicht erledigt:
  Namentliche Freigabe, echte Signatur, erneute Game-Qualifizierung und der
  produktive Odoo-/Periodenwechsel fehlen noch. Packen, Prüfen und Staging sind
  ausdrücklich kein Aktivierungsnachweis.

## Verworfene Alternativen

1. **Öffentliche Kartenkacheln direkt verwenden:** verworfen wegen
   Nutzungsgrenzen, fehlender Verfügbarkeitssicherung und nicht gepinntem
   Replaystand.
2. **Nur das spielbare Gebiet importieren:** verworfen, weil Kartensichtbarkeit,
   Datenmodell und Weltfreigabe dadurch untrennbar würden.
3. **APN oder KI als Infrastrukturwahrheit behandeln:** verworfen, weil APN die
   freie Strecke nicht vollständig beschreibt und KI-Evidenz keine getestete
   Regelwerksableitung ersetzt.
4. **Absolute Nachbildung jedes Stellwerks abwarten:** verworfen, weil ein
   regelkonformes, transparent konservatives B-Modell für robuste Spiellogik
   genügt und schrittweise zu A qualifiziert werden kann.
