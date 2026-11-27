// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type DragEvent } from "react";
import { cardTransform, measureCard, prepareCardRelease } from "./boardMotion";

type DragCard = { cardId: string; zone: string; promptId: number; gameId: string };
type Grip = ReturnType<typeof measureCard> & { x: number; y: number };
type Gesture = {
  card: DragCard; source: HTMLButtonElement; hand: Element | null; grip: Grip; pointerId: number;
  startX: number; startY: number; x: number; y: number; lastMove: number; lifted: number;
  leftHand: boolean; tiltX: number; tiltY: number; velocityX: number; velocityY: number; frameTime: number;
};
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function gripAt(source: HTMLButtonElement, x: number, y: number): Grip {
  const pose = measureCard(source);
  // The live card may be anywhere between its fanned and raised hover poses.
  // Invert that actual on-screen rotation/scale at the instant of the press.
  const dx = (x - pose.centerX) / pose.scale, dy = (y - pose.centerY) / pose.scale;
  const cos = Math.cos(pose.angle), sin = Math.sin(pose.angle);
  return { ...pose, x: pose.width / 2 + dx * cos + dy * sin, y: pose.height / 2 - dx * sin + dy * cos };
}

function paint(ghost: HTMLElement, g: Gesture, now: number) {
  const age = now - g.lifted;
  const dt = Math.max(0, Math.min(now - g.frameTime, 50));
  const lift = reduced.matches ? 0 : 1 - Math.exp(-age / 60);
  const decay = reduced.matches ? 0 : Math.exp(-Math.max(0, now - g.lastMove - 14) / 54);
  const follow = 1 - Math.exp(-dt / 48);
  // Bound the combined angle, including diagonal gestures, to nine degrees.
  const speed = Math.hypot(g.velocityX, g.velocityY);
  const gain = Math.min(8, 9 / (speed || 1)) * decay;
  g.tiltX += (-g.velocityY * gain - g.tiltX) * follow;
  g.tiltY += (g.velocityX * gain - g.tiltY) * follow;
  g.frameTime = now;
  const resting = now - g.lastMove > 320 && Math.abs(g.tiltX) + Math.abs(g.tiltY) < .06;
  const angle = g.grip.angle * (reduced.matches ? 1 : 1 - lift);
  const scale = g.grip.scale * (1 + .037 * lift);
  const flat = resting || reduced.matches;
  ghost.style.transform = cardTransform(g.x - g.grip.x, g.y - g.grip.y, angle, scale,
    flat ? 0 : g.tiltX, flat ? 0 : g.tiltY);
  ghost.style.boxShadow = `0 ${1 + 7 * lift}px ${2 + 13 * lift}px rgb(0 0 0 / .38), 0 ${1 + lift}px 1px rgb(0 0 0 / .5)`;
  return !reduced.matches && (!resting || age < 400);
}

export function useCardDrag(gameId: string, promptId: number | undefined) {
  const gesture = useRef<Gesture>(undefined);
  const [dragging, setDragging] = useState<DragCard>();
  const floating = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const release = useRef<(() => void) | undefined>(undefined);
  const swallowClick = useRef(false);

  function animate(now: number) {
    frame.current = 0;
    const g = gesture.current;
    if (g?.lifted && floating.current && paint(floating.current, g, now)) frame.current = requestAnimationFrame(animate);
  }

  function finish(kind: "click" | "abort" | "returning" | "landing") {
    const g = gesture.current;
    if (!g) return;
    gesture.current = undefined;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (kind !== "click") swallowClick.current = true;
    if (g.lifted && (kind === "returning" || kind === "landing") && floating.current) {
      release.current = prepareCardRelease(floating.current, g.source, g.grip, { x: g.x, y: g.y }, kind);
    }
    if (g.source.hasPointerCapture(g.pointerId)) g.source.releasePointerCapture(g.pointerId);
    setDragging(undefined);
  }

  useLayoutEffect(() => {
    const g = gesture.current;
    if (g && (g.card.gameId !== gameId || g.card.promptId !== promptId || !g.source.isConnected || !g.source.draggable)) {
      finish("abort");
    }
  });
  useLayoutEffect(() => {
    const g = gesture.current, ghost = floating.current;
    if (dragging && g && ghost) {
      ghost.style.width = g.grip.width + "px";
      ghost.style.height = g.grip.height + "px";
      ghost.style.transformOrigin = `${g.grip.x}px ${g.grip.y}px`;
      animate(performance.now());
    } else {
      release.current?.();
      release.current = undefined;
    }
  }, [dragging]);

  useEffect(() => {
    const cancel = () => finish("returning");
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) { event.preventDefault(); cancel(); }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", cancel);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("visibilitychange", cancel);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  function handlers(card: DragCard, onLift: () => void, onDrop: () => void) {
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => event.preventDefault(),
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0 || !event.isPrimary || gesture.current) return;
        const source = event.currentTarget;
        const x = event.clientX, y = event.clientY;
        source.setPointerCapture(event.pointerId);
        gesture.current = { card, source, grip: gripAt(source, x, y), hand: source.closest(".hand"), pointerId: event.pointerId,
          startX: x, startY: y, x, y, lastMove: performance.now(), frameTime: 0, lifted: 0, leftHand: false,
          velocityX: 0, velocityY: 0, tiltX: 0, tiltY: 0 };
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const g = gesture.current;
        if (!g || event.pointerId !== g.pointerId) return;
        const x = event.clientX, y = event.clientY, now = performance.now();
        if (!g.lifted) {
          if (Math.hypot(x - g.startX, y - g.startY) < (event.pointerType === "touch" ? 8 : 5)) return;
          g.lifted = g.frameTime = now;
          onLift();
          setDragging(g.card);
        }
        const dt = Math.max(4, now - g.lastMove);
        if (g.x !== x || g.y !== y) {
          g.velocityX = (x - g.x) / dt;
          g.velocityY = (y - g.y) / dt;
          g.lastMove = now;
        }
        g.x = x; g.y = y;
        if (floating.current) {
          paint(floating.current, g, now);
          if (!frame.current) frame.current = requestAnimationFrame(animate);
        }
        if (g.hand) {
          const inside = g.hand.contains(document.elementFromPoint(x, y));
          if (inside && g.leftHand) finish("returning");
          else if (!inside) g.leftHand = true;
        }
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const g = gesture.current;
        if (!g || event.pointerId !== g.pointerId) return;
        if (!g.lifted) { finish("click"); return; }
        g.x = event.clientX; g.y = event.clientY;
        if (floating.current) paint(floating.current, g, performance.now());
        const target = document.elementFromPoint(g.x, g.y);
        const drop = target?.closest(".battlefield.home") && g.source.closest(".duel")?.contains(target);
        finish(drop ? "landing" : "returning");
        if (drop) onDrop();
      },
      onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
        if (event.pointerId === gesture.current?.pointerId) finish("returning");
      },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) {
        if (event.pointerId === gesture.current?.pointerId) finish("returning");
      },
    };
  }

  return { dragging, floating, handlers, clickGuard: {
    onPointerDownCapture: (event: PointerEvent) => { if (event.isPrimary) swallowClick.current = false; },
    onClickCapture: (event: MouseEvent) => {
      if (swallowClick.current && event.detail !== 0) {
        swallowClick.current = false;
        event.preventDefault(); event.stopPropagation();
      }
    },
  } };
}
