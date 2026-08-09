/**
 * Vertrag der Health-Check-Registry: jedes Paket meldet seinen Zustand über
 * dieselbe kleine Schnittstelle, unabhängig davon, was es im Einzelnen prüft
 * (Datenbankverbindung, externer Dienst, interner Zustand). Neue Prüfungen
 * kommen dazu, ohne diesen Vertrag zu ändern — das ist der Punkt.
 */

/** `degraded` ist erreichbar, aber eingeschränkt — kein Ausfall, aber ein Hinweis. */
export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthCheckOutcome {
  readonly status: HealthStatus;
  /** Ausschließlich bereits sanitisiertes, öffentlich freigegebenes Detail. */
  readonly detail?: string;
  /** Stabiler, nicht sensitiver Maschinen-Code für Alarmierung und Runbooks. */
  readonly code?: string;
}

/** Eine einzelne, benannte Prüfung. Wirft sie, zählt das als `down`. */
export interface HealthCheck {
  readonly name: string;
  check(signal?: AbortSignal): Promise<HealthCheckOutcome>;
}

export interface HealthCheckResult extends HealthCheckOutcome {
  readonly name: string;
  readonly durationMs: number;
}

export interface HealthReport {
  /** Der ungünstigste Status aller Prüfungen; `ok` bei einer leeren Liste. */
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheckResult[];
}

export interface HealthCheckRunOptions {
  /** Hartes Gesamtbudget je parallel laufender Prüfung. */
  readonly timeoutMs?: number;
  /** Interne Fehlerablage; die Ursache erscheint niemals im öffentlichen Bericht. */
  readonly onError?: (checkName: string, error: unknown) => void;
}
