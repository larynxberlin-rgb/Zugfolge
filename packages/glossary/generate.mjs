import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../../docs/glossar.md", import.meta.url));
const outputPath = fileURLToPath(new URL("./src/generated.ts", import.meta.url));
const source = await readFile(sourcePath, "utf8");
const entries = source.split(/\r?\n/).flatMap((line) => {
  if (!line.startsWith("| ") || line.startsWith("| Begriff") || /^\|[-: ]+\|/.test(line)) return [];
  const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
  if (cells.length < 4) throw new Error(`Glossarzeile ist nicht vierteilig: ${line}`);
  const [term, rawCode, definition] = cells;
  const code = rawCode?.replace(/^`|`$/g, "") ?? "";
  if (term === undefined || definition === undefined || code === "" || code === "—") return [];
  return [{ term, code, definition: definition.replaceAll("`", "") }];
});
const duplicates = entries.filter((entry, index) => entries.findIndex((candidate) => candidate.code === entry.code) !== index);
if (duplicates.length > 0) throw new Error(`Doppelte Glossarbezeichner: ${duplicates.map((entry) => entry.code).join(", ")}`);
const generated = `// Mit packages/glossary/generate.mjs aus docs/glossar.md erzeugt. Nicht von Hand ändern.\nexport const GENERATED_GLOSSARY_ENTRIES = Object.freeze(${JSON.stringify(entries, null, 2)});\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) throw new Error("Glossarprojektion ist veraltet. Führen Sie pnpm --filter @zugfolge/glossary generate aus.");
} else {
  await writeFile(outputPath, generated, "utf8");
}
