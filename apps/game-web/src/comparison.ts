export interface ComparisonAlternative {
  readonly id: string;
  readonly label: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Getrennte Dimensionen ohne Gesamtscore (E11), in allen Journey-Oberflächen wiederverwendbar. */
export function renderComparisonWorkbench(
  title: string,
  dimensionLabels: Readonly<Record<string, string>>,
  alternatives: readonly ComparisonAlternative[],
): string {
  if (alternatives.length < 2) return "";
  const dimensions = Object.keys(dimensionLabels).filter((key) => alternatives.some((alternative) => alternative.dimensions[key] !== undefined));
  return `<section class="comparison-workbench" aria-label="${escapeHtml(title)}"><div><p class="eyebrow">Vergleich ohne Gesamtscore</p><h3>${escapeHtml(title)}</h3></div><p class="comparison-help">Alle Dimensionen bleiben getrennt. Auf kleinen Bildschirmen lässt sich die Tabelle mit den Pfeiltasten horizontal bewegen.</p><div class="comparison-scroll" role="region" aria-label="${escapeHtml(title)} als horizontal verschiebbare Tabelle" tabindex="0"><table><caption>${escapeHtml(title)} · kein Gesamtscore</caption><thead><tr><th scope="col">Dimension</th>${alternatives.map((alternative) => `<th scope="col">${escapeHtml(alternative.label)}</th>`).join("")}</tr></thead><tbody>${dimensions.map((dimension) => `<tr><th scope="row">${escapeHtml(dimensionLabels[dimension])}</th>${alternatives.map((alternative) => `<td>${escapeHtml(alternative.dimensions[dimension] ?? "–")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}
