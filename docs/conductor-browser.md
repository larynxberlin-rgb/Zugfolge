# Schaffneroberfläche im Spiel (M15.8)

Der Einstieg steht in der privaten Zugansicht eines eigenen aktiven Zuges. Der Server prüft Weltzugang, EVU-Eigentum, laufende Betriebsformation, M5-Konfiguration, M10-Manifest und freigegebene Periodenpins. Die Oberfläche öffnet einen fokussierten Dialog mit Fahrtkontext und Rückkehr zur unveränderten Karte. Ein fehlender oder abgelaufener Vertrag erklärt die Nichtverfügbarkeit.

Die gemeinsame Komponente `conductor-entry.ts` führt diese Verfügbarkeitsabfrage
für die normale Zugdetailansicht und den separaten nativen Einstiegsnachweis
identisch aus. Bis zur Antwort bleibt der Einstieg gesperrt; eine Ablehnung
zeigt den tatsächlichen Servergrund. Antworten für eine inzwischen verlassene
Auswahl dürfen keinen Einstieg mehr aktivieren. Start und Fortsetzung behalten
Fahrt-, Welt- und Unternehmenskontext; die Rückkehr fokussiert denselben
Einstieg. Der separate Browsernachweis benutzt echte Availability-, Start-,
Detach- und Resume-Antworten. Er prüft diese Komponente ohne nachgebildete Karte.

Die Kopfzeile behält die bekannten Welt- und Unternehmensnamen aus dem
Spielkontext. Die gemeinsame rote Gleismarke und „Zur Karte“ schließen den
Modus mit erhaltener Kartenauswahl. Bestätigungen nennen zusätzlich zu den
Folgen die tatsächlich betroffene Fahrt.

Das Canvas verwendet PixiJS, das native InteriorLayoutV1 und die vollständige PassengerProjectionV2. Alle Fahrgäste bleiben im Modell; nur unsichtbare Sprites werden ausgeblendet. Positionen entstehen in Millimetern im Rust-Kern. Klicks, Tastatur und Touch erzeugen begrenzte Bewegungsbefehle; Kollision, Nähe, Deckwechsel und Wartezeiten entscheidet der Server. Es gibt keine optimistisch bestätigte Bewegung oder klientenseitig erzeugte Dialog-/Geldfolgen.

Der geprüfte Atlas stellt eine explizite öffentliche Renderprojektion bereit: Release-/Dateihashes, Pixelmaße, Ausschnitte, Pivot, Weltmaße, Erscheinungsvarianten, Animationen und Zubehörbindungen. Herkunftsbelege, Prompts und interne Prüfvermerke bleiben im Release. Dateiabrufe werden auf dieselbe aktive Eigentümersitzung begrenzt; der Browser prüft die SHA-256-Bytes. Ganzzahliger Zoom, 32 Pixel pro Meter und Nearest-Neighbor gelten auch nach Resize. Änderungen der Bewegungspräferenz werden berücksichtigt.

Ein paralleles DOM enthält Fahrzeug-/Deckauswahl, vollständige Fahrgastliste und alle angebotenen Dialogoptionen. Fokusfang, Escape/Rückkehr, beschriftete Touchflächen, Tastaturbedienung, Live-Status und reduzierte Bewegung machen die Handlung ohne Canvas möglich. Optionen stammen nur aus dem öffentlichen Encounter-Snapshot; verborgene Fahrscheinmerkmale werden nicht übertragen. Polizei und Forderungen erfordern einen sichtbaren Bestätigungsschritt mit den bekannten Folgen.

Authentifizierter Fetch-SSE transportiert nummerierte private Snapshots. Bei Verbindungsabbruch bleibt die letzte bestätigte Ansicht sichtbar und schreibgeschützt; ein neuer Vollsnapshot synchronisiert vor weiteren Befehlen. Wiederholungen verwenden dieselbe Idempotenzkennung. Ein aktiver Befehl sperrt konkurrierende lokale Eingaben. Manifestwechsel aktualisieren die vollständige Liste, ohne einen ausgestiegenen Fahrgast weiter anwählbar zu halten.

