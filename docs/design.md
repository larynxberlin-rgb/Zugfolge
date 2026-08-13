# Design

Dieses Dokument enthält die **früh bindenden** Gestaltungsentscheidungen — die,
die auf jeder Fläche auftauchen und deshalb teuer nachzuziehen wären. Die
eigentliche Gestaltungsarbeit entsteht mit den ersten Oberflächen in M3.
Abschnitt 8 listet auf, was bewusst offenbleibt.

## 1. Grundsatz: Domänensprache statt Markenzitat (E17)

Zugfolge soll unverkennbar nach deutschem Eisenbahnbetrieb aussehen. Das
erreicht es über die **Sprache der Domäne**, nicht über das Zitat einer Firma:

- die Farblogik des Signalwesens — Rot heißt Halt, Gelb heißt Vorsicht;
- die Konventionen des Bildfahrplans, ein über hundert Jahre gewachsenes
  Weg-Zeit-Diagramm, das Fachleute fließend lesen;
- die Grammatik der Bahnsteig-Wegeleitung: knappe Zeile, klare Hierarchie,
  Zeit rechtsbündig, Ziel links;
- die Anmutung einer Leitstelle: dunkel, dicht, wenig Dekoration, viel Zustand.

**In dieser Domäne schlägt Konvention Originalität.** Das Publikum ist
fachkundig. Einen Bildfahrplan neu zu erfinden macht ihn schlechter, nicht
moderner.

Was ausdrücklich **nicht** übernommen wird, steht in Abschnitt 7.

## 2. Farbsystem

### 2.1 Das Prinzip

> **Farbe gehört dem Betrieb. Die Marke ist achromatisch.**

In einer Dispositionsoberfläche *ist* Farbe Information. Jede Farbe, die eine
Marke belegt, verliert ihre Signalwirkung im Betrieb. Deshalb tragen Wortmarke,
Rahmen, Navigation und alle Strukturelemente ausschließlich Graustufen — und
jede farbige Fläche auf dem Bildschirm bedeutet etwas.

Daraus folgt unmittelbar: **Rot wird niemals Markenfarbe.** Es bleibt Störung,
Sperrung, Ausfall.

### 2.2 Der Normalzustand ist farblos

Bei tausenden Zügen auf einer Karte wäre eine Einfärbung „alles in Ordnung“
reines Rauschen. Pünktliche Züge bleiben deshalb neutral; **eingefärbt wird nur
die Abweichung.** Das hält die Karte ruhig und lässt Probleme sofort
hervortreten.

Nebeneffekt: Grün bleibt frei für Ressourcenzustände und kollidiert nicht mit
„pünktlich“.

### 2.3 Barrierefreiheitsregel — bindend

> **Ein Zustand wird niemals allein über den Farbton kodiert.**

Rund acht Prozent der Männer haben eine Rot-Grün-Sehschwäche — genau auf der
Achse, die im Bahnbetrieb am meisten trägt. Jeder Zustand braucht deshalb einen
**zweiten Kanal**: Zahlenwert, Symbolform, Musterung oder Buchstabe.

Zusätzlich sind alle Verlaufsskalen **helligkeitsmonoton**. Eine Skala, deren
Helligkeit durchgehend steigt oder fällt, bleibt bei jeder Form von
Farbfehlsichtigkeit und in Graustufen lesbar — der Farbton ist dann Komfort,
nicht Voraussetzung.

Kontrastziele nach WCAG 2.2 AA: **4,5:1** für Text, **3:1** für grafische
Elemente und Bedienelemente. Gilt auch für Zustandsfarben auf der Karte.

### 2.4 Zugzustände

| Zustand | Farbe | Zweiter Kanal |
|---------|-------|---------------|
| pünktlich (≤ 1 min) | neutral, keine Einfärbung | — Normalfall ist farblos |
| 2–5 min | Bernstein, hell | Minutenwert am Symbol |
| 6–15 min | Bernstein, kräftig | Minutenwert |
| über 15 min | Rot-Orange | Minutenwert |
| Ausfall | Rot, gedämpft | durchgestrichenes Symbol |
| Zusatz- und Leerfahrt | neutral, gedämpft | hohles statt gefülltes Symbol |
| Eigenbetrieb | neutral, kühl | eigene Randmarkierung, nie wie ein Spieler-EVU |

