// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { Component, createRef } from "react";
import { cardArtURL } from "./CardImages";
import type { CardMove, Identity, MoveEndpoint, PendingCast, Snapshot } from "./protocol";

type Point = { x: number; y: number; width: number };
type ObjectView = { at: MoveEndpoint; identity?: Identity };
type Anchor = { point: Point; element?: HTMLElement; art?: string };
type Scene = { cards: Map<string, ObjectView>; objects: Map<string, Anchor>; zones: Map<string, Anchor> };
type Leg = Pick<CardMove, "from" | "to" | "castId">;
type Flight = { ghost: HTMLElement; animation: Animation; landing: Anchor; key?: string };
type Props = { game: Snapshot; online: boolean; pending?: PendingCast };

function pendingEndpoint(cast: PendingCast): MoveEndpoint {
  return { zone: "stack", seat: cast.controllerSeat, objectId: cast.id };
}

function zoneKey(at: MoveEndpoint) {
  return at.zone === "stack" ? "stack" : at.zone + ":" + at.seat;
}

function point(rect: DOMRect, isCard: boolean): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    width: isCard ? Math.max(25, Math.min(rect.width, 120)) : Math.max(28, Math.min(rect.width * .8, 64)) };
}

function scene(table: HTMLElement, game: Snapshot, pending?: PendingCast): Scene {
  const cards = new Map<string, ObjectView>();
  for (const zone of game.zones) {
    for (const card of zone.cards ?? []) {
      cards.set(card.id, { at: { zone: zone.zone, seat: zone.ownerSeat, objectId: card.id },
        identity: card.visible && !card.faceDown ? card.identity : undefined });
    }
  }
  for (const item of game.stack) {
    cards.set(item.id, { at: { zone: "stack", seat: item.controllerSeat, objectId: item.id },
      identity: item.identity?.name ? item.identity : undefined });
  }
  if (pending) cards.set(pending.id, { at: pendingEndpoint(pending), identity: pending.identity });
  const objects = new Map<string, Anchor>();
  const zones = new Map<string, Anchor>();
  for (const element of table.querySelectorAll<HTMLElement>("[data-motion-zone], [data-card-id], [data-stack-id]")) {
    const rect = element.getBoundingClientRect();
    if (!rect.width) continue;
    const { motionZone, seat, cardId, stackId } = element.dataset;
    if (motionZone) {
      zones.set(zoneKey({ zone: motionZone, seat: Number(seat) }), { point: point(rect, false) });
    } else {
      const id = stackId || cardId;
      const img = element.querySelector("img");
      if (!id) continue;
      const center = point(rect, true);
      const clip = element.closest(".hand, .stack")?.getBoundingClientRect();
      if (clip) {
        center.x = Math.max(clip.left, Math.min(center.x, clip.right));
        center.y = Math.max(clip.top, Math.min(center.y, clip.bottom));
      }
      objects.set(id, { point: center, element, art: img?.currentSrc || img?.src });
    }
  }
  return { cards, objects, zones };
}

function find(at: MoveEndpoint, state: Scene) {
  const card = at.objectId ? state.cards.get(at.objectId) : undefined;
  if (at.objectId && card && zoneKey(card.at) === zoneKey(at)) {
    return { anchor: state.objects.get(at.objectId) ?? state.zones.get(zoneKey(at)), identity: card.identity };
  }
  return { anchor: state.zones.get(zoneKey(at)), identity: undefined };
}

function watermark(game: Snapshot) {
  return (game.cardMoves ?? []).reduce((maximum, move) => Math.max(maximum, move.id), 0);
}

// Keep intermediate stack stops even if a batched snapshot never mounted their
// thumbnails. Anonymous endpoints cannot link two separate movements.
function paths(moves: Leg[]) {
  const all: Leg[][] = [];
  const ends = new Map<string, Leg[]>();
  for (const move of moves) {
    const id = move.from.objectId;
    const existing = id ? ends.get(id) : undefined;
    const path = existing && zoneKey(existing[existing.length - 1].to) === zoneKey(move.from) ? existing : [];
    if (!path.length) all.push(path);
    if (id) ends.delete(id);
    path.push(move);
    if (move.to.objectId) ends.set(move.to.objectId, path);
  }
  return all;
}

export class CardMovements extends Component<Props, unknown, Scene | null> {
  private layer = createRef<HTMLDivElement>();
  private lastMove = 0;
  private awaitingSnapshot = false;
  private flights = new Set<Flight>();
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  componentDidMount() {
    this.lastMove = watermark(this.props.game);
    this.awaitingSnapshot = !this.props.online;
    this.reduced.addEventListener("change", this.clear);
    window.addEventListener("resize", this.clear);
    document.addEventListener("visibilitychange", this.clear);
    document.addEventListener("scroll", this.onScroll, true);
  }

  componentWillUnmount() {
    this.clear();
    this.reduced.removeEventListener("change", this.clear);
    window.removeEventListener("resize", this.clear);
    document.removeEventListener("visibilitychange", this.clear);
    document.removeEventListener("scroll", this.onScroll, true);
  }

