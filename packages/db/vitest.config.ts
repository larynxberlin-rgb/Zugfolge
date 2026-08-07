import { configDefaults, defineConfig } from "vitest/config";

/**
 * Ohne diesen Ausschluss liest Vitest nach `pnpm build` sowohl
 * `src/*.test.ts` als auch die kompilierten `dist/*.test.js` — CI baut vor
 * dem Testlauf, jeder Test liefe sonst doppelt.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
    // PGlite startet eine eingebettete Postgres-Instanz aus WASM — unter
    // CI-Last, parallel zu anderen Paketen, braucht das spürbar länger als
    // die vitest-Vorgabe von 10 s.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
