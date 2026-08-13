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
 * - Jedes produktive Crate, Paket und jede App braucht eine ausdrückliche
 *   Domänenzuordnung. Ein neues Verzeichnis darf nicht unbemerkt außerhalb
 *   aller pfadgebundenen Wächter entstehen.
 * - Jede produktive Source-Datei trifft exakt eine aktive Domäne. Eine Lücke
 *   braucht eine enge, begründete `coverageExceptions`-Ausnahme; Überlappungen
 *   sind nie zulässig.
 */

import { matchesAny } from "../glob.js";
import type { Finding, GuardConfig, Rule, SourceFile } from "../types.js";

/** Pfad der Monorepo-Beschreibung, relativ zur Wurzel. */
export const MONOREPOPFAD = "docs/monorepo.md";

const PRODUKTIVE_SOURCE = /^(?:(?:crates\/[^/]+\/(?:src|tests|benches)\/.*\.rs|crates\/[^/]+\/build\.rs)|(?:packages|apps)\/[^/]+\/src\/.*\.(?:ts|tsx|js|jsx|mjs|cjs)|tools\/.*\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|sh|ps1)|spikes\/.*\.(?:rs|ts|tsx|js|mjs))$/;

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
        for (const path of domain.paths) {
          if (["crates/**", "packages/**", "apps/**", "tools/**"].includes(path)) {
            melde(
              `Domäne '${domain.id}' verwendet den zu breiten Pfad '${path}'. ` +
                "Produktionspakete müssen einzeln zugeordnet werden.",
            );
          }
        }
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

      const produktionsmanifeste = files.filter((datei) =>
        /^(?:crates\/[^/]+\/Cargo\.toml|(?:packages|apps|tools)\/[^/]+\/package\.json|tools\/[^/]+\/Cargo\.toml)$/.test(
          datei.path,
        ),
      );
      for (const manifest of produktionsmanifeste) {
        const zugeordnet = config.domains.filter(
          (domain) => domain.status === "active" && matchesAny(manifest.path, domain.paths),
        );
        if (zugeordnet.length !== 1) {
          const wurzel = manifest.path.slice(0, manifest.path.lastIndexOf("/"));
          melde(zugeordnet.length === 0
            ? `Produktionsdomäne '${wurzel}' ist keinem Wächterbereich mit Status 'active' zugeordnet. Den Pfad ausdrücklich in guards.config.json aufnehmen; Catch-all-Globs sind unzulässig.`
            : `Produktionsdomäne '${wurzel}' überlappt die aktiven Wächterbereiche ${zugeordnet.map((domain) => `'${domain.id}'`).join(", ")}.`);
        }
      }

      const produktiveSources = files.filter((datei) => PRODUKTIVE_SOURCE.test(datei.path));
      const verwendeteAusnahmen = new Set<number>();
      for (const datei of produktiveSources) {
        const domains = config.domains.filter(
          (domain) => domain.status === "active" && matchesAny(datei.path, domain.paths),
        );
        const ausnahmen = config.coverageExceptions
          .map((ausnahme, index) => ({ ausnahme, index }))
          .filter(({ ausnahme }) => matchesAny(datei.path, [ausnahme.path]));

        if (domains.length > 1) {
          melde(
            `Produktive Source-Datei '${datei.path}' überlappt aktive Domänen: ` +
              domains.map((domain) => `'${domain.id}'`).join(", ") + ".",
          );
          continue;
        }
        if (domains.length === 1) {
          if (ausnahmen.length > 0) {
            melde(`Coverage-Ausnahme fuer '${datei.path}' ist veraltet: Die Datei gehört bereits zu '${domains[0]?.id}'.`);
          }
          continue;
        }
        if (ausnahmen.length === 1) {
          verwendeteAusnahmen.add(ausnahmen[0]?.index ?? -1);
          continue;
        }
        melde(
          ausnahmen.length === 0
            ? `Produktive Source-Datei '${datei.path}' hat keine aktive Domäne und keine begründete Coverage-Ausnahme.`
            : `Produktive Source-Datei '${datei.path}' trifft mehrere Coverage-Ausnahmen; genau eine ist zulässig.`,
        );
      }

      config.coverageExceptions.forEach((ausnahme, index) => {
        if (!verwendeteAusnahmen.has(index) && !produktiveSources.some((datei) => matchesAny(datei.path, [ausnahme.path]))) {
          melde(`Coverage-Ausnahme '${ausnahme.path}' trifft keine produktive Source-Datei und ist damit nicht prüfbar.`);
        }
      });

      return befunde;
    },
  };
}
