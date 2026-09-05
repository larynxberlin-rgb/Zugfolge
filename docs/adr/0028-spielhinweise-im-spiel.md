# E28 — Spielhinweise direkt im laufenden Spiel

Dieses ADR entspricht E28.

Status: angenommen am 2026-09-05 auf ausdrückliche Entscheidung des Projektverantwortlichen.

## Entscheidung

Die Einführung wird vollständig neu als reine Tooltipps im eigentlichen Spiel
aufgebaut. Der bisherige Aufbau samt Code, Texten, Figuren, Szenarien, Sitzungen
und eigenen Welten wird entfernt. Es wird nichts davon für die neue Einführung
übernommen. Der vollständige Verhaltensvertrag steht in [Spielhinweise](../spielhinweise.md).

## Konsequenzen

Spieler entscheiden in ihrer regulären Welt. Hinweise erklären vorhandene
Bedienelemente, ohne Spielhandlungen oder Verwaltungsprozesse auszulösen.
Lesestand und Abschalten sind lokale Browserpräferenzen. Der signierte
Weltvertrag bestimmt weiterhin Startkapital und Markteintritt. Jede Gründung
wendet dessen `StartingCapitalPolicy` atomar und idempotent an.

Jeder Server betreibt genau eine Welt (E32). Odoo verwaltet die Zuordnung der
verschiedenen Weltserver. Die Hinweise benötigen keine Odoo-Verwaltung.

Die Datenbankmigration 0035 entfernt vorhandene alte Lernwelten und die drei
zugehörigen Tabellen einschließlich ihrer abhängigen Daten. Historische
Migrationsdateien bleiben zum Upgrade lesbar; sie werden nicht in neue
Laufzeitfunktionalität übernommen. Reguläre Weltgeschichte bleibt geschützt.
