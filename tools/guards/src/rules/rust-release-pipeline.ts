/** ADR-0005: Autoritative InfraRelease-Builder liegen ausschließlich in Rust. */

import type { Finding, Rule, SourceFile } from "../types.js";

const AUTORITATIVE_BUILDER = /\b(?:buildPublicInfraRelease|buildAnnualPlan|createQualifiedReleaseManifest|build_public_infra_release|build_annual_infra_plan|build_qualified_reference_release)\b|schema\s*:\s*["']zugfolge-(?:infra-release|annual-infra-plan)\/v\d+["']|["']zugfolge-qualified-infra-release-manifest\/v\d+["']/g;
const REPORT_ONLY_QUALIFICATION = /qualifiedReleaseFromRust\s*\(\s*\{\s*(?:report|candidateManifest)\s*:/g;
const JAVASCRIPT_V3_COMPARISON = /\bcompareWithModel\s*\(/g;
const JAVASCRIPT_CHAIN_AUTHORITY = /\b(?:verifyQualificationEvidenceFiles|expectedModelBindings)\s*\(/g;
const JAVASCRIPT_OR_TYPESCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function isAllowed(path: string): boolean {
  return path.startsWith("crates/zugfolge-infra/")
    || path.endsWith(".test.mjs")
    || path.endsWith(".test.ts")
    || path.endsWith(".fixture.mjs")
    || path.endsWith(".fixture.ts");
}

function isExplicitLegacyPreview(path: string): boolean {
  return path === "tools/reference-corpus/legacy-preview.mjs"
    || path === "tools/reference-corpus/reference-corpus.mjs";
}

/** Verhindert eine zweite autoritative Manifest-, Plan- oder Qualifikationsbildung in JS/TS. */
export const rustReleasePipelineRule: Rule = {
  id: "rust-release-pipeline",
  title: "Autoritative InfraRelease-Bildung bleibt in Rust",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const findings: Finding[] = [];
    for (const file of files) {
      if (isAllowed(file.path) || !JAVASCRIPT_OR_TYPESCRIPT.test(file.path)) continue;
      AUTORITATIVE_BUILDER.lastIndex = 0;
      for (const match of file.text.matchAll(AUTORITATIVE_BUILDER)) {
        findings.push({
          rule: "rust-release-pipeline",
          path: file.path,
          line: file.text.slice(0, match.index).split("\n").length,
          message:
            "Autoritative InfraRelease-/Jahresplan-/Qualifikationsbildung außerhalb Rust (ADR-0005/E5). " +
            "JavaScript darf nur Dateien lesen/schreiben und den Rust-Compiler aufrufen.",
        });
      }
      REPORT_ONLY_QUALIFICATION.lastIndex = 0;
      for (const match of file.text.matchAll(REPORT_ONLY_QUALIFICATION)) {
        findings.push({
          rule: "rust-release-pipeline",
          path: file.path,
          line: file.text.slice(0, match.index).split("\n").length,
          message:
            "Vertrauensbasierte Referenzrelease-Qualifikation ohne vollständige Artefaktbytes (ADR-0005/E5). " +
            "Rust muss Capture, Korpus, Nachweise, Modell, Report und Kandidat selbst hashen und prüfen.",
        });
      }
      if (!isExplicitLegacyPreview(file.path) && !file.path.includes("/fixtures/")) {
        JAVASCRIPT_V3_COMPARISON.lastIndex = 0;
        for (const match of file.text.matchAll(JAVASCRIPT_V3_COMPARISON)) {
          findings.push({
            rule: "rust-release-pipeline",
            path: file.path,
            line: file.text.slice(0, match.index).split("\n").length,
            message:
              "Produktive Referenzreport-Bildung außerhalb Rust (ADR-0005/E5). " +
              "JavaScript darf nur den expliziten Legacy-v2-Vorschauadapter enthalten.",
          });
        }
      }
      JAVASCRIPT_CHAIN_AUTHORITY.lastIndex = 0;
      for (const match of file.text.matchAll(JAVASCRIPT_CHAIN_AUTHORITY)) {
        const line = file.text.slice(file.text.lastIndexOf("\n", match.index) + 1, file.text.indexOf("\n", match.index));
        const isDefinition = /(?:export\s+)?(?:async\s+)?function\s+(?:verifyQualificationEvidenceFiles|expectedModelBindings)/.test(line);
        const isFixture = file.path.includes("/fixtures/");
        if (isDefinition || isFixture) continue;
        findings.push({
          rule: "rust-release-pipeline",
          path: file.path,
          line: file.text.slice(0, match.index).split("\n").length,
          message:
            "Produktive Artefaktketten-Qualifikation außerhalb Rust (ADR-0005/E5). " +
            "JavaScript darf Qualifikationsnachweise nur als Testfixture prüfen.",
        });
      }
    }
    return findings;
  },
};
