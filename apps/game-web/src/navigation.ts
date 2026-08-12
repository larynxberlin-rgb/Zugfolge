export interface PrimarySurfaceInput {
  readonly requestedView: string | null;
  readonly demoMode: boolean;
  readonly livemapUrl: string;
  readonly worldId: string;
  readonly pageUrl: string;
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
