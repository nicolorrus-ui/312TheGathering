// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { dismissOpenDetails, dismissPanel, prepareHandReturn } from "./boardMotion";
import { cardArtURL, CardImage, useCardHover, type CardHover } from "./CardImages";
import { CardMovements } from "./CardMovements";
import { battlefieldChoice, BattlefieldActions } from "./BattlefieldChoice";
import { SpellStack } from "./SpellStack";
import { DecisionCard } from "./DecisionCard";
import { isManaChoice, ManaChoiceMenu, type ManaAnchor } from "./ManaChoiceMenu";
import { ConfirmationActions, Decision, DecisionPanel, Options, simpleConfirmation } from "./Decisions";
import { useAttackDeclaration, type AttackControl } from "./useAttackDeclaration";
import { PhaseControls, usePriorityStops } from "./PhaseControls";
import type { Card, GameMetadata, Option, Player, Prompt, Response, RulesPriority, Snapshot, Zone } from "./protocol";

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

const visibleFace = (card: Card) => card.visible && !card.faceDown && card.identity?.name ? card.identity : undefined;

function TableCard({ card, actionable, selected, activate, drag, touch, dragEnd, dragging, inspect, hover, style, attack, inZoneViewer }: {
  card: Card; actionable?: boolean; selected?: boolean; activate?: () => void;
  drag?: (event: DragEvent) => void; touch?: TouchDragHandlers; inspect?: () => void; hover: CardHover; style?: CSSProperties;
  dragEnd?: (event: DragEvent) => void; dragging?: boolean; attack?: AttackControl; inZoneViewer?: boolean;
}) {
  const face = visibleFace(card);
  const declaration = face && !inZoneViewer ? card.annotations?.filter((item) =>
    item.kind === "namedCard" || item.kind === "chosenType").map((item) =>
    (item.kind === "namedCard" ? "Named: " : "Type: ") + item.value).join(" · ") : undefined;
  const name = face?.name ?? (card.faceDown ? "Face-down permanent" : "Hidden card");
  return <div className={`card-slot ${card.tapped ? "tapped" : ""}`} data-dragging={dragging || undefined} style={style}>
    <button key={face ? cardArtURL(face) : "back"} type="button" className={`table-card ${face && card.land ? "land" : ""} ${face ? "" : "card-back"}`}
      data-card-id={card.id} data-attack-state={attack?.state} data-actionable={Boolean(actionable)} data-tapped={Boolean(card.tapped)}
      aria-label={name} aria-description={[declaration, card.copy && "Copy", card.summoningSick && "Summoning sickness", attack?.label ? `Attacking ${attack.label}` : attack?.state === "target" && "Attack target"].filter(Boolean).join(". ") || undefined}
      aria-pressed={selected || undefined}
      aria-disabled={!activate && !drag || undefined} tabIndex={!activate && !drag ? -1 : undefined}
      draggable={Boolean(drag)} onDragStart={drag} onDragEnd={dragEnd} onClick={activate} {...touch}
      onMouseEnter={(event) => hover(face, event.currentTarget)} onMouseLeave={() => hover()}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) hover(face, event.currentTarget); }}
      onBlur={() => hover()} onContextMenu={inspect && ((event) => { event.preventDefault(); inspect(); })}>
      {face && <CardImage identity={face} className="table-card-image" decorative eager compact fallbackName />}
      {card.copy && <span className="permanent-status copy-tag" title="Copy">Copy</span>}
      {card.summoningSick && <span className="permanent-status sickness-tag" title="Summoning sickness">zzZ</span>}
      {!inZoneViewer && card.power !== undefined && <b className="pt">{card.power}/{card.toughness}</b>}
      {attack?.state === "attacking" ? <span className="combat-tag">→ {attack.label}</span>
        : card.attacking && <span className="combat-tag">Attacking</span>}
      {Boolean(card.blocking?.length) && <span className="combat-tag">Blocking</span>}
    </button>
    {declaration && <span className="permanent-declaration">{declaration}</span>}
  </div>;
}

