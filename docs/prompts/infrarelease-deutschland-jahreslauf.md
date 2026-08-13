# Fester Arbeits-Prompt: Deutschland-InfraRelease zum Fahrplanwechsel

Diesen Prompt einmal jährlich in einem neuen, protokollierten Codex-Task
verwenden. `<FAHRPLANJAHR>`, `<STICHTAG_UTC>`, `<QUELLWURZEL>` und
`<ARTEFAKTWURZEL>` müssen vor dem Start konkret ersetzt werden.

---

Du baust den vollständigen Deutschland-`InfraCorpus` für das Fahrplanjahr
`<FAHRPLANJAHR>` und daraus einen signierbaren `InfraRelease`. Lies zuerst
`AGENTS.md`, `docs/daten.md`, `docs/rechte.md`,
`docs/deutschland-infracorpus.md`, `docs/infrastruktur.md`,
`docs/betriebsgraph.md`, ADR-0014, ADR-0022 und ADR-0025 sowie
`tools/region-import/germany/release.config.json` und
`source-catalog.json`. Ändere keine Rechteentscheidung stillschweigend.

Ziel und Grenzen:

- Importiere das deutschlandweite EBO-Regelspurnetz vollständig. Lade den
  gesamten Korpus in den Serverrelease; die aktuell spielbare Region bleibt
  eine separate `WorldRelease`-Maske.
- Stelle Klasse A her, wo jede Pflichtdimension belastbar validiert ist.
  Schließe verbleibende Lücken als vollständiges, konservatives Klasse-B-Modell.
  Klasse C bleibt sichtbar und darf niemals bestellbar sein.
- Reale Genauigkeit ist wünschenswert, aber die intern widerspruchsfreie,
  regelkonforme Betriebswahrheit ist zwingend. Erfinde keine vermeintlich
  beobachteten Fakten. Jede Annahme nennt eine versionierte Regel.
- Kein externer Dienst liegt im heißen Pfad. Alle Quellen werden einmalig
  erfasst, gehasht und offline verarbeitet.

Quellenlauf:

1. Prüfe jede Quelle gegen `tools/guards/quellenregister.json`. Stoppe vor dem
   Import, wenn Kennung, Lizenz, Bereitstellungsweg oder datierte Freigabe fehlt.
2. Erfasse die im Quellkatalog freigegebenen Jahresstände: Deutschland-OSM-PBF,
   Infrastruktur-Stammdaten, den offiziellen DB-InfraGO-Open-Data-Stand,
   GTFS-Schienenregionalverkehr, Copernicus-DEM sowie StaDa und OpenStation.
   Schreibe für jede Eingabe Version,
   Abrufzeit `<STICHTAG_UTC>`, Bytezahl und SHA-256 in das Capture-Manifest.
3. Nutze APN-Skizzen nur als **internen Validierungsbestand**. Erzeuge die
   RL100-Liste ausschließlich aus bereits freigegebenen Stammdaten. Für eine
   bekannte RL100 startet
   `https://trassenfinder.de/apn/RL100` den direkten Abruf. Ersetze `RL100`
   exakt, arbeite sequentiell und schonend, begrenze die Rate, unterstütze
   Wiederaufnahme, protokolliere Status und Hash und wiederhole dauerhaft
   fehlende Pläne nicht. Prüfe vor jedem Jahreslauf erneut Erreichbarkeit und
   Rechtefreigabe.
4. Lege APN-PDFs, Seitenbilder, OCR und Layoutkoordinaten ausschließlich unter
   `<QUELLWURZEL>/internal-evidence/apn/` ab. Nichts davon wird committed oder
   ausgeliefert.

APN-Auswertung:

- Extrahiere Betriebsstellenkennung, Gleisbezeichnungen, Bahnsteigkanten,
  Weichen, Kreuzungen, Hauptsignale, Fahrtrichtungen und eindeutig erkennbare
  topologische Verbindungen mit Seiten- und Koordinatenbezug.
- Trenne sichere Beobachtung, mehrdeutigen Vorschlag und nicht erkennbaren Wert.
  Automatisch akzeptiert werden nur widerspruchsfreie, geometrisch und
  topologisch eindeutig zuordenbare Befunde. Alles andere kommt in eine
  Reviewliste.
- APN deckt die freie Strecke nicht vollständig ab. Ergänze Blocksignale,
  Überleitstellen und Abzweige aus dem deutschlandweiten OSM/ORM-Tagbestand und
  validiere beziehungsweise modelliere fehlende Streckenlogik konservativ.
