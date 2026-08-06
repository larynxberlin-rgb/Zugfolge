# Daten, Quellen, Rechte, Qualitätsklassen

## 1. Was OSM und OpenRailwayMap wirklich liefern

Das Tagging-Schema ist ausgesprochen detailliert, und Deutschland gehört zu den
am besten erfassten Netzen: Streckentopologie, `maxspeed`, `electrified` mit
Spannung und Frequenz, Gleisnummern über `railway:track_ref`, Betriebsstellen,
Zugbeeinflussung über `railway:pzb` / `railway:etcs`, Hauptsignale, Vorsignale
und Blockkennzeichen nach ESO. Für Signale gilt die Erfassung in Deutschland
weitgehend als abgeschlossen, mit bekannten Lücken bei Zs 3(v) und bei
vorübergehenden Langsamfahrstellen, die dort ohnehin nicht geführt werden.

Drei Dinge stehen **nicht** darin und müssen abgeleitet werden — das ist Arbeit,
kein Import:

| Fehlt | Konsequenz |
|-------|------------|
| Blockabschnitte als Objekte | aus Signalstandort, Zugbeeinflussung und Topologie ableiten (M1.6) |
| Fahrstraßen, Durchrutschwege, Flankenschutz | aus Weichenlage und Signalstandort erzeugen (M1.7, **XL** — schwerster Einzelposten in M1) |
| Längsneigung (`incline` kaum gepflegt) | aus einem Höhenmodell entlang der Gleisgeometrie ableiten (M1.5) |

Deshalb steht die **Abdeckungsmessung (M1.4) vor** der Blockbildung. Sie
entscheidet datenbasiert, welcher Abschnitt Qualitätsklasse A erreichen kann und
welcher konservativ als B geführt wird. Die Qualitätsklassen sind damit kein
Notbehelf, sondern das Ergebnis einer Messung.

## 2. Quellen und Rechte

**Grundregel: Ohne dokumentierte Freigabe kein Import.** Die Pilotregion muss
allein mit OSM-Extract und eigenen Regeln spielbar sein — sonst blockiert die
Rechtslage das gesamte Projekt.

- Ein genehmigter, versionierter OSM-PBF-Extract ist die Basis für Geometrie und
  Railway-Tags. OpenRailwayMap ist dabei Interpretationsdokumentation, kein
  separater Datenprovider.
- OSM-abgeleitete und unabhängig lizenzierte Fakten bleiben getrennte
  Datenebenen, bis eine qualifizierte ODbL-Prüfung die Derivative-/Collective-
  Database- und Bereitstellungspflichten freigibt.
- OpenStation und StaDa sind Stationsdaten-Kandidaten. Version,
  Bereitstellungsweg, Marketplace-Bedingungen, Attribution und Feldmapping
  müssen vor einem Import genehmigt sein.
- RINF bleibt bis zu einer schriftlichen Wiederverwendungsentscheidung
  blockiert. pathOS und TPN sind ohne neue Berechtigung und ausdrücklichen
  Vertrag als Spiel- oder Validierungsbackend ausgeschlossen.
- Öffentliche OSM-/OpenRailwayMap-Tiles und öffentliches Nominatim werden nicht
  produktiv genutzt. Das Spiel erzeugt und hostet eigene Dark-Vector-Tiles.
- Entgeltregeln aus TPS-/SPS-/APS-/INB- und Anlagen-/Stationspreisquellen werden
  erst nach einer periodenbezogenen Rechteentscheidung als eigene, versionierte
  Regeln implementiert und mit zulässigen offiziellen Beispielen geprüft.
- Reale Baustellen- und Störungsfeeds benötigen einen Vertrag, der kommerziellen
  Abruf, Speicherung, Ableitung, Kartendarstellung, Replay, Audit, Aufbewahrung
  und Löschung abdeckt.
- **Jedes importierte Attribut trägt Quelle, Lizenz, Gültigkeit, Checksumme und
  Confidence.**

## 3. Trassenfinder (E10)

Wertvoll ist die **Struktur**: welche Parameter eine Trassenanfrage definieren —
Regellokbezeichnung, Kupplungsart, längenabhängige Achslastgrenzen, Zuglänge und
Masse — und welche Kostenkategorien real existieren: Trassenpreis nach TPS,
Stationsentgelt nach SPS, Anlagenpreise, Energiebedarf. Das ist eine fertige
Modellierungscheckliste für `PathRequest` und `EconomyRelease`.

Zwei Grenzen bleiben unabhängig von der Rechtslage bestehen:

- **Kein Laufzeitdienst.** Determinismus und Replay verlangen, dass jede
  Kostenberechnung aus dem gepinnten `EconomyRelease` der Welt kommt. Ein
  externer Dienst im heißen Pfad macht Replays unreproduzierbar und koppelt die
  Simulation an fremde Verfügbarkeit.
- **Keine Präzisionswahrheit.** Der Betreiber weist Fahrzeiten, Energiebedarf
  und Preise selbst als unverbindliche Richtwerte aus vereinfachter Berechnung
  aus. Für einen Größenordnungsabgleich genau richtig, für eine Referenzwahrheit
  nicht.

Sinnvolle Nutzung: **in der Entwicklung gegen ihn kalibrieren und validieren, im
Betrieb ohne ihn auskommen.** Ob eine automatisierte Nutzung mit Speicherung der
Ergebnisse von den Nutzungsbedingungen gedeckt ist, ist im Rechte-Gate als
Prüfpunkt festgehalten (`rechte.md` 4; Eintrag `trassenfinder` im
Quellenregister, Status `entwicklung`).

## 4. Trassenpreissystem als Vorbild für den `EconomyRelease`

Die reale Struktur ist übernahmefähig und liefert von sich aus die
mehrdimensionalen Zielkonflikte aus `produkt.md`: Grundpreis je Zugkm nach
Streckenkategorie, differenzierte Trassenprodukte für Personen- und
Güterverkehr, Zuschläge für hochbelastete Abschnitte, für besonders langsame
Züge und für schwere Güterzüge, dazu ein Anreizsystem, das Pünktlichkeit
finanziell bewertet. Getrennte Systeme für Stationen und Anlagen.

Genau dieses Gefüge — **nicht die konkreten Zahlen** — gehört in den
versionierten `EconomyRelease`.

## 5. Qualitätsklassen

- **A — validiert:** Signale, Fahrstraßen und Blöcke manuell beziehungsweise
  fachlich geprüft; vollständige Simulation.
- **B — konservativ:** Datenlücken werden durch sichtbare virtuelle Blöcke und
  sichere Annahmen geschlossen; vollständig spielbar.
- **C — unzureichend:** Darstellung auf der Karte, aber keine
  Trassenbestellung.

Jede Welt pinnt einen vollständigen Release-Satz aus Infrastruktur, Tarifen,
Nachfrage, Fahrzeugkatalog und Regeln. Updates erfolgen ausschließlich zu
angekündigten Fahrplanstichtagen.

**Lizenzhinweis:** Die ODbL kann die Projektlizenz nicht überschreiben — ist der
`InfraRelease` eine abgeleitete Datenbank im Sinne der ODbL, greifen deren
Share-alike-Pflichten unabhängig vom Lizenztext. Das ist zugleich ein Daten- und
ein Lizenzthema und braucht eine gemeinsame Antwort (→ `geschaeft.md`).
