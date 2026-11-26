import type { KeyboardEvent } from "react";

/**
 * Enter in a dialog presses its primary button (the one marked `data-primary`), unless it is disabled. A focused button, link, text area,
 * select or list keeps what Enter already does there, and a dialog's own form submit is left alone.
 */
export function pressPrimaryOnEnter(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Enter" || event.defaultPrevented || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
  const target = event.target as HTMLElement;
  if (target.closest("textarea, button, a, select, form, [role='combobox'], [role='option'], [role='switch'], [role='menuitem'], [role='listbox'], [cmdk-root]")) return;
  const primary = event.currentTarget.querySelector<HTMLButtonElement>("[data-primary]:not(:disabled)");
  if (!primary) return;
  event.preventDefault();
  primary.click();
}
