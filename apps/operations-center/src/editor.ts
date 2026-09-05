import type { OperatingProgram } from "@zugfolge/dispatch";
import type { ProgramVersion } from "./api.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

/** Vergleich der bearbeitbaren Inhalte; Version und Server-Hash bleiben separat. */
export function sameProgramContent(left: OperatingProgram, right: OperatingProgram): boolean {
  const content = ({ version: _version, ...program }: OperatingProgram) => stable({
    ...program,
    rules: [...program.rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
  });
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

export function nextProgramVersion(versions: readonly ProgramVersion[]): number {
  return Math.max(0, ...versions.map(({ version }) => version)) + 1;
}

export function savedProgramMatches(program: OperatingProgram | undefined, saved: ProgramVersion | undefined): boolean {
  return program !== undefined && saved !== undefined && program.version === saved.version && sameProgramContent(program, saved.canonicalProgram);
}

interface FocusDraft {
  readonly selector: string;
  readonly value?: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly direction?: "forward" | "backward" | "none" | null;
}

/** Rohtext und Auswahl bleiben auch vor change und bei einem fehlerhaften Zahlenentwurf erhalten. */
export function captureEditorFocus(root: HTMLElement): FocusDraft | undefined {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !root.contains(element)) return undefined;
  let selector = element.id === "" ? "" : `#${CSS.escape(element.id)}`;
  if (selector === "") {
    const rule = element.closest<HTMLElement>("[data-rule-id]");
    const attribute = element.getAttributeNames().find((name) => name.startsWith("data-"));
    if (rule === null || attribute === undefined) return undefined;
    const condition = element.closest<HTMLElement>("[data-condition-path]");
    selector = `[data-rule-id="${CSS.escape(rule.dataset.ruleId!)}"] ${condition === null ? "" : `[data-condition-path="${CSS.escape(condition.dataset.conditionPath!)}"] `}[${attribute}]`;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return { selector, value: element.value, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection };
  }
  return { selector };
}

export function restoreEditorFocus(root: HTMLElement, draft: FocusDraft | undefined): void {
  if (draft === undefined) return;
  const element = root.querySelector<HTMLElement>(draft.selector);
  if (element === null || (element instanceof HTMLButtonElement && element.disabled)) return;
  element.focus({ preventScroll: true });
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && draft.value !== undefined) {
    element.value = draft.value;
    if (draft.start != null && draft.end != null) element.setSelectionRange(draft.start, draft.end, draft.direction ?? "none");
  }
}
