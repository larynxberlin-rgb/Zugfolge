import { railwayBrand } from "@zugfolge/design-system";
import "@zugfolge/design-system/railway.css";
import { openGameMode } from "./game-mode.js";
import { createOfflineDemo, clearOfflineDemoSave } from "./bootstrap.js";
import "./demo.css";

const root = document.querySelector<HTMLElement>("#demo-root")!;
root.innerHTML = `<div class="demo-shell">
  <header class="demo-header"><div class="demo-brand">${railwayBrand("#demo-root")}</div><span class="demo-offline"><i aria-hidden="true"></i> OFFLINE-DEMO</span></header>
  <section class="demo-intro" aria-labelledby="demo-title">
    <p class="demo-eyebrow">DEIN EINSATZ AN BORD</p>
    <h1 id="demo-title">Einsteigen.<br>Mitfahren.<br><span>Kontrollieren.</span></h1>
    <p class="demo-lead">Dein Dienst im Regionalzug. Gehe durch die Wagen, sprich mit Fahrgästen und entscheide nach der Fahrkartenprüfung, wie es weitergeht.</p>
    <div class="demo-actions"><button class="demo-start" id="demo-start" data-testid="demo-start" type="button" disabled>Start</button><button class="demo-reset" id="demo-reset" data-testid="demo-reset" type="button" disabled>Neu beginnen</button><button class="demo-reset" id="demo-recover" data-testid="demo-recover" type="button" hidden>Gespeicherte Demo zurücksetzen</button></div>
    <p class="demo-status" id="demo-status" role="status" aria-live="polite">Die Demo wird vorbereitet …</p>
    <p class="demo-error" id="demo-error" role="alert" hidden></p>
  </section>
  <section class="demo-guide" aria-labelledby="demo-guide-title"><h2 id="demo-guide-title">So bist du unterwegs</h2>
    <div class="demo-guide-grid">
      <article><span class="demo-guide-number" aria-hidden="true">01</span><h3>Maus</h3><p><strong>Fahrgast anklicken</strong> und deine Figur geht hin. Die Kontrolle beginnt direkt im Zug; deine Antworten stehen unten im Spiel.</p></article>
      <article><span class="demo-guide-number" aria-hidden="true">02</span><h3>Tastatur</h3><p><strong>Pfeiltasten</strong> oder <strong>W A S D halten</strong> zum Gehen. <strong>E / Leertaste</strong> spricht einen Fahrgast an. Escape pausiert.</p></article>
      <article><span class="demo-guide-number" aria-hidden="true">03</span><h3>Touch</h3><p>Fahrgäste antippen oder das <strong>Steuerkreuz halten</strong>. Die Übungsauswahl führt zu verschiedenen Fahrgästen.</p></article>
    </div>
  </section>
  <footer class="demo-footer"><p>Alles läuft lokal in deinem Browser.</p><p>Keine Anmeldung · kein Internet · keine echten Forderungen</p></footer>
</div>`;

root.querySelector(".demo-brand a")?.setAttribute("aria-label", "Zugfolge – Offline-Demo");
const start = document.querySelector<HTMLButtonElement>("#demo-start")!;
const reset = document.querySelector<HTMLButtonElement>("#demo-reset")!;
const recover = document.querySelector<HTMLButtonElement>("#demo-recover")!;
const status = document.querySelector<HTMLElement>("#demo-status")!;
const problem = document.querySelector<HTMLElement>("#demo-error")!;
let demo: Awaited<ReturnType<typeof createOfflineDemo>> | undefined;
let busy = true, ended = false, modeOpen = false;

function controls() { start.disabled = busy || !demo; reset.disabled = busy || !demo; }
function showError(error: unknown) {
  problem.textContent = error instanceof Error ? error.message : "Die Demo konnte nicht gestartet werden. Öffne die Datei erneut in einem aktuellen Browser.";
  problem.hidden = false;
}
async function updateStart() {
  if (!demo) return;
  const available = await demo.api.availability();
  ended = available.sessionId !== null && (await demo.api.snapshot()).snapshot.status === "ended";
  start.textContent = ended ? "Neue Fahrt starten" : available.sessionId === null ? "Start" : "Fortsetzen";
  status.textContent = (ended ? "Der Einsatz ist beendet. Du kannst eine neue Übungsfahrt beginnen." : "Bereit für deinen Einsatz.")
    + (demo.persistence.message ? ` ${demo.persistence.message}` : "");
}
async function launch(fresh = false) {
  if (busy || !demo || document.querySelector("dialog.game-mode[open]")) return;
  busy = true; controls(); problem.hidden = true; status.textContent = "Du steigst ein …";
  try {
    if (fresh || ended) await demo.reset();
    await openGameMode({ api: demo.api, trainLabel: demo.trainLabel, returnFocus: start,
      movementPolicy: demo.metadata.movementPolicy, practicePassengers: demo.metadata.practicePassengers });
  } catch (error) { showError(error); }
  finally { busy = false; controls(); }
}

const observer = new MutationObserver(() => {
  const dialog = document.querySelector<HTMLDialogElement>("dialog.game-mode");
  if (dialog) {
    modeOpen = true;
  } else if (modeOpen) {
    modeOpen = false;
    void updateStart().catch(showError);
  }
});
observer.observe(document.body, { childList: true });
start.addEventListener("click", () => { void launch(); });
reset.addEventListener("click", () => { void launch(true); });
recover.addEventListener("click", () => {
  recover.disabled = true;
  void Promise.resolve().then(() => clearOfflineDemoSave()).then(() => location.reload()).catch((error: unknown) => { recover.disabled = false; showError(error); });
});
window.addEventListener("pagehide", () => { observer.disconnect(); demo?.dispose(); }, { once: true });

void (async () => {
  try {
    if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID || typeof WebAssembly === "undefined") {
      throw new Error("Diese Demo benötigt einen aktuellen Browser mit WebAssembly und WebCrypto. Öffne die HTML-Datei zum Beispiel in Edge, Chrome oder Firefox.");
    }
    demo = await createOfflineDemo();
    (window as unknown as { __zugfolgeOfflineDemo: unknown }).__zugfolgeOfflineDemo = Object.freeze({
      snapshot: () => demo!.snapshot(), metadata: demo.metadata,
      performance: () => demo!.performance(),
      get persistence() { return Object.freeze({ ...demo!.persistence }); },
    });
    await updateStart();
    document.documentElement.dataset["offlineReady"] = "true";
  } catch (error) { showError(error); status.textContent = "Die Demo ist noch nicht startbereit."; recover.hidden = false; }
  finally { busy = false; controls(); }
})();