Die Verspätungsskala ist eine helligkeitsmonotone Rampe von neutral nach warm.
Sie folgt damit der Erwartung des Fachpublikums und bleibt zugleich ohne Farbton
lesbar.

### 2.5 Ressourcenzustände

| Zustand | Farbe | Zweiter Kanal |
|---------|-------|---------------|
| frei | keine Einfärbung | — |
| belegt | Neutral, kräftiger | — |
| Fahrstraße eingestellt | schwaches Grün-Cyan | Richtungspfeil |
| Langsamfahrstelle | Bernstein | gestrichelte Kante |
| gesperrt | Rot | Schraffur |

### 2.6 Qualitätsklassen

A, B und C tragen immer ihren Buchstaben. Farbe ist hier nur Unterstützung, nie
Träger. Klasse C ist zusätzlich gestrichelt dargestellt — sichtbar, aber
erkennbar nicht bestellbar.

### 2.7 Konkrete Werte (M3.9)

Die Palette ist am dichten Bildfahrplan aus M3.10 geprüft und als CSS-Tokens in
`packages/design-system/src/styles.css` verbindlich umgesetzt:

| Rolle | Wert | Verwendung |
|-------|------|------------|
| Kartenfläche | `#090B10` | dunkelste Fläche, Diagrammhintergrund |
| Basisfläche | `#11141B` | Panels und Navigation |
| erhöhte Fläche | `#181C25` / `#202530` | Bedienelemente und Hover |
| Primärtext | `#F1F3F7` | Text mit höchster Hierarchie |
| Sekundärtext | `#A5ADBA` | Erläuterungen |
| Aufmerksamkeit | `#F0B75A` | ausgewählte Trasse, Warnung |
| Störung | `#FF715F` | Konflikt, Sperrung, Ausfall |
| Fahrstraße/frei | `#69D5C1` | bestätigte zulässige Alternative |
| Fokus | `#9FB8E8` | Tastaturfokus, kein Betriebszustand |

Die Zustandsfarben stehen nie allein: Konflikte tragen Schraffur und Warnsymbol,
Alternativen Text und Richtungspfeil, ausgewählte Zugläufe zusätzliche Linienstärke.

### 2.8 Lutz-Coach im Tutorial

Das Coach-Panel liegt auf `#11141B`, reserviert die Avatargröße mit expliziten
`width`/`height`-Attributen und zeigt
`/assets/tutorial/lutz-avatar-comic-v2.png` bei 96–160 Pixeln. Lutz ist eine
fiktive Figur ohne Unternehmensbezug, Logo oder Bildtext. Der Dialogkatalog
lebt versioniert beim Tutorialtemplate, nicht verstreut in Komponenten.

Normale Hinweise sind nichtmodal und stehen neben der einzigen Hauptaufgabe;
auf kleinen Bildschirmen folgen sie als kompakte untere Karte nach der Aufgabe.
Einleitung und Ergebnis dürfen hervorgehoben sein. Zielbereiche erhalten Fokus
und eine zusätzliche Kontur, ohne dass das Panel die Hauptaktion überdeckt.
Neue Texte werden mit `aria-live="polite"` angekündigt. Avatar-Alttext,
Fortschrittswörter, Tastaturfokus, „Warum?“, Ausblenden und manuelles
Wiederöffnen sind Pflicht. `prefers-reduced-motion: reduce` unterbindet
Animation und weiches Scrollen.

### 2.9 Anrede und sichtbare Fachsprache

