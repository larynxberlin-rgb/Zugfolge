import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  loadSignedAlphaWorldDeployment,
} from "../../apps/game-api/dist/alpha-world-start.js";
import { RegionalServiceCatalog } from "../../apps/game-api/dist/boundary-transition-scheduler.js";

const deploymentPath = process.argv[2];
if (deploymentPath === undefined || deploymentPath.length === 0) {
  throw new Error("Aufruf: node verify-alpha-recurrence.mjs ALPHA-WORLD-DEPLOYMENT.json");
}
const publicKeyPath = fileURLToPath(
  new URL("../../ops/keys/zugfolge-alpha-2026-ed25519-public.pem", import.meta.url),
);
const signed = await loadSignedAlphaWorldDeployment(deploymentPath, {
  "zugfolge-alpha-2026": await readFile(publicKeyPath, "utf8"),
});
const deployment = signed.deployment;
const catalog = new RegionalServiceCatalog(
  deployment.worldId,
  deployment.regionalSimulation.regionId,
  deployment.repeatEveryS,
  deployment.regionalSimulation.trains,
  deployment.boundaryTransitions,
);
const dayOne = catalog.due(
  deployment.worldId,
  deployment.regionalSimulation.regionId,
  deployment.repeatEveryS - 1,
  deployment.repeatEveryS * 2 - 1,
);
const materializations = dayOne.filter((item) => item.command.type === "materialize");
const transitionHorizon = Math.max(
  ...deployment.boundaryTransitions.map((item) => item.atS),
);
const repeatedTransitionWindow = catalog.due(
  deployment.worldId,
  deployment.regionalSimulation.regionId,
  deployment.repeatEveryS - 1,
  transitionHorizon + deployment.repeatEveryS,
);
const transitions = repeatedTransitionWindow.filter(
  (item) =>
    (item.command.type === "enter-external-zone" ||
      item.command.type === "reenter-from-external") &&
    item.transitionId.endsWith(":day-1"),
);
const cleanups = dayOne.filter((item) => item.command.type === "dematerialize-before");
if (materializations.length !== deployment.regionalSimulation.trains.length) {
  throw new Error("Der zweite Betriebstag materialisiert nicht das vollstaendige Betriebsprogramm.");
}
if (transitions.length !== deployment.boundaryTransitions.length) {
  throw new Error("Der zweite Betriebstag wiederholt nicht alle Grenzuebergaenge.");
}
if (cleanups.length !== 1) {
  throw new Error("Der zweite Betriebstag besitzt keinen eindeutigen Bereinigungspunkt.");
}
const expectedTransitionIds = new Set(
  deployment.boundaryTransitions.map((item) => `${item.transitionId}:day-1`),
);
if (
  transitions.some((item) => !expectedTransitionIds.has(item.transitionId)) ||
  new Set(transitions.map((item) => item.transitionId)).size !== expectedTransitionIds.size
) {
  throw new Error("Wiederholte Grenzkommandos besitzen keine eindeutige Tageskennung.");
}

process.stdout.write(
  `${JSON.stringify({
    schema: "zugfolge-alpha-recurrence-evidence/v1",
    deploymentHash: signed.deploymentHash,
    repeatEveryS: deployment.repeatEveryS,
    materializations: materializations.length,
    boundaryTransitions: transitions.length,
    cleanupCommands: cleanups.length,
    recurrenceHorizonS: transitionHorizon + deployment.repeatEveryS,
    totalCommandsInFirstDayWindow: dayOne.length,
    uniqueCommandIdsInFirstDayWindow: new Set(dayOne.map((item) => item.transitionId)).size,
  })}\n`,
);
