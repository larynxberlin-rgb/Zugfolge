export type Density = "control" | "document";
export type StatusTone = "neutral" | "attention" | "danger" | "success";
export type IconName = "alert" | "train" | "layers" | "chevron";

const paths: Readonly<Record<IconName, string>> = {
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 8v6m0 3v.2"/>',
  train: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 21l3-3m5 3-3-3M8 8h8m-8 4h2m4 0h2"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 4 9 5 9-5M3 16l9 5 9-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
};

/** Icons use currentColor and never carry state through colour alone. */
export function icon(name: IconName, label?: string): string {
  const accessibility = label === undefined ? 'aria-hidden="true"' : `role="img" aria-label="${escapeHtml(label)}"`;
  return `<svg class="zf-icon" viewBox="0 0 24 24" ${accessibility}>${paths[name]}</svg>`;
}

export function badge(content: string, tone: StatusTone = "neutral", iconName?: IconName): string {
  return `<span class="zf-badge zf-badge--${tone}">${iconName === undefined ? "" : icon(iconName)}<span>${escapeHtml(content)}</span></span>`;
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