Spieler werden in allen Oberflächen einheitlich mit **„Sie“** und **„Ihr“**
angesprochen. Neutrale Handlungsbeschriftungen dürfen ohne Pronomen formuliert
sein, wechseln aber nie zum „Du“. Sichtbare Texte verwenden korrektes
UTF-8-Deutsch; ASCII-Umschriften wie `Fuer`, `Ueberlappung` oder `Aussenlauf`
sind ausschließlich in unvermeidbaren technischen Bezeichnern zulässig.
Milestone-Codes, UUIDs, Revisionen und Hashes gehören nicht in die normale
Spielerführung. Wenn sie für Support oder Nachweis nötig sind, stehen sie in
einem standardmäßig geschlossenen Bereich „Technische Details“.

## 3. Dunkelmodus — durchgehend

Eine einzige Palette für alle Flächen. Lange Lesetexte — Verträge,
Ausschreibungsunterlagen, Ledger — werden **nicht** über einen hellen
Hintergrund lesbar gemacht, sondern über höheren Kontrast, kürzere Zeilenlänge
und größere Schrift (siehe 5.).

Regeln:

- **Kein reines Schwarz** als Fläche. Es erzeugt Halation unter hellem Text und
  lässt keine Ebenen unterscheiden. Tiefe entsteht durch leichte Aufhellung, nicht
  durch Schlagschatten.
- **Die Karte ist die dunkelste Fläche.** Sie ist Hintergrund, der Verkehr ist
  Inhalt.
- **Sättigung sparsam.** Voll gesättigte Farben flimmern auf dunklem Grund.
  Zustandsfarben werden leicht entsättigt und in der Helligkeit angehoben.
- Kein Hellmodus. Das spart dauerhaft die doppelte Pflege jeder Fläche und jedes
  Diagramms.

## 4. Typografie

**Auswahlkriterien, in dieser Reihenfolge:**

1. **Tabellenziffern** (`tnum`). Zeiten werden in jeder Tabelle und auf der
   Bildfahrplan-Achse vertikal verglichen. Proportionale Ziffern machen das
   unbrauchbar. Nicht verhandelbar.
2. **Eindeutige Zeichen** — 0 gegen O, 1 gegen l gegen I. In einer Oberfläche
   voller Zugnummern und Gleisbezeichnungen sicherheitsrelevant.
3. **Lesbarkeit bei kleinen Graden**, weil die Leitstellendichte klein setzt.
4. **Offene Lizenz.** Das Repository ist Source Available; eine lizenzpflichtige
   Hausschrift wäre ein Verteilungsproblem.
5. Vollständiger deutscher Zeichensatz inklusive ß und Umlauten.

**Empfehlung: IBM Plex Sans, dazu IBM Plex Mono** für Zahlenkolonnen und
Zugnummern. Begründung: exzellente Tabellenziffern, technisch-neutrale
Infrastrukturanmutung ohne Nähe zu einer Bahnhausschrift, SIL Open Font License,
sehr breiter Zeichensatz. Alternativen mit vergleichbaren Eigenschaften: Inter,
Source Sans 3.

**Ausdrücklich nicht:** DB Type und DB Screen Sans. Lizenzpflichtige Hausschrift
eines Dritten.

## 5. Dichtestufen

Zwei Stufen, **unterschieden allein durch Maß, nie durch Farbe** — beide leben
auf derselben dunklen Palette.

| Stufe | Wo | Merkmale |
|-------|-----|----------|
| **Leitstelle** | Betriebszentrale, Bildfahrplan, Trassenlisten, Livemap-Panels | enge Zeilenhöhe, kleiner Grundgrad, viele Werte je Fläche, minimale Polsterung |
| **Dokument** | Ausschreibungsunterlagen, Verträge, Tagesbericht, Onboarding, Glossar | größerer Grundgrad, begrenzte Zeilenlänge um 70 Zeichen, großzügige Abstände |

Die Dokumentstufe ist der Ausgleich dafür, dass es keinen Hellmodus gibt.

## 6. Wortmarke

**Reine Wortmarke „Zugfolge“, achromatisch.** Keine Bildmarke. Die Identität
trägt über Schriftschnitt, Laufweite und Layoutdisziplin — was zur Leitstelle
passt und dauerhaft billig zu pflegen ist.

