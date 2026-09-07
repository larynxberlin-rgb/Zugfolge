# Freigabe des Auftraggebers für den Pixelartkorpus 2026.1

Datum: 06.09.2026. Entscheidungsträger: Auftraggeber dieses Projekts
(Reviewerkennung `project-owner`). Aufzeichnung: Codex.

## Tatsächliche Erklärung und Umfang

Der Auftraggeber antwortete auf die folgende ausdrücklich ausgewählte Aussage:

> Für den Abschluss fehlen noch die formalen Asset-/Referenzfreigaben und die produktive Signatur. Issue #213 bleibt deshalb offen.

Seine Antwort lautete wörtlich:

> meine freigabe hast du!

Diese Erklärung erteilt die bisher ausstehenden formalen Bild-, Logo-/Schrift-,
Kontrast- und Herkunftsfreigaben, die Nutzungsfreigabe der acht tatsächlich
verwendeten eigenen Bildreferenzen sowie den Release-Review für
`conductor-art-2026.1`. Sie umfasst alle 186 Motive, 60 Animationen und sieben
Atlanten einschließlich der zuletzt gelieferten sechs Wagenfamilien mit 14
Teilen. Die technische Aufbereitung war bereits ausdrücklich mit
„Ja, technisch aufbereiten“ erlaubt.

Die Bild- und Herkunftssichtung hat Codex durchgeführt; ihre konkreten Befunde
stehen in `technical-visual-review.md` und `vehicle-visual-review.md`.
Die Auftraggeberentscheidung nimmt diese Lieferung und die dokumentierten
Befunde ab. Sie behauptet weder eine zusätzliche persönliche Pixelprüfung
jedes Frames durch den Auftraggeber noch eine C2PA-Zertifikatsprüfung.
Die älteren Sichtbelege behalten ihren damaligen Kandidatenstatus als
historischen Befund; die hier aufgezeichnete spätere Entscheidung schließt
ihre formalen Freigaben ab.

## Bindung an den abgenommenen Inhalt

- Ausgangscommit: `5692b39201e6292e10a010908fc20b06055f32f0`
- Katalog: `conductor-art-catalog/v2`
- Prüfeingang (inputSha256): `3a961d24e49d86520e7505873682582f43b5d0594a7d1df89afe5800ce318e9e`
- Aufbereitung (prepared.json): `b7624271bb9ba6e3248294bac40312934f3a3edf6b4638714c188f6ff06c3b0b`
- Manifest vor Eintragung der Freigabe: `47d8c75ebb06cc290ce2efb239909edc4fa7d7464e78ab662c2490171b7532aa`

- atlases/passenger-red.png: `7f0cd9c264bc5404d957675bc84ed886039dc84f2faab54b8e8d8a1e72b4b346`
- atlases/passenger-teal.png: `3aaadd3f90131877bd5f482c6d96b292b8f42471ef699bf4c4ea0e8cdd9c33ad`
- atlases/passenger-amber.png: `e781ead10d891f00ea99b744c2232441311bb70b8b53b1a5ab3c99fb7653ad04`
- atlases/passenger-slate.png: `c1807f78b0318d07ec1000004a4035600f82640f211c6455e04acec2ee998480`
- atlases/conductor.png: `e42490973eb0ea458a500b0b5278382d48fdbcdd1ed83424263151d1422a8c4a`
- atlases/modules.png: `9ddda097bed0c264600f1416cf3b7ce708e56201096be699cbb6e316ded1eb3c`
- atlases/vehicles.png: `9af3e9b1add565fe91e248db0b3e7c99c9d97a1627f15def8404672eae266323`

Der Prüfeingang bindet sämtliche Bildbytes, Zuschnitte, Pivots, Animationen,
Zuordnungen, Prompts und Generierungsbelege. Die Freigabedatei und ihre eigenen
Belege bleiben wegen Zirkularität außerhalb dieses Prüfeingangs; ihre exakten
Bytes werden anschließend vom finalen Manifest gebunden. Die Aufzeichnung
ändert kein Motiv und überträgt die Entscheidung nicht auf spätere Änderungen.

## Erlaubte eigene Referenzen

- reference-accessories: `398e103da7964b2aa8c0320cd93ec879ca4da4b1b5c71b9e3cffb7e0a11d71b9` (sources/accessories.png)
- reference-conductor: `c2ad8c6e6022636665b476fc2c01fd2093d91ad75bda6ab143e83717483f72d5` (sources/conductor.png)
- reference-passenger-amber: `394ca81a44b3e67db8bde737de71fb5c5a8187d138341c7b29a1a7c20e380c4a` (sources/passenger-amber.png)
- reference-passenger-red: `b30657809b5262048e4f5a288b9122d0c7dc37b018a3e6686e4caf92596594d7` (sources/passenger-red.png)
- reference-passenger-slate: `f551d9209c34b4cbde3f9c9967386611be7b4b5247f12382b97ed9d776c0189f` (sources/passenger-slate.png)
- reference-passenger-teal: `b3af182eeafe14069dfc1be64a5c053f5a525ab77e4089823109b0e79f144e9b` (sources/passenger-teal.png)
- reference-train: `72f19564ff8899a4b768baac671ff8659e7d488dba7b5322368fd51ab2669b0d` (sources/train.png)
- reference-vehicle-regional-double-initial: `5890e44184bdcc7b2bf036272eaaa3de5a091948099f765eaf6b527e609f31f7` (sources/vehicle-regional-double-initial.png)

Diese Dateien wurden für Zugfolge mit dem Bildwerkzeug erzeugt und tatsächlich
als Referenz verwendet. Erlaubt sind ihre Nutzung, technische Ableitung und
Auslieferung im eigenen Zugfolge-Korpus unter der Projektlizenz. Die Freigabe
bezieht sich auf diese vorhandenen Eigenproduktionen; sie erklärt keine
fremden Marken, Personen oder Bildkopien zu erlaubten Quellen.

## Signatur und betriebliche Grenze

Die Erklärung autorisiert auch die Signierung der finalen geprüften
Manifestbytes. Diese Aufzeichnung ist selbst keine kryptografische Signatur.
Die Signierung benötigt einen tatsächlich verfügbaren Ed25519-Privatschlüssel,
einen unabhängig vertrauten öffentlichen Schlüssel und den autorisierten
Welt-/Releasepin. Eine neue Behauptung über Produktionsvertrauen oder eine
Weltaktivierung entsteht durch das Eintragen der Freigabe nicht.
Die spätere M15.4-Geometrie und die M15.5-Betriebsanbindung bleiben eigene
Arbeitspakete; generische Wagenbilder geben keine Baureihenkapazitäten frei.
