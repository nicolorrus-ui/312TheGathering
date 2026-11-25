// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { CardHoverPreview, CardImage, type CardHover } from "./CardImages";
import { Decision, DecisionPanel, Options } from "./Decisions";
import { PhaseControls, usePriorityStops } from "./PhaseControls";
import type { Card, GameMetadata, Identity, Option, Player, Prompt, Response, RulesPriority, Snapshot, Zone } from "./protocol";

const manaColor: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless" };
const cardDragType = "application/x-hexproof-card";
const undoAction = (option: Option) => option.kind === "undoLand" || option.kind === "undoMana";

function fanPosition(index: number, count: number): CSSProperties {
  const position = count < 2 ? 0 : 2 * index / (count - 1) - 1;
  return { "--fan-angle": `${position * Math.min(12, (count - 1) * 2.3)}deg`,
    "--fan-offset": `${position ** 2 * Math.min(12, (count - 1) * 2.5)}px` } as CSSProperties;
}

type TouchDragHandlers = {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => void;
};

function TableCard({ card, actionable, selected, activate, drag, touch, dragEnd, dragging, inspect, hover, style }: {
  card: Card; actionable?: boolean; selected?: boolean; activate?: () => void;
  drag?: (event: DragEvent) => void; touch?: TouchDragHandlers; inspect?: () => void; hover: CardHover; style?: CSSProperties;
  dragEnd?: () => void; dragging?: boolean;
}) {
  const showBack = !card.visible || Boolean(card.faceDown);
  const name = (card.visible ? card.identity?.name : undefined) ?? (card.faceDown ? "Face-down permanent" : "Hidden card");
  return <div className={`card-slot ${card.tapped ? "tapped" : ""}`} data-dragging={dragging || undefined} style={style}>
    <button type="button" className={`table-card ${card.land ? "land" : ""} ${showBack ? "card-back" : ""}`}
      data-card-id={card.id} data-actionable={Boolean(actionable)} data-tapped={Boolean(card.tapped)}
      aria-label={name} aria-pressed={selected || undefined} title={card.typeLine ? `${name} · ${card.typeLine}` : name}
      aria-disabled={!activate && !drag || undefined} tabIndex={!activate && !drag ? -1 : undefined}
      draggable={Boolean(drag)} onDragStart={drag} onDragEnd={dragEnd} onClick={activate} {...touch}
      onMouseEnter={(event) => hover(showBack ? undefined : card.identity, event.currentTarget)} onMouseLeave={() => hover()}
      onContextMenu={inspect && ((event) => { event.preventDefault(); inspect(); })}>
      {!showBack && <>
        <strong>{name}</strong>
        {card.typeLine && <small>{card.typeLine}</small>}
        {card.oracle && <span className="card-text">{card.oracle}</span>}
        <CardImage identity={card.identity} className="table-card-image" decorative eager compact />
      </>}
      {card.power !== undefined && <b className="pt">{card.power}/{card.toughness}</b>}
      {card.attacking && <span className="combat-tag">Attacking</span>}
      {Boolean(card.blocking?.length) && <span className="combat-tag">Blocking</span>}
    </button>
  </div>;
}

function PlayerChip({ player, zone, zones, active, target, selected, selectTarget, selectZone }: {
  player: Player; zone: (name: string) => Zone | undefined; zones: string[];
  active: boolean; target?: boolean; selected?: boolean; selectTarget: () => void; selectZone?: (zone: Zone) => void;
}) {
  return <div className="player-chip">
    <button type="button" className="player-life" data-actionable={Boolean(target)} data-active={active}
      onClick={selectTarget} disabled={!target} aria-label={`Target ${player.name}`} aria-description={`${player.life} life`}
      aria-pressed={target ? selected : undefined}>
      <span className="monogram" aria-hidden="true">{player.name.slice(0, 1).toUpperCase()}</span>
      <span className="player-name" title={player.name}>{player.name}</span>
      <strong className="life-total">{player.life}</strong>
    </button>
    <div className="zones">{zones.map((name) => {
      const entry = zone(name);
      return <button className="zone-button" type="button" key={name} disabled={!selectZone || !entry?.cards?.some((card) => card.visible)}
        onClick={() => entry && selectZone?.(entry)}>{name} <strong>{entry?.count ?? 0}</strong></button>;
    })}</div>
  </div>;
}

