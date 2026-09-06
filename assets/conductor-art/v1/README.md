# Zugfolge — Freigegebener Grafikkorpus 2026.1

Der Korpus enthält **186 Motive und 60 Animationssequenzen** auf sieben PNG-Atlanten.
Der Auftraggeber hat am 06.09.2026 sämtliche Asset-, Referenz- und
Releasefreigaben erteilt: [Freigabebeleg](evidence/project-owner-approval.md).
Der strenge Inhaltscheck besteht mit `activationEligible: true` und ohne
Befunde. Die kryptografische Signatur und der autorisierte Weltpin sind der
verbleibende technische Auslieferungsschritt. [Fachvertrag](../../../docs/art-atlas.md)
und [Prüfnachweis](../../../docs/art-atlas/README.md) beschreiben die Grenzen.

- Vier Fahrgastfiguren und ein Schaffner: je vier Richtungen, Stillstand,
  vier Gehphasen und Sitzpose — insgesamt 120 Figurenframes.
- Elf Innenraummodule, drei Fahrzeugteile, 15 Bahnhofsmodule für drei Klassen,
  neun Umgebungsgruppen, zwei Signalbilder und zwölf Zubehöransichten.
- Sechs zusätzliche Wagenfamilien mit insgesamt 14 Teilen: Doppelstockwagen
  für Nah- und Fernverkehr, einstöckige Nah- und Fernverkehrswagen sowie Speise-
  und Schlafwagen. Doppelstockwagen besitzen Unterdeck, Oberdeck und Dach;
  einstöckige Wagen Innenraum und Dach. Die Galerie bietet eine Fahrzeugwahl
  und eine gemeinsame Vergleichsansicht.
- 25 RGBA-Paletteneinträge einschließlich Transparenz, 32 logische Pixel pro
  Meter, ganze Zoomstufen und Nearest Neighbor.
- Originale, tatsächliche Prompts, verwendete eigene Referenzen und die aus
  Originalbytes gelesene Modellangabe `gpt-image` / `2.0` bleiben nachvollziehbar.

`sources/interior.png` ist der dokumentierte verworfene Frontansicht-Entwurf;
seine Motive werden nicht geladen. Die final vorbereiteten Innenräume stammen
aus `sources/interior-topdown.png`. Die alten Nord-/Südansichten des Zubehörs
werden durch `sources/accessories-north-south.png` ersetzt.

`sources/vehicle-regional-double-initial.png` ist die tatsächlich verwendete
Vorstufe des korrigierten Doppelstockwagens. Die gezielte Bildkorrektur und
die übrigen Wagen beschreibt der [Fahrzeug-Sichtbeleg](evidence/vehicle-visual-review.md).
Die sechs vorhandenen Atlanten bleiben bytegleich; die neuen Wagen liegen in
`atlases/vehicles.png`. Der Katalog `conductor-art-catalog/v2` verlangt alle
186 Motive. Der Validator unterstützt weiterhin den bisherigen Katalog v1.

## Reproduzieren

Im Repository-Stamm:

```sh
pnpm --filter @zugfolge/conductor-art build
python tools/art-atlas/prepare.py
node tools/art-atlas/manifest.mjs
node tools/art-atlas/check.mjs
node tools/art-atlas/server.mjs
```

Die Aufbereitung benötigt Pillow 12.3.0. Sie verwendet ausschließlich bestehende
Originale; Bildgenerierung ist kein Buildschritt. Die CI verwendet den strengen
Checker ohne `--allow-pending`: fehlende Freigaben und Katalog-, Raster-, Hash-
oder Herkunftsfehler werden abgelehnt. Jede Inhaltsänderung nach dieser
Freigabe benötigt eine neue, an den geänderten Prüfeingang gebundene Entscheidung.

Die Galerie läuft ausschließlich unter `http://127.0.0.1:4186`. Sie zeigt eine
Grafikkomposition, keine M5-Konfigurations- oder M10-Betriebsabnahme. Die
Belegung und betriebliche Integration bleiben den folgenden M15-Teilen zugeordnet.

Browserprüfung mit Edge unter Windows bzw. installiertem Chromium unter Linux:

```sh
ART_PREVIEW_BROWSER_TEST=1 node --test tools/art-atlas/preview.test.mjs
```

Für Freigabe und Signatur gilt der öffentliche Vertrag in `docs/art-atlas.md`.
Die Inhaltsfreigabe ist im Manifest belegt; sie ersetzt keine kryptografische
Signatur und aktiviert allein keine Welt.
