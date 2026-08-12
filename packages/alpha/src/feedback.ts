import { alphaFeedback, alphaWorldProfiles, domainEvents } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";

import { AlphaValidationError } from "./errors.js";
import { pseudonym } from "./hash.js";
import type { AlphaDatabase } from "./world.js";

export interface FeedbackInput {
  readonly worldId: string;
  readonly keycloakSubject: string;
  readonly fromS: number;
  readonly untilS: number;
  readonly eventReference?: string;
  readonly reportReference?: string;
  readonly category: "usability" | "balancing" | "bug" | "incident" | "safety" | "privacy";
  readonly message: string;
  readonly contactAllowed: boolean;
}

export class AlphaFeedbackService {
  constructor(private readonly db: AlphaDatabase, private readonly pseudonymSecret: string) {
    if (pseudonymSecret.length < 32) throw new AlphaValidationError("Feedback-Pseudonymisierung braucht mindestens 32 Zeichen Geheimnis.");
  }

  async submit(input: FeedbackInput) {
    if (!Number.isSafeInteger(input.fromS) || !Number.isSafeInteger(input.untilS) || input.fromS < 0 || input.untilS < input.fromS) {
      throw new AlphaValidationError("Feedback-Zeitraum ist ungueltig.");
    }
    const message = input.message.trim();
    if (message.length < 10 || message.length > 8_000) throw new AlphaValidationError("Feedback braucht 10 bis 8.000 Zeichen.");
    const [profile] = await this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, input.worldId)).limit(1);
    if (profile === undefined) throw new AlphaValidationError("Alpha-Weltprofil fehlt.");
    if (input.eventReference !== undefined) {
      const sequence = Number(input.eventReference);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new AlphaValidationError("Ereignisverweis ist ungueltig.");
      const [event] = await this.db.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(
        eq(domainEvents.worldId, input.worldId), eq(domainEvents.sequence, sequence),
      )).limit(1);
      if (event === undefined) throw new AlphaValidationError("Ereignisverweis gehoert nicht zu dieser Welt.");
    }
    const [created] = await this.db.insert(alphaFeedback).values({
      worldId: input.worldId,
      participantPseudonym: pseudonym(this.pseudonymSecret, input.keycloakSubject),
      releaseHash: profile.blueprintHash,
      fromS: input.fromS,
      untilS: input.untilS,
      eventReference: input.eventReference,
      reportReference: input.reportReference,
      category: input.category,
      message,
      contactAllowed: input.contactAllowed,
    }).returning();
    if (created === undefined) throw new Error("Feedback konnte nicht gespeichert werden.");
    return created;
  }
}
