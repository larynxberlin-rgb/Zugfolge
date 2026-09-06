# Versionierter Sprechblasen-Dialogkorpus

Status: Implementierungsvertrag M15.6 / Issue #216, Version 1. Der kanonische
Fachvertrag bleibt [schaffnermodus.md](schaffnermodus.md), Abschnitte 7, 8 und 12.

## Release und Freigabe

`DialogueReleaseV1` (`conductor-dialogue-release/v1`) enthält mindestens 150
vollständige Bäume, 600 Fahrgastäußerungen und zwölf Situationsfamilien. Der erste
Korpus umfasst zwölf Familien mit jeweils 13 eigenständig geschriebenen Szenen.
Jede Szene enthält vier unterschiedliche Äußerungen, zwei kurze Nachfragen und
einen erreichbaren Abschluss. Eine gewöhnliche Kontrolle benötigt zwei bis drei
Antwortschritte; ein sofortiger Abschluss ist möglich. Die Texte sind originäre
deutschsprachige Spieltexte, keine importierten Gespräche und keine Aussagen
über wirkliche Personen oder Eisenbahnunternehmen.

Familien und Bäume tragen positive ganzzahlige Gewichte in Basispunkten. Die
Familiengewichte ergeben zusammen 10.000; die Baumgewichte ergeben innerhalb
jeder Familie 10.000. Optionen haben eine ganzzahlige Zeitdauer in Millisekunden,
eine sichtbare Bezeichnung, ausschließlich evidenzbezogene Bedingungen und
genau ein Folgeziel beziehungsweise eine terminale Absicht. Der Validator prüft
IDs, Gewichte, Textgrenzen, vollständige Erreichbarkeit, azyklische Terminierung,
Zeitkosten, Platzhalterfreiheit und die gesetzlichen Entscheidungsgrenzen.
Der Inhaltsfilter ergänzt eine dokumentierte redaktionelle Stichprobe; er ist
kein Ersatz für eine menschliche oder unabhängige redaktionelle Freigabe.

Die Welt aktiviert ausschließlich exakte kanonische UTF-8-Releasebytes, deren
SHA-256 mit einem unabhängig konfigurierten Weltpin übereinstimmt. Ed25519
signiert entsprechend dem vorhandenen Alpha-Vertrag den UTF-8-Text dieses
kleingeschriebenen Hexhashes. Signatur und Korpus dürfen den vertrauenswürdigen
öffentlichen Schlüssel nicht selbst liefern. Der Offline-Signierweg verwendet
einen extern bereitgestellten privaten Schlüssel und einen bereits bestehenden
öffentlichen Schlüsselpin; er erzeugt weder Schlüssel noch Vertrauen. Eine
unsignierte Kandidatendatei ist kein produktiv aktivierter Dialogrelease.

## Deterministische Auswahl und private Wahrheit

Die Rust-Crate `zugfolge-conductor-dialogue` hat keine Uhr, Datenbank oder
Netzwerkverbindung. Auswahl und Zustandshashes verwenden SHA-256 über explizite,
längenpräfixierte Eingaben mit dem benannten Unterstrom `fare_dialogue` sowie
Welt, Periode, Zugfahrt, Fahrgastschlüssel und Seed. Sortierte IDs machen die
Auswahl unabhängig von der Reihenfolge der Autorenlisten. Aktive Begegnungen
behalten Release, Periode und Baum nach einem Periodenwechsel unverändert.

Der tatsächliche M10-`FareFactV1` wird ausschließlich im privaten
`DialogueStateV1` gepinnt. Er beeinflusst weder Textauswahl, Auftreten, Tonfall,
Kooperation noch sichtbare Optionen. Insbesondere liefern echte und behauptete
Handyprobleme bei identischem Kontext zunächst dieselbe Oberfläche. Auch
Intoxikation ist kein Beleg für eine ungültige Fahrkarte. Die Autoren beschreiben
je Baum `Presentation`, `Tone` und `Cooperation` getrennt; keine dieser
Dimensionen entscheidet die objektive Fahrkartenwahrheit.

`DialogueEvidenceV1` enthält nur vom autoritativen Kontrollfall erhobene Fakten:
Dokumentstatus (`unchecked`, `verified_valid`, `not_presentable`,
`verified_invalid`), Erwerbsausnahme (`unknown`, `proven`, `excluded`),
synthetischen Identitätsstatus (`unknown`, `confirmed`, `refused`) und konkrete
Gefahr. Eine Fahrgastäußerung setzt keines dieser Felder. Das aufrufende
Sitzungs-/Kontrollsystem liefert diese Evidenz; Browserkommandos erhalten keine
Schreibmöglichkeit darauf. Dialogschritte dürfen Evidenz voranbringen, bereits
bestätigte Fakten aber nicht durch `unknown` oder `unchecked` zurücksetzen.

## Kommandos, Projektion und Folgewirkungen