**Kleine Größen** — Favicon, App-Icon, Kartenmarkierung des Eigenbetriebs —
brauchen trotzdem ein Zeichen. Lösung: eine **Kürzung derselben Schrift auf ein
Monogramm**, kein neues Symbol. Das bleibt eine Wortmarke, nur verkürzt, und
erzeugt keine zweite zu pflegende Gestalt.

Nie in Rot. Nie in einem Rechteck mit begleitenden Linien. Nie in der Nähe eines
Bahnrots platziert.

## 7. Rechtliche Leitplanken

Konkret, was nicht übernommen wird — ergänzt E6 um die Gestaltungsseite:

- **kein DB-Logo** und keine daran angelehnte Anordnung aus Buchstaben,
  Rechteck und begleitenden Linien;
- **DB Type und DB Screen Sans** werden nicht verwendet;
- **kein Bahnrot** als Marken- oder Flächenfarbe. Rot erscheint ausschließlich
  als Betriebszustand — was ohnehin die bessere Gestaltung ist (2.1);
- **keine Zuggattungsmarken** wie ICE oder IC. Eigene generische Systematik;
- **keine EVU-Marken und Lackierungen** realer Unternehmen. Der Lackierungs-
  editor filtert gegen den 1:1-Nachbau geschützter Zeichen;
- **unbedenklich** ist dagegen die Signalfarblogik nach ESO — regulatorische
  Konvention, keine Marke. Ebenso die Konventionen des Bildfahrplans.

## 8. Komponenten und Dichte (M3.9)

`packages/design-system` liefert Flächen, Schaltflächen, Zustands-Badges,
beschriftete Formfelder, Tabellen, Leerzustände und ein eigenes,
strichbasiertes Icon-Set für Zug, Konflikt, Zeit, Strecke, Sperrung, Bestätigung,
Ebenen und Navigation. Alle
Icons verwenden `currentColor`, tragen entweder eine zugängliche Beschriftung
oder sind ausdrücklich dekorativ und lassen sich deshalb ohne Farblogik nutzen.
Die Dichtestufen `control` (Leitstelle) und `document` (Dokument) schalten nur
Schriftgrad, Zeilenhöhe, Lesedurchschuss und Abstand. Ein gemeinsamer
`:focus-visible`-Vertrag, Screenreader-Hilfsklasse und immer beschriftete
Formfelder sind Teil der Komponentenbasis. Die Bildfahrplan-Oberfläche macht
den Wechsel direkt prüfbar.

## 9. Kartenstil und Zoomvertrag (E26, E27)

Die Karte ist weltweit dunkel und bewusst informationsarm; der semantische
Deutschland-Layer trägt den Betrieb. Die Kartenfolge ist verbindlich:
Basiskontext → aktive Gebietsgrenze → Infrastruktur → Betriebszustände → Züge
→ Auswahl. Aktive Infrastruktur ist neutral hell, inaktive modellierte
Infrastruktur gedämpft und Klasse C gestrichelt mit sichtbarem Buchstaben.

| Zoom | sichtbare Fachobjekte |
|------|-----------------------|
| 0–4 | Welt-Basiskarte |
| 5–7 | Deutschland-Korridore, große Betriebsstellen, Spielgebietsgrenze |
| 8–11 | Gleisgruppen, Betriebsstellen, Züge und Betriebsabweichungen |
| 12–14 | Einzelgleise, Bahnsteige, Blöcke; Signale und Weichen selektiv |
| 15–20 | vollständige semantische Elemente und Beschriftung |

Klickflächen sind breiter als die sichtbare Geometrie. Bei Überlagerung gilt
Zug vor Signal/Weiche vor Bahnhof/Bahnsteig vor Gleis; mehrere Treffer öffnen
eine Auswahl. Tastaturzugang erfolgt zusätzlich über eine Objektliste. Ein
Detailpanel ist per `focus=art:id` tief verlinkbar.

### Zugpositionsgenauigkeit (E27)

Exact und Estimate verwenden dieselbe Markerform, Größe, Zuggattungskennung
und Klickfläche. Damit bleibt derselbe Zug bei einem Wechsel der
Projektionsgenauigkeit visuell derselbe Gegenstand. Die Genauigkeit wird als
zusätzliche Ebene kommuniziert:

