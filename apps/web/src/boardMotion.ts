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

export function cardTransform(x: number, y: number, angle: number, scale: number, tiltX = 0, tiltY = 0) {
  return `translate3d(${x}px,${y}px,0) perspective(680px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) rotateZ(${angle}rad) scale(${scale})`;
}

export function measureCard(card: HTMLElement) {
  const rect = card.getBoundingClientRect(), style = getComputedStyle(card);
  const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
  return { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2,
    width: parseFloat(style.width), height: parseFloat(style.height),
    scale: Math.hypot(matrix.a, matrix.b), angle: Math.atan2(matrix.b, matrix.a) };
}

export function prepareCardRelease(ghost: HTMLElement, card: HTMLElement, grip: { x: number; y: number },
  pointer: { x: number; y: number }, kind: "returning" | "landing") {
  if (reduced.matches || document.hidden) return;
  const { transform, transformOrigin, width, height, boxShadow } = ghost.style;
  // Animate the live source after React restores its slot. Changes in visibility,
  // printing or zone therefore remove/replace the moving face immediately.
  return () => {
    if (!card.isConnected || reduced.matches || document.hidden) return;
    card.dataset[kind] = "";
    const to = measureCard(card);
    const dx = (grip.x - to.width / 2) * to.scale, dy = (grip.y - to.height / 2) * to.scale;
    const x = to.centerX + dx * Math.cos(to.angle) - dy * Math.sin(to.angle) - grip.x;
    const y = to.centerY + dx * Math.sin(to.angle) + dy * Math.cos(to.angle) - grip.y;
    const common = { position: "fixed", left: "0px", top: "0px", zIndex: 7, pointerEvents: "none",
      opacity: 1, transformOrigin, width, height };
    const shadow = getComputedStyle(card).boxShadow;
    const start = { ...common, transform, boxShadow };
    const rest = { ...common, transform: cardTransform(x, y, to.angle, to.scale), boxShadow: shadow };
    const frames: Keyframe[] = [start];
    if (kind === "landing") {
      // Keep the last pointer position through touchdown. The next snapshot
      // can hand this on-screen position to CardMovements for the cast/land.
      const drop = { ...common, transform: cardTransform(pointer.x - grip.x, pointer.y - grip.y, 0, 1), boxShadow: shadow };
      frames.push({ ...drop, offset: .35 }, { ...drop, offset: .56 });
    }
    frames.push(rest);
    play(card, frames, kind === "landing" ? 350 : 210, () => delete card.dataset[kind]);
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
