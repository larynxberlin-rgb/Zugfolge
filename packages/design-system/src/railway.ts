import { escapeHtml, icon, type IconName } from "./index.js";

export type RailwayPage = "map" | "planner" | "operations" | "markets" | "company" | "mailbox";

export interface RailwayLink {
  readonly page: RailwayPage;
  readonly href: string;
  readonly id?: string;
}

const destinations: Readonly<Record<RailwayPage, { label: string; icon: IconName }>> = {
  map: { label: "LiveMap", icon: "map" },
  planner: { label: "Fahrplan", icon: "clock" },
  operations: { label: "Betrieb", icon: "train" },
  markets: { label: "Markt", icon: "market" },
  company: { label: "Unternehmen", icon: "company" },
  mailbox: { label: "Postfach", icon: "mail" },
};

/** Own railway mark: two tracks and a junction, shared by every game surface. */
export function railwayBrand(href: string): string {
  return `<a class="zf-brand" href="${escapeHtml(href)}" aria-label="Zugfolge – zur LiveMap"><span class="zf-brand__mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6 9h10l5 7h5M6 16h9l5 7h6M7 23h8"/></svg></span><span>ZUGFOLGE<small>DEINE BAHN. DEINE WELT.</small></span></a>`;
}

export function railwayNavigation(links: readonly RailwayLink[], active: RailwayPage): string {
  return `<nav class="rail-nav" aria-label="Hauptnavigation"><p class="rail-nav__caption">DEINE SPIELWELT</p>${links.map((link) => `<a class="rail-nav__link"${link.id === undefined ? "" : ` id="${escapeHtml(link.id)}"`} href="${escapeHtml(link.href)}"${link.page === active ? ' aria-current="page"' : ""}>${icon(destinations[link.page].icon)}<span>${destinations[link.page].label}</span>${link.page === "map" ? '<i class="rail-nav__map-dot" aria-hidden="true"></i>' : ""}</a>`).join("")}<div class="rail-nav__tracks" aria-hidden="true"><svg viewBox="0 0 130 210"><path d="M27 0v60c0 40 73 53 73 96v54M39 0v58c0 35 73 50 73 98v54M22 26h22M22 48h22M33 84l16-12M50 105l14-14M75 123l14-14M94 147l20-6M95 174h22"/></svg></div><span class="rail-nav__footer">Zugfolge <span>ALPHA</span></span></nav>`;
}

export function railwayTabs(items: readonly { id: string; label: string }[]): string {
  return `<div class="rail-tabs" role="tablist" aria-label="Arbeitsbereich">${items.map((item, index) => `<button type="button" role="tab" id="tab-${escapeHtml(item.id)}" aria-controls="${escapeHtml(item.id)}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-workspace-tab="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join("")}</div>`;
}

/** Switching panels keeps form nodes and drafts intact; hashes reveal deep links. */
const tabCleanups = new WeakMap<ParentNode, () => void>();

export function bindRailwayTabs(root: ParentNode, hash = ""): void {
  tabCleanups.get(root)?.();
  tabCleanups.delete(root);
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-workspace-tab]")];
  if (tabs.length === 0) return;
  const panels = tabs.map((tab) => root.querySelector<HTMLElement>(`#${tab.dataset["workspaceTab"]}`));
  const select = (index: number, focus = false): void => {
    tabs.forEach((tab, position) => {
      const active = position === index;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = panels[position];
      if (panel !== null && panel !== undefined) {
        panel.hidden = !active;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
      }
    });
    if (focus) tabs[index]?.focus();
  };
  const selectFromHash = (fragment: string): void => {
    let target = "";
    try { target = decodeURIComponent(fragment.replace(/^#/, "")); } catch { /* Malformed deep link: first panel. */ }
    const selected = panels.findIndex((panel) => panel !== null && panel !== undefined
      && (panel.id === target || [...panel.querySelectorAll("[id]")].some((node) => node.id === target)));
    select(Math.max(0, selected));
  };
  selectFromHash(hash);
  const scrollToWorkspaceStart = (): void => {
    root.querySelector<HTMLElement>("[data-scroll-region]")?.scrollTo({ top: 0, behavior: "instant" });
  };
  const onHashChange = (): void => {
    selectFromHash(window.location.hash);
    if (panels.some((panel) => panel?.id === window.location.hash.slice(1))) scrollToWorkspaceStart();
  };
  window.addEventListener("hashchange", onHashChange);
  tabCleanups.set(root, () => window.removeEventListener("hashchange", onHashChange));
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      select(index);
      scrollToWorkspaceStart();
      const url = new URL(window.location.href);
      url.hash = tab.dataset["workspaceTab"] ?? "";
      window.history.replaceState({}, "", url);
    });
    tab.addEventListener("keydown", (event) => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
      scrollToWorkspaceStart();
      const url = new URL(window.location.href);
      url.hash = tabs[next]?.dataset["workspaceTab"] ?? "";
      window.history.replaceState({}, "", url);
    });
  });
}
