import { describe, expect, it } from "vitest";

import { GameApiError } from "./api.js";
import { classifyJourneyFailure } from "./recovery.js";

describe("Spielerreise-Wiederherstellung", () => {
  it.each([401, 403])("beginnt bei HTTP %i eine neue Anmeldung", (status) => {
    expect(classifyJourneyFailure(new GameApiError("technische Meldung", false, status), "Fallback"))
      .toEqual({
        message: "Deine Anmeldung ist abgelaufen. Melde dich erneut an, um weiterzuspielen.",
        recovery: "authenticate",
      });
  });

  it("bewahrt fachliche Konflikte als normalen Wiederholungsfall", () => {
    expect(classifyJourneyFailure(new GameApiError("Fachrevision ist veraltet.", false, 409), "Fallback"))
      .toEqual({ message: "Fachrevision ist veraltet.", recovery: "retry" });
  });
});
