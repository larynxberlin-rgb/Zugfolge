import { fileURLToPath } from "node:url";

/** Ort der SQL-Migrationen dieses Schemas — von `src/` und `dist/` gleichermaßen aus erreichbar. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
