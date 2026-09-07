# Kontrollhalt in der autoritativen Betriebsengine

Dieser Fachvertrag konkretisiert M15.9 / Issue #219 und
`schaffnermodus.md` §9 vor der Implementierung. Es entsteht keine zweite
Belegungs-, Fahrdienstleiter- oder Bewegungsengine.

## 1. Gepinnte Policy und Anforderung

`FareControlPolicyV1` liegt optional im echten `OperationalWorld`; fehlt sie,
ist die Anforderung gesperrt. Ihr Vertrag besitzt `schema`, `policyId`,
`revision`, `worldId`, `schedulePeriodId`, `contentHash`,
`maxPoliceHoldsPerTrainRun` (genau1), `eligibleReasons` (genau
`identity_refusal` und `concrete_danger`), `targetRule`
(`next_unreached_scheduled_passenger_stop`), `providerByStopId`, `maxWaitMs`,
`policeResponseModelId`, `policeResponseModelHash` und `publicCause`
(`authority.police.fare-control`). Der Hash ist SHA-256 über die kompakte
typisierte Rust-Serialisierung mit leerem `contentHash`; die Plattform prüft
vorher den unabhängig gepinnten Release. Zeitwerte bleiben sichere ganze
Millisekunden, Wartezeit und Korpusgröße sind begrenzt.

Der vorhandene versionierte Operational-Command erhält die Payloads
`set-fare-control-policy`, `request-fare-control-hold` und
`resolve-fare-control-hold`. Konfiguration und Commands bleiben serverseitig;
Spieler dürfen weder Policy, Fallbelege, Anbieter noch Polizeiergebnis setzen.
`request-fare-control-hold` enthält `trainId`, `caseId`, `reason` und
`causalityId`. Der offene Kontrollfall muss den Grund tatsächlich belegen;
diese Autorisierungsgrenze liegt vor dem Betriebscommand. Der Betriebszustand
bestimmt selbst den ersten noch nicht angekommenen Halt seines tatsächlichen
PassengerStopPlan. Fehlende Anbieterbindung, fehlender Fahrgastzug oder
fehlender künftiger Halt sind konkrete Ablehnungen.

Weitere Fälle dürfen ausschließlich derselben bereits angeforderten Wartefolge
bis vor der Zielankunft beitreten. Jeder Fall wird nur einmal aufgenommen.
Bereits freigegebene oder entfallene Halte verbrauchen weiterhin die einmalige
Zuglaufquote. Weder neue Sitzung noch neue Periode eröffnet eine zweite Quote.

## 2. Zustand, Zeit und reale Ressourcen

`FareControlHoldV1` enthält Welt und Zuglauf, `holdId`, `caseIds`, Zielhalt,
Anforderungs-/Aktivierungs-/Frist-/Freigabezeit, Policy und Modellpin,
`providerId`, Status (`requested`, `active`, `released`), Ergebnis,
Revision und Kausalitätskennung. Eine aktive Folge erhält keine Konto-ID,
Fahrausweiswahrheit, Namen oder Dialogtexte. Öffentliche Betriebsereignisse
zeigen ausschließlich Hold-/Zug-/Haltekennung, Ursache, Zeitpunkt und Status;
die Fallliste gehört nicht in die öffentliche Darstellung.

Anforderung ändert weder Geschwindigkeit noch Fahrweg oder Belegung. Erst die
tatsächliche Zielankunft und das Maximum aus planmäßiger Abfahrt und
Ist-Ankunft plus Mindestaufenthalt machen den Zug regulär abfahrbereit.
Genau dann aktiviert der vorhandene Ereignisscheduler den zusätzlichen Halt.
Die Höchstfrist beginnt an diesem Zeitpunkt; normale Haltezeit zählt nicht
als Kontrollhalt. Auch ein Endbahnhof besitzt diesen Aktivierungspunkt, obwohl
keine weitere planmäßige Abfahrt materialisiert wird.

Während `active` verweigern Fahrdienstleiter, direkte Fahrstraßenanforderung,
Lokführer und Haltquittung die Abfahrt. Vorherige Abfahrterlaubnisse werden
entzogen. Bereits vorhandene tatsächliche Fahrstraßenlocks und vom Zug
belegte Gleisintervalle bleiben im selben Weltzustand; das normale
Zugschluss-Freigabeverfahren hat geräumte Ressourcen vorher bereits entfernt.
Es werden keine neuen Sperrressourcen, Infrastrukturstörungen oder virtuellen
Bahnsteigbelegungen erzeugt. Aktive Halte verhindern vorzeitiges Retirement.

