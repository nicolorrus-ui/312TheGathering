// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useState } from "react";
import { CubeBuild } from "./CubeBuild";
import { CubePool } from "./CubePool";
import { DecisionCard } from "./DecisionCard";
import { TournamentTables } from "./Tournaments";
import type { LimitedSnapshot, Tournament } from "./protocol";
import type { useSession } from "./session";
import "./cube-event.css";

type Session = ReturnType<typeof useSession>;
export const isClubCube = (event?: Tournament) => event?.clubStyle === "cube";

function PickClock({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  if (!Number.isFinite(remaining)) return null;
  return <span className="cube-pick-clock" role="timer" aria-label="Time to pick">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span>;
}

function CubeDraft({ session, event, limited }: { session: Session; event: Tournament; limited: LimitedSnapshot }) {
  const rochester = limited.rochester;
  const participants = limited.participants;
  const owner = participants.find((player) => player.participantId === event.participantId);
  const nameOf = (id: string) => participants.find((player) => player.participantId === id)?.displayName ?? "Player";
  const selectable = new Set(limited.currentPack.map((card) => card.instanceId));
  const pack = rochester?.cards ?? limited.currentPack;
  const round = limited.packRound;
  const active = rochester?.activeParticipantId;
  const yourTurn = owner && (!active || active === owner.participantId) && selectable.size > 0;

  return <section className="cube-draft" aria-label="Cube draft">
    <div className="cube-draft-main">
      <header className="cube-draft-heading"><div>
        <h3>{rochester ? `Open pack ${rochester.packNumber}` : `Booster ${round} of ${event.draftSettings?.packsPerPlayer ?? 3}`}</h3>
        <small>{rochester ? `Opened by ${nameOf(rochester.openerId)}` : limited.direction > 0 ? "Packs pass left" : "Packs pass right"}</small>
      </div>{limited.pickDeadline && <PickClock deadline={limited.pickDeadline} />}</header>
      <p role="status">{yourTurn ? "Choose a card" : active ? `${nameOf(active)} is picking` :
        owner ? "Waiting for your next pack…" : "Draft in progress"}</p>
      {pack.length > 0 && <div className="cube-pack" role="group" aria-label="Draft pack">{pack.map((card) => {
        const face = <DecisionCard card={card} className="cube-card-art" />;
        return yourTurn && selectable.has(card.instanceId) ? <button type="button" className="cube-image-choice"
          key={card.instanceId} data-instance-id={card.instanceId} aria-label={`Pick ${card.name}`}
          disabled={session.connection !== "online" || Boolean(session.pendingPick)}
          onClick={() => session.send("limited.pick", { instanceId: card.instanceId, pickDeadline: limited.pickDeadline })}>{face}</button>
          : <div key={card.instanceId} className="cube-image-choice" tabIndex={0} data-art-focus>{face}</div>;
      })}</div>}
      {rochester && rochester.picks.length > 0 && <div className="cube-public-picks"><h3>Picks from this pack</h3>
        <ol>{rochester.picks.map(({ participantId, card }) => <li key={card.instanceId}>
          <DecisionCard card={card} className="cube-history-art" focusable /><span>{nameOf(participantId)}</span>
        </li>)}</ol></div>}
      {owner && <><h3>Your picks <small>({limited.pool.length})</small></h3>
        <CubePool cards={limited.pool} label="Your picks" /></>}
    </div>
    <aside className="cube-draft-seats" aria-label="Draft seats"><h3>Seats</h3><ol>
      {participants.map((seat) => <li key={seat.participantId} data-active={seat.participantId === active || undefined}>
        <span>{seat.displayName}{seat.participantId === owner?.participantId ? " (you)" : ""}</span><small>{seat.picked} picked</small>
      </li>)}
    </ol></aside>
  </section>;
}

export function CubeEvent({ session }: { session: Session }) {
  const event = session.tournament!;
  const online = session.connection === "online";
  const ownSeat = event.participants.find((player) => player.participantId === event.participantId);
  const [copied, setCopied] = useState(false);
  const limited = session.limited?.tournamentId === event.tournamentId && session.limited.stage === event.stage ? session.limited : undefined;
  const lobby = event.status === "registration";
  const seats = event.maxPlayers;
  const mode = event.draftSettings?.mode === "rochester" ? "Rochester draft" : "Booster draft";
  async function copyInvite() {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("cube", event.tournamentId);
    try { await navigator.clipboard.writeText(url.href); setCopied(true); }
    catch { window.prompt("Copy the Cube invite link", url.href); }
  }
  return <section className={`panel tournament cube-event event-${event.status}`}>
    <header><div><h2>{event.name}</h2><small>{mode} · {seats} seats · {seats === 4 ? "Round robin" : "Swiss"}</small></div>
      <button type="button" className="quiet" disabled={!online} onClick={() => session.send("tournament.leave")}>Leave Cube view</button></header>
    {lobby && <>
      <div className="room-code"><span>Room code</span><strong>{event.tournamentId}</strong>
        <button type="button" className="quiet" onClick={copyInvite}>{copied ? "Invite copied" : "Copy Cube invite"}</button></div>
      <section className="cube-registration" aria-label="Cube seats"><header><h3>Seats</h3>
        <span>{event.checkedIn} of {seats} checked in</span></header>
        <ul className="seats">{Array.from({ length: seats }, (_, index) => {
          const player = event.participants[index];
          return <li key={player?.participantId ?? `open-${index}`} className={player && player.participantId === ownSeat?.participantId ? "own-seat" : undefined}>
            <strong>{player ? player.displayName + (player.participantId === ownSeat?.participantId ? " (you)" : "") : "Open seat"}</strong>
            <small className={player?.checkedIn && player.online !== false ? "seat-ready" : undefined}>{player ? player.online === false ? "Disconnected" : player.checkedIn ? "Checked in" : "Seated" : "Awaiting player"}</small>
            {player && event.role === "organizer" && player.online === false && player.participantId !== ownSeat?.participantId &&
              <button type="button" className="quiet" disabled={!online} aria-label={`Release seat for ${player.displayName}`}
                onClick={() => session.send("tournament.unregister", { participantId: player.participantId })}>Release seat</button>}</li>;
        })}</ul>
        <div className="cube-seat-actions">
          {event.canRegister && !ownSeat && <button type="button" className="primary" disabled={!online || event.participants.length >= seats}
            onClick={() => session.send("tournament.register", { tournamentId: event.tournamentId })}>Join seat</button>}
          {ownSeat && <button type="button" className={ownSeat.checkedIn ? undefined : "check-in-action"} disabled={!online} onClick={() => session.send("tournament.check_in", { checkedIn: !ownSeat.checkedIn })}>
            {ownSeat.checkedIn ? "Cancel check-in" : "Check in"}</button>}
          {ownSeat && event.role !== "organizer" && <button type="button" className="quiet" disabled={!online}
            onClick={() => session.send("tournament.unregister")}>Leave seat</button>}
          {event.role === "organizer" && <button type="button" className="primary" disabled={!online || event.checkedIn !== seats}
            onClick={() => session.send("tournament.start", { expectedStage: "registration", operationId: crypto.randomUUID() })}>Start draft</button>}
        </div>
      </section>
    </>}
    {event.stage === "draft" && (limited ? <CubeDraft event={event} session={session} limited={limited} /> : <p role="status">Loading draft…</p>)}
    {event.stage === "deck_building" && (limited && ownSeat
      ? <CubeBuild key={event.tournamentId + ownSeat.participantId} limited={limited} online={online} send={session.send} lastReply={session.limitedReply} />
      : <p role="status">{limited ? `${limited.participants.filter((player) => player.deckSubmitted).length} of ${seats} decks ready` : "Loading deck construction…"}</p>)}
    {event.status === "completed" && <p role="status" className="notice">Cube complete</p>}
    {event.currentRound > 0 && <TournamentTables session={session} />}
    {event.status === "cancelled" && <p role="status">Cube cancelled.</p>}
  </section>;
}
