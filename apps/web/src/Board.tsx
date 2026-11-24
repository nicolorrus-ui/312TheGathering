// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { CardImage } from "./CardImages";
import { Decision, DecisionPanel, Options } from "./Decisions";
import type { Card, GameMetadata, Option, Player, Prompt, Response, Snapshot, Zone } from "./protocol";

const manaColor: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless" };
const phases = [
  ["untap", "Untap", "Untap"], ["upkeep", "Upkeep", "Upkeep"], ["draw", "Draw", "Draw"],
  ["main1", "First main", "Main I"], ["combatBegin", "Beginning of combat", "Combat"],
  ["combatDeclareAttackers", "Declare attackers", "Attack"], ["combatDeclareBlockers", "Declare blockers", "Block"],
  ["combatFirstStrikeDamage", "First strike damage", "First strike"], ["combatDamage", "Combat damage", "Damage"],
  ["combatEnd", "End of combat", "End combat"], ["main2", "Second main", "Main II"],
  ["endOfTurn", "End step", "End"], ["cleanup", "Cleanup", "Cleanup"],
] as const;

function PhaseTrack({ game, turnLabel }: { game: Snapshot; turnLabel: string }) {
  return <aside className="phase-rail" aria-label="Turn phases">
    <header className="turn-widget"><strong>Turn {game.turn || "—"}</strong><small>{turnLabel}</small></header>
    <ol className="phase-track">{phases.map(([id, label, short]) => <li key={id} data-phase={id}
      aria-current={game.step === id ? "step" : undefined} aria-label={label} title={label}>
      {short}
    </li>)}</ol>
  </aside>;
}

function fanPosition(index: number, count: number): CSSProperties {
  const position = count < 2 ? 0 : 2 * index / (count - 1) - 1;
  return { "--fan-angle": `${position * Math.min(12, (count - 1) * 2.3)}deg`,
    "--fan-offset": `${position ** 2 * Math.min(12, (count - 1) * 2.5)}px` } as CSSProperties;
}

function TableCard({ card, actionable, selected, activate, drag, inspect, style }: {
  card: Card; actionable?: boolean; selected?: boolean; activate?: () => void;
  drag?: (event: DragEvent) => void; inspect: () => void; style?: CSSProperties;
}) {
  const showBack = !card.visible || Boolean(card.faceDown);
  const name = (card.visible ? card.identity?.name : undefined) ?? (card.faceDown ? "Face-down permanent" : "Hidden card");
  return <div className={`card-slot ${card.tapped ? "tapped" : ""}`} style={style}>
    <button type="button" className={`table-card ${card.land ? "land" : ""} ${showBack ? "card-back" : ""}`}
      data-card-id={card.id} data-actionable={Boolean(actionable)} data-tapped={Boolean(card.tapped)}
      aria-label={name} aria-pressed={selected || undefined} title={card.typeLine ? `${name} · ${card.typeLine}` : name}
      draggable={Boolean(drag)} onDragStart={drag} onClick={activate ?? inspect}
      onContextMenu={(event) => { event.preventDefault(); inspect(); }}>
      {!showBack && <>
        <strong>{name}</strong>
        {card.typeLine && <small>{card.typeLine}</small>}
        {card.oracle && <span className="card-text">{card.oracle}</span>}
        <CardImage identity={card.identity} className="table-card-image" decorative />
      </>}
      {card.power !== undefined && <b className="pt">{card.power}/{card.toughness}</b>}
      {card.attacking && <span className="combat-tag">Attacking</span>}
      {Boolean(card.blocking?.length) && <span className="combat-tag">Blocking</span>}
    </button>
  </div>;
}

function PlayerChip({ player, zone, zones, target, selectTarget, selectZone }: {
  player: Player; zone: (name: string) => Zone | undefined; zones: string[];
  target?: boolean; selectTarget: () => void; selectZone: (zone: Zone) => void;
}) {
  return <div className="player-chip">
    <button type="button" className="player-life" data-actionable={Boolean(target)} onClick={selectTarget}
      disabled={!target} aria-label={`Target ${player.name}`}>
      <span className="monogram">{player.name.slice(0, 1).toUpperCase()}</span>
      <span className="player-name" title={player.name}>{player.name}</span><strong>{player.life}</strong>
    </button>
    <div className="zones">{zones.map((name) => {
      const entry = zone(name);
      return <button className="zone-button" type="button" key={name} disabled={!entry?.cards?.some((card) => card.visible)}
        onClick={() => entry && selectZone(entry)}>{name} <strong>{entry?.count ?? 0}</strong></button>;
    })}</div>
  </div>;
}

