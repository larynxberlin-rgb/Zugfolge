/** Hält die kanonische Entscheidungsliste, Agentenhinweise und ADRs synchron. */

import type { Finding, Rule, SourceFile } from "../types.js";

const QUELLE = "docs/entscheidungen.md";
const AGENTEN = "AGENTS.md";
const ADR_INDEX = "docs/adr/README.md";
const CLAUDE = "CLAUDE.md";

function entscheidungen(text: string): number[] {
  return [...text.matchAll(/^\| E(\d+) \|/gm)].map((match) => Number(match[1]));
}

function adrIndex(text: string): number[] {
  return [...text.matchAll(/^\| \[(\d{4})\]\([^)]+\) \| E(\d+) \|/gm)].map(
    (match) => Number(match[2]),
  );
}

function gleich(links: readonly number[], rechts: readonly number[]): boolean {
  return JSON.stringify(links) === JSON.stringify(rechts);
}

function lueckenlos(values: readonly number[]): boolean {
  return values.every((value, index) => value === index + 1);
}

function finde(files: readonly SourceFile[], path: string): SourceFile | undefined {
  return files.find((file) => file.path === path);
}

/** E1–En müssen an allen Einstiegspunkten dieselbe lückenlose Menge bilden. */
export const decisionConsistencyRule: Rule = {
  id: "decision-consistency",
  title: "Grundsatzentscheidungen und ADR-Index sind konsistent",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const findings: Finding[] = [];
    const report = (path: string, message: string): void => {
      findings.push({ rule: "decision-consistency", path, line: 0, message });
    };

    const source = finde(files, QUELLE);
    if (source === undefined) {
      report(QUELLE, "Die maßgebliche Entscheidungsliste fehlt.");
      return findings;
    }

    const canonical = entscheidungen(source.text);
    if (canonical.length === 0 || !lueckenlos(canonical)) {
      report(QUELLE, "Die Entscheidungsliste muss lückenlos mit E1 beginnen.");
      return findings;
    }
    const highest = canonical.at(-1) ?? 0;

    const agents = finde(files, AGENTEN);
    if (agents === undefined) {
      report(AGENTEN, "Die kanonische Agenten-Anleitung fehlt.");
    } else {
      if (!gleich(entscheidungen(agents.text), canonical)) {
        report(AGENTEN, `${AGENTEN} muss dieselben Entscheidungen E1–E${highest} wie ${QUELLE} führen.`);
      }
      if (!agents.text.includes(`E1–E${highest}`)) {
        report(AGENTEN, `Dokumentkarte und Stand müssen den aktuellen Umfang E1–E${highest} nennen.`);
      }
    }

    const index = finde(files, ADR_INDEX);
    if (index === undefined) {
      report(ADR_INDEX, "Der ADR-Index fehlt.");
    } else {
      if (!gleich(adrIndex(index.text), canonical)) {
        report(ADR_INDEX, `Der ADR-Index muss genau E1–E${highest} enthalten.`);
      }
      if (!index.text.includes(`E1–E${highest}`)) {
        report(ADR_INDEX, `Die Quellenbeschreibung muss den aktuellen Umfang E1–E${highest} nennen.`);
      }
    }

    for (const number of canonical) {
      const prefix = `docs/adr/${String(number).padStart(4, "0")}-`;
      const records = files.filter(
        (file) => file.path.startsWith(prefix) && file.path.endsWith(".md"),
      );
      if (records.length !== 1) {
        report(ADR_INDEX, `E${number} braucht genau ein ADR mit Präfix ${prefix}.`);
        continue;
      }
      if (!records[0]?.text.includes(`entspricht E${number}`)) {
        report(records[0]?.path ?? ADR_INDEX, `ADR-${String(number).padStart(4, "0")} muss sich als E${number} ausweisen.`);
      }
    }

    const claude = finde(files, CLAUDE);
    if (claude === undefined) {
      report(CLAUDE, "Der Claude-Einstiegshinweis fehlt.");
    } else {
      if (!claude.text.includes("AGENTS.md")) {
        report(CLAUDE, "Claude muss auf die kanonische AGENTS.md verweisen.");
      }
      if (/^\| E\d+ \|/m.test(claude.text)) {
        report(CLAUDE, "CLAUDE.md darf keine zweite, driftanfällige Entscheidungstabelle führen.");
      }
    }

    return findings;
  },
};
