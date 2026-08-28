import assert from "node:assert/strict";
import test from "node:test";

import { verifySourceCandidateBeforeStaging } from "./signed-game-staging-source-verification.mjs";

const EXPECTED = {
  packageId: "zugfolge-map-deutschland",
  version: "2026.3",
  manifestSha256: "e42d190811a00f615ed7be20d97b2201e696148915aedd0bd8ba8401fd33d67e",
};

test("prueft den Quellkandidaten vor jeder closed-Stage-Wiederverwendung vollstaendig", async () => {
  const calls = [];
  const result = await verifySourceCandidateBeforeStaging({
    packageRoot: "C:/candidate",
    packageVerifier: async (packageRoot) => {
      calls.push(["verify-source", packageRoot]);
      return EXPECTED;
    },
    expected: EXPECTED,
    continueStaging: async () => {
      calls.push(["reuse-stage"]);
      return { status: "closed" };
    },
  });

  assert.deepEqual(calls, [
    ["verify-source", "C:/candidate"],
    ["reuse-stage"],
  ]);
  assert.deepEqual(result.stagingResult, { status: "closed" });
});

test("laesst einen fehlenden oder manipulierten Quellteil keinen vorhandenen Stage verdecken", async () => {
  let stageWasUsed = false;
  await assert.rejects(
    verifySourceCandidateBeforeStaging({
      packageRoot: "C:/candidate",
      packageVerifier: async () => {
        throw new Error("Paketteil stimmt nicht mit seinem SHA-256-Vertrag ueberein.");
      },
      expected: EXPECTED,
      continueStaging: async () => {
        stageWasUsed = true;
        return { status: "finalized" };
      },
    }),
    /Paketteil stimmt nicht/u,
  );
  assert.equal(stageWasUsed, false);
});

test("verwirft eine abweichende Quellpaketidentitaet vor der Stage-Wiederverwendung", async () => {
  let stageWasUsed = false;
  await assert.rejects(
    verifySourceCandidateBeforeStaging({
      packageRoot: "C:/candidate",
      packageVerifier: async () => ({ ...EXPECTED, version: "2026.3-fremd" }),
      expected: EXPECTED,
      continueStaging: async () => {
        stageWasUsed = true;
        return { status: "closed" };
      },
    }),
    /vollstaendig gepruefte Quellkandidat weicht/u,
  );
  assert.equal(stageWasUsed, false);
});
