import assert from "node:assert/strict";
import test from "node:test";

import {
  validateGermanyOperationalOuterNativeAnnualLaunchBinding,
} from "./operational-infrastructure-v2-outer-execution-receipt.mjs";

function fixture() {
  const annualLaunch = {
    contract: {
      bytes: 123,
      file: "tools/region-import/germany/direct-contract.json",
      releaseId: "infra-deutschland-2026.5",
      schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
      sha256: "1".repeat(64),
    },
    executionPins: {
      bytes: 456,
      file: "tools/region-import/germany/execution-pins.json",
      schema: "zugfolge-germany-operational-v2-execution-pins/v1",
      sha256: "2".repeat(64),
    },
    mode: "pinned-rust-command-env-clear-v1",
    trustedExecutor: {
      buildCommit: "3".repeat(40),
      bytes: 789,
      file: "var/derived/germany-2026.5/toolchain/executor.exe",
      sha256: "4".repeat(64),
    },
  };
  return {
    outer: { annualLaunch },
    native: {
      operationalProvenance: {
        producerKind: "integrated-runner-v1",
        productionActivationEligible: true,
        releaseEvidenceEligible: true,
        executionProof: { annualLaunch: structuredClone(annualLaunch) },
      },
    },
  };
}

test("Outer und Native-Receipt binden exakt denselben integrierten Annual-Launch-Vertrag", () => {
  const value = fixture();
  assert.equal(validateGermanyOperationalOuterNativeAnnualLaunchBinding(value.outer, value.native), true);
});

test("anderer Direct-Contract unter gleichen Pins und Outputs bleibt fail-closed", () => {
  const value = fixture();
  value.native.operationalProvenance.executionProof.annualLaunch.contract.sha256 = "5".repeat(64);
  assert.throws(
    () => validateGermanyOperationalOuterNativeAnnualLaunchBinding(value.outer, value.native),
    /nicht denselben integrierten Annual-Launch-Vertrag/u,
  );
});

test("forensische oder nicht aktivierungsgeeignete Native-Provenienz bleibt fail-closed", () => {
  for (const mutate of [
    (value) => { value.native.operationalProvenance.producerKind = "forensic-stdin-v1"; },
    (value) => { value.native.operationalProvenance.releaseEvidenceEligible = false; },
    (value) => { value.native.operationalProvenance.productionActivationEligible = false; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validateGermanyOperationalOuterNativeAnnualLaunchBinding(value.outer, value.native),
      /nicht denselben integrierten Annual-Launch-Vertrag/u,
    );
  }
});
