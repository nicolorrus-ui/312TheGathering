// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { CardImage, cardArtURL, type CardHover } from "./CardImages";
import type { StackObject, Target } from "./protocol";

export type StackEntry = StackObject & { pending?: boolean; renderKey?: string };

type Props = { objects: StackEntry[]; targets?: Target[]; targetIds: string[]; hoverCard: CardHover;
  toggleTarget: (id: string) => void; inspect: (id: string) => void };

export function SpellStack({ objects, targets, targetIds, hoverCard, toggleTarget, inspect }: Props) {
  const pile = useRef<HTMLElement>(null);
  const topId = objects[0]?.renderKey ?? objects[0]?.id;
  const active = objects.length > 0;
  useLayoutEffect(() => {
    pile.current?.scrollTo({ left: 0 });
  }, [topId]);
  useEffect(() => {
    const stack = pile.current;
    if (!stack) return;
    // Native horizontal scrolling handles touch and trackpads. A vertical mouse wheel
    // moves toward older cards, releasing the page scroll again at either end.
    function wheel(event: WheelEvent) {
      if (!stack || event.ctrlKey || event.shiftKey || event.deltaX || !event.deltaY) return;
      const extent = stack.scrollWidth - stack.clientWidth;
      if (extent <= 1 || (event.deltaY > 0 ? stack.scrollLeft <= 1 - extent : stack.scrollLeft >= -1)) return;
      const scale = event.deltaMode === 2 ? stack.clientWidth : event.deltaMode === 1 ? 16 : 1;
      event.preventDefault();
      stack.scrollBy({ left: -event.deltaY * scale });
    }
    stack.addEventListener("wheel", wheel, { passive: false });
    return () => stack.removeEventListener("wheel", wheel);
  }, [active]);

  return <div className="stack-position" data-motion-zone="stack"
    style={{ "--stack-overlap-count": Math.max(0, objects.length - 1) } as CSSProperties}>
    {active && <aside ref={pile} className="stack" aria-label="Spell and ability stack"
      onKeyDown={(event) => {
        if (event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const first = event.key === "Home";
        const card = event.currentTarget.querySelector<HTMLButtonElement>(first ? "button:first-child" : "button:last-child");
        card?.focus({ preventScroll: true });
        event.currentTarget.scrollTo({ left: first ? 0 : -event.currentTarget.scrollWidth });
      }}>
      {objects.map((object, depth) => {
        const target = !object.pending && targets?.find((choice) => choice.objectId === object.id && !choice.selected);
        const face = object.identity?.name ? object.identity : undefined;
        const label = face?.name || object.text;
        // Forge sends the next object to resolve first. Keep this order for keyboard navigation,
        // and paint each older card underneath it with a visible, clickable edge.
        return <button key={(object.renderKey ?? object.id) + (face ? cardArtURL(face) : "")} type="button" data-stack-id={object.id}
          data-pending={object.pending || undefined}
          style={{ "--stack-depth": depth, zIndex: objects.length - depth } as CSSProperties}
          title={object.text} aria-label={label} aria-description={[object.copy && "Copy", object.text !== label && object.text].filter(Boolean).join(". ") || undefined}
          aria-pressed={target ? targetIds.includes(target.responseId) : undefined} data-actionable={Boolean(target)}
          onMouseEnter={(event) => hoverCard(face, event.currentTarget)} onMouseLeave={() => hoverCard()}
          onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) hoverCard(face, event.currentTarget); }}
          onBlur={() => hoverCard()}
          onContextMenu={(event) => { event.preventDefault(); inspect(object.id); }}
          onClick={() => target ? toggleTarget(target.responseId) : inspect(object.id)}>
          {face ? <><span className="stack-card-label">{label}</span>
            <CardImage identity={face} className="stack-card-image" decorative compact eager /></>
            : <span className="stack-card-back card-back" aria-hidden="true" />}
          {object.copy && <span className="permanent-status copy-tag" title="Copy">Copy</span>}
          {depth > 0 && <span className="stack-edge" aria-hidden="true">{label}</span>}
        </button>;
      })}
    </aside>}
  </div>;
}
