export type Density = "control" | "document";
export { railwayBrand, railwayNavigation, railwayTabs, bindRailwayTabs, type RailwayPage, type RailwayLink } from "./railway.js";
export { mountGameHints, readGameHintPreferences, type GameHint, type GameHintPreferences } from "./game-hints.js";
export type StatusTone = "neutral" | "attention" | "danger" | "success";
export type IconName =
  | "map"
  | "market"
  | "company"
  | "mail"
  | "alert"
  | "train"
  | "layers"
  | "chevron"
  | "check"
  | "close"
  | "clock"
  | "route"
  | "lock"
  | "warning";

const paths: Readonly<Record<IconName, string>> = {
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15"/>',
  market: '<path d="M4 7h16M4 17h16m-4-4 4 4-4 4M8 3 4 7l4 4"/>',
  company: '<path d="M3 21h18M5 21V5l8-2v18m0-13h6v13M8 8h2m-2 4h2m-2 4h2m5-4h2m-2 4h2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 8v6m0 3v.2"/>',
  train:
    '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 21l3-3m5 3-3-3M8 8h8m-8 4h2m4 0h2"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 4 9 5 9-5M3 16l9 5 9-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  route:
    '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  warning: '<path d="M12 4v10m0 4v.2"/><circle cx="12" cy="12" r="9"/>',
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
export function icon(name: IconName, label?: string): string {
  const accessibility =
    label === undefined
      ? 'aria-hidden="true"'
      : `role="img" aria-label="${escapeHtml(label)}"`;
  return `<svg class="zf-icon" viewBox="0 0 24 24" ${accessibility}>${paths[name]}</svg>`;
}
export function badge(
  content: string,
  tone: StatusTone = "neutral",
  iconName?: IconName,
): string {
  return `<span class="zf-badge zf-badge--${tone}">${iconName === undefined ? "" : icon(iconName)}<span>${escapeHtml(content)}</span></span>`;
}
export function field(
  id: string,
  label: string,
  value: string,
  help?: string,
): string {
  return `<label class="zf-field" for="${escapeHtml(id)}"><span>${escapeHtml(label)}</span><input id="${escapeHtml(id)}" value="${escapeHtml(value)}"${help ? ` aria-describedby="${escapeHtml(id)}-help"` : ""}>${help ? `<small id="${escapeHtml(id)}-help">${escapeHtml(help)}</small>` : ""}</label>`;
}
export function emptyState(title: string, description: string): string {
  return `<div class="zf-empty" role="status">${icon("route")}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
}
