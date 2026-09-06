import type { ConductorCommandActionV1, ConductorCommandV1, InteriorDeckId, InteriorPointV1, VisiblePassengerV2 } from "@zugfolge/runtime-native";
import { ConductorApi, ConductorApiError, type ConductorResponse } from "./conductor-api.js";
import { createConductorRenderer, type ConductorRenderer } from "./conductor-renderer.js";
import { openConductorReport, renderConductorControlReport } from "./conductor-report.js";
import "./conductor.css";

const deckLabels = { main: "Hauptdeck", lower: "Unterdeck", upper: "Oberdeck" };
const spaceLabels = { ordinary: "", wheelchair: "Rollstuhlplatz", bicycle: "mit Fahrrad", stroller: "mit Kinderwagen" };
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value;
}
function button(text: string, act: () => void): HTMLButtonElement { const value = element("button", text); value.type = "button"; value.addEventListener("click", act); return value; }
const sameSpace = (a: InteriorPointV1, b: InteriorPointV1) => a.vehicleId === b.vehicleId && a.bodyId === b.bodyId && a.deckId === b.deckId;
const distance = (a: InteriorPointV1, b: InteriorPointV1) => sameSpace(a, b) ? Math.abs(a.xMm - b.xMm) + Math.abs(a.yMm - b.yMm) : Infinity;
const pause = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration));

