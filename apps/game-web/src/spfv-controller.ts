import { GameApiClient } from "./api.js";
import { ensureAccessToken, loadRuntimeConfiguration, validateRuntimeConfiguration } from "./auth.js";
import { renderSpfv, parseSpfvDraft, spfvReturnDestination, type SpfvCatalog, type SpfvLineDraft, type SpfvPreview, type SpfvSubmission } from "./spfv.js";

/** The review is tied to the exact current draft; editing immediately invalidates it. */
export async function mountSpfv(app: HTMLElement): Promise<void> {
  const parameters = new URLSearchParams(window.location.search);
  const runtime = loadRuntimeConfiguration();
  const worldId = runtime.publicWorldId;
  const referenceTrainId = parameters.get("train") ?? undefined;
  let operatorId = parameters.get("operator") ?? "";
  let catalog: SpfvCatalog | undefined;
  let draft: SpfvLineDraft | undefined;
  let stopIds: string[] = [];
  let preview: SpfvPreview | undefined;
  let submission: SpfvSubmission | undefined;
  let busy = true;
  let message = "";
  let error = false;
  let revision = 0;
  let api: GameApiClient | undefined;
  let retainedFields: Record<string, string> | undefined;
  const commandIds = new Map<string, string>();
  const liveUrl = (): string => {
    const page = new URL(window.location.href); if (operatorId) page.searchParams.set("operator", operatorId);
    return spfvReturnDestination(runtime.livemapUrl, page.href, worldId);
  };
  const capture = (): Record<string, string> => {
    const form = app.querySelector<HTMLFormElement>("#spfv-form");
    return form === null ? retainedFields ?? {} : Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
  };
  const invalidate = (): void => {
    ++revision; preview = undefined; submission = undefined;
    app.querySelector(".spfv-preview")?.remove();
  };
  const render = (): void => {
    app.innerHTML = renderSpfv({ worldId, operatorId, liveUrl: liveUrl(), ...(catalog ? {catalog} : {}), ...(draft ? {draft} : {}), stopIds, ...(preview ? {preview} : {}), busy, message, error, ...(referenceTrainId ? {referenceTrainId} : {}), ...(submission ? {submission} : {}) });
    if (retainedFields !== undefined) {
      app.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#spfv-form [name]").forEach((control) => { const value = retainedFields?.[control.name]; if (value !== undefined) control.value = value; });
    }
    app.querySelector("#spfv-retry")?.addEventListener("click", () => void load());
    const form = app.querySelector<HTMLFormElement>("#spfv-form");
    form?.addEventListener("input", invalidate);
    form?.addEventListener("change", invalidate);
    form?.addEventListener("submit", (event) => { event.preventDefault(); void check(); });
    const changeStops = (action: () => void): void => { retainedFields = capture(); invalidate(); action(); render(); app.querySelector<HTMLElement>("#spfv-stop-option")?.focus(); };
    app.querySelector("#spfv-add-stop")?.addEventListener("click", () => {
      const id = app.querySelector<HTMLSelectElement>("#spfv-stop-option")?.value;
      if (id && !stopIds.includes(id) && stopIds.length < 32) changeStops(() => { stopIds.push(id); });
    });
    app.querySelectorAll<HTMLButtonElement>("[data-stop-remove]").forEach((button) => button.addEventListener("click", () => changeStops(() => { stopIds.splice(Number(button.dataset["stopRemove"]), 1); })));
    for (const direction of ["up", "down"] as const) app.querySelectorAll<HTMLButtonElement>(`[data-stop-${direction}]`).forEach((button) => button.addEventListener("click", () => changeStops(() => {
      const index = Number(button.dataset[direction === "up" ? "stopUp" : "stopDown"]); const next = index + (direction === "up" ? -1 : 1);
      if (next >= 0 && next < stopIds.length) [stopIds[index], stopIds[next]] = [stopIds[next]!, stopIds[index]!];
    })));
    app.querySelector<HTMLSelectElement>("#spfv-line")?.addEventListener("change", (event) => {
      const line = catalog?.lines.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
      invalidate(); retainedFields = undefined;
      draft = line === undefined ? undefined : { ...line, lineId: line.id };
      stopIds = line === undefined ? [] : [...line.stopIds]; render();
    });
    app.querySelector<HTMLButtonElement>("#spfv-confirm")?.addEventListener("click", () => void confirm());
  };
  const failure = (value: unknown): void => { error = true; message = value instanceof Error ? value.message : "Die Fernverkehrsplanung ist gerade nicht verfügbar."; };
  const load = async (): Promise<void> => {
    busy = true; error = false; message = ""; render();
    try {
      validateRuntimeConfiguration(runtime);
      const token = await ensureAccessToken(runtime); if (token === "") return;
      api = new GameApiClient(runtime.gameApiUrl, (refresh) => ensureAccessToken(runtime, refresh));
      const context = await api.loadPlayerOperatorContext(worldId);
      const own = context.operators.map((operator) => operator.id);
      if (!own.includes(operatorId)) operatorId = own[0] ?? "";
      if (operatorId === "") throw new Error("Gründe oder wähle zuerst dein Unternehmen im Bereich Unternehmen.");
      catalog = await api.loadSpfvCatalog(worldId, operatorId, referenceTrainId);
      const line = referenceTrainId === undefined ? undefined : catalog.lines.find((item) => item.referenceTrainId === referenceTrainId);
      if (line !== undefined) { draft = { ...line, lineId: line.id }; stopIds = [...line.stopIds]; }
      else if (parameters.get("station") && catalog.stops.some((item) => item.id === parameters.get("station"))) stopIds = [parameters.get("station")!];
    } catch (value) { failure(value); }
    finally { busy = false; render(); }
  };
  const check = async (): Promise<void> => {
    if (!catalog || !api || busy) return;
    retainedFields = capture();
    try { draft = parseSpfvDraft(retainedFields, stopIds, catalog, referenceTrainId); }
    catch (value) { failure(value); render(); return; }
    const current = ++revision; preview = undefined; busy = true; error = false; message = ""; render();
    try {
      const result = await api.previewSpfv(worldId, operatorId, draft);
      if (revision !== current) { message = "Dein Angebot wurde während der Prüfung geändert. Prüfe die neue Fassung erneut."; return; }
      retainedFields = capture(); preview = result;
    } catch (value) { failure(value); }
    finally { retainedFields = capture(); busy = false; render(); app.querySelector<HTMLElement>(".spfv-preview")?.focus({preventScroll: true}); }
  };
  const confirm = async (): Promise<void> => {
    if (!api || !preview?.confirmationAllowed || busy) return;
    const acceptedPreview = preview;
    let commandId = commandIds.get(acceptedPreview.previewId);
    if (commandId === undefined) { commandId = crypto.randomUUID(); commandIds.set(acceptedPreview.previewId, commandId); }
    busy = true; message = "Deine Linie wird zur Trassenplanung eingereicht …"; error = false;
    app.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(".spfv-workspace button, .spfv-workspace input, .spfv-workspace select").forEach((control) => { control.disabled = true; });
    try { submission = await api.confirmSpfv(worldId, operatorId, acceptedPreview.previewId, commandId); preview = undefined; message = "Deine Einreichung wurde bestätigt. Die endgültige Trassenvergabe steht noch aus."; }
    catch (value) { failure(value); }
    finally { busy = false; render(); }
  };
  await load();
}
