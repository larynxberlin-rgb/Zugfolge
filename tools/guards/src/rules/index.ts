/** Das Verzeichnis aller Wächterregeln. */

import { brandRule } from "./brand.js";
import { createCoverageRule } from "./coverage.js";
import { glossaryRule } from "./glossary.js";
import { layerSeparationRule } from "./layer-separation.js";
import { PATTERN_RULES } from "./pattern-rules.js";
import { rightsGateRule } from "./rights-gate.js";
import { worldIdRule } from "./world-id.js";
import type { Rule } from "../types.js";

const BASISREGELN: readonly Rule[] = [
  ...PATTERN_RULES,
  worldIdRule,
  glossaryRule,
  brandRule,
  rightsGateRule,
  layerSeparationRule,
];

/**
 * Alle Regeln.
 *
 * `coverage` kennt die Kennungen aller anderen Regeln und meldet deshalb auch
 * einen Tippfehler in `guards.config.json` — sonst liefe eine Domäne still
 * ohne Prüfung.
 */
export const ALL_RULES: readonly Rule[] = [
  ...BASISREGELN,
  createCoverageRule([...BASISREGELN.map((regel) => regel.id), "coverage"]),
];