export async function openConductorMode(input: { api: ConductorApi; trainLabel: string; returnFocus: HTMLElement }): Promise<void> {
  const { api } = input;
  const dialog = element("dialog", undefined, "conductor-mode");
  dialog.setAttribute("aria-labelledby", "conductor-title");
  const header = element("header", undefined, "conductor-header"), heading = element("div");
  heading.append(element("p", "UNTERWEGS IM ZUG", "conductor-eyebrow"));
  const title = element("h1", input.trainLabel); title.id = "conductor-title"; heading.append(title);
  const close = button("Zur Karte", () => { void leave(false); }); close.className = "conductor-back"; header.append(heading, close);
  const status = element("p", "Fahrt wird geöffnet …", "conductor-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const problem = element("p", undefined, "conductor-problem"); problem.setAttribute("role", "alert"); problem.hidden = true;
  const tools = element("nav", undefined, "conductor-tools"); tools.setAttribute("aria-label", "Innenraumansicht");
  const sectionLabel = element("label", "Wagen und Deck "), section = element("select"); sectionLabel.append(section); tools.append(sectionLabel);
  const zoomLabel = element("label", "Zoom "), zoom = element("select");
  for (const value of [1, 2, 3, 4]) { const option = element("option", `${value}×`); option.value = String(value); zoom.append(option); } zoom.value = "2";
  zoomLabel.append(zoom); tools.append(zoomLabel);
  tools.append(button("Zu meiner Position", () => focusPlayer()), button("Ansicht ←", () => renderer?.panBy(-200)), button("Ansicht →", () => renderer?.panBy(200)));
  const content = element("div", undefined, "conductor-content"), visual = element("section", undefined, "conductor-visual");
  const stage = element("div", undefined, "conductor-stage"); stage.tabIndex = 0; stage.setAttribute("aria-label", "Innenraum. Pfeiltasten oder W A S D bewegen deine Figur.");
  const movement = element("div", undefined, "conductor-movement"); movement.setAttribute("aria-label", "Bewegen");
  const directions: [string, number, number][] = [["←", -500, 0], ["↑", 0, -500], ["↓", 0, 500], ["→", 500, 0]];
  for (const [label, x, y] of directions) {
    const control = button(label, () => { void step(x, y); }); control.setAttribute("aria-label", `Gehen ${label}`); control.dataset["action"] = "move"; movement.append(control);
  }
  const stop = button("Weg abbrechen", () => { ++walkGeneration; }); movement.append(stop);
  const instruction = element("p", "Fahrgast auswählen, hingehen und die Kontrolle beginnen. Pfeiltasten bewegen dich im Innenraum.", "conductor-help");
  visual.append(stage, movement, instruction);
  const sidebar = element("aside", undefined, "conductor-sidebar"), passengerTitle = element("h2", "Fahrgäste"), count = element("span"); passengerTitle.append(count);
  const filter = element("input"); filter.type = "search"; filter.placeholder = "Fahrgast oder Wagen suchen"; filter.setAttribute("aria-label", "Fahrgastliste filtern");
  const list = element("div", undefined, "conductor-passengers"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Vollständige Fahrgastliste");
  const selectedInfo = element("section", undefined, "conductor-selected"), encounter = element("section", undefined, "conductor-encounter");
  encounter.setAttribute("aria-label", "Fahrkartenkontrolle"); encounter.tabIndex = -1;
  const controlStatus = element("section", undefined, "conductor-control-status"); controlStatus.setAttribute("aria-label", "Kontrollfälle und Polizeihalt");
  sidebar.append(passengerTitle, filter, list, selectedInfo, encounter, controlStatus); content.append(visual, sidebar);
  const footer = element("footer", undefined, "conductor-footer"), reconnect = button("Verbindung wiederherstellen", () => { void recover(); }); reconnect.hidden = true;
  const retry = button("Letzte Handlung erneut bestätigen", () => { if (pending) void send(pending.action, pending); }); retry.hidden = true;
  const finish = button("Schaffnersitzung beenden", () => { void leave(true); });
  const reportButton = button("Kontrollbericht", () => { void openConductorReport({ api, trainLabel: input.trainLabel, returnFocus: reportButton }); });
  footer.append(reportButton, reconnect, retry, finish); dialog.append(header, status, problem, tools, content, footer);
  document.body.append(dialog); dialog.showModal(); close.focus();

  let response: ConductorResponse | undefined, renderer: ConductorRenderer | undefined;
  let disposed = false, connected = false, busy = false, walkGeneration = 0, selectedKey: string | undefined;
  let pending: ConductorCommandV1 | undefined, streamAbort: AbortController | undefined;
  let listKey = "", encounterKey = "", viewKey = "", selectedRenderKey = "", controlKey = "";
  const labels = new Map<string, number>();
  function showError(error: unknown) { problem.textContent = error instanceof Error ? error.message : "Die Handlung konnte nicht bestätigt werden."; problem.hidden = false; }
  function actionEnabled() { return !disposed && connected && !busy && response?.snapshot.status === "active"; }
  function passengerLabel(person: VisiblePassengerV2): string {
    if (!labels.has(person.passengerKey)) labels.set(person.passengerKey, labels.size + 1);
    const vehicle = response!.layout.vehicles.findIndex((row) => row.vehicleId === person.vehicleId) + 1;
    return `Fahrgast ${labels.get(person.passengerKey)} · Wagen ${vehicle}, ${deckLabels[person.deckId]}${person.posture === "standing" ? " · steht" : ""}${person.spaceNeeds === "ordinary" ? "" : ` · ${spaceLabels[person.spaceNeeds]}`}`;
  }
  function selectPassenger(key: string) { selectedKey = key; selectedRenderKey = ""; render(); }
  function setView() {
    if (!response) return;
    const parts = section.value.split("|");
    const vehicle = response.layout.vehicles[Number(parts[0])], body = vehicle?.bodies[Number(parts[1])];
    if (vehicle && body) renderer?.setView({ vehicleId: vehicle.vehicleId, bodyId: body.bodyId, deckId: parts[2] as InteriorDeckId, zoom: Number(zoom.value) as 1 | 2 | 3 | 4 });
  }
  function focusPlayer() {
    if (!response) return;
    const { position } = response.snapshot;
    const vehicleIndex = response.layout.vehicles.findIndex((vehicle) => vehicle.vehicleId === position.vehicleId);
    const bodyIndex = response.layout.vehicles[vehicleIndex]?.bodies.findIndex((body) => body.bodyId === position.bodyId);
    if (vehicleIndex < 0 || bodyIndex === undefined || bodyIndex < 0) return;
    section.value = `${vehicleIndex}|${bodyIndex}|${position.deckId}`;
    renderer?.focusPlayer();
  }
  section.addEventListener("change", setView); zoom.addEventListener("change", setView);
  filter.addEventListener("input", () => { listKey = ""; render(); });
  function render() {
    if (!response || disposed) return;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedKey = priorFocus?.dataset["conductorFocus"];
    const { snapshot, layout, scene } = response;
    const people = snapshot.passengers.passengers;
    if (selectedKey && !people.some((person) => person.passengerKey === selectedKey && person.activity === "onboard")) { selectedKey = undefined; ++walkGeneration; }
    count.textContent = ` · ${people.length}`;
    status.textContent = snapshot.status === "ended" ? "Diese Schaffnersitzung ist beendet. Du kannst zur Karte zurückkehren."
      : !connected ? "Verbindung unterbrochen · letzter bestätigter Stand" : busy ? "Handlung wird bestätigt …"
      : `${scene?.station?.name ?? "Auf der Fahrt"}${scene ? ` · ${Math.round(scene.speedMmps * 0.0036)} km/h` : ""} · ${people.length} Fahrgäste an Bord`;
    reconnect.hidden = connected || snapshot.status === "ended"; retry.hidden = !pending || busy;
    finish.disabled = busy || !connected || snapshot.status === "ended";
    for (const control of movement.querySelectorAll<HTMLButtonElement>("button[data-action]")) control.disabled = !actionEnabled();
    renderer?.update({ layout, passengers: snapshot.passengers, position: snapshot.position, atMs: snapshot.nowMs, scene, selectedPassengerKey: selectedKey });
    if (viewKey !== layout.layoutHash) {
      viewKey = layout.layoutHash; section.replaceChildren();
      layout.vehicles.forEach((vehicle, vehicleIndex) => vehicle.bodies.forEach((body, bodyIndex) => body.deckIds.forEach((deck) => {
        const option = element("option", `Wagen ${vehicleIndex + 1} · Teil ${bodyIndex + 1} · ${deckLabels[deck]}`);
        option.value = `${vehicleIndex}|${bodyIndex}|${deck}`; section.append(option);
        if (sameSpace(snapshot.position, { ...snapshot.position, vehicleId: vehicle.vehicleId, bodyId: body.bodyId, deckId: deck })) section.value = option.value;
      })));
      setView();
    }
    const key = `${snapshot.pins.projectionHash}:${filter.value}:${selectedKey ?? ""}`;
    if (listKey !== key) {
      listKey = key;
      const query = filter.value.toLocaleLowerCase("de"), fragment = document.createDocumentFragment();
      for (const person of people) {
        const label = passengerLabel(person); if (query && !label.toLocaleLowerCase("de").includes(query)) continue;
        const row = button(label, () => selectPassenger(person.passengerKey)); row.className = "conductor-passenger";
        row.dataset["conductorFocus"] = `passenger:${person.passengerKey}`;
        row.setAttribute("aria-pressed", String(person.passengerKey === selectedKey)); row.disabled = person.activity !== "onboard"; fragment.append(row);
      }
      if (!fragment.childNodes.length) fragment.append(element("p", people.length ? "Keine passenden Fahrgäste." : "Im aktuellen Fahrtabschnitt sind keine Fahrgäste an Bord."));
      list.replaceChildren(fragment);
    }
    const selectionKey = `${selectedKey}:${snapshot.position.xMm}:${snapshot.position.yMm}:${snapshot.position.bodyId}:${snapshot.position.deckId}`;
    if (selectedRenderKey !== selectionKey) {
      selectedRenderKey = selectionKey; selectedInfo.replaceChildren();
      const passenger = people.find((person) => person.passengerKey === selectedKey);
      if (passenger) {
        const go = button("Zum Fahrgast gehen", () => { void walkToPassenger(passenger); }); go.disabled = !actionEnabled();
        const inspect = button("Fahrkarte kontrollieren", () => { void send({ type: "start_inspection", passengerKey: passenger.passengerKey }).then((ok) => { if (ok) encounter.focus(); }); });
        go.dataset["conductorFocus"] = "go"; inspect.dataset["conductorFocus"] = "inspect";
        inspect.disabled = !actionEnabled();
        selectedInfo.append(element("h3", passengerLabel(passenger)), element("p", Number.isFinite(distance(snapshot.position, passenger))
          ? `Entfernung: ${(distance(snapshot.position, passenger) / 1000).toFixed(1)} m` : "Die Person befindet sich in einem anderen Wagenteil oder Deck."), go, inspect);
      }
    }
    const active = snapshot.activeEncounter;
    const newEncounterKey = `${active?.encounterId}:${active?.revision}:${active ? snapshot.nowMs >= active.availableAtMs : true}`;
    if (encounterKey !== newEncounterKey) {
      encounterKey = newEncounterKey; encounter.replaceChildren();
      if (active) {
        encounter.append(element("h2", active.status === "closed" ? "Kontrolle abgeschlossen" : "Fahrkartenkontrolle"), element("blockquote", active.passengerText));
        const documentLabels = { unchecked: "Fahrkarte noch nicht geprüft", verified_valid: "Gültiger Nachweis bestätigt", not_presentable: "Nachweis derzeit nicht vorzeigbar", verified_invalid: "Ungültiger Nachweis bestätigt" };
        encounter.append(element("p", documentLabels[active.hints.documentStatus], "conductor-evidence"));
        if (active.hints.identityStatus === "refused") encounter.append(element("p", "Identitätsklärung wurde verweigert.", "conductor-evidence"));
        if (active.hints.concreteDanger) encounter.append(element("p", "Eine konkrete Gefährdung wurde festgestellt.", "conductor-evidence"));
        if (snapshot.nowMs < active.availableAtMs) encounter.append(element("p", "Die vorherige Handlung läuft noch. Warte auf den nächsten bestätigten Stand."));
        for (const option of active.options) {
          const control = button(`${option.text} · ${option.timeCostMs / 1000} s`, () => { void choose(option.optionId, option.text); });
          control.dataset["conductorFocus"] = `option:${option.optionId}`;
          control.disabled = !actionEnabled() || snapshot.nowMs < active.availableAtMs; encounter.append(control);
        }
      } else encounter.append(element("h2", "Fahrkartenkontrolle"), element("p", "Wähle eine Person in deiner Nähe und beginne die Kontrolle."));
    }
    for (const control of selectedInfo.querySelectorAll("button")) control.disabled = !actionEnabled();
    for (const control of encounter.querySelectorAll("button")) control.disabled = !actionEnabled() || !!active && snapshot.nowMs < active.availableAtMs;
    const nextControlKey = JSON.stringify(response.control);
    if (controlKey !== nextControlKey) {
      controlKey = nextControlKey;
      if (response.control) renderConductorControlReport(controlStatus, response.control, snapshot.nowMs);
      else controlStatus.replaceChildren();
    }

    if (focusedKey && priorFocus && !priorFocus.isConnected) {
      const replacement = [...dialog.querySelectorAll<HTMLElement>("[data-conductor-focus]")].find((node) => node.dataset["conductorFocus"] === focusedKey);
      if (replacement && !(replacement instanceof HTMLButtonElement && replacement.disabled)) replacement.focus({ preventScroll: true });
      else encounter.focus({ preventScroll: true });
    }
  }
  function accept(value: ConductorResponse) {
    if (response && value.snapshot.sessionId === response.snapshot.sessionId && value.snapshot.sequence < response.snapshot.sequence) return;
    const changedSpace = response && !sameSpace(response.snapshot.position, value.snapshot.position);
    if (value.snapshot.status === "ended") {
      streamAbort?.abort(); ++walkGeneration; pending = undefined; problem.hidden = true;
    }
    response = value; render();
    if (changedSpace) focusPlayer();
  }
  async function send(action: ConductorCommandActionV1, original?: ConductorCommandV1): Promise<boolean> {
    const resumeAllowed = action.type === "resume_session" && !disposed && connected && response?.snapshot.status === "detached";
    if ((!original && !actionEnabled() && !resumeAllowed) || busy || !response) return false;
    ++walkGeneration;
    let command: ConductorCommandV1 = original ?? { schemaVersion: "conductor-command/v1", worldId: api.worldId, trainRunId: api.trainRunId,
      sessionId: response.snapshot.sessionId, expectedRevision: response.snapshot.revision,
      expectedManifestRevision: response.snapshot.pins.manifestRevision, idempotencyKey: crypto.randomUUID(), action };
    busy = true; problem.hidden = true; render();
    const startPosition = response.snapshot.position, startLayout = response.layout.layoutHash;
    try {
      for (let attempt = 0; ; attempt++) {
        try { const value = await api.command(command); pending = undefined; accept(value); return true; }
        catch (error) {
          if (original || action.type !== "move" || attempt >= 2 || !(error instanceof ConductorApiError)
            || error.status !== 409 || error.code !== "conductor_stale_revision") throw error;
          const latest = await api.snapshot(); accept(latest);
          // A confirmed rejection has no effect. Rebind the same target only
          // when a concurrent clock/snapshot update left the player's origin intact.
          if (latest.snapshot.sessionId !== command.sessionId || latest.snapshot.status !== "active" || latest.layout.layoutHash !== startLayout
            || !sameSpace(latest.snapshot.position, startPosition) || distance(latest.snapshot.position, startPosition) !== 0) throw error;
          command = { ...command, expectedRevision: latest.snapshot.revision, expectedManifestRevision: latest.snapshot.pins.manifestRevision,
            idempotencyKey: crypto.randomUUID() };
        }
      }
    }
    catch (error) {
      showError(error);
      if (!(error instanceof ConductorApiError)) { pending = command; connected = false; streamAbort?.abort(); }
      else { pending = undefined; try { accept(await api.snapshot()); } catch { connected = false; } }
      return false;
    } finally { busy = false; render(); }
  }
  async function step(x: number, y: number) {
    if (!response) return;
    const from = response.snapshot.position;
    await send({ type: "move", to: { ...from, xMm: Math.max(0, from.xMm + x), yMm: Math.max(0, from.yMm + y) }, transitionEdgeId: null });
  }
  async function walk(nodeId: string) {
    if (!actionEnabled()) return;
    const generation = ++walkGeneration;
    try {
      const path = await api.path(nodeId);
      if (!response || path.layoutHash !== response.layout.layoutHash || generation !== walkGeneration) return;
      for (const waypoint of path.points) {
        while (response && (distance(response.snapshot.position, waypoint.to) > 0 || !sameSpace(response.snapshot.position, waypoint.to))) {
          if (disposed || generation !== walkGeneration || !actionEnabled()) return;
          const from = response.snapshot.position, dx = waypoint.to.xMm - from.xMm, dy = waypoint.to.yMm - from.yMm;
          const length = Math.max(Math.abs(dx), Math.abs(dy));
          const to = waypoint.transitionEdgeId !== null || length <= 500 ? waypoint.to : { ...from,
            xMm: from.xMm + Math.round(dx * 500 / length), yMm: from.yMm + Math.round(dy * 500 / length) };
          // Waiting advances no local state; every segment still needs a native receipt.
          await pause(500);
          if (generation !== walkGeneration || disposed) return;
          const before = walkGeneration;
          const ok = await send({ type: "move", to, transitionEdgeId: waypoint.transitionEdgeId });
          if (!ok) return;
          if (walkGeneration === before + 1) walkGeneration = generation; else return;
        }
      }
    } catch (error) { showError(error); }
  }
  async function walkToPassenger(person: VisiblePassengerV2) {
    const target = person.spaceNeeds === "wheelchair" ? person.spaceId : person.placeId;
    const nodeId = response?.layout.interactions.find((interaction) => interaction.targetId === target)?.nodeId;
    if (nodeId) await walk(nodeId); else showError(new Error("Für diesen Platz ist kein begehbarer Zugang verfügbar."));
  }
  async function choose(optionId: string, label: string) {
    if (!actionEnabled()) return;
    // This corpus exposes short semantic option IDs; all authority remains on the server.
    if (["police", "regular", "provisional"].includes(optionId)) {
      const confirmed = await confirm(optionId === "police" ? "Polizei anfordern?" : label,
        optionId === "police" ? "Die Fahrt kann am nächsten geeigneten Halt aufgehalten werden. Die betriebliche Verspätung wirkt auch auf weitere Fahrten und Anschlüsse."
          : "Der bestätigte Prüfbefund entscheidet über die Forderung. Ein späterer Nachweis kann eine vorläufige Forderung reduzieren; das Ergebnis wird im Fall dokumentiert.");
      if (!confirmed) return;
    }
    await send({ type: optionId === "police" ? "request_police" : "choose_dialogue_option", optionId });
  }
  function confirm(titleText: string, explanation: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = element("dialog", undefined, "conductor-confirm"), title = element("h2", titleText); title.id = "conductor-confirm-title";
      modal.setAttribute("aria-labelledby", title.id); modal.append(title, element("p", explanation));
      const finish = (value: boolean) => { modal.close(); modal.remove(); encounter.focus(); resolve(value); };
      modal.append(button("Abbrechen", () => finish(false)), button("Bestätigen", () => finish(true)));
      modal.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); }); dialog.append(modal); modal.showModal(); modal.querySelector("button")?.focus();
    });
  }
  async function listen() {
    if (!response || disposed || response.snapshot.status === "ended") return;
    streamAbort?.abort(); const controller = new AbortController(); streamAbort = controller;
    try {
      await api.stream(response.snapshot.sequence, controller.signal, (value) => {
        if (disposed || controller.signal.aborted || !response) return;
        if (value.schemaVersion === "conductor-scene-update/v1") {
          if (value.sessionId === response.snapshot.sessionId && value.sequence === response.snapshot.sequence) accept({ ...response, scene: value.scene });
        } else if (value.schemaVersion === "conductor-control-update/v1") {
          if (value.sessionId === response.snapshot.sessionId && value.sequence === response.snapshot.sequence) accept({ ...response, control: value.control });
        } else if ("snapshot" in value) accept(value);
        else if (value.pins.interiorLayoutHash === response.layout.layoutHash) accept({ ...response, snapshot: value });
        else { controller.abort(); void recover(); }
      });
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      connected = false; ++walkGeneration; showError(error); render();
      await pause(1500); if (!disposed && !pending && streamAbort === controller) await recover();
    }
  }
  async function recover() {
    if (disposed || busy) return;
    try { accept(await api.snapshot()); connected = true; problem.hidden = true; render(); void listen(); }
    catch (error) { connected = false; showError(error); render(); }
  }
  async function leave(end: boolean) {
    if (busy || disposed) return;
    ++walkGeneration;
    if (response?.snapshot.status === "active" && connected) {
      const ok = await send({ type: end ? "end_session" : "detach_session" });
      if (!ok && end) return;
    }
    disposed = true; streamAbort?.abort(); renderer?.dispose(); dialog.close(); dialog.remove(); input.returnFocus.focus({ preventScroll: true });
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void leave(false); });
  stage.addEventListener("keydown", (event) => {
    const move: Record<string, [number, number]> = { ArrowLeft: [-500, 0], a: [-500, 0], ArrowRight: [500, 0], d: [500, 0], ArrowUp: [0, -500], w: [0, -500], ArrowDown: [0, 500], s: [0, 500] };
    const direction = move[event.key]; if (direction) { event.preventDefault(); if (!event.repeat) void step(...direction); }
  });
  try {
    const available = await api.availability();
    if (available.sessionId === null) {
      const command: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: api.worldId, trainRunId: api.trainRunId,
        sessionId: crypto.randomUUID(), expectedRevision: 0, expectedManifestRevision: null,
        idempotencyKey: crypto.randomUUID(), action: { type: "start_session" } };
      try { response = await api.command(command); }
      catch (error) { if (!(error instanceof ConductorApiError)) { response = await api.command(command); } else throw error; }
    } else {
      response = await api.snapshot();
      if (response.snapshot.status === "detached") {
        connected = true;
        if (!await send({ type: "resume_session" })) throw new Error("Die pausierte Sitzung konnte noch nicht fortgesetzt werden. Stelle die Verbindung erneut her.");
      }
    }
    if (disposed) return;
    connected = true; render();
    try {
      const art = await api.art();
      renderer = await createConductorRenderer({ host: stage, art, fetchAtlas: (fileId) => api.atlas(fileId), onPassengerSelect: selectPassenger,
        onPointSelect(point) {
          const node = response?.layout.nodes.filter((node) => sameSpace(node.point, point)).sort((a, b) => distance(a.point, point) - distance(b.point, point))[0];
          if (node) void walk(node.nodeId);
        } });
      if (disposed) { renderer.dispose(); return; }
      renderer.update({ layout: response.layout, passengers: response.snapshot.passengers, position: response.snapshot.position, atMs: response.snapshot.nowMs, scene: response.scene });
      setView(); renderer.focusPlayer(); render();
    } catch (error) { showError(new Error(`Die Innenraumgrafik konnte nicht geladen werden. Die vollständige Fahrgastliste und Bedienung bleiben verfügbar. ${error instanceof Error ? error.message : ""}`)); }
    void listen();
  } catch (error) { showError(error); status.textContent = "Der Schaffnermodus kann für diese Fahrt gerade nicht geöffnet werden."; finish.disabled = true; }
}
