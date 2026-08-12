import { alphaHash } from "./hash.js";

export const TUTORIAL_TEMPLATE_SCHEMA = "zugfolge-tutorial-template/v1" as const;
export const TUTORIAL_TEMPLATE_VERSION = "tutorial-minimal-2026.1" as const;

export const TUTORIAL_CHAPTERS = [
  { chapter: 1, code: "first-tender", title: "Erste Ausschreibung", goal: "Ein wirtschaftlich tragfaehiges Angebot gewinnt das Tutorial-Los." },
  { chapter: 2, code: "lease-vehicle", title: "Fahrzeug leasen", goal: "Ein Mietvertrag ist aktiv und das Fahrzeug autoritativ uebergeben." },
  { chapter: 3, code: "request-path", title: "Trasse beantragen", goal: "Eine eigene, bestaetigte Trasse liegt im Fleet-Single-Writer." },
  { chapter: 4, code: "operating-program", title: "Betriebsprogramm aktivieren", goal: "Eine veraenderte, echte Betriebsprogrammversion ist aktiv." },
  { chapter: 5, code: "handle-disruption", title: "Erste Stoerung", goal: "Stoerung, Dispositionsentscheidung und Ergebniswirkung sind belegt." },
] as const;

export const TUTORIAL_DIALOGUE_TRIGGERS = [
  "session.started",
  "chapter.1.started", "chapter.1.invalid", "chapter.1.completed", "chapter.1.hint",
  "chapter.2.started", "chapter.2.invalid", "chapter.2.completed", "chapter.2.hint",
  "chapter.3.started", "chapter.3.invalid", "chapter.3.completed", "chapter.3.hint",
  "chapter.4.started", "chapter.4.invalid", "chapter.4.completed", "chapter.4.hint",
  "chapter.5.started", "chapter.5.invalid", "chapter.5.completed", "chapter.5.hint",
  "summary.ready", "session.closed",
] as const;

export type TutorialDialogueTrigger = (typeof TUTORIAL_DIALOGUE_TRIGGERS)[number];

export interface TutorialDialogue {
  readonly id: string;
  readonly templateVersion: string;
  readonly chapter: number;
  readonly trigger: TutorialDialogueTrigger;
  readonly speaker: "lutz";
  readonly text: string;
  readonly why?: string;
  readonly actionLabel?: string;
  readonly target?: string;
  readonly canDismiss: boolean;
}

const dialogue = (
  id: string,
  chapter: number,
  trigger: TutorialDialogueTrigger,
  text: string,
  options: Pick<TutorialDialogue, "why" | "actionLabel" | "target" | "canDismiss">,
): TutorialDialogue => Object.freeze({ id, templateVersion: TUTORIAL_TEMPLATE_VERSION, chapter, trigger, speaker: "lutz", text, ...options });

