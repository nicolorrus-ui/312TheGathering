// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function play(element: HTMLElement, frames: Keyframe[], duration: number, finish: () => void) {
  const animation = element.animate(frames, { duration, easing: "cubic-bezier(.2,.65,.28,1)" });
  const cancel = () => animation.cancel();
  reduced.addEventListener("change", cancel);
  window.addEventListener("resize", cancel);
  document.addEventListener("scroll", cancel, true);
  document.addEventListener("visibilitychange", cancel);
  const done = () => {
    reduced.removeEventListener("change", cancel);
    window.removeEventListener("resize", cancel);
    document.removeEventListener("scroll", cancel, true);
    document.removeEventListener("visibilitychange", cancel);
    finish();
  };
  animation.finished.then(done, done);
}

function pose(card: HTMLElement) {
  const rect = card.getBoundingClientRect();
  const transform = getComputedStyle(card).transform;
  const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    width: card.offsetWidth * Math.hypot(matrix.a, matrix.b), angle: Math.atan2(matrix.b, matrix.a) };
}

export function prepareHandReturn(ghost: HTMLElement | null, hand: Element | null, id: string) {
  const card = hand?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
  if (!card || !ghost || reduced.matches || document.hidden) return;
  const from = pose(ghost);
  // Wait for React to restore the fan. Animate the live card itself so a new
  // projection can replace its face or remove the card even halfway home.
  return () => {
    if (!card.isConnected || reduced.matches || document.hidden) return;
    card.setAttribute("data-returning", "");
    const to = pose(card);
    const frames = [from, to].map(({ x, y, width, angle }) => ({
      position: "fixed", left: "0px", top: "0px", zIndex: 7, pointerEvents: "none", opacity: 1,
      transform: `translate(${x - card.offsetWidth / 2}px, ${y - card.offsetHeight / 2}px) rotate(${angle}rad) scale(${width / card.offsetWidth})`,
    }));
    play(card, frames, 180, () => card.removeAttribute("data-returning"));
  };
}

export function dismissPanel(panel: Element | null) {
  const duel = panel?.closest(".duel");
  if (!panel || !duel || reduced.matches || document.hidden) return;
  const { left, top, width, height } = panel.getBoundingClientRect();
  const frame = document.createElement("div");
  frame.className = "closing-panel";
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { left: left + "px", top: top + "px", width: width + "px", height: height + "px" });
  duel.append(frame);
  // The contents and controls disappear immediately, only their empty frame fades.
  play(frame, [{ opacity: .65 }, { opacity: 0, transform: "translateY(3px)" }], 110, () => frame.remove());
}

export function dismissOpenDetails(summary: HTMLElement) {
  if (summary.parentElement?.hasAttribute("open")) dismissPanel(summary.nextElementSibling);
}
