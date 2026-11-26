// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import "./order-strip.css";

type Item = { id: string; label: string; face?: ReactNode; description?: string };
type Drag = { id: string; pointer: number; start: number; x: number; scrollStart: number; maxScroll: number; button: HTMLButtonElement; moved: boolean };

export function OrderStrip({ label, items, change, resolution = false, replacement = false }: {
  label: string; items: Item[]; change: (ids: string[]) => void; resolution?: boolean; replacement?: boolean;
}) {
  const track = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag>(undefined);
  const frame = useRef(0);
  const focusAfterMove = useRef<string>(undefined);
  const [marker, setMarker] = useState<{ source: string; destination: number }>();
  const [status, setStatus] = useState("");
  const hint = useId();
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = undefined;
    // Moving a focused DOM node can blur it. Restore focus in the same commit,
    // before a subsequent Tab or confirmation can move focus somewhere else.
    const button = track.current?.querySelector<HTMLButtonElement>(`[data-order-id="${CSS.escape(id)}"] button`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [items]);

  function dropIndex(id: string, x: number) {
    const others = Array.from(track.current!.children).filter((cell) => cell.getAttribute("data-order-id") !== id);
    return others.filter((cell) => { const box = cell.getBoundingClientRect(); return x >= box.left + box.width / 2; }).length;
  }

  function move(id: string, to: number, keyboard = false) {
    const from = items.findIndex((item) => item.id === id);
    if (from < 0 || to === from || to < 0 || to >= items.length) return;
    const ids = items.map((item) => item.id);
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    if (keyboard) focusAfterMove.current = id;
    change(ids);
    setStatus(`${items[from].label}, position ${to + 1} of ${ids.length}`);
  }

  function showDrop() {
    const held = drag.current;
    if (!held?.moved || !track.current) return;
    const row = track.current.getBoundingClientRect();
    const edge = 28;
    const dx = held.x < row.left + edge ? -8 : held.x > row.right - edge ? 8 : 0;
    const scroll = track.current.scrollLeft;
    if (dx) track.current.scrollLeft = Math.max(0, Math.min(held.maxScroll, scroll + dx));
    const offset = held.x - held.start + track.current.scrollLeft - held.scrollStart;
    held.button.style.transform = `translateX(${offset}px)`;
    const destination = dropIndex(held.id, held.x);
    setMarker((previous) => previous?.source === held.id && previous.destination === destination
      ? previous : { source: held.id, destination });
    if (track.current.scrollLeft !== scroll) frame.current = requestAnimationFrame(showDrop);
  }

  function stop(event: PointerEvent<HTMLOListElement>, commit: boolean) {
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    drag.current = undefined;
    held.button.style.removeProperty("transform");
    cancelAnimationFrame(frame.current);
    if (commit && held.moved) move(held.id, dropIndex(held.id, event.clientX));
    setMarker(undefined);
  }

  const remaining = items.filter((item) => item.id !== marker?.source);
  return <div className="ordered-effects">
    <div className="order-direction" aria-hidden="true"><span>{replacement ? "Applies first" : resolution ? "Resolves first" : "First"}</span>
      <span>{replacement ? "Applies last" : resolution ? "Resolves last" : "Last"}</span></div>
    <p className="order-hint" id={hint}><span className="order-announcement">{replacement ? "The leftmost effect applies first. "
      : resolution ? "The leftmost effect resolves first. " : "The first card is on the left. "}</span>
      Drag to reorder, or focus a card and use the left and right arrow keys.</p>
    <ol ref={track} className="order-strip" aria-label={label} aria-describedby={hint}
      onPointerMove={(event) => {
        const held = drag.current;
        if (!held || held.pointer !== event.pointerId) return;
        held.x = event.clientX;
        if (Math.abs(held.x - held.start) >= 4) held.moved = true;
        if (held.moved) { cancelAnimationFrame(frame.current); showDrop(); }
      }}
      onPointerUp={(event) => stop(event, true)} onPointerCancel={(event) => stop(event, false)}
      onLostPointerCapture={(event) => stop(event, false)}>
      {items.map((item, index) => <li key={item.id} data-order-id={item.id} aria-description={item.description}
        data-dragging={marker?.source === item.id || undefined}
        data-insert={marker && (remaining[marker.destination]?.id === item.id ? "before"
          : marker.destination === remaining.length && remaining.at(-1)?.id === item.id ? "after" : undefined)}>
        <button type="button" aria-label={item.label} aria-description={item.description} onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (items.length < 2 || !event.isPrimary || event.button !== 0 || !track.current) return;
            track.current.setPointerCapture(event.pointerId);
            drag.current = { id: item.id, pointer: event.pointerId, start: event.clientX, x: event.clientX,
              scrollStart: track.current.scrollLeft, maxScroll: track.current.scrollWidth - track.current.clientWidth,
              button: event.currentTarget, moved: false };
          }} onKeyDown={(event) => {
            const to = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1
              : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
            if (to === undefined) return;
            event.preventDefault();
            move(item.id, to, true);
          }}>{item.face ?? item.label}</button>
      </li>)}
    </ol>
    <span className="order-announcement" role="status">{status}</span>
  </div>;
}