export const TUTORIAL_DIALOGUES: readonly TutorialDialogue[] = Object.freeze([
  dialogue("lutz-welcome", 1, "session.started", "Willkommen im Bahnbetrieb. Nein, die Zuege finden ihren Weg nicht von allein. Wir beginnen mit einer Ausschreibung.", { why: "Das Angebot entscheidet, ob Ihr EVU einen bezahlbaren Auftrag erhaelt. Preis allein gewinnt nicht.", actionLabel: "Ausschreibung oeffnen", target: "tutorial-chapter-1", canDismiss: false }),
  dialogue("lutz-tender", 1, "chapter.1.started", "Drei Angebotsfelder. Irgendjemand wird trotzdem vier Rueckfragen stellen. Pruefen Sie zuerst Marge und Wertung.", { why: "Die Gewichtung verbindet Preis und Qualitaet; die Poenale macht ein ueberzogenes Versprechen teuer.", actionLabel: "Angebot pruefen", target: "tutorial-tender-form", canDismiss: true }),
  dialogue("lutz-tender-invalid", 1, "chapter.1.invalid", "Das Angebot ist entweder ungueltig oder wirtschaftlich sportlicher als gesund. Korrigieren Sie die markierten Werte.", { why: "Nur ein fachlich gueltiges und auskoemmliches Gebot darf bezuschlagt werden.", actionLabel: "Werte korrigieren", target: "tutorial-tender-form", canDismiss: true }),
  dialogue("lutz-tender-done", 1, "chapter.1.completed", "Zuschlag erhalten. Die Behoerde hat offenbar auch einmal einen guten Tag. Jetzt fehlt nur noch ein Zug.", { actionLabel: "Fahrzeuge vergleichen", target: "tutorial-chapter-2", canDismiss: true }),
  dialogue("lutz-tender-hint", 1, "chapter.1.hint", "Bleiben Sie unter der angezeigten Auskoemmlichkeitsgrenze und versprechen Sie nur Qualitaet, die das Fahrzeug halten kann.", { target: "tutorial-tender-form", canDismiss: true }),
  dialogue("lutz-vehicle", 2, "chapter.2.started", "Ein Fahrzeug waere jetzt praktisch. Der Vorschlag, ohne eines zu fahren, fand technisch wenig Zustimmung.", { why: "Kosten, Kapazitaet und Zustand wirken direkt auf Marge und Betriebsrisiko.", actionLabel: "Angebote vergleichen", target: "tutorial-lease-options", canDismiss: true }),
  dialogue("lutz-vehicle-invalid", 2, "chapter.2.invalid", "Dieses Angebot ist nicht fuer Ihre Sitzung verfuegbar. Nehmen Sie eines der beiden geprueften Mietangebote.", { actionLabel: "Angebot waehlen", target: "tutorial-lease-options", canDismiss: true }),
  dialogue("lutz-vehicle-done", 2, "chapter.2.completed", "Vertrag aktiv, Halterwechsel verbucht. Das Fahrzeug gehoert Ihnen nicht, aber die Verantwortung natuerlich schon.", { actionLabel: "Trassen vergleichen", target: "tutorial-chapter-3", canDismiss: true }),
  dialogue("lutz-vehicle-hint", 2, "chapter.2.hint", "Die guenstigere Miete schont die Marge; der bessere Zustand senkt das Stoerungsrisiko. Beides gleichzeitig waere zu bequem.", { target: "tutorial-lease-options", canDismiss: true }),
  dialogue("lutz-path", 3, "chapter.3.started", "Die Gleise sind leider nicht exklusiv fuer Ihr EVU reserviert. Ich habe sicherheitshalber nachgesehen.", { why: "Mehr Puffer kostet, kann aber bei kleinen Abweichungen einen Konflikt verhindern.", actionLabel: "Alternativen vergleichen", target: "tutorial-path-options", canDismiss: true }),
  dialogue("lutz-path-invalid", 3, "chapter.3.invalid", "Ein Entwurf bewegt noch keinen Zug. Bestaetigen Sie eine der autoritativ berechneten Alternativen.", { actionLabel: "Trasse bestaetigen", target: "tutorial-path-options", canDismiss: true }),
  dialogue("lutz-path-done", 3, "chapter.3.completed", "Die Trasse ist bestaetigt, Personal und Formation sind gebunden. Das klingt fast organisiert.", { actionLabel: "Programm bearbeiten", target: "tutorial-chapter-4", canDismiss: true }),
  dialogue("lutz-path-hint", 3, "chapter.3.hint", "Knapp ist billiger. Robust hat mehr Puffer und reduziert das Risiko einer spaeteren Poenale.", { target: "tutorial-path-options", canDismiss: true }),
  dialogue("lutz-program", 4, "chapter.4.started", "Der Zug faehrt nicht besser, nur weil Sie ihn motivierend ansehen. Aktivieren Sie eine brauchbare Regel.", { why: "Das Betriebsprogramm entscheidet auch dann, wenn Sie nicht online sind.", actionLabel: "Regel veraendern", target: "tutorial-program-form", canDismiss: true }),
  dialogue("lutz-program-invalid", 4, "chapter.4.invalid", "Eine unveraenderte Vorlage ist noch keine Entscheidung. Aendern Sie mindestens eine betriebliche Regel.", { actionLabel: "Regel anpassen", target: "tutorial-program-form", canDismiss: true }),
  dialogue("lutz-program-done", 4, "chapter.4.completed", "Programm aktiv und Verkehr uebernommen. Geniessen Sie den ruhigen Moment, er ist gleich vorbei.", { actionLabel: "Betrieb beobachten", target: "tutorial-chapter-5", canDismiss: true }),
  dialogue("lutz-program-hint", 4, "chapter.4.hint", "Anschlusswarten hilft Reisenden, kostet aber Puenktlichkeit. Eine niedrigere Schwelle greift haeufiger ein.", { target: "tutorial-program-form", canDismiss: true }),
  dialogue("lutz-disruption", 5, "chapter.5.started", "Da ist die Stoerung. Puenktlich. Wenigstens etwas hier. Waehlen Sie jetzt eine zulaessige Reaktion.", { why: "Jede Reaktion veraendert Verspaetung, Kosten und Vertragsrisiko anders.", actionLabel: "Reaktion waehlen", target: "tutorial-dispatch-options", canDismiss: true }),
  dialogue("lutz-disruption-invalid", 5, "chapter.5.invalid", "Diese Reaktion passt nicht zu den geprueften Betriebsgrenzen. Nehmen Sie eine der angebotenen Massnahmen.", { actionLabel: "Massnahme waehlen", target: "tutorial-dispatch-options", canDismiss: true }),
  dialogue("lutz-disruption-done", 5, "chapter.5.completed", "Stoerung disponiert, Wirkung verbucht. Niemand jubelt, also war es vermutlich professionell.", { actionLabel: "Ergebnis ansehen", target: "tutorial-summary", canDismiss: true }),
  dialogue("lutz-disruption-hint", 5, "chapter.5.hint", "Umleiten kostet mehr, vermeidet aber den Ausfall. Kurzwenden ist billiger und belastet das Qualitaetsziel.", { target: "tutorial-dispatch-options", canDismiss: true }),
  dialogue("lutz-summary", 5, "summary.ready", "Sie haben einen Eisenbahnbetrieb ueberstanden. Die Messlatte lag nicht hoch, aber Sie sind drueber.", { why: "Die Rechnung zeigt, welche Ihrer Entscheidungen Marge und Qualitaet veraendert haben.", actionLabel: "Tutorial abschliessen", target: "tutorial-summary-confirm", canDismiss: false }),
  dialogue("lutz-closed", 5, "session.closed", "Die Tutorialwelt ist geschlossen. In der oeffentlichen Welt gibt es keine heimliche Ausruestung, nur deren echte Startkapitalregel.", { actionLabel: "Zur oeffentlichen Welt", target: "tutorial-public-world-link", canDismiss: false }),
]);

