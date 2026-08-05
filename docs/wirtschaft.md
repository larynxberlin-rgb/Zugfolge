# Wirtschaft: Kreislauf, Märkte, Ausschreibung, Scheitern

## 1. Gemeinsamer Spielkreislauf

```text
Markt erkennen
  → Angebot planen
  → Fahrzeuge und Personal sichern
  → Trasse beantragen
  → Betrieb durchführen
  → Ergebnis auswerten
  → Angebot verbessern
```

Alle drei Geschäftsfelder sind vollständig spielbar:

- **SPFV** — eigenwirtschaftliche Linien, Haltepolitik, Tarife, Komfort,
  Nachfrage, Vertrieb, vollständiges Erlösrisiko.
- **SGV** — Verladerverträge, Spot- und Langfristaufträge, Zugbildung,
  Terminals, Wagenumläufe, Leerfahrten, Lieferqualität.
- **SPNV** — spielweltgenerierte Ausschreibungen mit Leistungsbeschreibung,
  Qualitätsanforderungen, Mobilisierungsphase, Angebotswertung, Verkehrsvertrag,
  Bonus und Pönale. **Erstes vollständig spielbares Feld (E1).**

Gemeinsame Kosten und Restriktionen: Trassen-, Stations-, Abstell- und
Anlagenentgelte; Fahrzeugkauf, Leasing und Finanzierung; Energie, Personal,
Verwaltung; Wartung, Fristen, Werkstattaufenthalte; Leer- und
Zuführungsfahrten; Verspätungs-, Ausfall- und Vertragsfolgekosten.

Geld wird ausschließlich als **Integer-Cent** in einem unveränderlichen,
ausgeglichenen Ledger geführt. Alle Balancewerte liegen in einem versionierten
`EconomyRelease` und sind nicht im Programmcode verdrahtet.

## 2. Nachfrage und Wettbewerb

- Personenverkehr verwendet ein zonenbasiertes Nachfragemodell aus Bevölkerung,
  Arbeitsplätzen, POIs, Reiseanlässen, Saison und Tageszeit.
- Die Verkehrsmittel- und Zugwahl bewertet Fahrpreis, Reisezeit, Umstiege, Takt,
  Zuverlässigkeit und Komfort.
- Güterverkehr entsteht aus Industrie-, Terminal-, Hafen- und
  Warenstrommodellen sowie generierten Verladerverträgen.
- SPNV-Aufgabenträger sind simulierte Marktakteure, aber keine Zugbetreiber.
- Reale öffentliche Daten kalibrieren Größenordnungen; reale Personen oder
  vertrauliche Unternehmensdaten werden nicht nachgebildet.
- Kredite, Restrukturierung und Insolvenz gehören zur Wirtschaft.

## 3. Eigenbetrieb — Ausfallsicherung des Aufgabenträgers (E7)

**Wann er greift**

1. Kein Angebot innerhalb der Angebotsfrist.
2. Alle Angebote über der veröffentlichten Auskömmlichkeitsgrenze.
3. Kündigung oder Insolvenz eines EVU während der Vertragslaufzeit.

**Die Auskömmlichkeitsgrenze wird vor Angebotsöffnung veröffentlicht** und
deterministisch aus dem `EconomyRelease` berechnet: Zugkm × Kostensatz zuzüglich
Aufschlägen für Fahrzeugbedarf, Nachtabstellung und Zugsicherungsausrüstung.
Angebote darüber sind ungültig. Nichts daran ist verborgen — es gibt nichts zu
erraten und nichts auszunutzen. Das ersetzt eine wertende Serverentscheidung
(„zu teuer“) durch eine nachrechenbare Regel.

**Der Eigenbetrieb ist bewusst mittelmäßig.** Sonst gäbe es keinen Grund zu
bieten:

- fährt exakt die Mindestbedienung, keine Zusatzhalte, keine Verstärker;
- Standardfahrzeuge aus dem Fahrzeugpool des Aufgabenträgers, älterer Jahrgang;
- festes, konservatives Betriebsprogramm ohne Optimierung, dadurch spürbar
  schlechtere Pünktlichkeit als ein gut geführtes EVU;
- nimmt am normalen `PlanningRun` teil, aber mit nachrangiger Priorität im
  Konfliktfall; seine Trassen werden bei Übernahme sofort freigegeben;
- erhält niemals einen Qualitätsbonus;
- ist optisch eindeutig gekennzeichnet — neutrale Lackierung, eigene Markierung
  auf der Livemap, niemals als Spieler-EVU getarnt.

