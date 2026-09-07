import { bindRailwayTabs, mountGameHints } from "../../packages/design-system/src/index.js";
import "../../packages/design-system/src/styles.css";
import { mountGlossaryLayer } from "../../packages/glossary/src/index.js";
import "../../packages/glossary/src/styles.css";
import { captureWorkspaceView } from "../../apps/game-web/src/workspace-view.js";
import { playerContext, worldId, operatorId, cooperation, worldContract, mailbox, operationsState, previewVehicleRegistryHistory } from "./fixtures.mjs";

const root = document.querySelector<HTMLDivElement>("#root")!;
const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "company";
if (["operations", "program", "reports"].includes(screen)) {
  const { renderApp } = await import("../../apps/operations-center/src/view.js");
  await import("../../apps/operations-center/src/styles.css");
  await import("../../packages/design-system/src/railway.css");
  await import("../../apps/operations-center/src/railway-operations.css");
  root.innerHTML = renderApp({ ...operationsState, activePanel: screen } as never);
  const { OPERATIONS_HINTS } = await import("../../apps/operations-center/src/game-hints.js");
  mountGameHints(root, OPERATIONS_HINTS);
} else {
  await import("../../apps/game-web/src/styles.css");
  await import("../../packages/design-system/src/railway.css");
  await import("../../apps/game-web/src/railway-game.css");
  await import("../../apps/game-web/src/route-import.css");
  root.dataset.density = "control";
  if (screen === "planning-adjustments") {
    const { mountPlanningAdjustmentsPreview } = await import("./planning-adjustments-preview.js");
    mountPlanningAdjustmentsPreview(root);
  } else if (screen === "planner") {
    const { renderProjection } = await import("../../apps/game-web/src/view.js");
    const { demoProjection } = await import("../../apps/game-web/src/demo.js");
    root.innerHTML = renderProjection(demoProjection, { density:"control",showBlockingTimes:true,selectedTrainId:demoProjection.trains[0]!.id,selectedConflictId:"",demoMode:true,livemapUrl:"http://127.0.0.1:4173/?screen=map" });
    const { GAME_HINTS } = await import("../../apps/game-web/src/game-hints.js");
    mountGameHints(root, GAME_HINTS);
  } else {
    const { renderJourney } = await import("../../apps/game-web/src/journey.js");
    const { bindCooperationSurface, vehiclePassportFragment } = await import("../../apps/game-web/src/cooperation.js");
    const { GAME_HINTS } = await import("../../apps/game-web/src/game-hints.js");
    const founding = screen === "foundation" || screen === "entry";
    const workshop = screen === "workshop" || screen === "route-import";
    const routePreview = screen === "route-import" ? await import("./route-import-preview.js") : undefined;
    const marketState = { ...cooperation };
    const registry = cooperation.vehicleRegistry;
    const openPassport = (vehicleId: string) => {
      marketState.selectedVehiclePassport = registry.find((vehicle: { vehicleId: string }) => vehicle.vehicleId === vehicleId);
      marketState.vehicleRegistryHistory = previewVehicleRegistryHistory(vehicleId);
      const current = marketState.selectedVehiclePassport;
      const priorOwner = current?.ownerOperatorId === operatorId ? "horizont" : operatorId;
      marketState.selectedVehicleHistory = current ? [{ id: `${vehicleId}-sale`, worldId, vehicleId, eventType: "sale", atS: 86400 * 2, priorHistoryHash: "b".repeat(64), resultingHistoryHash: "c".repeat(64), details: { fromOwnerOperatorId: priorOwner, toOwnerOperatorId: current.ownerOperatorId, priceCents: "160000000" } }] : [];
      marketState.selectedHistoryVehicleId = vehicleId;
    };
    if (location.hash.startsWith("#vehicle-") && !["#vehicle-market", "#vehicle-register"].includes(location.hash)) openPassport(decodeURIComponent(location.hash.slice(9)));
    const render = (accepted: boolean) => {
      const restoreView = captureWorkspaceView(root);
      const drafts = [...root.querySelectorAll<HTMLFormElement>("form[data-preserve-draft]")].map(form => ({ id: form.id, fields: [...new FormData(form).entries()] }));
      root.innerHTML = renderJourney({publicWorldId:worldId,busy:false,message:"",activeSection:founding?"world":workshop?"operations":screen as never,entryConfirmed:accepted,hasActiveOperator:!founding,activeOperatorId:founding?"":operatorId,livemapUrl:"http://127.0.0.1:4173/?screen=map",operationsCenterUrl:"http://127.0.0.1:4173/?screen=operations",worldContracts:[worldContract] as never,operatorContext:founding?{...playerContext,operators:[]}:playerContext as never,mailbox:mailbox as never,cooperation:{...marketState,section:screen==="markets"?"markets":workshop?"operations":"all",activeOperatorId:founding?"":operatorId} as never});
      routePreview?.mountRouteImportPreview(root, worldId);
      bindRailwayTabs(root, location.hash);
      for (const draft of drafts) for (const [name,value] of draft.fields) {
        const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${CSS.escape(draft.id)} [name="${CSS.escape(name)}"]`);
        if (input && typeof value === "string") input.value = value;
      }
      bindCooperationSurface(root, {
        refresh: () => render(accepted),
        changeMarketQuery: value => { marketState.marketQuery = value; render(accepted); },
        changeMarketType: value => { marketState.marketType = value; render(accepted); },
        changeMarketSort: value => { marketState.marketSort = value; render(accepted); },
        changeRegistryQuery: value => { marketState.registryQuery = value; marketState.vehicleRegistry = registry.filter((vehicle: {vehicleId:string,classDesignation:string}) => `${vehicle.vehicleId} ${vehicle.classDesignation}`.toLocaleLowerCase("de").includes(value.toLocaleLowerCase("de"))); render(accepted); },
        loadHistory: vehicleId => { openPassport(vehicleId); history.replaceState({}, "", vehiclePassportFragment(vehicleId)); render(accepted); root.querySelector<HTMLElement>(".vehicle-passport")?.focus(); },
      });
      restoreView();
      root.querySelector("[data-world-contract-form]")?.addEventListener("submit",event=>{event.preventDefault();render(true);});
      root.querySelector("#operator-foundation-form")?.addEventListener("submit",event=>{event.preventDefault();location.search="?screen=company";});
      root.querySelector("#company-exit-form")?.addEventListener("submit",event=>event.preventDefault());
    };
    render(screen === "foundation");
    window.addEventListener("hashchange", () => {
      if (!location.hash.startsWith("#vehicle-") || ["#vehicle-market", "#vehicle-register"].includes(location.hash)) return;
      const vehicleId = decodeURIComponent(location.hash.slice(9));
      if (vehicleId === marketState.selectedVehiclePassport?.vehicleId) return;
      openPassport(vehicleId);
      render(screen === "foundation");
    });
    mountGameHints(root, GAME_HINTS);
  }
}
mountGlossaryLayer(document.body);
const glossary = document.querySelector<HTMLElement>("[data-zugfolge-glossary]");
if (glossary) document.querySelector(".player-topbar")?.append(glossary);
document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link=>{
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.hash.startsWith("#event-")) return;
  if (url.searchParams.has("screen")) return;
  const target = url.searchParams.get("view") === "diagram" ? "planner" : url.searchParams.get("panel") ?? url.searchParams.get("section");
  if (target) {url.search="?screen="+(target==="world"?"entry":target==="operations"&&screen!=="operations"?"workshop":target);link.href=url.href;}
});
