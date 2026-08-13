export interface PrimarySurfaceInput {
  readonly requestedView: string | null;
  readonly demoMode: boolean;
  readonly livemapUrl: string;
  readonly worldId: string;
  readonly pageUrl: string;
}

export interface WorldContext {
  readonly worldId: string;
  readonly publicWorldId: string;
}

export interface CooperationPageViews {
  readonly contractPageView: "actionable" | "archive";
  readonly listingPageView: "actionable" | "archive";
}

/**
 * Archiv-Deep-Links duerfen nicht erst nach dem ersten Rendern auf die
 * abgeschlossene Sicht umschalten: der erste autoritative Abruf muss bereits
 * den verlinkten Bestand laden.
 */
export function cooperationPageViews(parameters: URLSearchParams): CooperationPageViews {
  return Object.freeze({
    contractPageView: parameters.get("contractView") === "archive" ? "archive" : "actionable",
    listingPageView: parameters.get("listingView") === "archive" ? "archive" : "actionable",
  });
}

function cooperationTargetId(hash: string): string | undefined {
  if (hash.length < 2) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return undefined;
  }
  return id.startsWith("contract-") || id.startsWith("listing-") ? id : undefined;
}

/** Fokusiert einen nach dem Datenabruf gerenderten Vertrags- oder Marktbeleg. */
export function focusCooperationDeepLink(
  root: ParentNode,
  hash: string,
  reducedMotion: boolean,
): boolean {
  const id = cooperationTargetId(hash);
  if (id === undefined) return false;
  const target = [...root.querySelectorAll<HTMLElement>("[id]")].find((candidate) => candidate.id === id);
  if (target === undefined) return false;
  target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  target.focus({ preventScroll: true });
  return true;
}

/**
 * Eine normale Spielerreise bleibt immer in der mit `world` verlinkten Welt.
 * Nur ein expliziter Tutorial-Reentry besitzt zusätzlich eine getrennte
 * öffentliche Welt. So kann ein Runtime-Default keine fremde Welt unterschieben.
 */
export function resolveWorldContext(
  parameters: URLSearchParams,
  runtimeDefaultWorldId: string,
): WorldContext {
  const worldId = parameters.get("world") ?? runtimeDefaultWorldId;
  const tutorialReference = parameters.get("tutorial");
  const publicWorldId = tutorialReference === null
    ? worldId
    : (parameters.get("publicWorld") ?? runtimeDefaultWorldId);
  return Object.freeze({ worldId, publicWorldId });
}

/**
 * Die Karte ist die primäre Spieloberfläche. Nur ausdrücklich angeforderte
 * Nebenansichten bleiben in game-web; ein fehlender Kartenendpunkt fällt
 * fail-closed auf die Spielerreise zurück.
 */
export function primaryMapDestination(input: PrimarySurfaceInput): string | undefined {
  if (input.demoMode || input.requestedView !== null || input.livemapUrl.trim() === "") return undefined;
  const destination = new URL(input.livemapUrl, input.pageUrl);
  if (input.worldId !== "") destination.searchParams.set("world", input.worldId);
  return destination.href;
}