**Er verschwindet wieder.** Eine Notvergabe ist auf zwei Perioden befristet.
Danach wird neu ausgeschrieben, mit einem **nachgebesserten Paket**: höheres
Bestellerentgelt, reduzierter Leistungsumfang oder gestellte Fahrzeuge aus dem
Pool. Eine gescheiterte Ausschreibung macht die nächste attraktiver —
selbstheilendes Ventil und automatischer Schwierigkeitsregler zugleich.

**Anti-Kartell ohne Sonderregel.** Jeder Aufgabenträger hat ein endliches
Periodenbudget, und Notvergaben sind für ihn teuer. Wer sich abspricht und ein
Netz leerlaufen lässt, drückt dieses Budget — die nächste Ausschreibung in
derselben Region fällt kleiner aus oder entfällt. Kollektiver Boykott schadet
allen Beteiligten, ganz ohne künstliche Anti-Absprache-Mechanik.

**Weltstart.** Wenn eine Welt öffnet, hält der Eigenbetrieb das **gesamte**
SPNV-Netz der Region. Die Welt sieht ab Sekunde eins aus wie eine echte
Eisenbahn, und die Spieler erobern sie Ausschreibung für Ausschreibung. Das löst
das schwierigste Problem eines persistenten Spiels — den leeren ersten Tag —
ohne einen einzigen künstlichen Konkurrenten.

Fernverkehr und Güterverkehr erhalten bewusst **keine** Ausfallsicherung. Beide
sind eigenwirtschaftlich: fährt niemand, fährt niemand. Unerfüllte Nachfrage
bleibt aber als offener Marktbedarf sichtbar — als Signal an die Spieler, nicht
als Füllmasse.

## 4. Insolvenz als Totalverlust (E8)

Scheitern beendet das EVU vollständig: Fahrzeuge werden verwertet, Verträge
gekündigt, Trassen freigegeben, der Restwert geht an die Gläubiger. Der Account
bleibt bestehen, das Unternehmen nicht.

Harte Konsequenzen sind nur zulässig, wenn sie **vollständig vorhersehbar**
sind. Deshalb eine sichtbare Eskalationsleiter — jede Stufe erscheint im
Postfach und im Tagesbericht:

| Stufe | Auslöser | Wirkung |
|-------|----------|---------|
| 1 Frühwarnung | Liquidität reicht weniger als zwei Perioden | Warnung, Prognoserechnung, Handlungsvorschläge |
| 2 Zahlungsverzug | fällige Entgelte nicht gedeckt | Verzugszinsen, keine neuen Trassenanträge |
| 3 Kreditsperre | Bonität unter Schwellwert | keine neuen Kredite, kein Fahrzeugkauf |
| 4 Vertragskündigung | Nachweise oder Pönalen überschritten | Aufgabenträger kündigt, Eigenbetrieb übernimmt |
| 5 Insolvenz | Zahlungsunfähigkeit festgestellt | Liquidation, EVU endet |

**Kein Reset-Exploit.** Insolvenz darf kein billiger Ausweg aus einem schlechten
Vertrag sein. Zwei Sperren:

- Pönalen und Kündigungsfolgen greifen **vor** Stufe 5, nicht erst danach.
- Der Spieler trägt eine **Präqualifikation** — einen Eignungsnachweis über
  seine Betriebshistorie in dieser Welt. Nach einer Insolvenz ist er für mehrere
  Perioden nur für kleine Lose zugelassen und startet mit schlechterer Bonität.
  Das entspricht der realen Eignungsprüfung im Vergabeverfahren und schließt die
  Lücke, ohne eine künstliche Strafe zu erfinden.

## 5. Kooperation zwischen EVU

Kein Gilden- oder Allianzsystem, sondern spielweltseitig durchgesetzte Verträge
mit Laufzeit, Entgelt und Pönale:

- Traktionsleistungen (ein EVU stellt Lok und Personal für den Zug eines
  anderen);
- Fahrzeugvermietung und -verkauf inklusive Fristenstand;
- Anschlussvereinbarungen mit verbindlichen Wartezeiten;
- Wagenübergang im SGV;
- Ersatzverkehrshilfe bei Störungen;
- Bietergemeinschaften für SPNV-Ausschreibungen.

Daraus entsteht Politik zwischen Spielern, ohne ein zusätzliches Sozialsystem
bauen zu müssen.
