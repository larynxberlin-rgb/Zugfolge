# Zugfolge — Grafikkandidat 2026.1

Der Korpus enthält **172 Motive und 60 Animationssequenzen** auf sechs PNG-Atlanten.
Er ist vollständig technisch vorbereitet, aber **noch nicht produktiv freigegeben
oder signiert**. [Fachvertrag](../../../docs/art-atlas.md) und
[Prüfbericht](evidence/technical-visual-review.md) beschreiben Umfang und Grenzen.

- Vier Fahrgastfiguren und ein Schaffner: je vier Richtungen, Stillstand,
  vier Gehphasen und Sitzpose — insgesamt 120 Figurenframes.
- Elf Innenraummodule, drei Fahrzeugteile, 15 Bahnhofsmodule für drei Klassen,
  neun Umgebungsgruppen, zwei Signalbilder und zwölf Zubehöransichten.
- 25 RGBA-Paletteneinträge einschließlich Transparenz, 32 logische Pixel pro
  Meter, ganze Zoomstufen und Nearest Neighbor.
- Originale, tatsächliche Prompts, verwendete eigene Referenzen und die aus
  Originalbytes gelesene Modellangabe `gpt-image` / `2.0` bleiben nachvollziehbar.

`sources/interior.png` ist der dokumentierte verworfene Frontansicht-Entwurf;
seine Motive werden nicht geladen. Die final vorbereiteten Innenräume stammen
aus `sources/interior-topdown.png`. Die alten Nord-/Südansichten des Zubehörs
werden durch `sources/accessories-north-south.png` ersetzt.

## Reproduzieren

Im Repository-Stamm:

```sh
pnpm --filter @zugfolge/conductor-art build
python tools/art-atlas/prepare.py
node tools/art-atlas/manifest.mjs
node tools/art-atlas/check.mjs --allow-pending
node tools/art-atlas/server.mjs
```

Die Aufbereitung benötigt Pillow 12.3.0. Sie verwendet ausschließlich bestehende
Originale; Bildgenerierung ist kein Buildschritt. Der Checker ohne
`--allow-pending` lehnt den noch nicht freigegebenen Kandidaten ab. Die CI erlaubt
ausschließlich die explizit fehlenden Freigaben, keine Katalog-, Raster-, Hash-
oder Herkunftsfehler.

Die Galerie läuft ausschließlich unter `http://127.0.0.1:4186`. Sie zeigt eine
Grafikkomposition, keine M5-Konfigurations- oder M10-Betriebsabnahme. Die
Belegung und betriebliche Integration bleiben den folgenden M15-Teilen zugeordnet.

Browserprüfung mit Edge unter Windows bzw. installiertem Chromium unter Linux:

```sh
ART_PREVIEW_BROWSER_TEST=1 node --test tools/art-atlas/preview.test.mjs
```

Für Freigabe und Signatur gilt der öffentliche Vertrag in `docs/art-atlas.md`.
Die Hashbindung eines Kandidaten ersetzt weder Freigabe noch Signatur.
