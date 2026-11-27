// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useRef } from "react";

const focusableControl = 'button, a[href], summary, [role="button"], [tabindex]';

export function useDuelShortcuts(enabled: boolean) {
  const boardRef = useRef<HTMLElement>(null);
  const pointerControl = useRef<Element | null>(null);

  useEffect(() => {
    function pointerDown(event: PointerEvent) {
      pointerControl.current = event.target instanceof Element ? event.target.closest(focusableControl) : null;
    }

    function keyDown(event: KeyboardEvent) {
      if (event.key === "Tab" || event.key.startsWith("Arrow")) pointerControl.current = null;
      if (!enabled || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const space = event.key === " ";
      if (!space && event.key.toLowerCase() !== "e") return;

      const board = boardRef.current;
      const target = event.target;
      if (!board || !(target instanceof HTMLElement) ||
          (target !== document.body && target !== document.documentElement && !board.contains(target)) ||
          target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]')) return;
      if (board.querySelector(".inspection, .mana-choice-menu") || target.closest(".log")) return;

      const panel = board.querySelector(".action-dock .decision") ?? board.querySelector(".priority-actions");
      const key = space ? "Space" : "E";
      const buttons = panel?.querySelectorAll<HTMLButtonElement>(`button[aria-keyshortcuts="${key}"]:enabled`);
      // E also works with the Auto-pass menu closed. A minimized decision can
      // render a second Confirm, so Space must use the one the player can see.
      const button = Array.from(buttons ?? []).find(candidate => !space || candidate.getClientRects().length > 0);
      const focused = target.closest(focusableControl);
      if (space && focused && focused !== button && focused !== pointerControl.current) return;
      if (!button) {
        // A pointer-selected card can keep focus while its confirmation is
        // disabled (for example, while choosing a defender). Don't click it twice.
        if (space && focused === pointerControl.current && focused?.matches("button[aria-pressed], .table-card") &&
            panel?.querySelector('[aria-keyshortcuts="Space"]')) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!event.repeat) button.click();
    }

    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown);
    };
  }, [enabled]);

  return boardRef;
}