type Props = { game: Snapshot; seat: number; prompt?: Prompt; locked: boolean; metadata?: GameMetadata;
  answer: (prompt: Prompt, response: Response) => void; concede: () => void; back: () => void };
type AutoPass = { until: "step" | "turn"; turn: number; step: string };

export function Board({ game, seat, prompt, locked, metadata, answer, concede, back }: Props) {
  const [reviewId, setReviewId] = useState<string>();
  const [openedZone, setOpenedZone] = useState<{ zone: string; ownerSeat: number }>();
  const [actionMenu, setActionMenu] = useState<{ promptId: number; options: Option[] }>();
  const [targetSelection, setTargetSelection] = useState<{ promptId: number; ids: string[] }>();
  const [autoPass, setAutoPass] = useState<AutoPass>();
  const targetIds = targetSelection && targetSelection.promptId === prompt?.promptId ? targetSelection.ids : [];
  const isCurrent = prompt?.gameId === game.gameId;
  const decision = isCurrent && prompt?.pending ? prompt : undefined;
  const priority = decision?.kind === "chooseAction";
  const myTurn = game.activeSeat === seat;
  const owner = game.players.find((player) => player.seat === seat);
  const opponent = game.players.find((player) => player.seat !== seat);
  const autoPassCurrent = autoPass?.turn === game.turn && (autoPass.until === "turn" || autoPass.step === game.step);
  const pass = decision?.options.find((option) => option.responseId === "$pass");

  useEffect(() => {
    // Only send a currently published ordinary-priority response. Every
    // mandatory or specialized decision remains with the player.
    if (!locked && autoPassCurrent && decision?.kind === "chooseAction" && pass && !game.stack.length) {
      const timer = setTimeout(() => answer(decision, { responseId: pass.responseId }), 220);
      return () => clearTimeout(timer);
    }
  }, [answer, autoPassCurrent, decision, game.stack.length, locked, pass]);

  if (!owner || !opponent) return <main className="shell"><p>Waiting for both seats.</p></main>;
  const allPermanents = game.zones.filter((zone) => zone.zone === "battlefield").flatMap((zone) => zone.cards ?? []);
  const zoneFor = (who: number, zone: string) => game.zones.find((entry) => entry.ownerSeat === who && entry.zone === zone);
  const reviewedStackObject = reviewId ? game.stack.find((object) => object.id === reviewId) : undefined;
  const review: Card | undefined = reviewedStackObject ? { id: reviewedStackObject.id, identity: reviewedStackObject.identity,
    visible: true, oracle: reviewedStackObject.text, ownerSeat: -1, controllerSeat: -1 }
    : reviewId ? game.zones.flatMap((zone) => zone.cards ?? []).find((card) => card.id === reviewId && card.visible) : undefined;
  const visibleZone = openedZone ? zoneFor(openedZone.ownerSeat, openedZone.zone) : undefined;
  const hand = zoneFor(seat, "hand")?.cards ?? [];
  const opponentHandCount = zoneFor(opponent.seat, "hand")?.count ?? 0;
  const currentMenu = actionMenu?.promptId === decision?.promptId ? actionMenu?.options : undefined;
  const respond = (response: Response) => {
    if (decision && !locked) {
      setActionMenu(undefined);
      answer(decision, response);
    }
  };

  function toggleTarget(id: string) {
    if (!decision || locked) return;
    if (targetIds.includes(id)) setTargetSelection({ promptId: decision.promptId, ids: targetIds.filter((value) => value !== id) });
    else if (targetIds.length < decision.maxSelections) setTargetSelection({ promptId: decision.promptId, ids: [...targetIds, id] });
  }

  function activateCard(card: Card) {
    if (!decision || locked) return setReviewId(card.id);
    const targets = decision.targets.filter((target) => target.objectId === card.id && !target.selected);
    if (targets.length === 1) return toggleTarget(targets[0].responseId);
    if (targets.length > 1) return;
    const options = decision.options.filter((option) => option.cardId === card.id);
    if (options.length === 1) return respond({ responseId: options[0].responseId });
    if (options.length > 1) return setActionMenu({ promptId: decision.promptId, options });
    setReviewId(card.id);
  }

  function showCard(card: Card, handIndex?: number) {
    const targets = decision?.targets.filter((target) => target.objectId === card.id && !target.selected) ?? [];
    const options = decision?.options.filter((option) => option.cardId === card.id) ?? [];
    const actionable = !locked && Boolean(options.length || targets.length);
    return <TableCard key={card.id} card={card} actionable={actionable}
      selected={targets.some((target) => targetIds.includes(target.responseId))}
      activate={() => activateCard(card)} inspect={() => setReviewId(card.id)}
      style={handIndex === undefined ? undefined : fanPosition(handIndex, hand.length)}
      drag={handIndex !== undefined && !locked && options.length > 0 ? (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-hexproof-card", card.id);
      } : undefined} />;
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    const card = hand.find((entry) => entry.id === event.dataTransfer.getData("application/x-hexproof-card"));
    if (card && decision?.options.some((option) => option.cardId === card.id)) activateCard(card);
  }

  const showPlayer = (player: Player, own: boolean) => {
    const targets = decision?.targets.filter((target) => target.seat === player.seat && !target.selected) ?? [];
    return <PlayerChip player={player} zone={(zone) => zoneFor(player.seat, zone)}
      zones={own ? ["library", "graveyard", "exile"] : ["hand", "library", "graveyard", "exile"]}
      target={!locked && targets.length === 1} selectTarget={() => targets.length === 1 && toggleTarget(targets[0].responseId)}
      selectZone={(zone) => setOpenedZone({ ownerSeat: zone.ownerSeat, zone: zone.zone })} />;
  };
  const showPermanents = (who: number, lands: boolean) => allPermanents.filter((card) =>
    card.controllerSeat === who && Boolean(card.land) === lands).map((card) => showCard(card));
  const turnLabel = game.gameOver ? "Game over" : myTurn ? "Your turn" : `${opponent.name}'s turn`;
  const stackPass = Boolean(game.stack.length && decision?.options.some((option) => option.responseId === "$pass-stack"));
  const priorityOptions = priority ? decision.options.filter((option) =>
    !option.cardId && option.kind !== "pass" && option.responseId !== "$pass-stack") : [];

  return <main className="duel">
    <section className="table" onDragOver={(event) => {
      if (event.dataTransfer.types.includes("application/x-hexproof-card")) event.preventDefault();
    }} onDrop={drop}>
      <div className="player-info opponent-info">{showPlayer(opponent, false)}</div>
      <section className="hand opponent-hand" aria-label={`Opponent hand, ${opponentHandCount} cards`}>
        <div className="hand-fan" aria-hidden="true">
          {Array.from({ length: opponentHandCount }, (_, index) =>
            <span key={index} className="opponent-card-back card-back" style={fanPosition(index, opponentHandCount)} />)}
        </div>
      </section>
      <aside className="duel-tools">
        {metadata && <p className="score">Game {metadata.gameNumber} · {metadata.score[seat] ?? 0}–{metadata.score[opponent.seat] ?? 0}</p>}
        <details className="log"><summary>Game log</summary><ol aria-label="Game log">
          {metadata?.log.map((entry) => <li key={`server-${entry.id}`}>{entry.text}</li>)}
        </ol></details>
      </aside>
      <section className="battlefield away" aria-label="Opponent battlefield">
        <div className="permanents lands">{showPermanents(opponent.seat, true)}</div>
        <div className="permanents">{showPermanents(opponent.seat, false)}</div>
      </section>
      <div className="center-line"><span>Stack</span><div className="stack">
        {game.stack.length === 0 ? <span className="empty-stack">Empty</span> : game.stack.map((object) => {
          const target = decision?.targets.find((choice) => choice.objectId === object.id && !choice.selected);
          return <button key={object.id} type="button" title={object.text} aria-pressed={target ? targetIds.includes(target.responseId) : undefined}
            data-actionable={Boolean(target)} onClick={() => target ? toggleTarget(target.responseId) :
              setReviewId(object.id)}>{object.identity.name || object.text}</button>;
        })}
      </div><span className="waiting">{game.gameOver ? (game.winnerSeat === undefined ? "Draw" : game.winnerSeat === seat ? "You won" : `${opponent.name} won`)
        : locked ? "Syncing…" : decision ? "Your decision" : "Waiting for opponent"}</span></div>
      <section className="battlefield home" aria-label="Your battlefield">
        <div className="permanents">{showPermanents(seat, false)}</div>
        <div className="permanents lands">{showPermanents(seat, true)}</div>
      </section>
      <div className="player-info own-info">{showPlayer(owner, true)}
        <div className="mana-pool" aria-label="Mana pool"><small>Mana pool</small>
          {owner.manaPool.length ? owner.manaPool.map((mana) =>
            <span key={mana.name} className={`mana ${manaColor[mana.name] ?? ""}`}>{mana.name} {mana.value}</span>) : <span>Empty</span>}
        </div>
      </div>
      <section className="hand own-hand" aria-label="Your hand">
        <div className="hand-fan">{hand.map((card, index) => showCard(card, index))}</div>
      </section>
      <div className="action-dock">
        {decision && !priority && <Decision key={`${decision.gameId}:${decision.promptId}`} prompt={decision}
          toggleTarget={toggleTarget} targetIds={targetIds} submit={respond} disabled={locked} />}
        {currentMenu?.length && <DecisionPanel key={decision?.promptId} title="Choose an action">
          <Options options={currentMenu} submit={respond} />
          <footer><button type="button" className="quiet" onClick={() => setActionMenu(undefined)}>Close</button></footer>
        </DecisionPanel>}
        <fieldset className="priority-actions" aria-label="Priority controls" disabled={locked}>
          {priorityOptions.length > 0 && <Options options={priorityOptions} submit={respond} />}
          {autoPassCurrent ? <button type="button" onClick={() => setAutoPass(undefined)}>Cancel auto-pass</button> : priority && !game.gameOver &&
            <details className="auto-pass"><summary>Auto-pass</summary><div className="choices">
              <button type="button" onClick={() => setAutoPass({ until: "step", step: game.step, turn: game.turn })}>This step</button>
              <button type="button" onClick={() => setAutoPass({ until: "turn", step: game.step, turn: game.turn })}>This turn</button>
            </div></details>}
          {stackPass && <button type="button" onClick={() => respond({ responseId: "$pass-stack" })}>Pass until stack resolves</button>}
          {game.gameOver && metadata?.result?.matchFinished ? <button className="primary" type="button" onClick={back}>Return to room</button> : <>
            <button type="button" className="primary" disabled={!priority || !pass}
              onClick={() => pass && respond({ responseId: pass.responseId })}>Pass priority</button>
            <button type="button" className="quiet concede" disabled={game.gameOver}
              onClick={() => window.confirm("Concede this game?") && concede()}>Concede game</button>
          </>}
        </fieldset>
      </div>
    </section>
    <PhaseTrack game={game} turnLabel={turnLabel} />
    {review && <section className="inspection" aria-label="Card preview"><header><h2>{review.identity?.name ?? "Face-down card"}</h2>
      <button type="button" className="quiet" onClick={() => setReviewId(undefined)}>Close</button></header>
      {!review.faceDown && <CardImage identity={review.identity} className="preview-card-image" />}
      <small>{review.typeLine} {review.identity?.setCode && `· ${review.identity.setCode} ${review.identity.collectorNumber}`}</small>
      <p>{review.oracle}</p>
      {review.counters?.map((counter) => <p key={counter.name}>{counter.name} × {counter.value}</p>)}
    </section>}
    {visibleZone && <section className="inspection" aria-label="Zone contents"><header><h2>{visibleZone.zone}</h2>
      <button type="button" className="quiet" onClick={() => setOpenedZone(undefined)}>Close</button></header>
      <div className="choice-grid">{visibleZone.cards.filter((card) => card.visible).map((card) => showCard(card))}</div>
    </section>}
  </main>;
}