function PlayerChip({ player, zone, zones, active, target, selected, selectTarget, selectZone, attack }: {
  player: Player; zone: (name: string) => Zone | undefined; zones: string[];
  active: boolean; attack?: AttackControl; target?: boolean; selected?: boolean; selectTarget: () => void; selectZone?: (zone: Zone) => void;
}) {
  return <div className="player-chip">
    <button type="button" className="player-life" data-attack-state={attack?.state} data-actionable={Boolean(target)} data-active={active}
      onClick={selectTarget} disabled={!target} aria-label={`Target ${player.name}`} aria-description={`${player.life} life`}
      aria-pressed={target ? selected : undefined}>
      <span className="monogram" aria-hidden="true">{player.name.slice(0, 1).toUpperCase()}</span>
      <span className="player-name" title={player.name}>{player.name}</span>
      <strong className="life-total" key={player.life}>{player.life}</strong>
    </button>
    <div className="zones">{zones.map((name) => {
      const entry = zone(name);
      return <button className="zone-button" type="button" key={name} data-motion-zone={name === "hand" ? undefined : name} data-seat={player.seat} disabled={!selectZone || !entry?.cards?.some(visibleFace)}
        onClick={() => entry && selectZone?.(entry)}>{name} <strong>{entry?.count ?? 0}</strong></button>;
    })}</div>
  </div>;
}

type Props = { game: Snapshot; seat: number; prompt?: Prompt; locked: boolean; metadata?: GameMetadata;
  answer: (prompt: Prompt, response: Response) => void; back: () => void; tournamentTable?: boolean;
  online: boolean; sendPriority: (preference: RulesPriority) => void; spectating?: boolean };
type AutoPass = { until: "step" | "turn"; turn: number; step: string };
type CardDrag = { cardId: string; zone: string; promptId: number; x: number; y: number; origin: Element | null; leftHand: boolean };
type TouchDrag = { pointerId: number; drag: CardDrag; active: boolean };