## 3. Polizeiergebnis, Freigabe und Fahrdienstleiter

`PoliceResponseModelV1` und die deterministische fallweise Reaktion gehören
zum separaten Kontrollfallkern. Dieser erhält den tatsächlich aktivierten
Hold und liefert erst nach seiner gepinnten Reaktionsdauer ein
`resolve-fare-control-hold` mit `trainId`, `holdId`, `expectedRevision`,
`modelHash`, `outcome` und `causalityId`. Zulässige Polizeiergebnisse sind
`identity_confirmed`, `identity_not_confirmed` und `unavailable`.
`timeout` und `target_unavailable` bestimmt ausschließlich der Betrieb.
Ein verspätetes Ergebnis kann einen bereits abgeschlossenen Halt nicht öffnen.

Der vorhandene M8-/Operational-Pfad besitzt bisher keinen nativen
Fahrgasthaltplan-Abbruch; eine veränderte M10-Prognose genügt dafür nicht.
Der neue serverseitige Betriebscommand `cancel-passenger-stop-plan` enthält
`cancellation: {trainId, expectedStopPlanHash, causalityId}`. Ausschließlich
die autorisierte Betriebsdisposition darf ihn aus einer verbindlich
beschlossenen Fahrtabsage erzeugen. Er hält den tatsächlichen Zug sicher an,
bewahrt den vollständigen ursprünglichen Plan und alle Istquittungen und
ergänzt eine unveränderliche native Abbruchquittung. Eine laufende Bewegung
wird zuvor an der expliziten aktuellen Weltzeit ganzzahlig materialisiert;
der Zug springt nicht auf einen älteren Segmentanfang zurück. Die normalen
Ressourcen bleiben durch die reale Belegung und Zugschlussprüfung geschützt.
Neue Fahrgastabfahrten sind für den abgebrochenen Plan gesperrt. Eine spätere
sichere Räumung benötigt eine gesonderte Betriebsdisposition.

Ein noch angeforderter Kontrollhalt endet dadurch mit `target_unavailable`.
Ein bereits aktiver Kontrollhalt läuft einschließlich ursprünglicher Frist
weiter und wird durch die Absage nicht vorzeitig freigegeben. Die Sitzung
endet wegen des nativ quittierten Fahrtabbruchs; frühere Kontrollfolgen bleiben
erhalten. Der Command ist über die bestehenden Runtime-Receipts idempotent.

Die explizite Weltfortschreibung verarbeitet die Frist auch ohne Sitzung,
Browser, Polizeidienstaufruf oder weiteres Spielercommand. Entfällt ein
angeforderter Zielhalt oder die Fahrt vor Aktivierung, entsteht
`target_unavailable`; es gibt keine automatische Umbuchung auf einen anderen
Bahnhof. Der Hold behält die ursprüngliche Policy und Frist über Perioden.

Nach Freigabe bleibt die frühere Abfahrterlaubnis ungültig. Eine neue normale
Abfahrtsanfrage läuft durch dieselbe lexikographische FDL-Ordnung und erneute
Konflikt-, Fahrstraßen- und Schutzprüfung. Bereits erhaltene Locks dürfen nur
nach dieser erneuten Prüfung eine neue Zustimmung für ihren noch benötigten
Restfahrweg tragen. Die Anfrage bekommt keinen Minigame-Sondervorrang.

## 4. Persistenz, Handover und Nachweise

Policy und Holds sind Teil des normalen Operational-Zustandshashes,
Checkpoints und Runtime-Replays. Ohne aktivierte Policy bleibt die neue
optionale Eigenschaft ausgelassen; alte Welten behalten ihre Hashdarstellung.
Ein normaler regionaler Handover überträgt die zuggebundene Holdfolge gemeinsam
mit Fahrzeugen und Ist-Haltquittungen. Er darf sie weder verdoppeln noch löschen.
Öffentliche Projektionen verwenden nur die bestehende betriebliche Ursache.

Tests durchlaufen den echten PassengerStopPlan und Fahrdienstleiter:
Anforderung auf Strecke ohne Wirkung, Aktivierung nach regulärer Haltezeit,
Fälle bündeln, Frist und Modellauflösung, Periodenpin, Sitzungsunabhängigkeit,
Restore/Replay, Zielentfall, Mehrzugkonflikte und Neupriorisierung. Variierende
Haltefristen und Ankunftsfolgen müssen stets die vorhandene
`verify_invariants()`-Prüfung erfüllen. API/DB und der spielbare Nachweis
verwenden dieselben nativen Commands.
