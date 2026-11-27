// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type CSSProperties, type ButtonHTMLAttributes } from "react";
import { dismissOpenDetails, dismissPanel } from "./boardMotion";
import { cardArtURL, CardImage, imageIdentity, useCardHover, type CardHover } from "./CardImages";
import { BroadcastOracle } from "./BroadcastOracle";
import { CardMovements } from "./CardMovements";
import { battlefieldChoice, BattlefieldActions } from "./BattlefieldChoice";
import { SpellStack, type StackEntry } from "./SpellStack";
import { DecisionCard } from "./DecisionCard";
import { isManaChoice, ManaChoiceMenu, type ManaAnchor } from "./ManaChoiceMenu";
import { ConfirmationActions, Decision, DecisionPanel, Options, simpleConfirmation } from "./Decisions";
import { useAttackDeclaration, type AttackControl } from "./useAttackDeclaration";
import { useCardDrag } from "./useCardDrag";
import { useDuelShortcuts } from "./useDuelShortcuts";
import { phaseControlStep, PhaseControls, usePriorityStops } from "./PhaseControls";
import type { Card, GameMetadata, Option, Player, Prompt, Response, RulesPriority, Snapshot, Zone } from "./protocol";

const manaColor: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless" };
const undoAction = (option: Option) => option.kind === "undoLand" || option.kind === "undoMana";

function fanPosition(index: number, count: number): CSSProperties {
  const position = count < 2 ? 0 : 2 * index / (count - 1) - 1;
  return { "--fan-angle": `${position * Math.min(12, (count - 1) * 2.3)}deg`,
    "--fan-offset": `${position ** 2 * Math.min(12, (count - 1) * 2.5)}px` } as CSSProperties;
}

const visibleFace = (card: Card) => card.visible && !card.faceDown && card.identity?.name ? card.identity : undefined;

