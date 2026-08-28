import assert from "node:assert/strict";
import test from "node:test";
import { auditOplPasses, parseOplRecord } from "./osm-stop-area-topology-audit.mjs";

test("liest OPL-IDs, Way-Nodes und Relationsrollen unverändert", () => {
  assert.deepEqual(parseOplRecord("r90 v1 dV c0 t i0 u Tpublic_transport=stop_area,type=public_transport Mn10@stop,w20@platform"), {
    type: "r",
    id: "90",
    key: "r90",
    tags: { public_transport: "stop_area", type: "public_transport" },
    members: [
      { type: "n", id: "10", key: "n10", role: "stop" },
      { type: "w", id: "20", key: "w20", role: "platform" },
    ],
  });
});

test("akzeptiert nur die explizite Plattform-Stop-Gleis-Kette mit zwei gemeinsamen Endnodes", async () => {
  const topologyLines = [
    "n10 v1 dV c0 t i0 u Tpublic_transport=stop_position,train=yes x13 y52",
    "n11 v1 dV c0 t i0 u Tpublic_transport=stop_position,train=yes x14 y53",
    "w20 v1 dV c0 t i0 u Tpublic_transport=platform,train=yes Nn100,n101,n102",
    "w21 v1 dV c0 t i0 u Tpublic_transport=platform,train=yes Nn200,n201",
    "r90 v1 dV c0 t i0 u Tpublic_transport=stop_area,type=public_transport Mn10@stop,w20@platform",
    "r91 v1 dV c0 t i0 u Tpublic_transport=stop_area,type=public_transport Mn10@stop,n11@stop,w21@platform",
  ];
  const railLines = [
    "w30 v1 dV c0 t i0 u Trailway=rail Nn1,n100,n10,n102,n2",
    "w31 v1 dV c0 t i0 u Trailway=rail Nn3,n11,n4",
  ];
  const report = await auditOplPasses({ topologyLines, railLines });
  assert.equal(report.inventory.trainStopNodes, 2);
  assert.equal(report.inventory.stopAreaRelations, 2);
  assert.equal(report.stopAreaComposition.oneTrainStop, 1);
  assert.equal(report.stopAreaComposition.multipleTrainStops, 1);
  assert.deepEqual(report.chains, {
    platformElementsTotal: 2,
    platformMembersOfStopArea: 2,
    platformWithoutTrainStop: 0,
    platformWithOneTrainStop: 1,
    platformWithMultipleTrainStops: 1,
    platformInMultipleStopAreas: 0,
    platformWithExplicitOneToOneStopAreaPair: 1,
    stopWithoutRailWay: 0,
    stopOnOneRailWay: 2,
    stopOnMultipleRailWays: 0,
    strictPlatformStopRailWayChain: 1,
    strictChainPlatformPoint: 0,
    strictChainPlatformWay: 1,
    strictChainPlatformRelation: 0,
    strictChainWithNoSharedPlatformTrackNode: 0,
    strictChainWithOneSharedPlatformTrackNode: 0,
    strictChainWithTwoOrMoreSharedPlatformTrackNodes: 1,
    strictChainWithExactlyTwoDistinctEndpointNodes: 1,
    strictChainWithRelationGeometryMissingMembers: 0,
  });
});

test("weist fehlende und mehrdeutige Stop-Gleis-Mitgliedschaften aus", async () => {
  const topologyLines = [
    "n10 v1 dV c0 t i0 u Tpublic_transport=stop_position,train=yes x13 y52",
    "n11 v1 dV c0 t i0 u Tpublic_transport=stop_position,train=yes x14 y53",
    "n20 v1 dV c0 t i0 u Tpublic_transport=platform,train=yes x13 y52",
    "n21 v1 dV c0 t i0 u Tpublic_transport=platform,train=yes x14 y53",
    "r90 v1 dV c0 t i0 u Tpublic_transport=stop_area,type=public_transport Mn10@stop,n20@platform",
    "r91 v1 dV c0 t i0 u Tpublic_transport=stop_area,type=public_transport Mn11@stop,n21@platform",
  ];
  const railLines = [
    "w30 v1 dV c0 t i0 u Trailway=rail Nn1,n11,n2",
    "w31 v1 dV c0 t i0 u Trailway=rail Nn3,n11,n4",
  ];
  const report = await auditOplPasses({ topologyLines, railLines });
  assert.equal(report.chains.stopWithoutRailWay, 1);
  assert.equal(report.chains.stopOnMultipleRailWays, 1);
  assert.equal(report.chains.strictPlatformStopRailWayChain, 0);
});
