# ADR-0027: Geschätzte Zugkartenpositionen bleiben rein visuell und von der Betriebswahrheit getrennt

Dieses ADR entspricht E27 und ist als historischer, abgelöster Vertrag erhalten.

- **Status:** Abgelöst durch ADR-0032; historischer Entscheidungsstand
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../zugkartenprojektion.md](../zugkartenprojektion.md) · [../architektur.md](../architektur.md) · [../design.md](../design.md)
- **Betrifft Milestones:** M4.8, M9.3, M14.2
- **Verwandte ADRs:** [ADR-0009](0009-vollstaendige-transparenz-livemap.md), [ADR-0017](0017-design-domaenensprache-achromatisch-dunkel.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0025](0025-gebietsueberschreitende-fahrtketten.md), [ADR-0026](0026-karte-als-spielzentrum.md), [ADR-0032](0032-eine-autoritative-betriebswirklichkeit.md)
- **Ersetzt:** ausschließlich den Exact-only-Satz zur sichtbaren Zugposition in ADR-0026; alle übrigen Teile von E26 und ADR-0026 bleiben bindend

> Seit E31 gilt wieder Exact-only: Korridor- und Anker-Estimates sind kein
> v2-Laufzeitvertrag. Dieses ADR bleibt nur zur Nachvollziehbarkeit erhalten.

## Kontext

ADR-0026 ließ einen Zugmarker nur bei einer lückenlos nachgewiesenen
Ressourcen-, Gleis- und Offsetzuordnung zu. Diese strenge Regel ist für die
betriebliche Wahrheit weiterhin richtig. Der reale Jahreslauf 2026.1 zeigt
aber, dass viele betrieblich sichere Zugwege noch keine durchgehend eindeutige
Gleisgeometrie besitzen. Sie erscheinen deshalb in der Liste, während die
eigentliche Spieloberfläche — die Karte — über weite Strecken keinen Zugmarker
zeigt.

Eine visuelle Näherung verbessert Orientierung und Kontinuität. Ohne eine
harte Typ-, Datenfluss- und Gestaltungsgrenze könnte sie jedoch als reale
Gleisbelegung missverstanden oder versehentlich von Fahrdienstleitung,
Fahrstraßenlogik, Konfliktprüfung oder Bestellbarkeit verwendet werden. Gelb
und Rot sind bereits betrieblichen Warnungen und Störungen vorbehalten und
dürfen nicht zugleich „ungefähr“ bedeuten.

## Entscheidung

**Die exakte Zugkartenposition bleibt die einzige betriebliche
Positionswahrheit; daneben darf eine ausdrücklich geschätzte,
releasegebundene Position ausschließlich die öffentliche Kartendarstellung
ergänzen.**

Exakte und geschätzte Position sind getrennte, diskriminierte Ergebnisse. Eine
Schätzung darf niemals in ein Exact-Feld geschrieben werden. Sie trägt die
bestätigte `resourceId` als autoritative Bindung an die Betriebsressource, aber
niemals eine behauptete `trackId` oder einen gleisscharfen `offsetMm`. Die
`resourceId` wählt nur die richtige Darstellungsprojektion und behauptet keine
konkrete Gleisbelegung. Sobald eine exakte Position vorliegt, hat sie
ausnahmslos Vorrang.

Nur wenn Exact fehlt und die Fahrt kein `ExternalLeg` ist, darf die
Darstellungsprojektion folgende feste Reihenfolge verwenden:

1. **Orientierter amtlicher Korridor:** Ein zum selben InfraRelease gehörender
   amtlicher Korridor darf den serverseitig bestätigten Fahrtfortschritt
   aufnehmen, wenn Strecke und Richtung eindeutig gebunden und die Orientierung
   anhand der releasegebundenen Ankerhalte nachgewiesen sind. Parallele oder
   widersprüchliche Korridore bleiben ungelöst; der Projektor wählt nicht nach
   bloßer räumlicher Nähe.
2. **Resourcegebundener Ankerhalt:** Ist keine eindeutige Korridorposition
   möglich, darf der Marker an dem im gepinnten Release genau dieser
   `resourceId` eindeutig zugeordneten Ankerhalt stehen. Diese Zuordnung ist
   zustandslos und deterministisch; sie verwendet keinen zuletzt beobachteten
   Serverstand. Ohne eindeutigen Release-Anker gibt es keine Kartenposition.

Beide Schätzwege sind deterministische Read-only-Projektionen aus gepinnten
Artefakten. Sie rufen weder zur Laufzeit externe Quellen noch KI auf und
schreiben kein Domain-Event zurück.

`topological-track` bleibt als künftige höherwertige Estimate-Methode
reserviert, falls ein Release eine eindeutige Gleiskette für die Darstellung
nachweist, ohne die gleisscharfe Exact-Bindung zu erreichen. Auch diese Methode
bliebe rein visuell. Der Jahresstand 2026.1 erzeugt sie nicht; für ihn gilt
Exact → orientierter amtlicher Korridor → resourcegebundener Ankerhalt →
keine Kartenposition.