- Ein akzeptierter Beleg nennt Abschnitt, validierte Qualitätsdimensionen,
  Extraktionsversion, Prüfergebnis und interne Evidenzhashes. Er darf Klasse A
  nur für tatsächlich belegte Dimensionen vergeben. Ein APN-Beleg ist
  `classAEligible=false`: Er verbessert oder bestätigt Klasse B, darf aber ohne
  eine unabhängige freigegebene Evidenz keine Dimension auf A heben.
- Behandle OSM, den offiziellen InfraGO-Datensatz, den jährlichen
  Infrastruktur-Stammdatensnapshot, StaDa, OpenStation, DEM und APN als
  getrennte Evidenzen. Bei Widersprüchen gewinnt keine Quelle allein aufgrund
  ihres Namens; erzeuge einen Reviewfall mit Feld, Abschnitt und beiden
  Belegständen.
- In ausgelieferten Daten dürfen weder `APN`, die Abrufadresse, PDF-Name,
  OCR-Text noch eine darauf bezogene Quellenattribution vorkommen. Der
  öffentliche Release enthält auch keinen Hash, Namen oder Bezeichner des
  internen Evidenzledgers. Alle anderen Lizenzattributionen bleiben erhalten.

Deterministischer Build und Prüfung:

1. Filtere EBO-Regelspur und erhalte ausgeschlossene Infrastruktur als
   gedimmten Kartenkontext.
2. Erzeuge stabile IDs, Graph, einzelne Gleise, Betriebsstellen, Weichen,
   Signale, Blöcke, Fahrstraßen- und Konfliktmodelle. Sortiere alle Eingaben vor
   dem Hashen stabil; Zeiten und Längen bleiben ganzzahlig.
3. Kennzeichne diesen reinen Build-Zwischenschritt mit
   `ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1` und führe
   `build-germany-release.mjs compile` aus. Erzeuge den Qualitätsbericht je
   Dimension, Ursache und Länge. Prüfe ausdrücklich, dass konservativ
   geschlossene Lücken B und ungelöste Lücken C ergeben. Dieser Schritt darf
   selbst keinen Release freigeben.
4. Erzeuge getrennte, selbst gehostete PMTiles für weltweite Dark-Basemap und
   semantische Deutschland-Infrastruktur. Prüfe stabile Feature-IDs, Zoomvertrag,
   Attribution, Dateihash und HTTP-Range-Auslieferung.
5. Baue das öffentliche Manifest mit `build-germany-release.mjs manifest` im
   autoritativen Rust-Compiler und suche rekursiv nach verbotenen internen
   Evidenzkennungen. Jeder Treffer blockiert den Release.
6. Führe Unit-, Golden-Master-, Determinismus-, Rechte-, Lizenz-,
   Konfliktinvarianten-, Karten- und unabhängige Holdout-Tests aus. Vergleiche
   Qualitätslängen und Laufzeit/RAM/PMTiles-Größe mit dem Vorjahresrelease und
   erkläre jede wesentliche Abweichung.
7. Lege Kandidat, Hashes, Berichte und Reviewliste zur Freigabe vor. Signiere
   erst nach namentlicher Releasefreigabe. Markiere M14.2 nur dann erledigt,
   wenn der vollständige Deutschlandlauf und nicht lediglich eine Fixture
   bestanden hat und alle verbleibenden Abnahmebelege erfüllt sind.
8. Erzeuge nach den öffentlichen Infra-, Karten- und Deliverymanifesten das
   transportneutrale Paket mit dem Jahresplan. Prüfe es vollständig, installiere
   es in ein neues versioniertes Testziel und protokolliere Manifest-Hash,
   Teilezahl, Gesamtbytezahl und Installationspfad. Übergib anschließend
   Manifest und alle Teile über den vorgesehenen Odoo-Jahresimport in das
   getrennte Game-Staging, sofern die Zielumgebung verfügbar ist. Ein
   unsignierter Kandidat darf gepackt, geprüft und gestaged werden, muss aber
   `activationEligible=false` bleiben und darf keinen Übernahmeantrag erzeugen.

Liefere am Ende eine knappe Tabelle mit Quelle/Version/Hash, A-/B-/C-Länge,
offenen Ursachen, Teststatus, Artefaktgrößen, Änderungen zum Vorjahr und
Signaturstatus. Ergänze Paketmanifest-Hash, Teilezahl, Verify-/Installstatus,
Odoo-/Game-Stagingstatus und den ausdrücklich getrennten Aktivierungsstatus.
Verlinke alle internen Laufbelege, aber keine APN-Rohdateien.

---
