# Releasegebundene exakte Zugkartenprojektion

## Zweck und Sicherheitsgrenze

Die Zugkartenprojektion ist ab E31 keine eigene Positionsberechnung. Sie
übersetzt ausschließlich die exakte Zugspitze des committed
`OperationalWorld` über dessen Laufwegversion und die Geometrie des
gepinnten operativen `InfraRelease` in E7-Koordinaten. LiveMap und RZÜ
verwenden denselben Zugdatensatz und dieselbe Commit-Sequenz.

Ohne die vollständige Kette

`Zug → Formation → Laufwegversion → gerichtete Gleiskante → ganzzahliger
Offset → Releasegeometrie`

gibt es keine fortgesetzte Bewegung. Der Kern hält am letzten garantierten
Punkt, Zugintervalle und Locks bleiben erhalten und beide Anzeigen frieren
ein. Räumlich nächstes Gleis, Korridor, Ankerhalt, OSM-Nähe, Laufzeit-KI und
andere Schätzpfade sind ausgeschlossen.

## Öffentlicher v2-Vertrag

`PublicMapPosition` nennt:

- `infrastructureReleaseId`, bestätigte Ressourcen- und Gleiskennung;
- ganzzahligen gleisscharfen Offset und E7-Koordinate;
- optional die ganzzahlige Richtung in Milligrad.

`PublicOperationalTrainState` desselben Zuges nennt:

- Commit- und Simulationszeit;
- Laufweg- und Formationsversion;
- Bewegungsart und Richtung;
- Zugspitze, Zugschluss, Kantenintervalle und Blöcke;
- Fahrberechtigungsende und gegebenenfalls Wartegrund;
- den unveränderlichen autorisierten Bewegungsabschnitt mit
  `started_at`, `valid_until`, Startposition, Startgeschwindigkeit,
  Beschleunigung und der dafür zulässigen Releasegeometrie.

Der Browser darf innerhalb dieses Abschnitts mit Gleitkommazahlen darstellen;
er darf weder über `valid_until` noch über das Fahrberechtigungsende hinaus
rechnen. Danach, bei Verbindungsabbruch oder Sequenzlücke friert er ein.
`ExternalLeg` besitzt weiterhin keine erfundene Kartenposition.

An einem Gleiswechsel enthält die Bewegungsgeometrie beide Endpunkte: zuerst
den Austritt der alten Kante, dann den Eintritt der neuen Kante am selben
Laufwegmillimeter und derselben E7-Koordinate. Die gleisbezogenen Offsets
bleiben getrennt. Nur solche verbundenen Kantenwechsel dürfen denselben
Laufwegmillimeter besitzen; zwischen verschiedenen Gleisen wird kein Offset
interpoliert. Am Übergang gilt bereits der Eintrittspunkt der folgenden Kante.

Die Kartendarstellung kennzeichnet einen eingefrorenen Marker zusätzlich mit
„Lage eingefroren“, einen Ausfall mit „Ausfall“ und Verspätungen über einer
Minute mit dem Minutenwert. Markerkennung und letzter bestätigter Kartenpunkt
bleiben bei einem Verbindungsabbruch erhalten. Die kontinuierliche Animation
endet mit dem letzten noch gültigen Bewegungsabschnitt; eine längere
Transporttoleranz des Regionsframes erzeugt keine weiteren Animationsframes.

## Öffentliches Laufzeitartefakt

Der Releasecompiler erzeugt den Kartenpfad neben Readmodel, Basemap und
Infrastruktur-PMTiles. Das v2-Artefakt ist an genau ein
`infrastructure_release_id` gebunden und enthält:

- ganzzahlige gerichtete Gleisgeometrien;
- Kantenlängen und Laufweg-zu-Kanten-Spannen;
- eindeutige Ressourcen-, Block- und Bahnsteigintervalle;
- statisches RZÜ-Layout.

Historische Korridor- und Ankerpfade aus
`train-map-projection.sqlite` dürfen zur Datenpflege erhalten bleiben, sind
aber keine v2-Laufzeiteingabe. Der Messstand 2026.1 mit 28,49 Prozent
gleisscharf bestätigten Ressourcenmillimetern ist damit ein echter
Freigabeblocker für alle noch nicht exakt qualifizierten befahrenen Laufwege,
nicht eine Einladung zur visuellen Überbrückung.

Der Adapter öffnet Releaseartefakte read-only, deaktiviert Erweiterungen,
prüft Schema-Allowlist, gepinnten SQL-Hash, Fremdschlüssel, Integrität, Welt-
und Releasebindung. Ein Mismatch verhindert den Weltstart.

## Infrastrukturzustände

Nur eine nachgewiesene Ressourcen-zu-Gleis-Zuordnung projiziert committed
Betriebsabweichungen:

| Fachwirkung | Kartenstatus |
|---|---|
| Sperrung | `closure` |
| Langsamfahrstelle oder Eingleisigkeit | `restriction` |
| autoritativ klassifizierte geplante Baustelle | `construction` |

Freitext oder Datum genügt nicht. Die Aufhebung der autoritativen Störung
entfernt im selben committed Delta auch den sparsamen Objektzustand.

## Abnahme

Automatisiert zu beweisen sind:

- keine sichtbare Position ohne exakte Release-/Laufwegbindung;
- mathematische Kontinuität über Kanten, Weichen und Laufwegversionen;
- Zugspitze nie hinter Fahrberechtigungsende;
- Freeze exakt bei `valid_until`;
- Snapshotreset bei Stream-/Sequenzlücke;
- Commitgleichheit von LiveMap und RZÜ;
- unveränderte LiveMap-Markeridentität, Layerreihenfolge und Pop-ups.

Manuelle Browserabnahme für Kontrast, Zoomstufen, Tastatur, Screenreader und
den bestehenden geografischen Stil bleibt vor der produktiven Freigabe
zusätzlich notwendig. Der vollständige Betriebs- und Cutoververtrag steht in
[`betriebsengine.md`](betriebsengine.md).
