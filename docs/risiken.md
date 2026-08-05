# Risiken

| # | Risiko | Gegenmaßnahme |
|---|--------|---------------|
| R1 | OSM enthält Signale gut, aber **Blöcke, Fahrstraßen, Durchrutschwege und Neigungen gar nicht**. Diese Arbeit wird leicht als „Import“ unterschätzt. | Drei eigene Ableitungsschritte (M1.5–M1.7), kein Ladevorgang. Die Abdeckungsmessung M1.4 steht davor. M1.7 ist mit XL bewertet, nicht mit L. |
| R2 | Der Trassen-Planner (M3.4, XL) ist das Herz. Funktioniert er nicht, funktioniert nichts. | Deshalb der Wegwerf-Spike in M0.3, bevor irgendetwas anderes gebaut wird. |
| R3 | 1:1-Echtzeit mit wenigen Spielern ergibt eine leere Welt. | Weltstart mit Eigenbetrieb (M9.2), Pilotregion klein halten, Alpha eng und gleichzeitig starten. |
| R4 | Rechtsklärung bei Daten und Marken blockiert den Aufbau. | M0.4 und M0.5 als harte Gates. Die Pilotregion muss allein mit OSM-Extract spielbar sein. |
| R5 | Komplexitätsschock beim Einstieg. | Tutorial-Welt, Regelwerk-Vorlagen, Glossar-Layer (M9.1–9.3). Nicht ans Ende schieben. |
| R6 | Kapazitäts-Landgrab durch Früheinsteiger. | Rahmenvertragsdeckel, Verfall bei Nichtnutzung, Markteintrittskontingent — ab M3.8 wirksam. Von Beginn an mitbauen, nicht nachrüsten. |
| R7 | Realismus frisst Spielbarkeit. | Jeder Milestone hat einen Beweis, der ein *Spielerlebnis* beschreibt, keine technische Eigenschaft. |
| R8 | Strategie-Monokultur: alle Spieler konvergieren auf dieselbe optimale Linie. | Widersprüchliche Ziele und umkämpfte Kapazität als Struktur, nicht als Balancing-Nachschlag (E11). |
| R9 | Absprache oder kollektiver Boykott bei Ausschreibungen, um Preise zu treiben. | Endliches Aufgabenträgerbudget (M6.9). Notvergaben verbrennen es, die nächste Ausschreibung fällt kleiner aus. Boykott schadet allen. |
| R10 | Insolvenz wird zum billigen Neustart, um schlechte Verträge abzuwerfen. | Präqualifikation und Bonität (M6.12). Pönalen greifen vor Stufe 5, nicht danach. |
| R11 | Der Versorgungsbereich erschlägt Kurzzeitspieler mit Mikromanagement. | Drei Eingriffstiefen. Kritisch ist M5.10: Ist die Automatik zu schwach, verlieren Kurzzeitspieler; ist sie optimal, verlieren Detailverliebte ihren Anreiz. Die Zielgüte 85–90 % ist ein messbares Balancingziel, kein Gefühl. |
| R12 | Der Eigenbetrieb wird als unfairer Konkurrent wahrgenommen. | Bietet nie in laufenden Verfahren, fährt nur Mindestbedienung, nachrangige Trassenpriorität, nie Qualitätsbonus, klar gekennzeichnet. |
| R13 | Monetarisierung greift in die Wettbewerbsmechanik über und beschädigt Fairness und Einstiegstrichter zugleich. | Der Test in `geschaeft.md` ist vor jedem neuen Kaufangebot anwendbar; der CI-Wächter in M0.2 macht den Fehler unmöglich statt nur unerwünscht. |
| R14 | Der Rust-Simulationskern wird zu einem Bereich, den der Entwickler nicht selbst reparieren kann. | Bewusst in Kauf genommen (E5), weil ein Solver-Umbau bei nationalem Maßstab teurer wäre. Beherrschbar durch engen Kernvertrag ohne Datenbankzugriff, ein Regelwerk aus dem Eisenbahnbetrieb statt aus Produktentscheidungen, Golden-Master- und Determinismus-Tests, und einen kleinen Einstieg über M0.3. |
| R15 | Die Lastschätzungen in `architektur.md` erweisen sich als zu niedrig, besonders bei mehreren parallelen Welten. | Zielgrößen, keine Annahmen: M4.11 misst gegen sie, M14.3 plant Kapazität dagegen. Weltisolation macht Skalierung horizontal — die Antwort auf zu wenig Leistung sind mehr Prozesse, nicht ein anderer Entwurf. |
