/** Keep both Tab directions inside the currently active conductor dialog. */
export function trapConductorDialogFocus(dialog: HTMLDialogElement): void {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !(event.target instanceof Element) || event.target.closest("dialog") !== dialog) return;
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0 && control.closest("dialog") === dialog);
    event.preventDefault();
    if (!controls.length) { dialog.focus(); return; }
    const current = controls.findIndex((control) => control === document.activeElement);
    const next = current < 0 ? event.shiftKey ? controls.length - 1 : 0
      : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next]!.focus();
  });
}
