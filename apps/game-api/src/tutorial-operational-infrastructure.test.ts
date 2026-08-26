import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { TUTORIAL_TEMPLATE_HASH } from "@zugfolge/alpha";
import { describe, expect, it } from "vitest";

import { TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR } from "./tutorial-operational-infrastructure.js";

const artifactRoot = new URL(
  "../tutorial-infrastructure/tutorial-minimal-2026.1/",
  import.meta.url,
);

describe("externe Tutorial-Operational-v2-Infrastruktur", () => {
  it("bindet Descriptor, Template und kanonische Dateibytes ohne Inline-Fallback", () => {
    const committedDescriptor = JSON.parse(
      readFileSync(new URL("descriptor.json", artifactRoot), "utf8"),
    ) as unknown;
    const artifact = readFileSync(
      new URL("operational-infrastructure-v2.json", artifactRoot),
    );

    expect(committedDescriptor).toEqual(TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR);
    expect(TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR.templateHash)
      .toBe(TUTORIAL_TEMPLATE_HASH);
    expect(artifact.byteLength)
      .toBe(TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR.binding.bytes);
    expect(createHash("sha256").update(artifact).digest("hex"))
      .toBe(TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR.binding.sha256);
    expect(JSON.parse(artifact.toString("utf8"))).toMatchObject({
      id: TUTORIAL_OPERATIONAL_INFRASTRUCTURE_DESCRIPTOR.binding.infraReleaseId,
    });
  });
});
