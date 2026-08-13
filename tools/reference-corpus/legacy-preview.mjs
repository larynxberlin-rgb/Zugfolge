// Nichtautoritative v2-Vorschau. Dieser Adapter darf weder ein v3-Release
// qualifizieren noch ohne den expliziten lokalen Preview-Schalter laufen.
import { compareWithModel } from "./reference-corpus.mjs";

export function buildLegacyPreviewReport(corpus, modelResults, tolerance) {
  if (process.env.ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD !== "1") {
    throw new Error("Legacy-Vergleich ist ausschließlich als nichtautoritative Vorschau erlaubt.");
  }
  if (corpus?.schema !== "zugfolge-reference-corpus/v2" || modelResults?.schema !== "zugfolge-model-results/v2") {
    throw new Error("Die JavaScript-Vorschau akzeptiert ausschließlich Legacy-v2; v3 wird autoritativ in Rust verglichen.");
  }
  return compareWithModel(corpus, modelResults, tolerance);
}
