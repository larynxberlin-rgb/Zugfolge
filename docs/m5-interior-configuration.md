# M5-Konfiguration als Quelle für M15.4

Vertrag: `m5-vehicle-configuration/v1`. Der optionale Eintrag
`vehicleConfiguration` im individuellen Welt-Seed und Fleet-Authority-Asset
überträgt die vorhandenen M5-Typen `StructuralConfiguration` und
`InteriorConfiguration` verlustfrei. Der Katalogcompiler übernimmt ihn in
seine Authority-Ausgabe; Seed-, Release- und Receipt-Hashes binden die Daten.
Die native Flotteninitialisierung und jeder Restore prüfen sie erneut.

## Felder

| Objekt | Pflichtfelder |
|---|---|
| Wurzel | `schemaVersion`, `structural`, `interior` |
| `structural` | `doorCountPerSide` (u8), `doorWidthMm` (u16), `bodyLengthMm` (positiver u32-Wert) |
| `interior` | `firstClassSeats`, `secondClassSeats` (u16), `density`, `seatType`, `multipurpose`, `toilets`, `accessibleToilets` (u8), `amenities` |
| `multipurpose` | `bicycles`, `pushchairs`, `wheelchairs`, `standing` (u16) |

`density` verwendet `dense`, `standard` oder `spacious`; `seatType` verwendet
`row`, `face_to_face` oder `folding`. `amenities` enthält eine eindeutige,
kanonisch geordnete Auswahl aus `air_conditioning`, `wifi`, `power_sockets`
und `passenger_information`. Zusätzliche oder fehlende Felder, JSON-null-Werte,
Fließkommazahlen und unbekannte Enumerationen werden abgelehnt.

Die Typprüfung ist keine alternative M5-Fachlogik. Rust baut aus diesen
Feldern die bestehenden M5-Konfigurationstypen und verwendet deren Prüfung.
Die Kastenlänge muss zur technischen Assetlänge passen; Sitzsumme, erste
Klasse, Fahrrad- und Rollstuhlplätze müssen exakt den vorhandenen
Authority-Fakten entsprechen. Ein als nicht barrierefrei geführtes Asset
darf keine Rollstuhlplätze oder barrierefreien WCs deklarieren. Aus einem
positiven Barrierefreiheitsmerkmal werden keine zusätzlichen Plätze oder
WCs erfunden.

Die bekannten Ausstattungsmerkmale müssen als Menge exakt zu `amenities`
passen. M5 erkennt `air-conditioning` oder `air_conditioning`, `wifi`,
`power-sockets` oder `power_sockets` sowie `passenger-information`,
`passenger_information` oder `pis`. Andere Ausstattungsmerkmale bleiben
unverändert. Die kanonische Reihenfolge ist `air_conditioning`, `wifi`,
`power_sockets`, `passenger_information`.

## Fehlender Bestand und Weiterverwendung

Fehlt der gesamte Eintrag in einem alten Seed oder Release, bleibt er beim
Lesen und Schreiben abwesend. Bestehende Serialisierungen und Hashes bleiben
dadurch unverändert. Die betriebliche Nutzbarkeit alter Fahrzeuge ändert
sich nicht; der Einstieg in ihren M15.4-Innenraum wird mit dem konkreten
fehlenden Konfigurationsbeleg abgelehnt. Kein Standardgrundriss ergänzt
unbekannte Kapazitäten oder technische Eigenschaften.

M15.4 darf die vollständigen Daten ausschließlich aus dem nativ geprüften,
committed und weltgebundenen M5-Zustand lesen. Browserparameter können keine
Konfiguration, keinen Authority-Release oder Flottencheckpoint ersetzen.
Die generische Aufteilung in Decks, Gänge und grafische Module gehört zum
separaten Innenraumvertrag. Sie verändert keine M5-Kapazität und behauptet
keine realen Baureihenmaße.