  // Read before React removes the source. The destination is measured after the same commit.
  getSnapshotBeforeUpdate(prev: Props) {
    const table = this.layer.current?.parentElement;
    const { game, online } = this.props;
    const moving = this.flights.size > 0 || watermark(game) > this.lastMove || prev.pending?.id !== this.props.pending?.id;
    return table && moving && prev.game !== game && online && !this.awaitingSnapshot && !this.reduced.matches
      ? scene(table, prev.game, prev.pending) : null;
  }

  componentDidUpdate(prev: Props, _state: unknown, before: Scene | null) {
    const { game, online } = this.props;
    if (!online) this.awaitingSnapshot = true;
    if (this.awaitingSnapshot || document.hidden || this.reduced.matches) {
      if (online && prev.game !== game) this.awaitingSnapshot = false;
      this.clear();
      this.lastMove = watermark(game);
      return;
    }
    if (!before || !this.layer.current?.parentElement) return;
    const pending = this.props.pending;
    const after = scene(this.layer.current.parentElement, game, pending);
    let moves: Leg[] = (game.cardMoves ?? []).filter((move) => move.id > this.lastMove);
    if (prev.pending?.id !== pending?.id) {
      const old = prev.pending;
      if (old) {
        const origin = pendingEndpoint(old);
        const incoming = moves.find((move) => move.castId === old.id);
        const stackId = incoming?.to.objectId ?? game.stack.find((item) => item.castId === old.id)?.id;
        if (stackId) {
          // This viewer already saw the announcement. Continue any resolution in the
          // same batch from that thumbnail, without replaying the inbound movement.
          moves = moves.filter((move) => move !== incoming).map((move) => move.from.objectId === stackId
            ? { from: origin, to: move.to } : move);
          if (!moves.some((move) => move.from === origin)) {
            for (const flight of this.flights) {
              if (flight.key === origin.objectId) flight.key = stackId;
            }
          }
        } else {
          moves.push({ from: origin, to: old.from });
        }
      }
      if (pending) moves.push({ from: pending.from, to: pendingEndpoint(pending) });
    }
    this.lastMove = Math.max(this.lastMove, watermark(game));
    for (const path of paths(moves)) this.fly(path, before, after);
    // A later disclosure can expire while a card is travelling. Remove its face
    // immediately if this viewer can no longer see the destination object.
    for (const { ghost, key } of this.flights) {
      if (key && !after.cards.get(key)?.identity?.name && !ghost.classList.contains("card-back")) {
        ghost.replaceChildren();
        ghost.classList.add("card-back");
      }
    }
  }

  private fly(path: Leg[], before: Scene, after: Scene) {
    const start = path[0].from, end = path[path.length - 1].to;
    const source = find(start, before), destination = find(end, after);
    const landing = destination.anchor, layer = this.layer.current;
    if (!source.anchor || !landing || !layer) return;
    const stops: Point[] = [];
    const previous = start.objectId && [...this.flights].find((flight) => flight.key === start.objectId);
    if (previous) {
      stops.push(point(previous.ghost.getBoundingClientRect(), true));
      this.remove(previous);
    }
    stops.push(source.anchor.point);
    for (const leg of path.slice(0, -1)) {
      const way = find(leg.to, after).anchor ?? find(leg.to, before).anchor;
      if (way) stops.push(way.point);
    }
    stops.push(landing.point);
    const ghost = document.createElement("div");
    ghost.className = "moving-card";
    ghost.dataset.from = start.zone;
    ghost.dataset.to = end.zone;
    const visible = source.identity?.name && destination.identity?.name &&
      path.every((leg) => leg.from.objectId && leg.to.objectId);
    if (visible && destination.identity) {
      ghost.textContent = destination.identity.name;
      const img = document.createElement("img");
      img.alt = "";
      img.src = landing.art || (source.identity?.name === destination.identity.name && source.anchor.art)
        || cardArtURL(destination.identity, true);
      img.onerror = () => img.remove();
      ghost.append(img);
    } else {
      ghost.classList.add("card-back");
    }
    layer.append(ghost);
    const animation = ghost.animate(stops.map(({ x, y, width }) => ({
      transform: `translate(${x - 35}px, ${y - 49}px) scale(${width / 70})`,
      easing: "cubic-bezier(.22,.65,.24,1)",
    })), { duration: Math.min(850, (stops.length - 1) * 325), fill: "both" });
    const flight = { ghost, animation, landing, key: end.objectId };
    landing.element?.setAttribute("data-arriving", "");
    this.flights.add(flight);
    animation.onfinish = () => this.remove(flight);
  }

  private remove(flight: Flight) {
    this.flights.delete(flight);
    flight.animation.cancel();
    flight.ghost.remove();
    if (![...this.flights].some((other) => other.landing.element === flight.landing.element)) {
      flight.landing.element?.removeAttribute("data-arriving");
    }
  }

  private clear = () => {
    for (const flight of this.flights) this.remove(flight);
  };

  private onScroll = (event: Event) => {
    if (event.target === document) this.clear();
    else if (event.target instanceof Element) {
      for (const flight of this.flights) {
        if (flight.landing.element && event.target.contains(flight.landing.element)) this.remove(flight);
      }
    }
  };

  render() { return <div ref={this.layer} className="card-movements" aria-hidden="true" />; }
}
