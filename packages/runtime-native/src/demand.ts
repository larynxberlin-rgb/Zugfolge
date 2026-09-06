import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

/** Versionierte JSON-Grenze; Fachvalidierung und Rechnung erfolgen ausschließlich in Rust. */
export interface DemandRuntime {
  evaluate(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export function demandRuntimeFromAddon(addon: { evaluatePassengerDemand(input: string): string }): DemandRuntime {
  return Object.freeze({
    evaluate(input: Readonly<Record<string, unknown>>) {
      const result: unknown = JSON.parse(addon.evaluatePassengerDemand(JSON.stringify(input)));
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError("Nachfragekern liefert kein Ergebnisobjekt.");
      }
      const output = result as Record<string, unknown>;
      if (output["worldId"] !== input["worldId"] || output["periodId"] !== input["periodId"]
        || output["revision"] !== input["revision"]
        || typeof output["stateHash"] !== "string" || !/^[a-f0-9]{64}$/.test(output["stateHash"])) {
        throw new TypeError("Nachfragekern verletzt Welt-, Perioden-, Revisions- oder Hashbindung.");
      }
      return output;
    },
  });
}

/** Derselbe gebaute Runtime-Addon; ohne Export wird die Aktivierung abgebrochen. */
export function loadDemandRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): DemandRuntime {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new TypeError("Absoluter Runtime-Addonpfad fehlt.");
  const addon: unknown = createRequire(import.meta.url)(addonPath);
  if (addon === null || typeof addon !== "object"
    || !("evaluatePassengerDemand" in addon) || typeof addon.evaluatePassengerDemand !== "function") {
    throw new TypeError("Runtime-Addon exportiert evaluatePassengerDemand nicht.");
  }
  return demandRuntimeFromAddon(addon as { evaluatePassengerDemand(input: string): string });
}
