# Grafikfassung v2 der lokalen Offline-Demo

Diese Dateien gehören zur neuen Pixelspielansicht der fiktiven Offline-Demo.
Sie wurden für diesen Auftrag mit dem eingebauten image_gen-Werkzeug
(kein CLI/API-Fallback) erstellt und technisch zu Spielrastern aufbereitet.
Die tatsächlichen Eingaben liegen als
Promptdateien daneben. Die Bildfassung verändert keine produktiven
Atlas-Releases, Weltfreigaben oder fachlichen Fahrzeugkonfigurationen.

## Quellen und Ableitungen

| Inhalt | Generierte Quelle | Eingabetext | Technische Ableitung | Beleg |
| --- | --- | --- | --- | --- |
| Sechs Personen, je vier Gehrichtungen mit zwei Phasen | [characters-source.png](./characters-source.png) | [characters.prompt.txt](./characters.prompt.txt) | [prepare.py](./prepare.py) → [characters.png](./characters.png) | [preparation.json](./preparation.json) |
| Stand-, Blick-/Blinzel- und Sitzphasen derselben Personen | [idle-source.png](./idle-source.png), mit Figurenreferenz aus dem ersten Blatt | [idle.prompt.txt](./idle.prompt.txt) | [prepare.py](./prepare.py) → letzte vier Zeilen von [characters.png](./characters.png) | [preparation.json](./preparation.json) |
| Drei Gebäudemotive und drei Vegetationsmotive | [environment-source.png](./environment-source.png) | [environment.prompt.txt](./environment.prompt.txt) | [prepare-environment.py](./prepare-environment.py) → [environment.png](./environment.png) | [environment-preparation.json](./environment-preparation.json) |

Die Prompts verlangen eigenständige Figuren und Motive ohne bekannte
Spielfiguren, Marken oder Schriftzüge. Sie beschreiben kompakte Proportionen,
klare Pixelkonturen und die bestehenden Farbfamilien. Sie sind
Generierungsanweisungen, keine Behauptung einer pixelgenauen Erfüllung jeder
Vorgabe. Die tatsächlich verwendeten Bildmaße, Ausschnitte und Ausgaben
stehen in den technischen Belegen.

`characters.png` ist **192 × 480 Pixel** groß: sechs Spalten und zwölf Zeilen
mit Zellen zu 32 × 40 Pixeln, insgesamt **72 Bilder**. Die ersten acht Zeilen
enthalten 48 Gehphasen; die letzten vier Zeilen enthalten 24 zusätzliche
Stand-/Gesten-/Sitzphasen. `environment.png` ist **192 × 128 Pixel** groß und
enthält sechs Zellen zu 64 × 64 Pixeln. Die Motive sind vollständig innerhalb
dieser Zellen platziert; transparente Randbereiche gehören zum Atlas.

`prepare.py` extrahiert die belegten Bildausschnitte, reduziert sie mit
Nearest-Neighbour auf das logische Raster und setzt eine gemeinsame
Grundlinie. Stehende Körper werden auf höchstens 32, sitzende auf höchstens
27 Pixel Höhe eingepasst. Die Alphawerte werden binär begrenzt. Im
Stand-/Sitzquellblatt wird ausschließlich der mit der Bildecke verbundene
nahezu weiße Hintergrund entfernt; eingeschlossene helle Kleidungs-/Augenpixel
bleiben erhalten. Das Skript zeichnet keine neuen Figurenmotive.

`prepare-environment.py` schneidet die sechs Quellzellen aus, begrenzt Alpha,
verkleinert ebenfalls mit Nearest-Neighbour auf höchstens 60 × 60 Pixel und
setzt sie auf eine gemeinsame Grundlinie im 64-Pixel-Raster.
Frühere Vorschau- und Masken-Debugbilder werden nicht übernommen. Die portable
Vorbereitung schreibt ausschließlich die Spielatlanten und ihre Belege.

[provenance.json](./provenance.json) bindet die drei Originalbilder, Prompts,
Referenzbeziehungen, technischen Skripte und Ausgaben über SHA-256. Die Quellen
enthalten PNG-C2PA-Metadaten mit `softwareAgent` `gpt-image`, Version `2.0`.
Dies wird ausschließlich als vom Anbieter deklarierte Modellversion geführt;
eine kryptografische C2PA-Signaturprüfung wurde nicht durchgeführt.

Die Bilder wurden für den Nutzerauftrag neu generiert. Als Bildreferenz kam
beim Stand-/Sitzblatt nur das zuvor in demselben Auftrag erzeugte Figurenblatt
zum Einsatz. Fremde Spielfiguren, Marken oder externe Bilddateien wurden nicht
übernommen. Der Nutzerauftrag umfasst die technische Aufbereitung und Aufnahme
dieser lokalen Demo in PR #539. Das ist keine Freigabe dieser zwei Atlanten als
produktiver `ArtAtlasManifestV1`-Release. Quellcode und Veröffentlichung bleiben
an die [Repositorylizenz](../../../LICENSE) und die dort erläuterte gesonderte
Markenbehandlung gebunden.

