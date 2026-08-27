import { isAbsolute, relative, resolve } from "node:path";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function contained(root, path) {
  invariant(typeof path === "string" && path !== "" && !isAbsolute(path), `Ungültiger relativer Pfad ${path}.`);
  const absolute = resolve(root, path);
  const remainder = relative(root, absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `Pfad verlässt die Wurzel: ${path}.`);
  return absolute;
}

export function buildGermanyImportPlan({ osmium, cargo, workspace, sourcePbf, outputRoot }) {
  for (const [name, value] of Object.entries({ osmium, cargo, workspace, sourcePbf, outputRoot })) {
    invariant(typeof value === "string" && value !== "", `${name} fehlt.`);
  }
  const eboPbf = resolve(outputRoot, "germany-ebo.osm.pbf");
  const wayFeatures = resolve(outputRoot, "germany-ebo.geojsonseq");
  const pbfReport = resolve(outputRoot, "pbf-release-report.json");
  const semanticOutputRoot = resolve(outputRoot, "semantic");
  const semanticReport = resolve(semanticOutputRoot, "semantic-export-report.json");
  return {
    schema: "zugfolge-germany-import-plan/v1",
    sourcePbf: resolve(sourcePbf),
    outputs: { eboPbf, wayFeatures, pbfReport, semanticReport },
    commands: [
      {
        id: "ebo-filter",
        command: osmium,
        args: [
          "tags-filter", "-o", eboPbf, resolve(sourcePbf),
          "w/railway=rail",
          // Die Nicht-EBO-Wege bleiben ausschliesslich als Scope-Evidenz im
          // Roh-PBF. `filter_network` verwirft ihre Kanten weiterhin hart;
          // der Semantikexport kann dadurch aber gemeinsam genutzte Knoten
          // (etwa EBO/Tram-Weichen) fail-closed aus den Punktlayern halten.
          "w/railway=tram,light_rail,subway,narrow_gauge,funicular,monorail",
          "w/railway=platform",
          "w/public_transport=platform",
          "n/railway=station,halt,stop,signal,switch,buffer_stop,railway_crossing,level_crossing,crossing,milestone,platform",
          "n/public_transport=station,stop_position",
          "n/public_transport=platform",
          "r/route=train",
          "r/type=route,route_master",
          "r/public_transport=stop_area,stop_area_group",
        ],
        cwd: resolve(workspace),
      },
      {
        id: "geojson-sequence",
        command: osmium,
        args: ["export", "--output-format=geojsonseq", "-o", wayFeatures, eboPbf],
        cwd: resolve(workspace),
      },
      {
        id: "topology-report",
        command: cargo,
        args: [
          "run", "--locked", "--release", "-p", "zugfolge-infra", "--example", "pbf_release_report", "--",
          eboPbf, "osm-pbf-deutschland", pbfReport,
        ],
        cwd: resolve(workspace),
      },
      {
        id: "semantic-export",
        command: cargo,
        args: [
          "run", "--locked", "--release", "-p", "zugfolge-infra", "--example", "pbf_semantic_export", "--",
          eboPbf, "osm-pbf-deutschland", semanticOutputRoot,
        ],
        cwd: resolve(workspace),
      },
    ],
  };
}
