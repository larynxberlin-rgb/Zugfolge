import type { ConductorCommandActionV1, ConductorCommandV1 } from "../../../packages/runtime-native/src/session-types.js";
import type { InteriorDeckId, InteriorPointV1, VisiblePassengerV2 } from "../../../packages/runtime-native/src/interior-types.js";
import { ConductorApi, ConductorApiError, type ConductorResponse } from "../../../apps/livemap/src/conductor-api.js";
import { openConductorReport } from "../../../apps/livemap/src/conductor-report.js";
import { trapConductorDialogFocus } from "../../../apps/livemap/src/conductor-dialog.js";
import { createGameRenderer, type GameRenderer } from "./game-renderer.js";
import "./game-mode.css";

export interface GameMovementPolicy {
  readonly walkSpeedMmPerSecond: number;
  readonly maxMovementBurstMm: number;
  readonly minCommandIntervalMs: number;
  readonly inspectionRangeMm: number;
}
const decks = { main: "Hauptdeck", lower: "Unterdeck", upper: "Oberdeck" };
const sameSpace = (a: InteriorPointV1, b: InteriorPointV1) => a.vehicleId === b.vehicleId && a.bodyId === b.bodyId && a.deckId === b.deckId;
const distance = (a: InteriorPointV1, b: InteriorPointV1) => sameSpace(a, b) ? Math.abs(a.xMm - b.xMm) + Math.abs(a.yMm - b.yMm) : Infinity;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node;
}
function button(text: string, action: () => void, cls?: string) {
  const node = el("button", text, cls); node.type = "button"; node.addEventListener("click", action); return node;
}
function euro(raw: string) {
  if (!/^-?\d+$/u.test(raw)) return "–";
  const cents = BigInt(raw), absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "−" : ""}${absolute / 100n},${String(absolute % 100n).padStart(2, "0")} €`;
}

/** Spielhülle. Wege, Bewegung, Gesprächsoptionen und Geldbeträge bleiben native Ergebnisse. */
export async function openGameMode(input: { api: ConductorApi; trainLabel: string; returnFocus: HTMLElement; movementPolicy: GameMovementPolicy;
  practicePassengers?: readonly { passengerKey: string; label: string }[] }): Promise<void> {
  const { api, movementPolicy: policy } = input;
  if (![policy.walkSpeedMmPerSecond, policy.maxMovementBurstMm, policy.minCommandIntervalMs, policy.inspectionRangeMm].every(Number.isFinite)
    || policy.walkSpeedMmPerSecond <= 0 || policy.maxMovementBurstMm <= 0 || policy.minCommandIntervalMs < 0 || policy.inspectionRangeMm < 0) {
    throw new Error("Die bestätigten Bewegungsregeln der Übungsfahrt fehlen.");
  }
  const cadence = Math.max(125, policy.minCommandIntervalMs);
  const stepMm = Math.max(1, Math.min(policy.maxMovementBurstMm, Math.floor(policy.walkSpeedMmPerSecond * cadence / 1000)));
  const dialog = el("dialog", undefined, "game-mode"); dialog.dataset.testid = "game-mode";
  dialog.setAttribute("aria-labelledby", "game-title"); trapConductorDialogFocus(dialog);
  const stage = el("div", undefined, "game-stage"); stage.tabIndex = 0; stage.dataset.testid = "game-stage";
  stage.setAttribute("aria-label", "Zuginnenraum. Pfeiltasten oder W A S D halten zum Gehen. E oder Leertaste spricht einen Fahrgast an.");
  const hud = el("header", undefined, "game-hud"), identity = el("div", undefined, "game-identity");
  const title = el("h1", "ZUGFOLGE"); title.id = "game-title";
  const location = el("span", "Einsteigen …", "game-location"); identity.append(title, location);
  const nav = el("nav", undefined, "game-nav"); nav.setAttribute("aria-label", "Spielansicht");
  const section = el("select"); section.setAttribute("aria-label", "Wagen und Deck"); section.dataset.testid = "game-section";
  const practice = el("select"); practice.setAttribute("aria-label", "Übungsfahrgast auswählen"); practice.dataset.testid = "game-practice";
  const noPractice = el("option", "Fahrgast wählen"); noPractice.value = ""; practice.append(noPractice);
  for (const person of input.practicePassengers ?? []) { const option = el("option", person.label); option.value = person.passengerKey; practice.append(option); }
  practice.hidden = !input.practicePassengers?.length;
  practice.addEventListener("change", () => { if (practice.value) void selectPassenger(practice.value, true); });
  const zoom = el("select"); zoom.setAttribute("aria-label", "Zoom");
  for (const level of [1, 2, 3, 4]) { const option = el("option", `${level}×`); option.value = String(level); zoom.append(option); } zoom.value = "3";
  const focusPlayerButton = button("Zu mir", () => focusPlayer());
  const report = button("Bericht", () => { stopWalking(); void openConductorReport({ api, trainLabel: input.trainLabel, returnFocus: report }); });
  report.dataset.testid = "game-report";
  const back = button("Pause", () => { void leave(); }); back.setAttribute("aria-label", "Zur Demo zurückkehren und pausieren");
  nav.append(practice, section, zoom, focusPlayerButton, report, back); hud.append(identity, nav);

  const speech = el("aside", undefined, "game-speech"); speech.hidden = true; speech.setAttribute("aria-label", "Aussage des Fahrgasts"); speech.setAttribute("aria-live", "polite");
  const speaker = el("strong", "Fahrgast"), speechText = el("p"); speechText.dataset.testid = "game-passenger-text"; speech.append(speaker, speechText);
  const conversation = el("section", undefined, "game-conversation"); conversation.hidden = true; conversation.setAttribute("aria-label", "Fahrkartenkontrolle");
  const conversationHeader = el("div", undefined, "game-conversation-header"), conversationTitle = el("strong", "Deine Antwort");
  const evidence = el("span", undefined, "game-evidence"), wait = el("span", undefined, "game-wait");
  conversationHeader.append(conversationTitle, evidence, wait);
  const answers = el("div", undefined, "game-answers"); answers.setAttribute("role", "group"); answers.setAttribute("aria-label", "Gesprächsantworten");
  const caseResult = el("p", undefined, "game-case-result"); caseResult.hidden = true; caseResult.dataset.testid = "game-case-result";
  caseResult.setAttribute("role", "status"); caseResult.setAttribute("aria-live", "polite");
  conversation.append(conversationHeader, answers, caseResult);
  const prompt = el("div", undefined, "game-prompt"), promptText = el("span", "Fahrgast anklicken oder mit E ansprechen.");
  const interactButton = button("E · Ansprechen", () => { void interact(); }, "game-interact"); interactButton.dataset.testid = "game-interact";
  const cancelWalk = button("Weg abbrechen", () => stopWalking()); cancelWalk.hidden = true; prompt.append(promptText, interactButton, cancelWalk);
  const status = el("p", "Die Fahrt wird vorbereitet …", "game-notice"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const problem = el("p", undefined, "game-error"); problem.hidden = true; problem.setAttribute("role", "alert");
  const retry = button("Erneut versuchen", () => { void recover(); }); retry.hidden = true;
  const pad = el("nav", undefined, "game-pad"); pad.setAttribute("aria-label", "Touchsteuerung");
  const arrows: [string, string, number, number][] = [["up", "↑", 0, -1], ["left", "←", -1, 0], ["down", "↓", 0, 1], ["right", "→", 1, 0]];
  for (const [name, text, dx, dy] of arrows) {
    const key = button(text, () => {}); key.className = `game-pad-${name}`; key.dataset.direction = name;
    key.setAttribute("aria-label", `Gehen ${text}`); key.style.touchAction = "none";
    key.addEventListener("pointerdown", (event) => { event.preventDefault(); key.setPointerCapture(event.pointerId); beginHold(`touch-${name}`, dx, dy); });
    const release = () => endHold(`touch-${name}`);
    key.addEventListener("pointerup", release); key.addEventListener("pointercancel", release); key.addEventListener("lostpointercapture", release); pad.append(key);
  }
  const overlay = el("div", undefined, "game-overlay"); overlay.append(hud, speech, prompt, pad, conversation, status, problem, retry);
  dialog.append(stage, overlay); document.body.append(dialog); dialog.showModal(); stage.focus();

  let response: ConductorResponse | undefined, renderer: GameRenderer | undefined;
  let disposed = false, busy = false, connected = false, generation = 0, walking = false;
  let selectedKey: string | undefined, dismissedEncounter: string | undefined;
  let lastDisplayedEncounterId: string | undefined, dismissedResultEncounterId: string | undefined;
  let streamAbort: AbortController | undefined, animation = 0, heldLoop = false, lastMoveAt = performance.now();
  let encounterKey = "", sectionsHash = "", pending: ConductorCommandV1 | undefined;
  const held = new Map<string, readonly [number, number]>(), labels = new Map<string, number>();
  const allowed = () => !disposed && !busy && connected && response?.snapshot.status === "active";
  const activeConversation = () => {
    const encounter = response?.snapshot.activeEncounter;
    return encounter && `${encounter.encounterId}:${encounter.revision}` !== dismissedEncounter ? encounter : undefined;
  };
  // Reine Anzeigeverknüpfung: niemals einen beendeten nativen Dialog als aktiv
  // ausgeben. Nach einem Reload ohne diese belegte Zuordnung bleibt der Bericht.
  const completedResult = () => !activeConversation() && lastDisplayedEncounterId !== dismissedResultEncounterId
    ? response?.control?.cases.find((record) => record.encounterId === lastDisplayedEncounterId && record.status !== "open") : undefined;
  function passengerName(person: VisiblePassengerV2) {
    if (!labels.has(person.passengerKey)) labels.set(person.passengerKey, labels.size + 1);
    return `Fahrgast ${labels.get(person.passengerKey)}`;
  }
  function showError(error: unknown) {
    const code = error instanceof ConductorApiError ? error.code : "";
    const messages: Record<string, string> = {
      conductor_movement_blocked: "Hier ist kein Durchgang. Wähle einen freien Weg im Gang.",
      conductor_movement_too_fast: "Einen Moment – die letzte Bewegung wird noch bestätigt.",
      conductor_movement_rate_limited: "Einen Moment – der Weg benötigt noch etwas Gehzeit.",
      conductor_passenger_already_inspected: "Diesen Fahrgast hast du bereits kontrolliert. Der Fall steht im Bericht.",
      conductor_encounter_active: "Beende zuerst das aktuelle Gespräch mit einer der Antworten.",
      conductor_inspection_out_of_range: "Gehe näher an den Fahrgast heran.",
      conductor_dialogue_not_ready: "Der Fahrgast antwortet noch.",
      conductor_stale_revision: "Die Fahrt hat sich verändert. Versuche die Handlung erneut.",
      conductor_stale_manifest: "Die Fahrgäste werden aktualisiert. Versuche die Handlung erneut.",
    };
    problem.textContent = messages[code] ?? (error instanceof Error ? error.message : "Die Handlung konnte noch nicht bestätigt werden."); problem.hidden = false;
  }
  function stopWalking() { generation += 1; held.clear(); walking = false; cancelWalk.hidden = true; }
  function focusPlayer() {
    if (!response) return;
    const position = response.snapshot.position;
    const vi = response.layout.vehicles.findIndex((v) => v.vehicleId === position.vehicleId), bi = response.layout.vehicles[vi]?.bodies.findIndex((b) => b.bodyId === position.bodyId);
    if (vi >= 0 && bi !== undefined && bi >= 0) section.value = `${vi}|${bi}|${position.deckId}`;
    renderer?.focusPlayer();
  }
  function setView() {
    if (!response) return;
    const [vi, bi, deck] = section.value.split("|"), vehicle = response.layout.vehicles[Number(vi)], body = vehicle?.bodies[Number(bi)];
    if (vehicle && body) renderer?.setView({ vehicleId: vehicle.vehicleId, bodyId: body.bodyId, deckId: deck as InteriorDeckId, zoom: Number(zoom.value) as 1 | 2 | 3 | 4 });
  }
  section.addEventListener("change", setView); zoom.addEventListener("change", setView);
  function interaction(person: VisiblePassengerV2) {
    const target = person.spaceNeeds === "wheelchair" ? person.spaceId : person.placeId;
    return response?.layout.interactions.find((point) => point.targetId === target);
  }
  function nearbyPassenger() {
    if (!response) return undefined;
    return response.snapshot.passengers.passengers.filter((p) => p.activity === "onboard")
      .map((person) => ({ person, length: distance(response!.snapshot.position, person) }))
      .sort((a, b) => a.length - b.length)[0]?.person;
  }
  function render() {
    if (!response || disposed) return;
    const previousAnswer = document.activeElement instanceof HTMLButtonElement && answers.contains(document.activeElement) ? document.activeElement : undefined;
    const { snapshot, layout, scene } = response, active = activeConversation();
    if (active) lastDisplayedEncounterId = active.encounterId;
    const completed = completedResult(), presentationOpen = !!active || !!completed;
    const people = snapshot.passengers.passengers;
    if (selectedKey && !people.some((p) => p.passengerKey === selectedKey && p.activity === "onboard")) { selectedKey = undefined; stopWalking(); }
    dialog.classList.toggle("game-talking", presentationOpen); conversation.hidden = !presentationOpen;
    practice.disabled = busy || active?.status === "active" || snapshot.status !== "active";
    location.textContent = snapshot.status === "ended" ? "Fahrt beendet" : scene?.station?.name ?? (scene ? `${Math.round(scene.speedMmps * .0036)} km/h · unterwegs` : "Übungsfahrt");
    report.textContent = `Bericht${response.control?.cases.length ? ` · ${response.control.cases.length}` : ""}`;
    if (sectionsHash !== layout.layoutHash) {
      sectionsHash = layout.layoutHash; section.replaceChildren();
      layout.vehicles.forEach((vehicle, vi) => vehicle.bodies.forEach((body, bi) => body.deckIds.forEach((deck) => {
        const option = el("option", `Wagen ${vi + 1} · Teil ${bi + 1} · ${decks[deck]}`); option.value = `${vi}|${bi}|${deck}`; section.append(option);
      }))); focusPlayer(); setView();
    }
    renderer?.update({ layout, passengers: snapshot.passengers, position: snapshot.position, atMs: snapshot.nowMs, scene, selectedPassengerKey: snapshot.activePassengerKey ?? selectedKey });
    const selected = people.find((p) => p.passengerKey === selectedKey), near = selected ?? nearbyPassenger();
    prompt.hidden = presentationOpen;
    promptText.textContent = snapshot.status === "ended" ? "Dein Einsatz ist beendet. Der Bericht bleibt verfügbar."
      : walking ? "Du gehst zum Fahrgast. Richtungstaste drücken bricht den Weg ab."
      : selected ? `${passengerName(selected)} · ${sameSpace(snapshot.position, selected) ? `${(distance(snapshot.position, selected) / 1000).toFixed(1)} m` : "anderes Deck / Wagenteil"}`
      : "Pfeiltasten halten · Fahrgast anklicken · E / Leertaste ansprechen";
    interactButton.disabled = !allowed() || !near || walking;
    interactButton.textContent = selected ? "E · Kontrollieren" : "E · Ansprechen";
    cancelWalk.hidden = !walking;
    status.textContent = !connected ? "Die lokale Fahrt wird wiederhergestellt …" : snapshot.status === "ended" ? "Einsatz beendet" : "";
    status.hidden = !status.textContent;
    retry.hidden = connected;
    const encounterState = `${active?.encounterId}:${active?.revision}:${snapshot.activePassengerKey}:result:${completed?.caseId}`;
    if (encounterState !== encounterKey) {
      encounterKey = encounterState; answers.replaceChildren(); caseResult.hidden = true;
      if (active) {
        const actual = people.find((p) => p.passengerKey === snapshot.activePassengerKey);
        speaker.textContent = actual ? passengerName(actual) : "Fahrgast";
        speechText.textContent = active.passengerText;
        conversationTitle.textContent = active.status === "closed" ? "Kontrolle abgeschlossen" : "Deine Antwort";
        for (const [index, option] of active.options.entries()) {
          const choice = button("", () => { void choose(option.optionId); }); choice.dataset.optionId = option.optionId;
          const number = el("kbd", String(index + 1)), text = el("span", option.text), duration = el("small", `${option.timeCostMs / 1000} s`);
          choice.append(number, text, duration); answers.append(choice);
        }
        if (active.status === "closed") {
          const next = button("Weitergehen", () => { dismissedEncounter = `${active.encounterId}:${active.revision}`; dismissedResultEncounterId = active.encounterId; selectedKey = undefined; render(); stage.focus(); }, "game-continue");
          next.dataset.testid = "game-continue"; answers.append(next);
        }
      } else if (completed) {
        conversationTitle.textContent = completed.claimKind ? "Forderung aufgenommen" : "Kontrolle abgeschlossen";
        evidence.textContent = "Bestätigter Kontrollfall"; wait.textContent = "";
        const next = button("Weitergehen", () => { dismissedResultEncounterId = completed.encounterId; selectedKey = undefined; render(); stage.focus(); }, "game-continue");
        next.dataset.testid = "game-continue"; answers.append(next);
      }
    }
    if (active) {
      const labels = { unchecked: "Fahrkarte ungeprüft", verified_valid: "✓ Gültiger Nachweis", not_presentable: "Nachweis nicht vorzeigbar", verified_invalid: "Ungültiger Nachweis bestätigt" };
      evidence.textContent = labels[active.hints.documentStatus]
        + (active.hints.identityStatus === "refused" ? " · Identitätsklärung verweigert" : "") + (active.hints.concreteDanger ? " · Gefährdung bestätigt" : "");
      const remaining = Math.max(0, Math.ceil((active.availableAtMs - snapshot.nowMs) / 1000));
      wait.textContent = remaining ? `${remaining} s …` : "";
      for (const choice of answers.querySelectorAll<HTMLButtonElement>("button")) choice.disabled = !allowed() || (choice.dataset.optionId !== undefined && remaining > 0);
    }
    const record = completed ?? response.control?.cases.find((row) => row.encounterId === active?.encounterId);
    caseResult.hidden = !record || record.status === "open";
    if (record && record.status !== "open") {
      caseResult.dataset.caseId = record.caseId;
      const minutes = Math.max(0, Math.ceil((record.proofDeadlineMs - snapshot.nowMs) / 60000));
      const text = record.claimKind ? `${record.claimKind === "regular" ? "Reguläre" : "Vorläufige"} Forderung: ${euro(record.claimCents)} · Gezahlt: ${euro(record.paidCents)}`
        + (record.claimKind === "provisional" ? ` · Nachweisfrist: ${minutes > 0 ? `noch ${minutes} Spielminuten` : "abgelaufen"}. Der bestätigte Nachweiseingang kann den Betrag reduzieren.` : "")
        : record.status === "closed_without_claim" ? "Dieser Fall ist ohne Forderung abgeschlossen." : "Kontrollfall bestätigt.";
      if (caseResult.textContent !== text) caseResult.textContent = text;
    } else { delete caseResult.dataset.caseId; caseResult.textContent = ""; }
    if (completed) for (const choice of answers.querySelectorAll<HTMLButtonElement>("button")) choice.disabled = busy;
    if (previousAnswer && !previousAnswer.isConnected) {
      const replacement = [...answers.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.dataset.optionId === previousAnswer.dataset.optionId && !candidate.disabled)
        ?? [...answers.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => !candidate.disabled);
      (replacement ?? stage).focus({ preventScroll: true });
    }
  }
  function accept(value: ConductorResponse) {
    if (response && value.snapshot.sessionId === response.snapshot.sessionId && value.snapshot.sequence < response.snapshot.sequence) return;
    const changedSpace = response && !sameSpace(response.snapshot.position, value.snapshot.position);
    response = value;
    if (value.snapshot.status === "ended") { stopWalking(); streamAbort?.abort(); }
    render(); if (changedSpace) focusPlayer();
  }
  async function send(action: ConductorCommandActionV1): Promise<boolean> {
    if (disposed || busy || !response || !connected || (response.snapshot.status !== "active" && action.type !== "resume_session")) return false;
    const origin = response.snapshot.position, layoutHash = response.layout.layoutHash, encounter = response.snapshot.activeEncounter;
    let command: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: api.worldId, trainRunId: api.trainRunId,
      sessionId: response.snapshot.sessionId, expectedRevision: response.snapshot.revision,
      expectedManifestRevision: response.snapshot.pins.manifestRevision, idempotencyKey: crypto.randomUUID(), action };
    busy = true; problem.hidden = true; render();
    try {
      for (let attempt = 0; ; attempt++) {
        try { accept(await api.command(command)); pending = undefined; return true; }
        catch (error) {
          if (attempt >= 1 || !(error instanceof ConductorApiError) || !["conductor_stale_revision", "conductor_stale_manifest"].includes(error.code)) throw error;
          const latest = await api.snapshot(); accept(latest);
          if (latest.snapshot.status !== "active" || latest.snapshot.sessionId !== command.sessionId || latest.layout.layoutHash !== layoutHash
            || distance(latest.snapshot.position, origin) !== 0 || latest.snapshot.activeEncounter?.encounterId !== encounter?.encounterId
            || latest.snapshot.activeEncounter?.revision !== encounter?.revision) throw error;
          command = { ...command, expectedRevision: latest.snapshot.revision, expectedManifestRevision: latest.snapshot.pins.manifestRevision, idempotencyKey: crypto.randomUUID() };
        }
      }
    } catch (error) {
      showError(error);
      if (!(error instanceof ConductorApiError)) { pending = command; connected = false; streamAbort?.abort(); }
      else { try { accept(await api.snapshot()); } catch { connected = false; } }
      return false;
    } finally { busy = false; render(); }
  }
  async function pacedMove(to: InteriorPointV1, transitionEdgeId: string | null, token: number) {
    const length = transitionEdgeId === null ? distance(response!.snapshot.position, to) : response!.layout.edges.find((edge) => edge.edgeId === transitionEdgeId)?.lengthMm;
    if (length === undefined || !Number.isFinite(length)) { showError(new Error("Der bestätigte Übergang fehlt.")); return false; }
    // Reale Wartezeit aus dem gepinnten Gehbudget; ein Treppenübergang kostet
    // seine native Kantenlänge und wird niemals als kurzer Gehschritt behandelt.
    const interval = Math.max(cadence, Math.ceil(length * 1000 / policy.walkSpeedMmPerSecond));
    await pause(Math.max(0, interval - (performance.now() - lastMoveAt)));
    if (disposed || token !== generation || !allowed()) return false;
    lastMoveAt = performance.now();
    const ok = await send({ type: "move", to, transitionEdgeId }); if (ok) renderer?.focusPlayer(); return ok;
  }
  function beginHold(key: string, dx: number, dy: number) {
    if (activeConversation()?.status === "active") return;
    if (completedResult()) { dismissedResultEncounterId = lastDisplayedEncounterId; render(); }
    if (!held.has(key)) { if (!held.size) stopWalking(); held.set(key, [dx, dy]); }
    if (!heldLoop) void runHeld();
  }
  function endHold(key: string) { held.delete(key); if (!held.size) generation += 1; }
  async function runHeld() {
    heldLoop = true;
    try {
      while (held.size && !disposed) {
        if (!allowed()) { await pause(30); continue; }
        const direction = [...held.values()].at(-1)!, from = response!.snapshot.position, token = generation;
        const to = { ...from, xMm: Math.max(0, from.xMm + direction[0] * stepMm), yMm: Math.max(0, from.yMm + direction[1] * stepMm) };
        if (distance(from, to) === 0 || !await pacedMove(to, null, token)) { held.clear(); break; }
      }
    } finally { heldLoop = false; }
  }
  async function walk(nodeId: string): Promise<boolean> {
    if (!allowed()) return false;
    stopWalking(); const token = generation; walking = true; render();
    try {
      const path = await api.path(nodeId);
      if (!response || path.layoutHash !== response.layout.layoutHash || token !== generation) return false;
      for (const waypoint of path.points) {
        while (response && distance(response.snapshot.position, waypoint.to) > 0) {
          if (disposed || token !== generation || !allowed()) return false;
          const from = response.snapshot.position, dx = waypoint.to.xMm - from.xMm, dy = waypoint.to.yMm - from.yMm;
          const length = Math.abs(dx) + Math.abs(dy);
          const to = waypoint.transitionEdgeId !== null || length <= stepMm ? waypoint.to : { ...from,
            xMm: from.xMm + Math.round(dx * stepMm / length), yMm: from.yMm + Math.round(dy * stepMm / length) };
          if (!await pacedMove(to, waypoint.transitionEdgeId, token)) return false;
        }
      }
      return true;
    } catch (error) { showError(error); return false; }
    finally { if (token === generation) { walking = false; render(); } }
  }
  async function selectPassenger(key: string, approach = false) {
    const existing = activeConversation();
    if (existing?.status === "active") { renderer?.focusPlayer(); return; }
    stopWalking();
    dismissedResultEncounterId = lastDisplayedEncounterId;
    dismissedEncounter = existing ? `${existing.encounterId}:${existing.revision}` : dismissedEncounter;
    selectedKey = key; render();
    if (approach) await interact();
  }
  async function interact() {
    const existing = activeConversation();
    if (existing?.status === "active" || !allowed()) return;
    const person = response!.snapshot.passengers.passengers.find((p) => p.passengerKey === selectedKey && p.activity === "onboard") ?? nearbyPassenger();
    if (!person) return;
    selectedKey = person.passengerKey; render();
    const target = interaction(person), node = response!.layout.nodes.find((n) => n.nodeId === target?.nodeId);
    if (!node) { showError(new Error("Dieser Platz besitzt keinen bestätigten Zugang.")); return; }
    if (distance(response!.snapshot.position, node.point) !== 0 && !await walk(node.nodeId)) return;
    if (await send({ type: "start_inspection", passengerKey: person.passengerKey })) { held.clear(); stage.focus(); }
  }
  async function choose(optionId: string) {
    const active = activeConversation();
    if (!active || active.status !== "active" || !active.options.some((option) => option.optionId === optionId) || !allowed() || response!.snapshot.nowMs < active.availableAtMs) return;
    stopWalking(); await send({ type: optionId === "police" ? "request_police" : "choose_dialogue_option", optionId });
  }
  function attachSpeech() {
    if (disposed) return;
    const active = activeConversation(), key = response?.snapshot.activePassengerKey;
    const point = key ? renderer?.screenPoint(key) : null;
    speech.hidden = !active || !point?.visible;
    const actualSpeaker = key && response?.snapshot.passengers.passengers.some((person) => person.passengerKey === key && person.activity === "onboard");
    if (active && point?.visible && actualSpeaker) speech.dataset.passengerKey = key;
    else delete speech.dataset.passengerKey;
    if (active && point?.visible) {
      const width = stage.clientWidth, height = stage.clientHeight;
      speech.style.left = `${Math.min(width - 12, Math.max(12, point.x))}px`;
      speech.style.top = `${Math.max(hud.offsetHeight + speech.offsetHeight + 25, Math.min(height - 120, point.y - 30))}px`;
      // Die Blase bleibt bei kleinen Displays im Bild; der Stiel zeigt zum Sprite.
      const half = speech.offsetWidth / 2, left = Math.min(width - speech.offsetWidth - 12, Math.max(12, point.x - half));
      speech.style.left = `${Math.max(8, left)}px`; speech.style.setProperty("--speech-tail", `${Math.max(12, Math.min(speech.offsetWidth - 16, point.x - left))}px`);
    }
    animation = requestAnimationFrame(attachSpeech);
  }
  async function listen() {
    if (!response || disposed || response.snapshot.status === "ended") return;
    streamAbort?.abort(); const controller = new AbortController(); streamAbort = controller;
    try {
      await api.stream(response.snapshot.sequence, controller.signal, (value) => {
        if (!response || disposed || controller.signal.aborted) return;
        if (value.schemaVersion === "conductor-scene-update/v1") {
          if (value.sessionId === response.snapshot.sessionId && value.sequence === response.snapshot.sequence) accept({ ...response, scene: value.scene });
        } else if (value.schemaVersion === "conductor-control-update/v1") {
          if (value.sessionId === response.snapshot.sessionId && value.sequence === response.snapshot.sequence) accept({ ...response, control: value.control });
        } else if ("snapshot" in value) accept(value);
        else if (value.pins.interiorLayoutHash === response.layout.layoutHash) accept({ ...response, snapshot: value });
        else { controller.abort(); void recover(); }
      });
    } catch (error) { if (!disposed && !controller.signal.aborted) { connected = false; stopWalking(); showError(error); render(); } }
  }
  async function recover() {
    if (disposed || busy) return;
    busy = true;
    try { const latest = pending ? await api.command(pending) : await api.snapshot(); pending = undefined; accept(latest); connected = true; problem.hidden = true; void listen(); }
    catch (error) { showError(error); connected = false; }
    finally { busy = false; render(); }
  }
  async function leave() {
    if (disposed) return;
    stopWalking();
    while (busy && !disposed) await pause(30);
    if (disposed) return;
    if (response?.snapshot.status === "active" && connected && !await send({ type: "detach_session" })) return;
    disposed = true; streamAbort?.abort(); cancelAnimationFrame(animation); renderer?.dispose();
    window.removeEventListener("blur", stopWalking); document.removeEventListener("visibilitychange", stopWalking);
    dialog.close(); dialog.remove(); input.returnFocus.focus({ preventScroll: true });
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void leave(); });
  const keys: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0], ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1] };
  dialog.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("select,input,textarea") || document.querySelector("dialog.conductor-report[open]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (activeConversation() || completedResult()) {
      const options = [...answers.querySelectorAll<HTMLButtonElement>("button")].filter((choice) => !choice.disabled);
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
        event.preventDefault();
        const current = options.indexOf(document.activeElement as HTMLButtonElement), forward = key === "ArrowDown" || key === "ArrowRight";
        options[current < 0 ? 0 : (current + (forward ? 1 : -1) + options.length) % options.length]?.focus({ preventScroll: false });
        return;
      }
      if (["e", " "].includes(key) && (target === stage || answers.contains(target))) {
        event.preventDefault();
        if (!event.repeat) (options.find((choice) => choice === document.activeElement) ?? options[0])?.click();
        return;
      }
    }
    if (keys[key]) { event.preventDefault(); if (!event.repeat) beginHold(key, ...keys[key]); }
    else if (["e", " "].includes(key) && target.tagName !== "BUTTON") { event.preventDefault(); if (!event.repeat) void interact(); }
    else if (/^[1-9]$/u.test(key) && !event.repeat) {
      const option = activeConversation()?.options[Number(key) - 1]; if (option) { event.preventDefault(); void choose(option.optionId); }
    }
  });
  dialog.addEventListener("keyup", (event) => { const key = event.key.length === 1 ? event.key.toLowerCase() : event.key; if (keys[key]) { event.preventDefault(); endHold(key); } });
  window.addEventListener("blur", stopWalking); document.addEventListener("visibilitychange", stopWalking);
  try {
    const availability = await api.availability();
    if (availability.sessionId === null) {
      const command: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: api.worldId, trainRunId: api.trainRunId,
        sessionId: crypto.randomUUID(), expectedRevision: 0, expectedManifestRevision: null, idempotencyKey: crypto.randomUUID(), action: { type: "start_session" } };
      response = await api.command(command);
    } else response = await api.snapshot();
    if (disposed) return;
    connected = true;
    if (response.snapshot.status === "detached" && !await send({ type: "resume_session" })) throw new Error("Der Einsatz konnte noch nicht fortgesetzt werden.");
    const art = await api.art();
    renderer = await createGameRenderer({ host: stage, art, fetchAtlas: (id) => api.atlas(id),
      onPassengerSelect: (key) => { void selectPassenger(key, true); },
      onPointSelect: (point) => {
        if (activeConversation()?.status === "active") return;
        const node = response?.layout.nodes.filter((n) => sameSpace(n.point, point)).sort((a, b) => distance(a.point, point) - distance(b.point, point))[0];
        if (node) void walk(node.nodeId);
      } });
    if (disposed) { renderer.dispose(); return; }
    render(); setView(); renderer.focusPlayer(); attachSpeech(); void listen(); stage.focus();
  } catch (error) { connected = false; showError(error); retry.hidden = false; status.textContent = "Die Übungsfahrt konnte noch nicht geöffnet werden."; }
}
