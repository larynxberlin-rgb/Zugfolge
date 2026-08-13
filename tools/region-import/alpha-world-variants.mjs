/**
 * Klont ein Deployment und ersetzt ausschliesslich explizite worldId-Felder.
 * Fremde Weltbindungen werden fail-closed abgewiesen, damit eine
 * Tutorialvariante nicht nur am Top-Level umetikettiert werden kann.
 */
export function rebindWorldIds(value, sourceWorldId, targetWorldId, path = "deployment") {
  if (Array.isArray(value)) {
    return value.map((entry, index) => rebindWorldIds(entry, sourceWorldId, targetWorldId, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return value;

  const rebound = {};
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key === "worldId") {
      if (entry !== sourceWorldId) {
        throw new Error(`${entryPath} ist an eine unerwartete Welt gebunden.`);
      }
      rebound[key] = targetWorldId;
      continue;
    }
    rebound[key] = rebindWorldIds(entry, sourceWorldId, targetWorldId, entryPath);
  }
  return rebound;
}

export function assertEmbeddedWorldIds(value, expectedWorldId, path = "deployment") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertEmbeddedWorldIds(entry, expectedWorldId, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key === "worldId" && entry !== expectedWorldId) {
      throw new Error(`${entryPath} verletzt die Weltbindung ${expectedWorldId}.`);
    }
    assertEmbeddedWorldIds(entry, expectedWorldId, entryPath);
  }
}

export function assertNoStarterIdentifiers(value, path = "deployment") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoStarterIdentifiers(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "startPackage" || key === "startPackageSlots") {
        throw new Error(`${path}.${key} enthaelt einen Tutorial-Startpaketvertrag.`);
      }
      assertNoStarterIdentifiers(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (value.startsWith("starter-") || value === "00000000-0000-4000-8000-000000000101")) {
    throw new Error(`${path} enthaelt die reservierte Tutorialkennung '${value}'.`);
  }
}
