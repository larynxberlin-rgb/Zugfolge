export class ArtAtlasError extends Error {
  constructor(readonly code: string) {
    super(`Grafikatlas abgelehnt: ${code}`);
    this.name = "ArtAtlasError";
  }
}

export function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ArtAtlasError(code);
}
