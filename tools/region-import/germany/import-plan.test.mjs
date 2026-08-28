import assert from "node:assert/strict";
import test from "node:test";

import { buildGermanyImportPlan, contained } from "./import-plan.mjs";

test("Deutschlandimport filtert vollständig und baut Topologie- sowie Semantiknachweis", () => {
  const plan = buildGermanyImportPlan({
    osmium: "osmium", cargo: "cargo", workspace: "C:/workspace", sourcePbf: "D:/sources/germany.osm.pbf", outputRoot: "D:/derived",
  });
  assert.deepEqual(plan.commands.map(({ id }) => id), ["ebo-filter", "geojson-sequence", "topology-report", "semantic-export"]);
  assert.ok(plan.commands[0].args.includes("w/railway=rail"));
  assert.ok(plan.commands[0].args.includes("w/railway=tram,light_rail,subway,narrow_gauge,funicular,monorail"));
  assert.ok(plan.commands[0].args.includes("w/railway=platform"));
  assert.ok(plan.commands[0].args.includes("n/public_transport=platform"));
  assert.equal(plan.commands[0].args.includes("--overwrite"), false);
  assert.equal(plan.commands[1].args.includes("--overwrite"), false);
  assert.deepEqual(plan.commands[2].args.slice(-3), [plan.outputs.eboPbf, "osm-pbf-deutschland", plan.outputs.pbfReport]);
  assert.deepEqual(plan.commands[3].args.slice(-3), [
    plan.outputs.eboPbf,
    "osm-pbf-deutschland",
    plan.outputs.semanticReport.replace(/[\\/]semantic-export-report\.json$/, ""),
  ]);
});

test("Capture-Pfade dürfen die externe Quellwurzel nicht verlassen", () => {
  assert.throws(() => contained("C:/sources", "../secret.pbf"), /verlässt/);
});