`start_dialogue`, `advance_dialogue` und `project_encounter` arbeiten mit
typisierten DTOs. Ein Schritt enthält erwartete Revision, Kommandokennung und
explizite autoritative Zeit. Ein identischer Wiederholungsaufruf liefert denselben
Zustand; eine geänderte Wiederholung oder veraltete Revision wird verworfen.
Restore validiert Releasebindung, Baum-/Knotenzustand, Evidenz, Zeit und Hash,
bevor eine öffentliche Projektion entsteht.

`PassengerEncounterV1` enthält nur Begegnungskennung, Revision, aktuell sichtbare
Sprechblase, aktuell zulässige Antwortkennungen/-texte, bereits erhobene Hinweise
und Abschlussstatus. Sie enthält weder Fahrgastschlüssel, Tarifwahrheit, Seed,
Baum-/Familienkennung, künftige Knoten noch den privaten Fallzustand. Die normalen
Logs enthalten keine Dialogtexte, Fahrgastschlüssel oder Freitexte; Telemetrie
darf ausschließlich feste Ergebniskennungen und nach Autorisierung Welt- und
Releasekennung führen.

Terminale Absichten sind `close_without_action`, `request_document_check`,
`request_regular_claim`, `request_provisional_claim` und `request_police`.
Reguläre Forderungen setzen eine verifiziert ungültige Fahrkarte und eine
ausgeschlossene Erwerbsausnahme voraus. Vorläufige Forderungen setzen einen
nicht vorzeigbaren Fahrausweis und eine ausgeschlossene Erwerbsausnahme voraus.
Beide benötigen bestätigte synthetische Identität. Polizei setzt ausdrückliche
Identitätsverweigerung oder konkrete Gefahr voraus; Unfreundlichkeit, Schweigen,
Intoxikation oder eine Ausrede reichen nicht. Diese Absichten buchen kein Geld,
begründen keine Fahrgastsperre und halten keinen Zug. M15.8–M15.11 entscheiden
Fall, Nachweis, Fahrpreis, Zahlung und tatsächliche Eskalation mit ihrem jeweils
gepinnten Fachrelease; Geldregeln werden hier nicht dupliziert.

## Nachweise

Die Abnahme umfasst Mengen und inhaltlich unterschiedliche Szenen, sämtliche
Pfade und Bedingungen, Datenschutz-Gegenfaktuale über alle drei FareFacts,
unzulässige Polizei-/Forderungsoptionen, gleiche Seeds/Kommandos nach Restore,
veraltete Revision und abweichende Welt-/Releasebindung, manipulierte Bytes und
Signaturen sowie eine dokumentierte Stichprobe von mindestens zwei Szenen je
Familie. Die spielbare Sitzungsprobe nutzt diesen tatsächlichen Rust-Resolver
mit M10-Fahrgästen; eine bloße Liste statischer Beispielsätze genügt nicht.

Der geschriebene Kandidat liegt unter `assets/conductor-dialogue/v1/`:
`scenes.txt` ist die Autorenquelle, `release.json` das kanonische Ergebnis von
`node tools/conductor-dialogue/build.mjs`. `editorial-review.json` bindet die
unabhängige Agentenstichprobe an den exakten Release- und Quellenhash. Die
Stichprobe umfasst Szene 01 und 13 jeder Familie (24 Szenen / 96 Äußerungen);
sie ist ausdrücklich keine menschliche Vollfreigabe. Der Hinweis zu bloßer
Unterlagenverweigerung und erzählter Gefahr ist durch eine gezielte native
Gegenprobe abgesichert: Text und Autorenprofil erzeugen keine Polizeievidenz.

Das Plattformpaket `@zugfolge/conductor-dialogue` aktiviert einen Release nur
mit `conductor-dialogue-world-pin/v1`: Welt, Releasekennung, `releaseSha256`,
`editorialReviewSha256` und explizite `signingKeyId`. Der native Validator muss
den Hash derselben kanonischen Bytes bestätigen. Der unveränderliche
Loaderzugriff gibt den vollständigen Korpus ausschließlich an serverseitige
Sitzungskerne aus; dieser Korpus ist keine Browserantwort.

Der Offlinebefehl `node tools/conductor-dialogue/release.mjs` verlangt
`--directory`, `--world-id`, `--world-pin`, `--trusted-keys`, `--private-key`,
`--key-id`, `--output` und genau eines von `--validator-addon` oder
`--validator-binary`. Alle Welt-/Schlüsseldateien sind unabhängige bestehende
Deploymentkonfiguration. Die Ausgabe ist ausschließlich eine neue
Signaturdatei; vorhandene Dateien werden nicht überschrieben, Welten nicht
aktiviert. Tests verwenden ausdrücklich temporäre Testschlüssel.

Reguläre Prüfungen: `cargo test -p zugfolge-conductor-dialogue` und
`pnpm --filter @zugfolge/conductor-dialogue test`. Der Plattformnachweis braucht
den echten NAPI-Pfad `ZUGFOLGE_RUNTIME_NATIVE_PATH`; für lokale Windowsnachweise
kann `ZUGFOLGE_DIALOGUE_TEST_BINARY` auf das tatsächlich gebaute Beispiel
`cargo build -p zugfolge-conductor-dialogue --example dialogue_json` zeigen.
Es gibt keinen fachlichen TypeScript-Ersatzresolver.