function TableCard({ card, actionable, selected, activate, drag, dragging, inspect, hover, style, attack, inZoneViewer }: {
  card: Card; actionable?: boolean; selected?: boolean; activate?: () => void;
  drag?: ButtonHTMLAttributes<HTMLButtonElement>; inspect?: () => void; hover: CardHover; style?: CSSProperties;
  dragging?: boolean; attack?: AttackControl; inZoneViewer?: boolean;
}) {
  const face = imageIdentity(visibleFace(card), card.copy);
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
      onClick={activate} {...drag}
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
type AutoPass = { until: "step" | "turn"; turn: number; step: string }
  | { until: "end"; turn: number; activeSeat: number };
export function Board({ game, seat, prompt, locked, metadata, answer, back, tournamentTable, online, sendPriority, spectating = false }: Props) {
  const [reviewId, setReviewId] = useState<string>();
  const showHover = useCardHover();
  const [openedZone, setOpenedZone] = useState<{ zone: string; ownerSeat: number }>();
  const [actionMenu, setActionMenu] = useState<{ promptId: number; options: Option[] }>();
  const [targetSelection, setTargetSelection] = useState<{ gameId: string; promptId: number; ids: string[] }>();
  const [autoPass, setAutoPass] = useState<AutoPass>();
  const manaAnchor = useRef<ManaAnchor>(undefined);
  const targetIds = targetSelection?.gameId === game.gameId && targetSelection.promptId === prompt?.promptId ? targetSelection.ids : [];
  const isCurrent = prompt?.gameId === game.gameId;
  const decision = !spectating && isCurrent && prompt?.pending ? prompt : undefined;
  const cardDrag = useCardDrag(game.gameId, online && !locked && !game.gameOver && decision?.supported ? decision.promptId : undefined);
  const dragging = cardDrag.dragging;
  const dragView = dragging && game.zones.filter((zone) => zone.zone === dragging.zone)
    .flatMap((zone) => zone.cards).find((card) => card.id === dragging.cardId);
  const activeDrag = online && !locked && !game.gameOver && dragView && dragging?.gameId === game.gameId && dragging.promptId === decision?.promptId ? dragging : undefined;
  const cardInMotion = Boolean(activeDrag);
  const boardRef = useDuelShortcuts(!spectating && online && !locked && !game.gameOver && !cardInMotion && (!decision || decision.supported));
  const priority = decision?.kind === "chooseAction";
  const pass = decision?.options.find((option) => option.responseId === "$pass");
  const hasPriority = priority && decision.supported && Boolean(pass) && game.prioritySeat === seat;
  const myTurn = game.activeSeat === seat;
  const turnSide = myTurn ? "own" : "other";
  const phase = phaseControlStep(game.step);
  const beforeEnd = phase !== "endOfTurn" && phase !== "cleanup";
  // The opponent or a mandatory trigger choice can be first in the end step.
  // Keep the hub stop until this seat actually receives end-step priority.
  const yieldingToEnd = autoPass?.until === "end" && autoPass.turn === game.turn && autoPass.activeSeat === game.activeSeat &&
    online && !game.gameOver && (beforeEnd || (phase === "endOfTurn" && (!hasPriority || locked)));
  const priorityStops = usePriorityStops(game.roomId, online && !game.gameOver, sendPriority, !spectating,
    yieldingToEnd ? `${turnSide}:end` : undefined);
  const stopped = priorityStops.stops.has(`${turnSide}:${phase}`);
  const owner = game.players.find((player) => player.seat === seat);
  const opponent = game.players.find((player) => player.seat !== seat);
  const attackPrompt = !game.gameOver && decision?.supported && decision.kind === "chooseAttackers" ? decision : undefined;
  const attacks = useAttackDeclaration(attackPrompt, opponent?.seat);
  const autoPassCurrent = online && !game.gameOver && !priorityStops.hold && autoPass?.turn === game.turn &&
    (autoPass.until === "end" ? yieldingToEnd : autoPass.step === game.step || (autoPass.until === "turn" && !stopped));

  useEffect(() => {
    if (autoPass && !autoPassCurrent) setAutoPass(undefined);
  }, [autoPass, autoPassCurrent]);
  useEffect(() => {
    if (openedZone && !game.zones.some((zone) => zone.ownerSeat === openedZone.ownerSeat &&
      zone.zone === openedZone.zone && zone.cards.some(visibleFace))) setOpenedZone(undefined);
  }, [game.zones, openedZone]);
  const payment = decision?.supported && decision.kind === "payManaCost" ? decision : undefined;
  const manaPrompt = !game.gameOver && isManaChoice(decision) ? decision : undefined;
  const confirmation = !game.gameOver && !manaPrompt && simpleConfirmation(decision);
  const autoPay = !game.gameOver && payment?.options.find((option) => option.responseId === "$auto-pay");
  const canAutoPass = autoPass?.until === "end" ? beforeEnd && hasPriority : !game.stack.length;

  useEffect(() => {
    // Only send a currently published ordinary-priority response. Every
    // mandatory or specialized decision remains with the player.
    if (!locked && !cardInMotion && autoPassCurrent && canAutoPass && decision?.supported && decision.kind === "chooseAction" && pass) {
      const timer = setTimeout(() => answer(decision, { responseId: pass.responseId }), 220);
      return () => clearTimeout(timer);
    }
  }, [answer, cardInMotion, autoPassCurrent, canAutoPass, decision, locked, pass]);

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
  const stack: StackEntry[] = pendingCast ? [{ ...pendingCast, pending: true, renderKey: pendingCast.id,
    text: pendingCast.identity.name || "Face-down spell" }, ...visibleStack] : visibleStack;
  const reviewedStackObject = reviewId ? stack.find((object) => object.id === reviewId || object.renderKey === reviewId) : undefined;
  const review: Card | undefined = libraryTop ?? (reviewedStackObject ? { id: reviewedStackObject.id, identity: reviewedStackObject.identity,
    visible: true, copy: reviewedStackObject.copy, oracle: reviewedStackObject.text, ownerSeat: -1, controllerSeat: -1 }
    : reviewId ? game.zones.flatMap((zone) => zone.cards ?? []).find((card) => card.id === reviewId && visibleFace(card)) : undefined);
  const hand = zoneFor(seat, "hand");
  const opponentHand = zoneFor(opponent.seat, "hand");
  const opponentHandCount = opponentHand?.count ?? 0;
  const notices = spectating ? undefined : game.viewerNotices;
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

  function showCard(card: Card, zone: string, fan?: { index: number; count: number }, inZoneViewer = false) {
    const targets = decision?.targets.filter((target) => target.objectId === card.id && !target.selected) ?? [];
    const boardId = zone === "battlefield" ? boardChoice?.candidates.get(card.id) : undefined;
    const chosenOnTable = Boolean(boardId && (targetIds.includes(boardId) || boardChoice?.selected.has(boardId)));
    const chooseOnTable = !locked && boardChoice && boardId && !boardChoice.selected.has(boardId) &&
      (chosenOnTable || targetIds.length < boardChoice.max) ? () => toggleTarget(boardId) : undefined;
    const options = decision?.options.filter((option) => option.cardId === card.id && !undoAction(option)) ?? [];
    const dragOptions = options.filter((option) => playsCard(option, zone));
    const clickOptions = options.filter((option) => !playsCard(option, zone));
    const canDrag = online && !locked && !game.gameOver && decision?.supported && dragOptions.length > 0;
    const inspect = spectating || !visibleFace(card) ? undefined : () => setReviewId(card.id);
    const combat = !locked && attackPrompt && zone === "battlefield" ? attacks.cardControl(card.id) : undefined;
    const activate = boardChoice && zone === "battlefield" ? chooseOnTable
      : attackPrompt && zone === "battlefield" ? combat?.activate
      : spectating || canDrag && zone !== "hand" && !targets.length && !clickOptions.length ? undefined : () => {
      if (!locked && targets.length === 1) toggleTarget(targets[0].responseId);
      else if (online && !locked && !targets.length && clickOptions.length) chooseAction(clickOptions);
      else if (!targets.length && canDrag && zone === "hand") chooseAction(dragOptions);
      else if (!targets.length) inspect?.();
    };
    const actionable = !locked && Boolean(boardChoice ? chooseOnTable : combat?.activate || options.length || targets.length);
    return <TableCard key={card.id} card={card} actionable={actionable} attack={combat} inZoneViewer={inZoneViewer}
      selected={combat?.state === "choosing" || combat?.state === "attacking" || chosenOnTable || targets.some((target) => targetIds.includes(target.responseId))}
      activate={activate} inspect={inspect} hover={hoverCard}
      style={fan ? fanPosition(fan.index, fan.count) : undefined}
      dragging={activeDrag?.cardId === card.id}
      drag={canDrag ? cardDrag.handlers({ cardId: card.id, zone, gameId: game.gameId, promptId: decision.promptId },
        () => showHover(), () => chooseAction(dragOptions)) : undefined} />;
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
  const canYieldToEnd = game.turn > 0 && beforeEnd &&
    (decision ? hasPriority : game.prioritySeat === opponent.seat);
  const priorityOptions = priority ? decision.options.filter((option) =>
    undoAction(option) || !option.cardId && option.kind !== "pass" && option.responseId !== "$pass-stack") : [];

  return <main ref={boardRef} className="duel" {...cardDrag.clickGuard}>
    <section className="table" aria-label="Duel table" data-drag-active={Boolean(activeDrag)}>
      <div className="player-info opponent-info">{showPlayer(opponent, false)}</div>
      <section data-motion-zone="hand" data-seat={opponent.seat} className="hand opponent-hand revealed-hand"
        aria-label={`${spectating ? opponent.name + "'s" : "Opponent"} hand, ${opponentHandCount} cards`}>
        {showHand(opponentHand, true)}
      </section>
      <aside className="duel-tools">
        {metadata && <p className="score">Game {metadata.gameNumber} · {metadata.score[seat] ?? 0}–{metadata.score[opponent.seat] ?? 0}</p>}
        {(metadata || Boolean(notices?.length)) && <details className="log"><summary onClick={(event) => dismissOpenDetails(event.currentTarget)}>Game log</summary>
          <div className="log-content">
            {notices && notices.length > 0 && <>
              <h3>Your notices</h3>
              <ol aria-label="Your notices" reversed>{notices.slice().reverse().map((notice) =>
                <li key={notice.id}>{notice.turn > 0 ? `Turn ${notice.turn}` : "Pregame"} · {notice.text}</li>)}</ol>
              {metadata && <h3>Table history</h3>}
            </>}
            {metadata && <ol aria-label="Game log">{metadata.log.map((entry) => <li key={entry.id}>{entry.text}</li>)}</ol>}
          </div>
        </details>}
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
      <section className="battlefield home" data-motion-zone="battlefield" data-seat={seat} aria-label={spectating ? `${owner.name}'s battlefield` : "Your battlefield"}>
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
            <button className="primary" type="button" aria-keyshortcuts="Space" disabled={Boolean(attacks.choosing)}
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
            {autoPassCurrent ? <button type="button" onClick={() => setAutoPass(undefined)}>Cancel auto-pass</button> : (priority || canYieldToEnd) && !game.gameOver && !priorityStops.hold &&
              <details className="auto-pass"><summary onClick={(event) => dismissOpenDetails(event.currentTarget)}>Auto-pass</summary><div className="choices">
                {priority && <>
                  <button type="button" onClick={() => setAutoPass({ until: "step", step: game.step, turn: game.turn })}>This step</button>
                  <button type="button" onClick={() => setAutoPass({ until: "turn", step: game.step, turn: game.turn })}>This turn</button>
                </>}
                <button type="button" aria-keyshortcuts="E" title="Until end step (E)" disabled={!canYieldToEnd}
                  onClick={() => setAutoPass({ until: "end", turn: game.turn, activeSeat: game.activeSeat })}>Until end step</button>
              </div></details>}
            {stackPass && <button type="button" onClick={() => respond({ responseId: "$pass-stack" })}>Pass until stack resolves</button>}
            {game.gameOver && metadata?.result?.matchFinished ? <button className="primary" type="button" onClick={back}>
              {tournamentTable ? "Return to tournament" : "Return to room"}
            </button> : autoPay ? <button type="button" className="primary" aria-keyshortcuts="Space"
              onClick={() => respond({ responseId: autoPay.responseId })}>Auto Pay</button> :
              !payment && <button type="button" className="primary" aria-keyshortcuts="Space" title="Pass priority (Space)" disabled={!priority || !pass}
                onClick={() => pass && respond({ responseId: pass.responseId })}>Pass priority</button>}
          </>}
        </fieldset>
      </div>}
    </section>
    {manaPrompt && <ManaChoiceMenu key={`${manaPrompt.gameId}:${manaPrompt.promptId}`} prompt={manaPrompt}
      anchor={manaAnchor.current} locked={locked} submit={respond} />}
    <PhaseControls game={game} turnLabel={turnLabel} myTurn={myTurn} {...priorityStops}
      spectatorNames={spectating ? [owner.name, opponent.name] : undefined} />
    {activeDrag && dragView && <div ref={cardDrag.floating} className="floating-hand-card" aria-hidden="true">
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
      {review.identity?.name && !review.faceDown ? <>
        <CardImage identity={imageIdentity(review.identity, review.copy)} className="preview-card-image" eager fallbackName english={spectating} />
        {spectating && <BroadcastOracle key={cardArtURL(review.identity)} card={review.identity} />}
      </>
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