export interface TutorialTemplate {
  readonly schemaVersion: typeof TUTORIAL_TEMPLATE_SCHEMA;
  readonly version: typeof TUTORIAL_TEMPLATE_VERSION;
  readonly accelerationFactor: number;
  readonly schedulePeriodWeeks: 3;
  readonly idleTtlMilliseconds: number;
  readonly maximumDurationMilliseconds: number;
  readonly summaryGraceMilliseconds: number;
  readonly tutorialCapitalCents: bigint;
  readonly worldSeed: bigint;
  readonly region: {
    readonly id: string;
    readonly name: string;
    readonly stations: readonly Readonly<Record<string, string | number>>[];
    readonly segments: readonly Readonly<Record<string, string | number | readonly number[]>>[];
  };
  readonly tender: Readonly<Record<string, unknown>>;
  readonly leases: readonly Readonly<Record<string, unknown>>[];
  readonly paths: readonly Readonly<Record<string, unknown>>[];
  readonly programmes: readonly Readonly<Record<string, string | number>>[];
  readonly disruption: Readonly<Record<string, string | number>>;
  readonly result: {
    readonly orderingRevenueCents: bigint;
    readonly baseOperatingCostCents: bigint;
    readonly trackCostTightCents: bigint;
    readonly trackCostRobustCents: bigint;
    readonly disruptionRerouteCostCents: bigint;
    readonly disruptionShortTurnCostCents: bigint;
    readonly disruptionReplacementCostCents: bigint;
    readonly punctualityTargetBasisPoints: number;
  };
}