type Props = { game: Snapshot; seat: number; prompt?: Prompt; locked: boolean; metadata?: GameMetadata;
  answer: (prompt: Prompt, response: Response) => void; back: () => void; tournamentTable?: boolean;
  online: boolean; sendPriority: (preference: RulesPriority) => void; spectating?: boolean };
type AutoPass = { until: "step" | "turn"; turn: number; step: string };
type CardDrag = { card: Card; zone: string; promptId: number; x: number; y: number; origin: Element | null; leftHand: boolean };
type TouchDrag = { pointerId: number; drag: CardDrag; active: boolean };

export function Board({ game, seat, prompt, locked, metadata, answer, back, tournamentTable, online, sendPriority, spectating = false }: Props) {
  const [reviewId, setReviewId] = useState<string>();
  const [hoveredCard, setHoveredCard] = useState<{ identity: Identity; source: Element }>();
  const [openedZone, setOpenedZone] = useState<{ zone: string; ownerSeat: number }>();
  const [actionMenu, setActionMenu] = useState<{ promptId: number; options: Option[] }>();
  const [targetSelection, setTargetSelection] = useState<{ promptId: number; ids: string[] }>();
  const [autoPass, setAutoPass] = useState<AutoPass>();
  const [dragging, setDragging] = useState<CardDrag>();
  const touchDrag = useRef<TouchDrag>(undefined);
  const targetIds = targetSelection && targetSelection.promptId === prompt?.promptId ? targetSelection.ids : [];
  const isCurrent = prompt?.gameId === game.gameId;
  const decision = !spectating && isCurrent && prompt?.pending ? prompt : undefined;
  const activeDrag = !locked && dragging?.promptId === decision?.promptId ? dragging : undefined;
  const cardInMotion = Boolean(activeDrag);
  const priority = decision?.kind === "chooseAction";
  const myTurn = game.activeSeat === seat;
  const priorityStops = usePriorityStops(game.roomId, online && !game.gameOver, sendPriority, !spectating);
  const stopped = priorityStops.stops.has(`${myTurn ? "own" : "other"}:${game.step}`);
  const owner = game.players.find((player) => player.seat === seat);
  const opponent = game.players.find((player) => player.seat !== seat);
  const autoPassCurrent = !priorityStops.hold && autoPass?.turn === game.turn &&
    (autoPass.step === game.step || (autoPass.until === "turn" && !stopped));

  useEffect(() => {
    if (autoPass && !autoPassCurrent) setAutoPass(undefined);
  }, [autoPass, autoPassCurrent]);
  useEffect(() => {
    if (hoveredCard && !hoveredCard.source.matches(":hover")) setHoveredCard(undefined);
  }, [decision, game, hoveredCard]);
  useEffect(() => {
    if (dragging && !activeDrag) setDragging(undefined);
  }, [activeDrag, dragging]);
  const pass = decision?.options.find((option) => option.responseId === "$pass");
  const autoPay = !game.gameOver && decision?.supported && decision.kind === "payManaCost"
    ? decision.options.find((option) => option.responseId === "$auto-pay") : undefined;

  useEffect(() => {
    // Only send a currently published ordinary-priority response. Every
    // mandatory or specialized decision remains with the player.
    if (!locked && !cardInMotion && autoPassCurrent && decision?.kind === "chooseAction" && pass && !game.stack.length) {
      const timer = setTimeout(() => answer(decision, { responseId: pass.responseId }), 220);
      return () => clearTimeout(timer);
    }
  }, [answer, cardInMotion, autoPassCurrent, decision, game.stack.length, locked, pass]);

  if (!owner || !opponent) return <main className="shell"><p>Waiting for both seats.</p></main>;
  const allPermanents = game.zones.filter((zone) => zone.zone === "battlefield").flatMap((zone) => zone.cards ?? []);
  const zoneFor = (who: number, zone: string) => game.zones.find((entry) => entry.ownerSeat === who && entry.zone === zone);
  const reviewedStackObject = reviewId ? game.stack.find((object) => object.id === reviewId) : undefined;
  const review: Card | undefined = reviewedStackObject ? { id: reviewedStackObject.id, identity: reviewedStackObject.identity,
    visible: true, oracle: reviewedStackObject.text, ownerSeat: -1, controllerSeat: -1 }
    : reviewId ? game.zones.flatMap((zone) => zone.cards ?? []).find((card) => card.id === reviewId && card.visible) : undefined;
  const visibleZone = openedZone ? zoneFor(openedZone.ownerSeat, openedZone.zone) : undefined;
  const hand = zoneFor(seat, "hand")?.cards ?? [];
  const opponentHand = zoneFor(opponent.seat, "hand");
  const opponentHandCount = opponentHand?.count ?? 0;
  const currentMenu = actionMenu?.promptId === decision?.promptId ? actionMenu?.options : undefined;
  const respond = (response: Response) => {
    if (decision && !locked) {
      setActionMenu(undefined);
      setHoveredCard(undefined);
      answer(decision, response);
    }
  };

  const hoverCard: CardHover = (identity, source) => {
    setHoveredCard(identity && source ? { identity, source } : undefined);
  };

  function toggleTarget(id: string) {
    if (!decision || locked) return;
    if (targetIds.includes(id)) setTargetSelection({ promptId: decision.promptId, ids: targetIds.filter((value) => value !== id) });
    else if (targetIds.length < decision.maxSelections) setTargetSelection({ promptId: decision.promptId, ids: [...targetIds, id] });
  }

  function chooseAction(options: Option[]) {
    if (!decision || locked) return;
    if (options.length === 1) return respond({ responseId: options[0].responseId });
    if (options.length > 1) return setActionMenu({ promptId: decision.promptId, options });
  }

  function playsCard(option: Option, zone: string) {
    // Forge reports a card's first ability for ordinary priority. A card
    // outside the battlefield can also offer a spell or land through its
    // native choice, so start that choice with the same drop gesture.
    return option.kind === "cast" || option.kind === "playLand" || (priority && zone !== "battlefield");
  }

  function dragCard(event: DragEvent, card: Card, zone: string) {
    if (!decision) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(cardDragType, card.id);
    const transparent = document.createElement("canvas");
    transparent.width = transparent.height = 1;
    transparent.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
    document.body.append(transparent);
    event.dataTransfer.setDragImage(transparent, 0, 0);
    requestAnimationFrame(() => transparent.remove());
    setHoveredCard(undefined);
    setDragging({ card, zone, promptId: decision.promptId, x: event.clientX, y: event.clientY,
      origin: event.currentTarget.closest(".hand"), leftHand: false });
  }

  function trackCard(drag: CardDrag, target: Node | null, x: number, y: number) {
    const inOrigin = drag.origin?.contains(target);
    const next = inOrigin && drag.leftHand ? undefined : { ...drag, x, y, leftHand: !inOrigin };
    setDragging(next);
    return next;
  }

  function touchHandlers(card: Card, zone: string): TouchDragHandlers {
    return {
      onPointerDown(event) {
        if (event.pointerType !== "touch" || !event.isPrimary || !decision) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        touchDrag.current = { pointerId: event.pointerId, active: false,
          drag: { card, zone, promptId: decision.promptId, x: event.clientX, y: event.clientY,
            origin: event.currentTarget.closest(".hand"), leftHand: false } };
      },
      onPointerMove(event) {
        const touch = touchDrag.current;
        if (!touch || touch.pointerId !== event.pointerId || touch.drag.promptId !== decision?.promptId || locked) return;
        if (!touch.active && Math.hypot(event.clientX - touch.drag.x, event.clientY - touch.drag.y) < 8) return;
        setHoveredCard(undefined);
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const drag = trackCard(touch.drag, target, event.clientX, event.clientY);
        touchDrag.current = drag ? { ...touch, active: true, drag } : undefined;
      },
      onPointerUp(event) {
        const touch = touchDrag.current;
        if (!touch || touch.pointerId !== event.pointerId) return;
        touchDrag.current = undefined;
        setDragging(undefined);
        const target = document.elementFromPoint(event.clientX, event.clientY);
        if (touch.active && target?.closest(".battlefield.home")) playDraggedCard(touch.drag);
      },
      onLostPointerCapture(event) {
        if (touchDrag.current?.pointerId !== event.pointerId) return;
        touchDrag.current = undefined;
        setDragging(undefined);
      },
    };
  }

  function showCard(card: Card, zone: string, fan?: { index: number; count: number }) {
    const targets = decision?.targets.filter((target) => target.objectId === card.id && !target.selected) ?? [];
    const options = decision?.options.filter((option) => option.cardId === card.id && !undoAction(option)) ?? [];
    const dragOptions = options.filter((option) => playsCard(option, zone));
    const clickOptions = options.filter((option) => !playsCard(option, zone));
    const canDrag = !locked && dragOptions.length > 0;
    const inspect = spectating ? undefined : () => setReviewId(card.id);
    const activate = spectating || canDrag && !targets.length && !clickOptions.length ? undefined : () => {
      if (!locked && targets.length === 1) toggleTarget(targets[0].responseId);
      else if (!locked && !targets.length && clickOptions.length) chooseAction(clickOptions);
      else if (!targets.length) inspect?.();
    };
    const actionable = !locked && Boolean(options.length || targets.length);
    return <TableCard key={card.id} card={card} actionable={actionable}
      selected={targets.some((target) => targetIds.includes(target.responseId))}
      activate={activate} inspect={inspect} hover={hoverCard}
      style={fan ? fanPosition(fan.index, fan.count) : undefined}
      dragging={activeDrag?.card.id === card.id}
      dragEnd={() => setDragging(undefined)}
      drag={canDrag ? (event) => dragCard(event, card, zone) : undefined} touch={canDrag ? touchHandlers(card, zone) : undefined} />;
  }

  function moveCard(event: DragEvent) {
    if (!activeDrag) return;
    trackCard(activeDrag, event.target as Node, event.clientX, event.clientY);
  }

  function allowCardDrop(event: DragEvent) {
    if (activeDrag && event.dataTransfer.types.includes(cardDragType)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(undefined);
    const id = event.dataTransfer.getData(cardDragType);
    if (activeDrag?.card.id === id) playDraggedCard(activeDrag);
  }

  function playDraggedCard(drag: CardDrag) {
    if (locked || !decision || decision.promptId !== drag.promptId) return;
    chooseAction(decision.options.filter((option) =>
      option.cardId === drag.card.id && !undoAction(option) && playsCard(option, drag.zone)));
  }

  const showPlayer = (player: Player, own: boolean) => {
    const targets = decision?.targets.filter((target) => target.seat === player.seat && !target.selected) ?? [];
    return <PlayerChip player={player} zone={(zone) => zoneFor(player.seat, zone)}
      zones={own ? ["library", "graveyard", "exile"] : ["hand", "library", "graveyard", "exile"]}
      active={!game.gameOver && game.activeSeat === player.seat}
      selected={targets.some((target) => targetIds.includes(target.responseId))}
      target={!locked && targets.length === 1} selectTarget={() => targets.length === 1 && toggleTarget(targets[0].responseId)}
      selectZone={spectating ? undefined : (zone) => setOpenedZone({ ownerSeat: zone.ownerSeat, zone: zone.zone })} />;
  };
  const showPermanents = (who: number, lands: boolean) => allPermanents.filter((card) =>
    card.controllerSeat === who && Boolean(card.land) === lands).map((card) => showCard(card, "battlefield"));
  const turnLabel = game.gameOver ? "Game over" : myTurn && !spectating ? "Your turn"
    : `${(myTurn ? owner : opponent).name}'s turn`;
  const stackPass = Boolean(game.stack.length && decision?.options.some((option) => option.responseId === "$pass-stack"));
  const priorityOptions = priority ? decision.options.filter((option) =>
    undoAction(option) || !option.cardId && option.kind !== "pass" && option.responseId !== "$pass-stack") : [];

  return <main className="duel" onDragOverCapture={moveCard}>
    <section className="table" aria-label="Duel table" data-drag-active={Boolean(activeDrag)}>
      <div className="player-info opponent-info">{showPlayer(opponent, false)}</div>
      <section className={`hand opponent-hand${spectating ? " revealed-hand" : ""}`}
        aria-label={`${spectating ? opponent.name + "'s" : "Opponent"} hand, ${opponentHandCount} cards`}>
        <div className="hand-fan" aria-hidden={!spectating || undefined}>
          {spectating ? opponentHand?.cards.map((card, index, cards) => showCard(card, "hand", { index, count: cards.length }))
          : Array.from({ length: opponentHandCount }, (_, index) =>
            <span key={index} className="opponent-card-back card-back" style={fanPosition(index, opponentHandCount)} />)}
        </div>
      </section>
      <aside className="duel-tools">
        {metadata && <p className="score">Game {metadata.gameNumber} · {metadata.score[seat] ?? 0}–{metadata.score[opponent.seat] ?? 0}</p>}
        {!spectating && <details className="log"><summary>Game log</summary><ol aria-label="Game log">
          {metadata?.log.map((entry) => <li key={`server-${entry.id}`}>{entry.text}</li>)}
        </ol></details>}
      </aside>
      <section className="battlefield away" aria-label={spectating ? `${opponent.name}'s battlefield` : "Opponent battlefield"}>
        <div className="permanents lands">{showPermanents(opponent.seat, true)}</div>
        <div className="permanents">{showPermanents(opponent.seat, false)}</div>
      </section>
      <div className="center-line">
        <span className="waiting" role="status" data-decision={Boolean(decision && !locked)}>{
          game.gameOver ? (game.winnerSeat === undefined ? "Draw" : game.winnerSeat === seat && !spectating ? "You won"
            : `${(game.winnerSeat === seat ? owner : opponent).name} won`)
            : !online ? "Reconnecting…" : spectating ? "Watching live" : locked ? "Syncing…" : decision ? "Your decision" : "Waiting for opponent"
        }</span>
      </div>
      <section className="battlefield home" aria-label={spectating ? `${owner.name}'s battlefield` : "Your battlefield"}
        onDragOver={spectating ? undefined : allowCardDrop} onDrop={spectating ? undefined : drop}>
        <div className="permanents">{showPermanents(seat, false)}</div>
        <div className="permanents lands">{showPermanents(seat, true)}</div>
      </section>
      <div className="player-info own-info">{showPlayer(owner, true)}
        <div className="mana-pool" aria-label="Mana pool"><small>Mana pool</small>
          {owner.manaPool.length ? owner.manaPool.map((mana) =>
            <span key={mana.name} className={`mana ${manaColor[mana.name] ?? ""}`}>{mana.name} {mana.value}</span>) : <span>Empty</span>}
        </div>
      </div>
      <section className="hand own-hand" aria-label={spectating ? `${owner.name}'s hand` : "Your hand"}>
        <div className="hand-fan">{hand.map((card, index) => showCard(card, "hand", { index, count: hand.length }))}</div>
      </section>
      {game.stack.length > 0 && <aside className="stack-tray" aria-label="Spell and ability stack">
        <div className="stack-title">Stack <span>{game.stack.length}</span></div>
        <div className="stack">{game.stack.map((object) => {
          const target = locked ? undefined : decision?.targets.find((choice) => choice.objectId === object.id && !choice.selected);
          return <button key={object.id} type="button" title={object.text}
            aria-pressed={target ? targetIds.includes(target.responseId) : undefined}
            data-actionable={Boolean(target)} aria-disabled={spectating || undefined} tabIndex={spectating ? -1 : undefined}
            onMouseEnter={(event) => hoverCard(object.identity, event.currentTarget)} onMouseLeave={() => hoverCard()}
            onClick={spectating ? undefined : () => target ? toggleTarget(target.responseId) : setReviewId(object.id)}>
            <CardImage identity={object.identity} className="stack-card-image" decorative compact />
            <span>{object.identity.name || object.text}</span>
          </button>;
        })}</div>
      </aside>}
      {!spectating && <div className="action-dock">
        {decision && !priority && <Decision key={`${decision.gameId}:${decision.promptId}`} prompt={decision}
          toggleTarget={toggleTarget} targetIds={targetIds} submit={respond} disabled={locked} hoverCard={hoverCard} />}
        {currentMenu?.length && <DecisionPanel key={decision?.promptId} title="Choose an action">
          <Options options={currentMenu} submit={respond} />
          <footer><button type="button" className="quiet" onClick={() => setActionMenu(undefined)}>Close</button></footer>
        </DecisionPanel>}
        <fieldset className="priority-actions" aria-label="Priority controls" disabled={locked}>
          {priorityOptions.length > 0 && <Options options={priorityOptions} submit={respond} />}
          {autoPassCurrent ? <button type="button" onClick={() => setAutoPass(undefined)}>Cancel auto-pass</button> : priority && !game.gameOver && !priorityStops.hold &&
            <details className="auto-pass"><summary>Auto-pass</summary><div className="choices">
              <button type="button" onClick={() => setAutoPass({ until: "step", step: game.step, turn: game.turn })}>This step</button>
              <button type="button" onClick={() => setAutoPass({ until: "turn", step: game.step, turn: game.turn })}>This turn</button>
            </div></details>}
          {stackPass && <button type="button" onClick={() => respond({ responseId: "$pass-stack" })}>Pass until stack resolves</button>}
          {game.gameOver && metadata?.result?.matchFinished ? <button className="primary" type="button" onClick={back}>
            {tournamentTable ? "Return to tournament" : "Return to room"}
          </button> : autoPay ? <button type="button" className="primary"
            onClick={() => respond({ responseId: autoPay.responseId })}>Auto Pay</button> :
            <button type="button" className="primary" disabled={!priority || !pass}
              onClick={() => pass && respond({ responseId: pass.responseId })}>Pass priority</button>}
        </fieldset>
      </div>}
    </section>
    <PhaseControls game={game} turnLabel={turnLabel} myTurn={myTurn} {...priorityStops}
      spectatorNames={spectating ? [owner.name, opponent.name] : undefined} />
    {!activeDrag && hoveredCard?.identity.name && <CardHoverPreview identity={hoveredCard.identity} />}
    {activeDrag && <div className="floating-hand-card" aria-hidden="true" style={{ left: activeDrag.x, top: activeDrag.y }}>
      {activeDrag.card.visible && !activeDrag.card.faceDown ? <>
        <strong>{activeDrag.card.identity?.name}</strong>
        <CardImage identity={activeDrag.card.identity} className="table-card-image" decorative eager compact />
      </> : <div className="floating-card-back card-back" />}
    </div>}
    {!spectating && review && <section className="inspection" aria-label="Card preview"><header><h2>{review.identity?.name ?? "Face-down card"}</h2>
      <button type="button" className="quiet" onClick={() => setReviewId(undefined)}>Close</button></header>
      {!review.faceDown && <CardImage identity={review.identity} className="preview-card-image" eager />}
      <small>{review.typeLine} {review.identity?.setCode && `· ${review.identity.setCode} ${review.identity.collectorNumber}`}</small>
      <p>{review.oracle}</p>
      {review.counters?.map((counter) => <p key={counter.name}>{counter.name} × {counter.value}</p>)}
    </section>}
    {!spectating && visibleZone && <section className="inspection" aria-label="Zone contents"><header><h2>{visibleZone.zone}</h2>
      <button type="button" className="quiet" onClick={() => setOpenedZone(undefined)}>Close</button></header>
      <div className="choice-grid">{visibleZone.cards.filter((card) => card.visible).map((card) => showCard(card, visibleZone.zone))}</div>
    </section>}
  </main>;
}