Die dokumentierten SHA-256-Werte lauten:

| Datei | SHA-256 |
| --- | --- |
| characters-source.png | `774d6378ea129e51d8c17e20d6b87e4411f678530d0ba574b6faccbb2c249730` |
| idle-source.png | `0a44a6a82d689f55a46cd792d5ba0567aa3d049daff2f1dc5c8c409d1c2fecd8` |
| characters.png | `ccc31d39c4cf5885dd643adb6d75885edd955879dfb212e44032a61d82007217` |
| environment-source.png | `d65f4d54d03a9bfcd5a20e002ba0db0b82f6f054502c229648df4979066ee047` |
| environment.png | `13816265464f2b1a68a1844ba3a18fcbb8590a434d76d370c66f617a25a83d21` |

## Verwendung im Spiel

[game-renderer.ts](../src/game-renderer.ts) zeichnet über Canvas 2D auf einem
Pixelraster mit deaktivierter Bildglättung. Die Graphit-/Rot-Familie des
Innenraums bleibt erhalten. Körper, Türen, Sitze, Treppen und Zugabschnitte
werden aus der bestätigten M5-Innenraumgeometrie dargestellt. Bilder liefern
keine Kapazitäten, Kollisionsflächen oder fachlichen Fahrgastmerkmale.

Eine dezente Atemphase hebt beziehungsweise dehnt nur den oberen Spritebereich
um **einen logischen Pixel**. Die unteren neun Pixel und der native Standort
bleiben fest. Individuell versetzte Phasen steuern Blinzeln, Blickwechsel und
Sitzvarianten. Diese Animationen sind rein visuell. Gehen wird nur zwischen
bereits bestätigten nativen Positionen interpoliert. Bei
`prefers-reduced-motion` entfallen diese Übergänge und Gesten.

Die Umgebungskacheln bilden die drei ländlichen, vorstädtischen und städtischen
Motivfamilien ab. Welche Umgebung, Station und Bewegung vorliegt, kommt aus
der originalen Szenenprojektion des bestätigten Betriebszustands. Der Renderer
erfindet keine Zuggeschwindigkeit oder Ortsfolge. Die lokalen Szenennamen
Ährenfeld, Südstadt und Hauptbahnhof sind in
[scene-authored-source.json](../data/scene-authored-source.json) dokumentiert;
[prepare-scene.mjs](../prepare-scene.mjs) bindet sie an den tatsächlichen
Szenenrelease in [scene.json](../data/scene.json).

Die sieben bisherigen Originalatlanten werden weiterhin mit ihren
SHA-256-Werten geprüft. Die zwei neuen PNGs sind eine explizite zusätzliche
Demo-Grafikfassung. [build-info.json](../build-info.json) bindet die tatsächlich
eingebetteten Bildbytes, Spiel-/Workerquellen und HTML-Datei. Prompt- und
Quellbilder werden für die Dokumentation aufbewahrt und gehören nicht zum
ausgelieferten Laufzeitbedarf der einzelnen HTML-Datei.

## Reproduktion und fachliche Grenze

Aus der Repositorywurzel, mit Python, Pillow und NumPy:

```powershell
node tools/conductor-offline/assets-v2/verify-art.mjs
python tools/conductor-offline/assets-v2/prepare.py --check
python tools/conductor-offline/assets-v2/prepare-environment.py --check
node tools/conductor-offline/build.mjs
```

`--check` berechnet die technische Aufbereitung im Speicher und vergleicht PNG-
und Belegbytes, ohne Dateien zu ändern. Ohne diese Option werden die zwei
Atlasdateien beziehungsweise Belege mit LF-Zeilenenden geschrieben. Die geprüften
Bibliotheksversionen stehen im Herkunftsbeleg. Diese Befehle erzeugen keine
neuen Bildmotive. Der HTML-Build komprimiert sein
Skript und entpackt es beim Start lokal. Der ursprüngliche Rust-WASM-Kern,
private Checkpoints und deren JSON-Verarbeitung laufen im Hintergrund-Worker;
die Spieloberfläche bekommt öffentliche Projektionen. Die Übungsfahrt besitzt
40 tatsächlich projizierte Fahrgäste bei unveränderten 200 Sitz- und 20
Stehplätzen. Ihre drei Kontrollübungen sind in
[CONTROL-PRACTICE.md](../CONTROL-PRACTICE.md) getrennt von dieser Grafikfassung
dokumentiert.

Bildherkunft, technische Ableitung, native Komponentenprüfung und tatsächliche
Browserbedienung sind unterschiedliche Nachweise. Diese Dokumentation erklärt
die lokale Demo und behauptet keinen Gesamtabschluss produktiver Milestones.