Eine geschätzte Position ist für Fahrdienstleitung, Fahrstraßen,
Konfliktressourcen, Sperrzeiten, Laufwegsuche, Trassenbestellung,
Bestellbarkeit und Infrastrukturqualität unsichtbar. Sie darf weder eine
Qualitätsklasse verändern noch einen unzureichenden Infrastrukturbefund aufwerten oder fehlende
Gleiszuordnung kaschieren. Diese Verbraucher erhalten weiterhin ausschließlich
den autoritativen Simulationszustand und nachgewiesene Exact-Daten.

Auf der Karte bleibt die Form des Zugmarkers gleich. Eine bewegte
Korridorschätzung erhält `≈`, ein am letzten belastbaren Anker gehaltener Marker
`?`; beide erhalten einen neutral achromatischen Ring und eine zugängliche
Erklärung. Der Ring verwendet weder Gelb/Bernstein noch Rot; diese Farben
bleiben betrieblichen Zuständen vorbehalten. Im Detailpanel werden Methode und
Releasebindung genannt. Während eines `ExternalLeg` gibt es
auch auf der weltweiten Basiskarte ausdrücklich keine Schätzung; der Zug bleibt
nur mit seinem Außenlaufstatus in Liste und Fahrtkette sichtbar.

## Begründung

Die Trennung bewahrt beide Ziele: Die Karte bleibt auch bei noch lückenhafter
gleisscharfer Georeferenzierung lebendig, ohne eine visuelle Hilfe zur
Stellwerks- oder Kapazitätswahrheit zu erheben. Der amtliche, orientierte
Korridor ist die stärkste verfügbare räumliche Näherung; der eindeutig
resourcegebundene Release-Ankerhalt ist der konservative letzte Rückfall. Das
unveränderte Markersymbol hält Zugidentität und Klickverhalten stabil, während
Ring, Genauigkeitszeichen und Text die geringere Genauigkeit ohne betriebliche
Warnfarbe eindeutig kommunizieren.

## Konsequenzen

- **Erleichtert:** Mehr fahrende Züge bleiben auf dem Kartenzentrum sichtbar;
  ein späterer Exact-Nachweis kann denselben Marker ohne Identitätswechsel
  präzisieren.
- **Kostet / schränkt ein:** Der Releasebau braucht einen geprüften
  Korridororientierungs- und Ankervertrag. UI, Protokoll und API müssen Exact
  und Estimate diskriminieren und dürfen keinen stillen Kompatibilitätsfallback
  besitzen.
- **Invarianten:** Schätzungen bleiben außerhalb des Simulationskerns und der
  Konfliktlogik. `world_id` und `infrastructureReleaseId` bleiben Pflicht;
  Laufzeitkoordinaten sind ganzzahlig. Invariante 1 kann von Estimate weder
  erfüllt noch verletzt oder bewertet werden, weil Estimate kein Eingang der
  Belegungslogik ist.
- **Historie:** Der Satz in ADR-0026 „Fehlt diese Zuordnung, bleibt die Fahrt in
  der Liste sichtbar, aber ohne erfundenen Kartenpunkt“ ist für die
  **Darstellung** durch E27 ersetzt. Als Exact- und Betriebsgrenze bleibt sein
  Sicherheitsgedanke unverändert bestehen.
- **Beweisstand:** Der reale v2-Jahreskatalog ist zweimal byteidentisch gebaut;
  Compiler-, Runtime-, Protokoll-, Karten- und Paneltests decken Priorität,
  Mehrdeutigkeit, Release-Mismatch, `ExternalLeg`, Markeridentität und die
  einseitige Verbrauchsgrenze ab. Offen bleiben die manuelle Browser- und
  Spielabnahme für Kontrast, Zoom, Tastatur und Screenreader sowie Signatur und
  externe Alpha-Abnahme. Kein bestehender Milestone erhält allein durch dieses
  ADR einen neuen Erledigt-Nachweis.

## Verworfene Alternativen

1. **Weiterhin nur Exact zeichnen:** verworfen, weil die Karte trotz
   betrieblicher Zugpräsenz großflächig leer bleibt.
2. **Schätzung wie Exact ohne Kennzeichnung zeigen:** verworfen, weil eine
   scheinbar gleisscharfe Position falsche betriebliche Sicherheit erzeugt.
3. **Nächstes OSM-Gleis zur Laufzeit wählen:** verworfen, weil Nähe weder
   Fahrweg noch Richtung beweist und der Weltstand nicht reproduzierbar wäre.
4. **Gelb oder Rot als Schätzfarbe verwenden:** verworfen, weil beide Farben
   bereits betriebliche Einschränkung, Sperrung oder Störung ausdrücken.
5. **Außenlauf auf der Weltbasiskarte schätzen:** verworfen, weil E25 dort
   absichtlich keine belastbare Topologie oder disponierbare Position kennt.
