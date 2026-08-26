import assert from "node:assert/strict";

/**
 * Erzwingt die vollstaendige Pruefung des explizit angegebenen Quellpakets,
 * bevor ein vorhandener Game-Stage wiederverwendet werden darf.
 */
export async function verifySourceCandidateBeforeStaging({
  packageRoot,
  packageVerifier,
  expected,
  continueStaging,
}) {
  assert.equal(typeof packageVerifier, "function", "Quellpaket-Pruefer fehlt.");
  assert.equal(typeof continueStaging, "function", "Game-Staging-Fortsetzung fehlt.");

  const verified = await packageVerifier(packageRoot);
  assert.deepEqual({
    packageId: verified.packageId,
    version: verified.version,
    manifestSha256: verified.manifestSha256,
  }, expected, "Der vollstaendig gepruefte Quellkandidat weicht vom erwarteten signierten Paket ab.");

  return {
    sourceVerification: verified,
    stagingResult: await continueStaging(),
  };
}
