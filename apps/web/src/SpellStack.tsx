// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { CardImage, cardArtURL, type CardHover } from "./CardImages";
import type { StackObject, Target } from "./protocol";

type Props = { objects: StackObject[]; targets?: Target[]; targetIds: string[]; hoverCard: CardHover;
  toggleTarget: (id: string) => void; inspect: (id: string) => void };

export function SpellStack({ objects, targets, targetIds, hoverCard, toggleTarget, inspect }: Props) {
  const pile = useRef<HTMLElement>(null);
  const topId = objects[0]?.id;
  useLayoutEffect(() => {
    if (pile.current) pile.current.scrollTop = 0;
  }, [topId]);
  return <div className="stack-position" data-motion-zone="stack">
    {topId && <aside ref={pile} className="stack" aria-label="Spell and ability stack">
      {objects.map((object, depth) => {
        const target = targets?.find((choice) => choice.objectId === object.id && !choice.selected);
        const face = object.identity?.name ? object.identity : undefined;
        const label = face?.name || object.text;
        // Forge sends the next object to resolve first. Keep this order for keyboard navigation,
        // and paint each older card underneath it with a visible, clickable edge.
        return <button key={object.id + (face ? cardArtURL(face) : "")} type="button" data-stack-id={object.id}
          style={{ "--stack-depth": depth, zIndex: objects.length - depth } as CSSProperties}
          title={object.text} aria-label={label} aria-description={object.text !== label ? object.text : undefined}
          aria-pressed={target ? targetIds.includes(target.responseId) : undefined} data-actionable={Boolean(target)}
          onMouseEnter={(event) => hoverCard(face, event.currentTarget)} onMouseLeave={() => hoverCard()}
          onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) hoverCard(face, event.currentTarget); }}
          onBlur={() => hoverCard()}
          onContextMenu={(event) => { event.preventDefault(); inspect(object.id); }}
          onClick={() => target ? toggleTarget(target.responseId) : inspect(object.id)}>
          {face ? <><span className="stack-card-label">{label}</span>
            <CardImage identity={face} className="stack-card-image" decorative compact eager /></>
            : <span className="stack-card-back card-back" aria-hidden="true" />}
          {depth > 0 && <span className="stack-edge" aria-hidden="true">{label}</span>}
        </button>;
      })}
    </aside>}
  </div>;
}
