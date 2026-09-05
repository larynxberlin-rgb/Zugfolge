# Bilder des UI-Neuaufbaus

## Dekorative Zugaufnahme

- Modus: integrierte Bildgenerierung (`image_gen`), neue Aufnahme ohne Bildvorlage.
- Verwendung: Hintergrund beim Spieleinstieg; keine Darstellung von Spieldaten.
- Datei: `apps/game-web/public/assets/railway/departure.png`.
- Keine externen Logos, keine lesbaren Ortsnamen und keine regionale Festlegung.

Finaler Generierungsprompt:

> Use case: photorealistic-natural. Asset type: decorative background for railway management game company founding screen. Create a premium cinematic photograph of a modern German electric regional multiple unit train, elegant white body with one thin signal-red horizontal stripe, dark graphite nose and black panoramic driver window, pulling into a large German railway station at blue hour, wet rails reflecting platform lights, believable overhead catenary and distant platforms. No brand logos, no text, no visible destination display, no people prominently. Landscape 3:2 composition: train front in lower right half, body trailing into background right; dark blue evening sky and architecture in upper and left half as clean negative space for text overlay. Muted blue gray, anthracite, warm tiny amber highlights, restrained railway realism. Not futuristic, no invented dramatic neon. Entire Germany setting with no recognizable regional landmark or readable station name. High resolution, authentic materials, crisp details. Output one image, no UI, no frames, no watermarks.

## Deutschland-Konzept

`design-concept-deutschland.png` ist ein mit der integrierten Bildgenerierung
erstellter UI-Entwurf. Gestaltungsbrief: deutschlandweite LiveMap statt
regionalem Ausschnitt, dunkle Bahnatmosphäre, Signalrot als Markenakzent,
kompakte Navigation und verständliche Entscheidungen direkt an der Karte.
Zahlen und Strecken dieser Konzeptgrafik sind illustrative Bestandteile.

## Browser-Screenshots

Die Dateien unter `screenshots/` werden mit Playwright aus den tatsächlichen
Renderfunktionen und Styles erzeugt. Sie wurden nicht mit Bildgenerierung
nachbearbeitet. Ihre ausdrücklich gekennzeichneten Beispieldaten liegen in
`tools/ui-preview/fixtures.mjs`.
