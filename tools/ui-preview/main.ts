import { bindRailwayTabs, mountGameHints } from "../../packages/design-system/src/index.js";
import "../../packages/design-system/src/styles.css";
import { mountGlossaryLayer } from "../../packages/glossary/src/index.js";
import "../../packages/glossary/src/styles.css";
import { captureWorkspaceView } from "../../apps/game-web/src/workspace-view.js";
import { playerContext, worldId, operatorId, cooperation, worldContract, mailbox, operationsState } from "./fixtures.mjs";

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
  root.dataset.density = "control";
  if (screen === "planner") {
    const { renderProjection } = await import("../../apps/game-web/src/view.js");
    const { demoProjection } = await import("../../apps/game-web/src/demo.js");
    root.innerHTML = renderProjection(demoProjection, { density:"control",showBlockingTimes:true,selectedTrainId:demoProjection.trains[0]!.id,selectedConflictId:"",demoMode:true,livemapUrl:"http://127.0.0.1:4173/?screen=map" });
    const { GAME_HINTS } = await import("../../apps/game-web/src/game-hints.js");
    mountGameHints(root, GAME_HINTS);
  } else {
    const { renderJourney } = await import("../../apps/game-web/src/journey.js");
    const { GAME_HINTS } = await import("../../apps/game-web/src/game-hints.js");
    const founding = screen === "foundation" || screen === "entry";
    const render = (accepted: boolean) => {
      const restoreView = captureWorkspaceView(root);
      root.innerHTML = renderJourney({publicWorldId:worldId,busy:false,message:"",activeSection:founding?"world":screen==="workshop"?"operations":screen as never,entryConfirmed:accepted,hasActiveOperator:!founding,activeOperatorId:founding?"":operatorId,livemapUrl:"http://127.0.0.1:4173/?screen=map",operationsCenterUrl:"http://127.0.0.1:4173/?screen=operations",worldContracts:[worldContract] as never,operatorContext:founding?{...playerContext,operators:[]}:playerContext as never,mailbox:mailbox as never,cooperation:{...cooperation,section:screen==="markets"?"markets":screen==="workshop"?"operations":"all",activeOperatorId:founding?"":operatorId} as never});
      bindRailwayTabs(root, location.hash);
      restoreView();
      root.querySelector("#m12-refresh")?.addEventListener("click", () => render(accepted));
      root.querySelector("[data-world-contract-form]")?.addEventListener("submit",event=>{event.preventDefault();render(true);});
      root.querySelector("#operator-foundation-form")?.addEventListener("submit",event=>{event.preventDefault();location.search="?screen=company";});
    };
    render(screen === "foundation");
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
