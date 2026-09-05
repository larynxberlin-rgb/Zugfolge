/** Rein erklärende Hilfe; kein Aufruf von Spielkommandos und kein eigener Spielzustand. */
export interface GameHint {
  readonly id: string;
  readonly selector: string;
  readonly title: string;
  readonly text: string;
}

export interface GameHintPreferences {
  readonly enabled: boolean;
  readonly visited: readonly string[];
}

const PREFERENCE_KEY = "zugfolge:game-hints:v1";
let nextTooltipId = 0;

export function readGameHintPreferences(storage: Pick<Storage, "getItem"> | undefined): GameHintPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFERENCE_KEY) ?? "null");
    if (value !== null && typeof value === "object") {
      const data = value as Record<string, unknown>;
      if (typeof data["enabled"] === "boolean" && Array.isArray(data["visited"])) {
        return { enabled: data["enabled"], visited: data["visited"].filter((id): id is string => typeof id === "string").slice(0, 200) };
      }
    }
  } catch { /* Gesperrter oder beschädigter Browserspeicher verhindert keine Hilfe. */ }
  return { enabled: true, visited: [] };
}

/** Tooltipps hängen ausschließlich an tatsächlich vorhandenen Bedienelementen. */
export function mountGameHints(root: HTMLElement, hints: readonly GameHint[]): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  let storage: Storage | undefined;
  try { storage = win.localStorage; } catch { /* Privater Browsermodus. */ }
  let preferences = readGameHintPreferences(storage);
  const host = doc.createElement("div");
  host.className = "zf-game-hints";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "zf-game-hints-toggle";
  toggle.textContent = "Spielhinweise";
  toggle.title = "Erklärungen direkt an den Bedienelementen ein- oder ausschalten";
  const tooltip = doc.createElement("div");
  tooltip.id = `zf-game-hint-tooltip-${++nextTooltipId}`;
  tooltip.className = "zf-game-hint-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  host.append(toggle, tooltip);
  doc.body.append(host);
  const bindings = new Map<HTMLElement, { button: HTMLButtonElement; hint: GameHint }>();
  let active: HTMLElement | undefined;
  let automaticShown = false;
  let pending = false;
  let disposed = false;

  const save = (): void => {
    try { storage?.setItem(PREFERENCE_KEY, JSON.stringify(preferences)); } catch { /* Hilfe bleibt in dieser Seite verfügbar. */ }
  };
  const close = (): void => {
    if (active !== undefined) {
      const binding = bindings.get(active);
      binding?.button.removeAttribute("aria-describedby");
      binding?.button.setAttribute("aria-expanded", "false");
    }
    active = undefined;
    tooltip.hidden = true;
  };
  const place = (): void => {
    if (active === undefined) return;
    const button = bindings.get(active)?.button;
    if (button === undefined || !button.isConnected || button.getClientRects().length === 0) { close(); return; }
    const anchor = button.getBoundingClientRect();
    const width = doc.documentElement.clientWidth;
    const height = win.innerHeight;
    if (anchor.bottom < 0 || anchor.top > height) { close(); return; }
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(anchor.left, width - box.width - 8))}px`;
    const below = anchor.bottom + 8;
    tooltip.style.top = `${Math.max(8, below + box.height <= height - 8 ? below : anchor.top - box.height - 8)}px`;
  };
  const open = (target: HTMLElement): void => {
    if (!preferences.enabled) return;
    const binding = bindings.get(target);
    if (binding === undefined) return;
    close();
    active = target;
    const title = doc.createElement("strong");
    title.textContent = binding.hint.title;
    const text = doc.createElement("p");
    text.textContent = binding.hint.text;
    const help = doc.createElement("small");
    help.textContent = "Mit ? erneut aufrufen · Esc schließt";
    tooltip.replaceChildren(title, text, help);
    tooltip.hidden = false;
    binding.button.setAttribute("aria-describedby", tooltip.id);
    binding.button.setAttribute("aria-expanded", "true");
    preferences = { ...preferences, visited: [...new Set([...preferences.visited, binding.hint.id])].slice(-200) };
    save();
    place();
  };
  const refresh = (): void => {
    if (disposed) return;
    pending = false;
    toggle.setAttribute("aria-pressed", String(preferences.enabled));
    for (const [target, binding] of bindings) {
      if (!root.contains(target) || !binding.button.isConnected) {
        if (active === target) close();
        binding.button.remove();
        target.classList.remove("zf-game-hint-heading");
        bindings.delete(target);
      }
    }
    for (const hint of hints) {
      const target = root.querySelector<HTMLElement>(hint.selector);
      if (target === null || bindings.has(target)) continue;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "zf-game-hint-trigger";
      button.textContent = "?";
      button.setAttribute("aria-label", `Spielhinweis: ${hint.title}`);
      button.setAttribute("aria-expanded", "false");
      button.dataset["gameHint"] = hint.id;
      button.addEventListener("click", () => open(target));
      button.addEventListener("focus", () => open(target));
      button.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") open(target); });
      if (/^H[1-6]$/u.test(target.tagName)) target.classList.add("zf-game-hint-heading");
      (target.closest("label") ?? target).after(button);
      bindings.set(target, { button, hint });
    }
    for (const binding of bindings.values()) binding.button.hidden = !preferences.enabled;
    if (!automaticShown && preferences.enabled) {
      for (const [target, binding] of bindings) {
        const rect = binding.button.getBoundingClientRect();
        if (target.closest('[aria-busy="true"]') === null && !preferences.visited.includes(binding.hint.id) && rect.width > 0 && rect.top >= 0 && rect.bottom < win.innerHeight) {
          automaticShown = true;
          open(target);
          break;
        }
      }
    }
    place();
  };
  const observer = new MutationObserver(() => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(refresh);
  });
  observer.observe(root, { childList: true, subtree: true });
  const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
  const onFocus = (event: FocusEvent): void => {
    if (active !== undefined && event.target !== bindings.get(active)?.button) close();
  };
  const onPointer = (event: PointerEvent): void => {
    if (active === undefined || !(event.target instanceof win.Node)) return;
    if (!tooltip.contains(event.target) && !bindings.get(active)?.button.contains(event.target)) close();
  };
  toggle.addEventListener("click", () => {
    preferences = { ...preferences, enabled: !preferences.enabled };
    save();
    close();
    automaticShown = false;
    refresh();
  });
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("focusin", onFocus);
  doc.addEventListener("pointerdown", onPointer);
  win.addEventListener("resize", place);
  doc.addEventListener("scroll", place, true);
  refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    close();
    for (const [target, binding] of bindings) {
      target.classList.remove("zf-game-hint-heading");
      binding.button.remove();
    }
    host.remove();
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("pointerdown", onPointer);
    win.removeEventListener("resize", place);
    doc.removeEventListener("scroll", place, true);
  };
}
