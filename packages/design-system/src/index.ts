export type Density = "control" | "document";
export type StatusTone = "neutral" | "attention" | "danger" | "success";
export type IconName =
  | "alert"
  | "train"
  | "station"
  | "platform"
  | "workshop"
  | "train-suburban"
  | "train-regional"
  | "train-long-distance"
  | "connection"
  | "accessible"
  | "bicycle"
  | "dining"
  | "information"
  | "disruption"
  | "layers"
  | "chevron"
  | "check"
  | "close"
  | "clock"
  | "route"
  | "lock"
  | "warning";

const paths: Readonly<Record<IconName, string>> = {
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 8v6m0 3v.2"/>',
  train:
    '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 21l3-3m5 3-3-3M8 8h8m-8 4h2m4 0h2"/>',
  station:
    '<path d="M3 10h18M5 10V7l7-4 7 4v3M6 10v8m4-8v8m4-8v8m4-8v8M3 18h18M5 21h14"/>',
  platform:
    '<path d="M3 19h18M5 19V8h14v11M8 12h8M8 15h5"/><path d="M9 5h6"/>',
  workshop:
    '<path d="M14.7 6.3a4 4 0 0 0-5-5l2.4 2.4-2.8 2.8-2.4-2.4a4 4 0 0 0 5 5L3 18a2.1 2.1 0 0 0 3 3l8.9-8.9a4 4 0 0 0 5-5l-2.4 2.4-2.8-2.8 2.4-2.4Z"/>',
  "train-suburban":
    '<rect x="5" y="3" width="14" height="16" rx="4"/><path d="M8 8h8m-8 4h2m4 0h2M8 22l3-3m5 3-3-3"/><circle cx="9" cy="15" r=".8"/><circle cx="15" cy="15" r=".8"/>',
  "train-regional":
    '<path d="M4 17V8c0-3 2-5 5-5h6c3 0 5 2 5 5v9l-2 2H6l-2-2Z"/><path d="M7 8h10M7 12h3m4 0h3M7 22l3-3m7 3-3-3"/>',
  "train-long-distance":
    '<path d="M3 16c0-7 4-12 10-12h3c3 0 5 2 5 5v8c0 1-1 2-2 2H6c-2 0-3-1-3-3Z"/><path d="M8 8h9M7 12h11M8 22l3-3m6 3-3-3"/>',
  connection:
    '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="17" r="2"/><path d="M8 7h4a4 4 0 0 1 4 4v4m-3-2 3 3 3-3"/>',
  accessible:
    '<circle cx="11" cy="4" r="1.5"/><path d="M10 7v6h5l3 5M10 9H7m3 4-3 6m3-3a5 5 0 1 1-3-7"/>',
  bicycle:
    '<circle cx="6" cy="17" r="4"/><circle cx="18" cy="17" r="4"/><path d="m6 17 4-7 4 7m-8 0h8l4-8h-4m-5-2h3"/>',
  dining:
    '<path d="M6 3v8m-2-8v5c0 2 1 3 2 3s2-1 2-3V3m-2 8v10M15 3v18m0-18c4 1 5 5 5 8h-5"/>',
  information:
    '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v.2"/>',
  disruption:
    '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 8v6m0 3v.2"/>',
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
  const title = label === undefined ? "" : `<title>${escapeHtml(label)}</title>`;
  return `<svg class="zf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" focusable="false" ${accessibility}>${title}${paths[name]}</svg>`;
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
