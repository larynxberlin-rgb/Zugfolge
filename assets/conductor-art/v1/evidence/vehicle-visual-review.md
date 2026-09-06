# Sichtung der zusätzlichen Wagenfamilien

Codex, 06.09.2026. Technischer Sichtbefund zum vom Auftraggeber gewünschten
Ausbau der Fahrzeugvielfalt; keine produktive Releasefreigabe.

| Familie | Tatsächliche sichtbare Merkmale | Teile |
|---|---|---|
| Regionaler Doppelstockwagen | Rote dichte Sitzgruppen, WC, Mehrzweckbereich und zwei Treppenlagen; durchgehenderes Oberdeck | Unterdeck, Oberdeck, Dach |
| Einstöckiger Fernverkehrswagen | Größere blau-graue Sitzgruppen, Tische, Gepäck- und WC-Bereiche an den Enden | Innenraum, Dach |
| Einstöckiger Regionalwagen | Breite Einstiegsbereiche, einfache rote Sitze und großer Fahrrad-/Mehrzweckbereich | Innenraum, Dach |
| Fernverkehrs-Doppelstockwagen | Blau-graue Tischgruppen unten, rote Sitz- und Tischgruppen oben, Treppen und Endvestibüle | Unterdeck, Oberdeck, Dach |
| Speisewagen | Tische mit einzelnen Stühlen, Theke, Küche und WC-Bereiche | Innenraum, Dach |
| Schlafwagen | Seitengang, einzelne Schlafabteile mit Betten und Sanitärräume an den Enden | Innenraum, Dach |

Alle sieben neu erzeugten Originale wurden gesichtet; sechs liefern den
finalen Korpus. Der erste regionale Doppelstockentwurf lag mit einer Treppe
im Unterdeck mittig, während das Oberdeck dort Sitzplätze zeigte. Die
gezielte Bildwerkzeug-Korrektur versetzte diese Treppe an den unteren Aufgang.
Die Vorstufe bleibt als `vehicle-regional-double-initial` erhalten und ist die
tatsächliche Referenz des korrigierten Bilds. Ihre eigene Referenz ist `train`.
Die übrigen fünf neuen Generierungen verwenden `train` direkt als Stilreferenz.

Die Originale besitzen einen eingebrannten neutralen Hintergrund. Die bereits
ausdrücklich erlaubte technische Pipeline entfernt nur dessen randverbundene
Pixel, beschneidet vollständig vorhandene Motive, reduziert die Palette ohne
Dithering und verwendet Nearest Neighbor. Ein gemeinsamer Maßstab pro Familie
und identische Pivots halten Decks und Dach im selben 96×864-Pixel-Rahmen.
Die Vorbereitung zeichnet weder neue Motive noch zusätzliche Treppen hinein.

Alle 14 finalen Ausschnitte wurden auf vollständige Konturen, Kupplungen,
Nachbarfragmente, verständliche Räume und die Unterscheidbarkeit der Familien
gesichtet. Es wurden keine fremden Logos oder lesbaren Markenschriftzüge
gefunden. Die Modellangabe stammt erneut aus den tatsächlichen PNG-Metadaten:
Providerdeklaration `gpt-image`, Version `2.0`, keine C2PA-Zertifikatsprüfung.

Die 3×27-Meter-Bildrahmen sind generische Grafikflächen. Sitzanzahl, Treppen,
Türen und Raumaufteilung sind keine Baureihen- oder Kapazitätsfreigabe und keine
aus tatsächlichen Fahrzeugkonfigurationen berechnete M15.4-Begehbarkeit.
Formale Asset-/Referenzfreigaben und Signatur bleiben ausstehend.

## Geprüfte Bytes

Prepared-SHA256: b7624271bb9ba6e3248294bac40312934f3a3edf6b4638714c188f6ff06c3b0b

- atlases/vehicles.png: 9af3e9b1add565fe91e248db0b3e7c99c9d97a1627f15def8404672eae266323

Die sechs vorherigen PNG-Atlanten bleiben bytegleich. Der Browserbericht
unter `docs/art-atlas/browser-report.json` bindet seine tatsächlichen
Ansichten an alle sieben PNG-Dateien und die aktuelle Aufbereitung.
