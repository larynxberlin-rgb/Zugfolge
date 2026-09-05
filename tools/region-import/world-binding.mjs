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
