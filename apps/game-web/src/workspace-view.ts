/** Retain the player's place when refreshed data replaces a workspace. */
export function captureWorkspaceView(root: HTMLElement): () => void {
  const disclosures = [...root.querySelectorAll<HTMLDetailsElement>("details[data-preserve-disclosure]")]
    .map((element) => ({ key: element.dataset["preserveDisclosure"]!, open: element.open }));
  const scrolls = [...root.querySelectorAll<HTMLElement>("[data-scroll-region]")]
    .map((element) => ({ top: element.scrollTop, left: element.scrollLeft }));
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
    ? document.activeElement : undefined;
  const formId = active?.closest("form[id]")?.id;
  const name = active?.getAttribute("name");
  const selector = active?.id ? `#${CSS.escape(active.id)}`
    : formId && name ? `#${CSS.escape(formId)} [name="${CSS.escape(name)}"]` : undefined;
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd } : undefined;
  return () => {
    disclosures.forEach(({ key, open }) => {
      const element = root.querySelector<HTMLDetailsElement>(`details[data-preserve-disclosure="${CSS.escape(key)}"]`);
      if (element) element.open = open;
    });
    root.querySelectorAll<HTMLElement>("[data-scroll-region]").forEach((element, index) => {
      const saved = scrolls[index];
      if (saved) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
    });
    const target = selector ? root.querySelector<HTMLElement>(selector) : undefined;
    if (target && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.end !== null
        && selection !== undefined && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        target.setSelectionRange(selection.start, selection.end);
      }
    }
  };
}
