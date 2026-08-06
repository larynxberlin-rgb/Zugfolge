/**
 * Die Wächterkonfiguration darf nicht verrotten.
 *
 * Der eigentliche Schwachpunkt einer pfadbasierten Regel: Sie prüft ein
 * Verzeichnis, das noch nicht existiert, meldet nichts und sieht dabei grün
 * aus. Diese Regel dreht das um.
 *
 * - Eine Domäne mit Status `active` **muss** Dateien treffen. Trifft sie
 *   keine, wurde etwas verschoben oder umbenannt.
 * - Eine Domäne mit Status `planned` **darf** keine treffen. Sobald sie es
 *   tut, ist der Code da und der Status gehört umgestellt — und damit greifen
 *   die Regeln dieser Domäne ab dem ersten Commit.
 * - Jede Domäne muss in `docs/monorepo.md` beschrieben sein.
 */

import { matchesAny } from "../glob.js";
import type { Finding, GuardConfig, Rule, SourceFile } from "../types.js";

/** Pfad der Monorepo-Beschreibung, relativ zur Wurzel. */
export const MONOREPOPFAD = "docs/monorepo.md";

/** Baut die Regel mit der Liste aller bekannten Regelkennungen. */
export function createCoverageRule(knownRuleIds: readonly string[]): Rule {
  const bekannt = new Set(knownRuleIds);

  return {
    id: "coverage",
    title: "Wächterkonfiguration deckt den Arbeitsbaum ab",
    scope: "repository",
    check(files: readonly SourceFile[], config: GuardConfig): Finding[] {
      const befunde: Finding[] = [];
      const konfigpfad = "tools/guards/guards.config.json";
      const monorepo = files.find((datei) => datei.path === MONOREPOPFAD);

      const melde = (message: string): void => {
        befunde.push({ rule: "coverage", path: konfigpfad, line: 0, message });
      };

      if (monorepo === undefined) {
        melde(`${MONOREPOPFAD} fehlt — die Domänengrenzen sind nirgends beschrieben.`);
      }

      for (const domain of config.domains) {
        const treffer = files.filter((datei) => matchesAny(datei.path, domain.paths));

        if (domain.status === "active" && treffer.length === 0) {
          melde(
            `Domäne '${domain.id}' ist aktiv, ihre Pfade treffen aber keine Datei ` +
              `(${domain.paths.join(", ")}). Wurde etwas verschoben?`,
          );
        }

        if (domain.status === "planned" && treffer.length > 0) {
          melde(
            `Domäne '${domain.id}' ist als geplant geführt, enthält aber schon Code ` +
              `(zum Beispiel ${treffer[0]?.path ?? "?"}). Status auf 'active' setzen, ` +
              "damit ihre Regeln greifen.",
          );
        }

        for (const regel of domain.rules) {
          if (!bekannt.has(regel)) {
            melde(`Domäne '${domain.id}' verweist auf die unbekannte Regel '${regel}'.`);
          }
        }

        if (monorepo !== undefined && !monorepo.text.includes(domain.id)) {
          melde(`Domäne '${domain.id}' ist in ${MONOREPOPFAD} nicht beschrieben.`);
        }
      }

      return befunde;
    },
  };
}