| Kartenposition | Markerzusatz | zugänglicher Text |
|---|---|---|
| Exact | kein Genauigkeitsring | „Position exakt“ im Detailpanel |
| Estimate auf orientiertem Korridor | `≈` und neutraler achromatischer Ring | „Position geschätzt: amtlicher Korridor“ |
| Estimate am resourcegebundenen Ankerhalt | `?` und derselbe neutrale Ring | „Letzte belastbare Lage; Fahrt läuft weiter“ |
| `ExternalLeg` oder keine eindeutige Projektion | kein Kartenmarker | Außenlauf beziehungsweise fehlende Kartenposition bleibt in Liste und Fahrtkette erklärt |

Der Ring ist weder gelb/bernsteinfarben noch rot und verwendet auch nicht die
Schraffur einer Qualitätsklasse. Diese Farben und Muster bleiben
Einschränkung, Sperrung, Baustelle und Infrastrukturqualität vorbehalten.
`≈` beziehungsweise `?`, Ring und Text treten gemeinsam auf; Farbe trägt die Aussage nie allein.
Das Detailpanel nennt außerdem den gebundenen Infrastruktur-Release. Sobald
Exact verfügbar ist, verschwinden Ring und Genauigkeitszeichen, ohne Markeridentität oder
Auswahlzustand zu wechseln.

Markeridentität, Layerreihenfolge, Genauigkeitszeichen, Detailtext und
`prefers-reduced-motion` sind automatisiert abgedeckt. Die manuelle
Browserabnahme für Kontrast, mehrere Zoomstufen, Tastatur und Screenreader
bleibt vor der produktiven Freigabe erforderlich.

Einschränkungen sind bernsteinfarben und gestrichelt, Sperrungen rot und
unterbrochen, Bauarbeiten rot-weiß gemustert. Fallblattanzeige und FIS nutzen
generische Domänensprache, Tabellenziffern und eine eigene Formensprache;
keine reale Hausschrift, kein Logo und kein Markenzitat. Animation betrifft
nur geänderte Zellen und entfällt bei reduzierter Bewegung.

## 10. Was nach M14.2 offenbleibt

- Layout der übrigen sechs Hauptflächen;
- Lackierungseditor;
- PWA-Layouts.

Diese Dinge sind billig zu ändern, solange das System aus Abschnitt 2 bis 5
steht. Deshalb warten sie.

## 11. Schaffnermodus: Pixelart und Sprechblasen (M15)

Der Schaffnermodus verwendet eine eigenständige orthogonale Pixelart mit 32
Pixeln pro Meter, ganzzahligen Zoomstufen und Nearest-Neighbor-Skalierung. Die
dunkle achromatische Grundsprache aus E17 bleibt erhalten; Betriebsfarben
werden nicht zu Dekoration. Fremde Figuren, Karten, Fahrzeuge, Gebäude, Logos
oder Marken werden weder übernommen noch in Produktionsanweisungen zitiert.

Alle sichtbaren Motive werden als finale, releasegebundene Grafiken erzeugt.
Ein `ArtAtlasManifestV1` dokumentiert Anweisung, Modellversion, erlaubte
Referenzen, Prüfsumme, Abmessungen und Freigabe. Zur Laufzeit findet keine
Bildgenerierung statt.

Fahrgastkommunikation erfolgt über kollisionsarm positionierte Sprechblasen.
Die Antworten sind echte Schaltflächen und erscheinen nach Auswahl kurz als
Spielerblase. Es gibt nur ein aktives Gespräch; andere Fahrgäste erzeugen kein
Ambient-Blasenrauschen. Touchziele erfüllen die bestehende Mindestgröße,
Tastaturreihenfolge bleibt logisch, Screenreader erhalten eine Live-Region und
`prefers-reduced-motion` schaltet jede Textenthüllungsanimation ab. Lange
deutsche Texte, Umlaute und kleine Viewports sind Pflichtfälle. Details:
[`schaffnermodus.md`](schaffnermodus.md) 5 bis 7.