export const TUTORIAL_TEMPLATE: TutorialTemplate = Object.freeze({
  schemaVersion: TUTORIAL_TEMPLATE_SCHEMA,
  version: TUTORIAL_TEMPLATE_VERSION,
  accelerationFactor: 240,
  schedulePeriodWeeks: 3,
  idleTtlMilliseconds: 30 * 60 * 1_000,
  maximumDurationMilliseconds: 60 * 60 * 1_000,
  summaryGraceMilliseconds: 5 * 60 * 1_000,
  tutorialCapitalCents: 2_000_000n,
  worldSeed: 7_219_2026n,
  region: Object.freeze({
    id: "tutorial-korridor",
    name: "Kieselgrund - Fichtenhain",
    stations: Object.freeze([
      Object.freeze({ numericId: 1, id: "tut-kieselgrund", code: "TKG", name: "Kieselgrund", distanceMm: 0, latitudeE7: 512000000, longitudeE7: 123000000, stationTrackNumericId: 101, stationTrackLengthMm: 180000, stationMaximumSpeedKph: 80 }),
      Object.freeze({ numericId: 2, id: "tut-muehlenbrueck", code: "TMB", name: "Muehlenbrueck", distanceMm: 9_000_000, latitudeE7: 512050000, longitudeE7: 123120000, stationTrackNumericId: 102, stationTrackLengthMm: 170000, stationMaximumSpeedKph: 100 }),
      Object.freeze({ numericId: 3, id: "tut-wiesenrode", code: "TWR", name: "Wiesenrode", distanceMm: 18_000_000, latitudeE7: 512090000, longitudeE7: 123250000, stationTrackNumericId: 103, stationTrackLengthMm: 160000, stationMaximumSpeedKph: 100 }),
      Object.freeze({ numericId: 4, id: "tut-fichtenhain", code: "TFH", name: "Fichtenhain", distanceMm: 28_000_000, latitudeE7: 512130000, longitudeE7: 123390000, stationTrackNumericId: 104, stationTrackLengthMm: 180000, stationMaximumSpeedKph: 80 }),
    ]),
    segments: Object.freeze([
      Object.freeze({ edgeNumericId: 1, trackNumericId: 11, id: "tut-segment-1", label: "Kieselgrund - Muehlenbrueck", fromStationId: "tut-kieselgrund", toStationId: "tut-muehlenbrueck", lengthMm: 9_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [3_000_000, 6_000_000], maximumVirtualBlockLengthMm: 3_000_000 }),
      Object.freeze({ edgeNumericId: 2, trackNumericId: 12, id: "tut-segment-2", label: "Muehlenbrueck - Wiesenrode", fromStationId: "tut-muehlenbrueck", toStationId: "tut-wiesenrode", lengthMm: 9_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [3_000_000, 6_000_000], maximumVirtualBlockLengthMm: 3_000_000 }),
      Object.freeze({ edgeNumericId: 3, trackNumericId: 13, id: "tut-segment-3", label: "Wiesenrode - Fichtenhain", fromStationId: "tut-wiesenrode", toStationId: "tut-fichtenhain", lengthMm: 10_000_000, maximumSpeedKph: 120, mainSignalPositionsMm: [3_500_000, 7_000_000], maximumVirtualBlockLengthMm: 3_500_000 }),
    ]),
  }),
  tender: Object.freeze({ id: "tutorial-tender", lotId: "tutorial-lot", authorityId: "tutorial-authority", profileId: "balanced-quality", announcedAtS: 10, opensAtS: 20, closesAtS: 86_420, operatingFromS: 90_000, trainKmPerPeriod: "840", viabilityThresholdCentsPerTrainKm: "1739", comparisonBidCentsPerTrainKm: "1580" }),
  leases: Object.freeze([
    Object.freeze({ id: "lease-economy", vehicleId: "tutorial-vehicle-economy", classDesignation: "T 442", monthlyCostCents: "210000", seats: 138, conditionBasisPoints: 8600, reliabilityBasisPoints: 8900, marginEffectCents: "90000" }),
    Object.freeze({ id: "lease-reliable", vehicleId: "tutorial-vehicle-reliable", classDesignation: "T 446", monthlyCostCents: "285000", seats: 160, conditionBasisPoints: 9600, reliabilityBasisPoints: 9700, marginEffectCents: "15000" }),
  ]),
  paths: Object.freeze([
    Object.freeze({ id: "path-tight", receiptId: "tutorial-path-tight", label: "Knapp und guenstig", desiredDepartureS: 240, bufferSeconds: 45, costCents: "78000" }),
    Object.freeze({ id: "path-robust", receiptId: "tutorial-path-robust", label: "Robust mit Puffer", desiredDepartureS: 300, bufferSeconds: 180, costCents: "112000" }),
  ]),
  programmes: Object.freeze([
    Object.freeze({ id: "connections", label: "Anschluesse sichern", baseThresholdSeconds: 240 }),
    Object.freeze({ id: "punctuality", label: "Puenktlichkeit priorisieren", baseThresholdSeconds: 480 }),
  ]),
  disruption: Object.freeze({ id: "tutorial-switch-failure", resourceId: "track:tut-segment-2", trainRunId: "tutorial-run-1", startsAtS: 90_220, validUntilS: 91_000, delaySeconds: 420, causeCode: 26, fineCauseId: "switch.drive" }),
  result: Object.freeze({ orderingRevenueCents: 1_560_000n, baseOperatingCostCents: 690_000n, trackCostTightCents: 78_000n, trackCostRobustCents: 112_000n, disruptionRerouteCostCents: 95_000n, disruptionShortTurnCostCents: 35_000n, disruptionReplacementCostCents: 145_000n, punctualityTargetBasisPoints: 9_000 }),
});