Der eigene Kontrollbereich zeigt ausschließlich die nativ öffentlich projizierten
Fälle dieser Fahrt: Bearbeitungsstand, reguläre oder vorläufige Forderung,
bestätigte Zahlung, Kosten, Abschreibung und Nachweisfrist. Ein Polizeihalt zeigt
Anforderung, aktiven Halt oder Freigabe und den bekannten Ausgang. Beträge werden
aus ganzzahligen Centzeichenketten formatiert. Weder Modellparameter noch eine
vermutete Identität oder verborgene Fahrscheinfakten erscheinen im Browser.
Der Tagesbericht zeigt die nativ bestätigte SPNV-Vertragsbasis, Nettoergebnis,
Prämie, Deckelausgleich und verbleibenden Beitrag des eigenen EVU. Er ist über
die eigene Zugansicht und im Kontrollbereich auch ohne aktive Schaffnersitzung
abrufbar. Nach Fahrtende aktualisiert ein ausdrücklicher Abruf die späteren
Nachweise, Zahlungen und Tagesabschlüsse; der Browser berechnet keine Buchung.
Kontroll- und Szenenaktualisierungen tragen dieselbe Sitzungs-/Sequenzbindung
wie der zugehörige native Snapshot.

„Zu meiner Position“ synchronisiert auch die Fahrzeug-/Deckauswahl. Ein nativ
bestätigter Wagen- oder Deckwechsel führt die Ansicht zur tatsächlichen Figur.
Ein bestätigter Sitzungsabschluss stoppt den privaten Strom und lokale Wege;
das reguläre Stromende erscheint nicht als Verbindungsfehler.
Eine bezahlte vorläufige Forderung zeigt ihre Nachweisfrist weiterhin an.
Aktualisierungen erhalten den Tastaturfokus auf derselben Fallzusammenfassung.
Transportabbrüche werden auf Deutsch erklärt und behalten die unveränderte
Kennung eines noch nicht bestätigten Befehls.
Tab und Umschalt+Tab bleiben auch an beiden Grenzen des Bestätigungs- und
Berichtdialogs innerhalb des jeweiligen Dialogs. Die aktive Äußerung steht
als einzelne Sprechblase im festen Kontrollbereich und verdeckt keine
Fahrgäste oder Antwortschaltflächen.

Der Evidenzpacker bindet die sieben erfolgreichen Browserberichte, den
separaten Originaldialog-HTTP-Beleg und jede
referenzierte PNG-Datei mit SHA-256 an den angegebenen Quellstand und optional
an den CI-Lauf. Fehlende Berichte, Browserfehler, fremde Pfade oder geänderte
Bildbytes verhindern das Paket. Das Paket bezeichnet diese fiktiven Korpora
ausdrücklich als Testnachweis; es ersetzt keine produktive Release-Signatur
und entscheidet nicht über die Abnahme der gesamten Spielwelt.

Ein ausdrücklich wegen veralteter Sitzungsrevision abgewiesener Gehschritt
darf höchstens zweimal mit aktuellem Snapshot erneut gesendet werden. Dabei
müssen Sitzung, Layout und Ausgangsposition unverändert sein; nur das bereits
beauftragte Ziel bleibt erhalten. Fachliche Bewegungsablehnungen und unklare
Netzwerkergebnisse erhalten keine neue Idempotenzkennung. Letztere wiederholen
weiterhin ausschließlich den ursprünglichen Befehl.

Weg-, Atlasmanifest- und Bildabrufe synchronisieren den privaten Sitzungsstand
unter derselben Weltsperre mit den aktuellen M10-/Betriebsbelegen. Ihr Erfolg
hängt dadurch nicht von einem vorherigen Snapshot oder dem nächsten SSE-Poll
ab. Die native Bindungs-, Eigentümer- und Layoutprüfung bleibt wirksam.
