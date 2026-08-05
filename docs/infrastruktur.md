# Infrastruktur, Trassen und Simulation

## 1. Konfliktressourcen

Die Infrastruktur wird als betrieblicher Graph modelliert. Konfliktressourcen:

- reale und konservativ erzeugte Blockabschnitte;
- Fahrstraßen, Weichen und kreuzende Bewegungen;
- eingleisige Gegenfahrten;
- Bahnsteig- und Bahnhofskopfbelegungen;
- Abstell- und Servicegleise sowie Behandlungsanlagen (→ `betrieb.md`);
- Durchrutschwege, Räumzeiten und Mindestzugfolgen;
- Zuglänge, Fahrdynamik und infrastrukturelle Kompatibilität.

> **Harte Invariante:** Keine zwei Züge dürfen zur gleichen Zeit inkompatible
> Belegungen derselben Konfliktressource besitzen.

Mehrere Züge dürfen auf derselben Strecke fahren, wenn unterschiedliche
freigegebene Blöcke belegt werden. Ein pauschales Verbot für einen gesamten
Streckenabschnitt wäre nicht realistisch.

**Anlagen sind Konfliktressourcen wie Gleise.** Werkstätten, Waschanlagen,
Tankstellen, Entsorgungsanlagen und Abstellgleise laufen durch dieselbe
Konfliktengine wie der Fahrweg — kein zweites System.

## 2. Trassenvergabe

1. Ein `PathRequest` enthält Zugcharakteristik, Verkehrstage, Halte,
   Wunschzeiten und zulässige Abweichungen.
2. Der Planner erzeugt Laufweg- und Zeitkandidaten mit relativen
   Belegungsprofilen.
3. Reguläre Anträge eines Planungsfensters werden gemeinsam in einem
   deterministischen `PlanningRun` behandelt.
4. Reihenfolge innerhalb des Fensters und Bezahlstatus beeinflussen das Ergebnis
   nicht.
5. Exakte Gleichstände werden über einen veröffentlichten, je Planungsperiode
   rotierenden Seed aufgelöst.
6. Ad-hoc-Anträge verwenden ausschließlich verbleibende Kapazität.
7. Annahme, Alternativtrasse und Ablehnung enthalten eine maschinenlesbare und
   verständliche Begründung.

**Zugcharakteristik statt Fahrzeugliste.** Der Planner rechnet mit Masse, Länge,
Vmax, Anfahr- und Bremsvermögen, Antriebsart und Zugsicherung — nicht mit
konkreten Fahrzeugen. Echte Formationen werden darauf abgebildet
(→ `betrieb.md`). So arbeiten reale Fahrplanrechner auch, und es entkoppelt die
Trassenplanung vom Fahrzeugkatalog.

## 3. Fahrplanperiode als Saison (E3)

Acht Wochen Echtzeit je Periode, gleicher Ablauf wie real, nur gestaucht.

| Woche | Phase |
|-------|-------|
| 1–2 | Anmeldefenster — `PathRequest` für die kommende Periode |
| 3 | Koordinierung — deterministischer `PlanningRun`, Alternativangebote, Einspruchsfenster |
| 4 | Veröffentlichung Netzfahrplan, Annahmefrist, Rahmenvertragsabgleich |
| 5–8 | Betrieb; parallel Ad-hoc-Trassen aus Restkapazität |

Der Periodenwechsel ist ein Ereignis mit Fahrplanwechsel-Bericht.
Infrastruktur- und Wirtschafts-Releases treten ausschließlich hier in Kraft.

SPNV-Verkehrsverträge laufen bewusst länger (6–12 Perioden), damit eine
gewonnene Ausschreibung Planungssicherheit bedeutet.

## 4. Kapazitätsschutz und Markteintritt (E4)

Das größte soziale Risiko einer Welt ohne Wipes: Früheinsteiger binden die
Korridore, Neulinge kommen nie hinein. Alle Gegenmittel sind real begründbar:

- **Rahmenvertragsdeckel** — Rahmenverträge binden nur einen begrenzten Anteil
  der Kapazität eines Korridors.
- **Use it or lose it** — unter einem Nutzungsschwellwert liegende Trassen
  verfallen und lösen Stornoentgelt aus.
- **Markteintrittskontingent** — neue EVU haben in ihrer ersten Periode bei
  kleinen Verkehren Vorrang im exakten Gleichstand.
- **Notvergabe nach Insolvenz** — die natürliche Wiedereinstiegsrampe.
- **Kapazitäts-Heatmap** — die Welt weist niemandem ein Gebiet zu, zeigt aber
  offen, wo noch etwas geht.

## 5. Simulation und Livemap

- Die Simulation ist ereignisgesteuert; Positionen werden zwischen
  Betriebspunkten analytisch berechnet.
- Nur die nächsten 48–72 Stunden werden als vollständige `TrainRun`-Instanzen
  materialisiert.
- Wiederkehrender Verkehr wird als `ServicePattern` plus relativem
  `OccupationProfile` gespeichert.
- Regionale Single-Writer-Prozesse besitzen die jeweiligen Konfliktressourcen.
- Eine Regionsgrenze wird erst übergeben, wenn die Folgeregion die Belegung
  bestätigt.
- Verspätungen, Fahrzeugstörungen und Infrastrukturrestriktionen propagieren
  regelbasiert. Die *Entstehung* von Störungsursachen ist davon getrennt
  (→ `betrieb.md`).
- Der Browser erhält einen Initialsnapshot und anschließend Sequenz-Deltas;
  Positionen werden entlang der Gleisgeometrie interpoliert.
- **Dispositionsschnittstelle:** Der Kern besitzt einen definierten
  Entscheidungspunkt je Ereignis. Zunächst greift ein konservatives
  Standardverhalten; später hängt dort die Regel-Engine des Betriebsprogramms.
- **Zeitumstellung** ist ein Pflichtfall, kein Detail: Verhalten von
  Fahrplanperiode und laufenden Zugfahrten beim Sommerzeitwechsel muss definiert
  sein.

**Sichtbarkeit (E9):** EVU, Zugart, Zugnummer, Position, Geschwindigkeit,
Verspätung, nächster Betriebspunkt und Betriebsstatus sind öffentlich.
Vertrags- und Ladungsdetails bleiben geschützt.