export const TUTORIAL_TEMPLATE_HASH = alphaHash(TUTORIAL_TEMPLATE_SCHEMA, TUTORIAL_TEMPLATE);

export function validateTutorialTemplate(template: TutorialTemplate): void {
  if (template.schemaVersion !== TUTORIAL_TEMPLATE_SCHEMA || template.version.trim() === "") throw new Error("Tutorialtemplate besitzt kein gueltiges Schema oder keine Version.");
  if (!Number.isSafeInteger(template.accelerationFactor) || template.accelerationFactor <= 1) throw new Error("Tutorialtemplate ist nicht beschleunigt.");
  if (template.tutorialCapitalCents <= 0n) throw new Error("Tutorialkapital muss endlich und positiv sein.");
  if (template.region.stations.length < 3 || template.region.stations.length > 4 || template.region.segments.length < 2) throw new Error("Tutorialkorridor besitzt keinen minimalen, zusammenhaengenden Inhalt.");
  if (template.leases.length !== 2 || template.paths.length !== 2 || template.programmes.length !== 2) throw new Error("Tutorialtemplate braucht jeweils genau zwei Entscheidungsalternativen.");
  const ids = new Set(TUTORIAL_DIALOGUES.map((entry) => entry.id));
  if (ids.size !== TUTORIAL_DIALOGUES.length || TUTORIAL_DIALOGUES.some((entry) => entry.templateVersion !== template.version || !TUTORIAL_DIALOGUE_TRIGGERS.includes(entry.trigger))) throw new Error("Lutz-Dialogkatalog ist unvollstaendig oder nicht reproduzierbar gebunden.");
}

validateTutorialTemplate(TUTORIAL_TEMPLATE);
