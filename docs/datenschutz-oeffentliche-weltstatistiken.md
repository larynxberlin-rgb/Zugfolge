# Datenschutz: öffentliche Weltstatistiken

Öffentlich verarbeitet werden nur aggregierte Weltwerte: Weltname/-beschreibung, Phase, Zeiten, Startkapitalregel, EVU-Gesamtzahl, optional nach freigegebener Policy die Zahl stark aktiver EVU, Kapazität, Region, Regel-/Datenreleases und Banner-Rechteangaben.

Nicht öffentlich sind Spielernamen, Keycloak-Subjects, Odoo-Partner-, Bestell- oder Zahlungsreferenzen, Game-Konto- und EVU-IDs, einzelne Handlungen, Login-/Onlinezustände, individuelle Aktivitätsverläufe sowie Support- oder Rechnungsdaten. Der TypeScript-Vertrag und das Odoo-Ingest prüfen verbotene Schlüssel rekursiv. Website-QWeb und der Refresh-Endpunkt liefern ausschließlich den Odoo-Projektionscache.

Der Refresh-Endpunkt bildet für das Rate-Limit nur einen pro Prozess gesalzenen SHA-256-Schlüssel aus der Remote-Adresse; die Adresse und der Schlüssel werden weder in einem Modell persistiert noch geloggt. Buckets verfallen nach 60 Sekunden. Reguläre Reverse-Proxy-/Odoo-Accesslogs sind nach dem getrennten Betriebs-Löschkonzept zu konfigurieren.

„Stark aktiv“ ist kein Online-Tracking. Die Berechnung nutzt ausschließlich autoritative, weltgebundene Spielereignisse in einem rollierenden Weltzeitfenster. Bots, System-EVU, ausgeschiedene und gelöschte EVU sind ausgeschlossen. Ohne ausdrücklich freigegebene `ActivityPolicy` wird keine Zahl veröffentlicht.

Bannerdateien sind verwaltete Odoo-Attachments. Produktive Veröffentlichung erfordert Alt-Text, Quelle, Urheber, Lizenz und ausdrückliche Rechtefreigabe; sonst erscheint das lokale, personenbezugsfreie Fallbackbild.
