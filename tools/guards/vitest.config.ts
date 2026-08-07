import { configDefaults, defineConfig } from "vitest/config";

/**
 * Ohne diesen Ausschluss liest Vitest nach `pnpm build` sowohl
 * `src/*.test.ts` als auch die kompilierten `dist/*.test.js` — CI baut vor
 * dem Testlauf, jeder Test liefe sonst doppelt.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