export function Board({ game, seat, prompt, locked, metadata, answer, back, tournamentTable, online, sendPriority, spectating = false }: Props) {
  const [reviewId, setReviewId] = useState<string>();
  const showHover = useCardHover();
  const [openedZone, setOpenedZone] = useState<{ zone: string; ownerSeat: number }>();
  const [actionMenu, setActionMenu] = useState<{ promptId: number; options: Option[] }>();
  const [targetSelection, setTargetSelection] = useState<{ gameId: string; promptId: number; ids: string[] }>();
  const [autoPass, setAutoPass] = useState<AutoPass>();
  const [dragging, setDragging] = useState<CardDrag>();
  const floatingCard = useRef<HTMLDivElement>(null);
  const returnHandCard = useRef<() => void>(undefined);
  const touchDrag = useRef<TouchDrag>(undefined);
  const manaAnchor = useRef<ManaAnchor>(undefined);
  const targetIds = targetSelection?.gameId === game.gameId && targetSelection.promptId === prompt?.promptId ? targetSelection.ids : [];
  const isCurrent = prompt?.gameId === game.gameId;
  const decision = !spectating && isCurrent && prompt?.pending ? prompt : undefined;
  const dragView = dragging && game.zones.filter((zone) => zone.zone === dragging.zone)
    .flatMap((zone) => zone.cards).find((card) => card.id === dragging.cardId);
  const activeDrag = online && !locked && dragView && dragging?.promptId === decision?.promptId ? dragging : undefined;
  const cardInMotion = Boolean(activeDrag);
  const priority = decision?.kind === "chooseAction";
  const myTurn = game.activeSeat === seat;
  const priorityStops = usePriorityStops(game.roomId, online && !game.gameOver, sendPriority, !spectating);
  const stopped = priorityStops.stops.has(`${myTurn ? "own" : "other"}:${game.step}`);
  const owner = game.players.find((player) => player.seat === seat);
  const opponent = game.players.find((player) => player.seat !== seat);
  const attackPrompt = !game.gameOver && decision?.supported && decision.kind === "chooseAttackers" ? decision : undefined;
  const attacks = useAttackDeclaration(attackPrompt, opponent?.seat);
  const autoPassCurrent = !priorityStops.hold && autoPass?.turn === game.turn &&
    (autoPass.step === game.step || (autoPass.until === "turn" && !stopped));

  useEffect(() => {
    if (autoPass && !autoPassCurrent) setAutoPass(undefined);
  }, [autoPass, autoPassCurrent]);
  useEffect(() => {
    if (dragging && !activeDrag) setDragging(undefined);
  }, [activeDrag, dragging]);
  useLayoutEffect(() => {
    if (!dragging) {
      returnHandCard.current?.();
      returnHandCard.current = undefined;
    }
  }, [dragging]);
  useEffect(() => {
    if (openedZone && !game.zones.some((zone) => zone.ownerSeat === openedZone.ownerSeat &&
      zone.zone === openedZone.zone && zone.cards.some(visibleFace))) setOpenedZone(undefined);
  }, [game.zones, openedZone]);
  const pass = decision?.options.find((option) => option.responseId === "$pass");
  const payment = decision?.supported && decision.kind === "payManaCost" ? decision : undefined;
  const manaPrompt = !game.gameOver && isManaChoice(decision) ? decision : undefined;
  const confirmation = !game.gameOver && !manaPrompt && simpleConfirmation(decision);
  const autoPay = !game.gameOver && payment?.options.find((option) => option.responseId === "$auto-pay");

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
  const boardChoice = !game.gameOver ? battlefieldChoice(decision, allPermanents) : undefined;
  const zoneFor = (who: number, zone: string) => game.zones.find((entry) => entry.ownerSeat === who && entry.zone === zone);
  const visibleZone = openedZone ? zoneFor(openedZone.ownerSeat, openedZone.zone) : undefined;
  const libraryTop = visibleZone?.zone === "library" ? visibleZone.cards.find(visibleFace) : undefined;
  const pendingCast = game.gameOver ? undefined : game.pendingCast;
  // A real stack instance inherits the announcement's render key. Abilities of
  // the same card keep their distinct stack IDs.
  const visibleStack = game.stack.map((object) => ({ ...object, renderKey: object.castId }));
  const stack = pendingCast ? [{ ...pendingCast, pending: true, renderKey: pendingCast.id,
    text: pendingCast.identity.name || "Face-down spell" }, ...visibleStack] : visibleStack;
  const reviewedStackObject = reviewId ? stack.find((object) => object.id === reviewId || object.renderKey === reviewId) : undefined;
  const review: Card | undefined = libraryTop ?? (reviewedStackObject ? { id: reviewedStackObject.id, identity: reviewedStackObject.identity,
    visible: true, oracle: reviewedStackObject.text, ownerSeat: -1, controllerSeat: -1 }
    : reviewId ? game.zones.flatMap((zone) => zone.cards ?? []).find((card) => card.id === reviewId && visibleFace(card)) : undefined);
  const hand = zoneFor(seat, "hand");
  const opponentHand = zoneFor(opponent.seat, "hand");
  const opponentHandCount = opponentHand?.count ?? 0;
  const currentMenu = actionMenu?.promptId === decision?.promptId ? actionMenu?.options : undefined;
  const actionSource = currentMenu?.[0]?.cardId;
  const actionCard = actionSource && currentMenu?.every((option) => option.cardId === actionSource)
    ? game.zones.flatMap((zone) => zone.cards).find((card) => card.id === actionSource) : undefined;
  const respond = (response: Response) => {
    if (decision && !locked) {
      setActionMenu(undefined);
      showHover();
      answer(decision, response);
    }
  };

  const hoverCard: CardHover = (identity, source) => showHover(activeDrag ? undefined : identity, source);

  function toggleTarget(id: string) {
    if (!decision || locked) return;
    if (boardChoice?.max === 1) return respond(boardChoice.response([id]));
    if (targetIds.includes(id)) setTargetSelection({ gameId: decision.gameId, promptId: decision.promptId, ids: targetIds.filter((value) => value !== id) });
    else if (targetIds.length < (boardChoice?.max ?? decision.maxSelections)) setTargetSelection({ gameId: decision.gameId, promptId: decision.promptId, ids: [...targetIds, id] });
  }

  function chooseAction(options: Option[]) {
    if (!decision || locked) return;
    const cardId = options[0]?.cardId;
    if (cardId) {
      const source = document.querySelector(`.duel .table-card[data-card-id="${CSS.escape(cardId)}"]`);
      if (source) manaAnchor.current = { gameId: game.gameId, cardId, rect: source.getBoundingClientRect() };
    }
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
    showHover();
    setDragging({ cardId: card.id, zone, promptId: decision.promptId, x: event.clientX, y: event.clientY,
      origin: event.currentTarget.closest(".hand"), leftHand: false });
  }

  function trackCard(drag: CardDrag, target: Node | null, x: number, y: number) {
    const inOrigin = drag.origin?.contains(target);
    if (inOrigin && drag.leftHand) {
      cancelDrag(drag);
      return;
    }
    const next = { ...drag, x, y, leftHand: !inOrigin };
    setDragging(next);
    return next;
  }

  function cancelDrag(drag?: CardDrag) {
    if (drag?.origin && floatingCard.current) {
      returnHandCard.current = prepareHandReturn(floatingCard.current, drag.origin, drag.cardId);
    }
    setDragging(undefined);
  }

  function touchHandlers(card: Card, zone: string): TouchDragHandlers {
    return {
      onPointerDown(event) {
        if (event.pointerType !== "touch" || !event.isPrimary || !decision) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        touchDrag.current = { pointerId: event.pointerId, active: false,
          drag: { cardId: card.id, zone, promptId: decision.promptId, x: event.clientX, y: event.clientY,
            origin: event.currentTarget.closest(".hand"), leftHand: false } };
      },
      onPointerMove(event) {
        const touch = touchDrag.current;
        if (!touch || touch.pointerId !== event.pointerId || touch.drag.promptId !== decision?.promptId || locked) return;
        if (!touch.active && Math.hypot(event.clientX - touch.drag.x, event.clientY - touch.drag.y) < 8) return;
        showHover();
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const drag = trackCard(touch.drag, target, event.clientX, event.clientY);
        touchDrag.current = drag ? { ...touch, active: true, drag } : undefined;
      },
      onPointerUp(event) {
        const touch = touchDrag.current;
        if (!touch || touch.pointerId !== event.pointerId) return;
        touchDrag.current = undefined;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        if (touch.active && target?.closest(".battlefield.home")) {
          setDragging(undefined);
          playDraggedCard(touch.drag);
        } else cancelDrag(touch.drag);
      },
      onLostPointerCapture(event) {
        if (touchDrag.current?.pointerId !== event.pointerId) return;
        cancelDrag(touchDrag.current.drag);
        touchDrag.current = undefined;
      },
    };
  }

  function showCard(card: Card, zone: string, fan?: { index: number; count: number }, inZoneViewer = false) {
    const targets = decision?.targets.filter((target) => target.objectId === card.id && !target.selected) ?? [];
    const boardId = zone === "battlefield" ? boardChoice?.candidates.get(card.id) : undefined;
    const chosenOnTable = Boolean(boardId && (targetIds.includes(boardId) || boardChoice?.selected.has(boardId)));
    const chooseOnTable = !locked && boardChoice && boardId && !boardChoice.selected.has(boardId) &&
      (chosenOnTable || targetIds.length < boardChoice.max) ? () => toggleTarget(boardId) : undefined;
    const options = decision?.options.filter((option) => option.cardId === card.id && !undoAction(option)) ?? [];
    const dragOptions = options.filter((option) => playsCard(option, zone));
    const clickOptions = options.filter((option) => !playsCard(option, zone));
    const canDrag = !locked && dragOptions.length > 0;
    const inspect = spectating || !visibleFace(card) ? undefined : () => setReviewId(card.id);
    const combat = !locked && attackPrompt && zone === "battlefield" ? attacks.cardControl(card.id) : undefined;
    const activate = boardChoice && zone === "battlefield" ? chooseOnTable
      : attackPrompt && zone === "battlefield" ? combat?.activate
      : spectating || canDrag && !targets.length && !clickOptions.length ? undefined : () => {
      if (!locked && targets.length === 1) toggleTarget(targets[0].responseId);
      else if (!locked && !targets.length && clickOptions.length) chooseAction(clickOptions);
      else if (!targets.length) inspect?.();
    };
    const actionable = !locked && Boolean(boardChoice ? chooseOnTable : combat?.activate || options.length || targets.length);
    return <TableCard key={card.id} card={card} actionable={actionable} attack={combat} inZoneViewer={inZoneViewer}
      selected={combat?.state === "choosing" || combat?.state === "attacking" || chosenOnTable || targets.some((target) => targetIds.includes(target.responseId))}
      activate={activate} inspect={inspect} hover={hoverCard}
      style={fan ? fanPosition(fan.index, fan.count) : undefined}
      dragging={activeDrag?.cardId === card.id}
      dragEnd={(event) => event.dataTransfer.dropEffect === "none" ? cancelDrag(activeDrag) : setDragging(undefined)}
      drag={canDrag ? (event) => dragCard(event, card, zone) : undefined} touch={canDrag ? touchHandlers(card, zone) : undefined} />;
  }

  function showHand(zone: Zone | undefined, away: boolean) {
    const count = zone?.count ?? 0;
    const known = zone?.cards.filter(visibleFace) ?? [];
    return <div className="hand-fan">
      {known.map((card, index) => showCard(card, "hand", { index, count }))}
      {Array.from({ length: Math.max(0, count - known.length) }, (_, i) => {
        const style = fanPosition(known.length + i, count);
        return away ? <span key={i} aria-hidden="true" className="opponent-card-back card-back" style={style} />
          : <span key={i} aria-hidden="true" className="card-slot" style={style}><span className="table-card card-back" /></span>;
      })}
    </div>;
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
    if (activeDrag?.cardId === id) playDraggedCard(activeDrag);
  }

  function playDraggedCard(drag: CardDrag) {
    if (locked || !decision || decision.promptId !== drag.promptId) return;
    chooseAction(decision.options.filter((option) =>
      option.cardId === drag.cardId && !undoAction(option) && playsCard(option, drag.zone)));
  }

  const showPlayer = (player: Player, own: boolean) => {
    const targets = decision?.targets.filter((target) => target.seat === player.seat && !target.selected) ?? [];
    const combat = attackPrompt ? attacks.playerControl(player.seat) : undefined;
    return <PlayerChip player={player} attack={combat} zone={(zone) => zoneFor(player.seat, zone)}
      zones={own ? ["library", "graveyard", "exile"] : ["hand", "library", "graveyard", "exile"]}
      active={!game.gameOver && game.activeSeat === player.seat}
      selected={targets.some((target) => targetIds.includes(target.responseId))}
      target={!locked && Boolean(combat?.activate || targets.length === 1)}
      selectTarget={combat?.activate ?? (() => targets.length === 1 && toggleTarget(targets[0].responseId))}
      selectZone={(zone) => {
        setReviewId(undefined);
        setOpenedZone({ ownerSeat: zone.ownerSeat, zone: zone.zone });
      }} />;
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
      <section data-motion-zone="hand" data-seat={opponent.seat} className="hand opponent-hand revealed-hand"
        aria-label={`${spectating ? opponent.name + "'s" : "Opponent"} hand, ${opponentHandCount} cards`}>
        {showHand(opponentHand, true)}
      </section>
      <aside className="duel-tools">
        {metadata && <p className="score">Game {metadata.gameNumber} · {metadata.score[seat] ?? 0}–{metadata.score[opponent.seat] ?? 0}</p>}
        {metadata && <details className="log"><summary onClick={(event) => dismissOpenDetails(event.currentTarget)}>Game log</summary><ol aria-label="Game log">
          {metadata?.log.map((entry) => <li key={`server-${entry.id}`}>{entry.text}</li>)}
        </ol></details>}
      </aside>
      <section className="battlefield away" data-motion-zone="battlefield" data-seat={opponent.seat} aria-label={spectating ? `${opponent.name}'s battlefield` : "Opponent battlefield"}>
        <div className="permanents lands">{showPermanents(opponent.seat, true)}</div>
        <div className="permanents">{showPermanents(opponent.seat, false)}</div>
      </section>
      <div className="center-line">
        <span className="waiting" role="status" data-decision={Boolean(decision && !locked)}>{
          game.gameOver ? (game.winnerSeat === undefined ? "Draw" : game.winnerSeat === seat && !spectating ? "You won"
            : `${(game.winnerSeat === seat ? owner : opponent).name} won`)
            : !online ? "Reconnecting…" : spectating ? "Watching live" : locked ? "Syncing…"
            : attackPrompt ? (attacks.choosing ? `Choose a defender for ${attacks.choosing.label}` : "Declare attackers")
            : decision ? "Your decision" : "Waiting for opponent"
        }</span>
      </div>
      <section className="battlefield home" data-motion-zone="battlefield" data-seat={seat} aria-label={spectating ? `${owner.name}'s battlefield` : "Your battlefield"}
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
      <section className="hand own-hand" data-motion-zone="hand" data-seat={seat} aria-label={spectating ? `${owner.name}'s hand` : "Your hand"}>
        {showHand(hand, false)}
      </section>
      <SpellStack objects={stack} targets={locked ? undefined : decision?.targets} targetIds={targetIds}
        hoverCard={hoverCard} toggleTarget={toggleTarget} inspect={(id) => { setOpenedZone(undefined); setReviewId(id); }} />
      <CardMovements key={`${game.roomId}:${game.gameId}:${seat}:${spectating}`} game={game} online={online} pending={pendingCast} />
      {!spectating && <div className="action-dock">
        {decision && !priority && !payment && !attackPrompt && !confirmation && !manaPrompt && !boardChoice && <Decision key={`${decision.gameId}:${decision.promptId}`} prompt={decision}
          toggleTarget={toggleTarget} targetIds={targetIds} submit={respond} disabled={locked} />}
        {currentMenu?.length && <DecisionPanel key={decision?.promptId} title="Choose an action">
          <div data-art-focus>
            {actionCard && <DecisionCard card={visibleFace(actionCard)} focusable />}
            <Options options={currentMenu} submit={respond} />
          </div>
          <footer><button type="button" className="quiet" onClick={(event) => {
            dismissPanel(event.currentTarget.closest(".decision"));
            setActionMenu(undefined);
          }}>Close</button></footer>
        </DecisionPanel>}
        <fieldset className="priority-actions" aria-label="Priority controls" disabled={locked}>
          {boardChoice ? <BattlefieldActions choice={boardChoice} ids={targetIds} submit={respond} /> : confirmation ? <ConfirmationActions confirmation={confirmation} submit={respond} /> : attackPrompt ? <>
            <div className="attack-shortcuts">
              <button type="button" disabled={!attacks.canStrikeAll} onClick={attacks.strikeAll}>All Strike</button>
              <button type="button" onClick={() => respond({ responseId: "$submit", assignments: [] })}>No Attack</button>
            </div>
            {attacks.hasDraft && <button className="quiet" type="button" onClick={attacks.clear}>Cancel</button>}
            <button className="primary" type="button" disabled={Boolean(attacks.choosing)}
              onClick={() => respond({ responseId: "$submit", assignments: attacks.assignments })}>Confirm</button>
          </> : <>
            {payment && <section className="mana-payment" aria-label="Mana payment">
              <strong role="status">{payment.title || "Pay mana"}</strong>
              <Options options={payment.options.filter((option) => option.responseId !== "$auto-pay" &&
                (!option.cardId || option.kind === "undoMana"))} submit={respond} />
              {payment.cancellable && !payment.options.some((option) => option.responseId === "$cancel") &&
                <button type="button" className="quiet" onClick={() => respond({ responseId: "$cancel" })}>Cancel action</button>}
            </section>}
            {priorityOptions.length > 0 && <Options options={priorityOptions} submit={respond} />}
            {autoPassCurrent ? <button type="button" onClick={() => setAutoPass(undefined)}>Cancel auto-pass</button> : priority && !game.gameOver && !priorityStops.hold &&
              <details className="auto-pass"><summary onClick={(event) => dismissOpenDetails(event.currentTarget)}>Auto-pass</summary><div className="choices">
                <button type="button" onClick={() => setAutoPass({ until: "step", step: game.step, turn: game.turn })}>This step</button>
                <button type="button" onClick={() => setAutoPass({ until: "turn", step: game.step, turn: game.turn })}>This turn</button>
              </div></details>}
            {stackPass && <button type="button" onClick={() => respond({ responseId: "$pass-stack" })}>Pass until stack resolves</button>}
            {game.gameOver && metadata?.result?.matchFinished ? <button className="primary" type="button" onClick={back}>
              {tournamentTable ? "Return to tournament" : "Return to room"}
            </button> : autoPay ? <button type="button" className="primary"
              onClick={() => respond({ responseId: autoPay.responseId })}>Auto Pay</button> :
              !payment && <button type="button" className="primary" disabled={!priority || !pass}
                onClick={() => pass && respond({ responseId: pass.responseId })}>Pass priority</button>}
          </>}
        </fieldset>
      </div>}
    </section>
    {manaPrompt && <ManaChoiceMenu key={`${manaPrompt.gameId}:${manaPrompt.promptId}`} prompt={manaPrompt}
      anchor={manaAnchor.current} locked={locked} submit={respond} />}
    <PhaseControls game={game} turnLabel={turnLabel} myTurn={myTurn} {...priorityStops}
      spectatorNames={spectating ? [owner.name, opponent.name] : undefined} />
    {activeDrag && dragView && <div ref={floatingCard} className="floating-hand-card" aria-hidden="true" style={{ left: activeDrag.x, top: activeDrag.y }}>
      {visibleFace(dragView) ? <>
        <CardImage identity={dragView.identity} className="table-card-image" decorative eager compact fallbackName />
      </> : <div className="floating-card-back card-back" />}
    </div>}
    {review && <section className="inspection" aria-label={libraryTop ? "Library top" : "Card preview"}><header className="inspection-actions">
      <button type="button" className="quiet" onClick={(event) => {
        dismissPanel(event.currentTarget.closest(".inspection"));
        setReviewId(undefined);
        if (libraryTop) setOpenedZone(undefined);
      }}>Close</button></header>
      {review.identity?.name && !review.faceDown ? <CardImage identity={review.identity} className="preview-card-image" eager fallbackName />
        : <span className="preview-card-image choice-card-back card-back" role="img" aria-label="Face-down card" />}
      {reviewedStackObject && reviewedStackObject.text && reviewedStackObject.text !== review.identity?.name && <p>{reviewedStackObject.text}</p>}
      {review.counters?.map((counter) => <p key={counter.name}>{counter.name} × {counter.value}</p>)}
    </section>}
    {visibleZone && visibleZone.zone !== "library" && !review && visibleZone.cards.some(visibleFace) && <section className="inspection" aria-label="Zone contents"><header><h2>{visibleZone.zone}</h2>
      <button type="button" className="quiet" onClick={(event) => {
        dismissPanel(event.currentTarget.closest(".inspection"));
        setOpenedZone(undefined);
      }}>Close</button></header>
      <div className="choice-grid">{visibleZone.cards.filter(visibleFace).map((card) => showCard(card, visibleZone.zone, undefined, true))}</div>
    </section>}
  </main>;
}
