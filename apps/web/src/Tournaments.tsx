// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
import { formatLabel, formats, type Deck, type DeckFormat } from "./protocol";
import type { useSession } from "./session";

type Session = ReturnType<typeof useSession>;

export function Tournaments({ session, decks }: { session: Session; decks: Deck[] }) {
  const event = session.tournament;
  const online = session.connection === "online";
  const [intent, setIntent] = useState<"create" | "join">(() => new URLSearchParams(location.search).has("tournament") ? "join" : "create");
  const [style, setStyle] = useState<"swiss" | "conquest">("swiss");
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("tournament") ?? "");
  const [format, setFormat] = useState<DeckFormat>("modern");
  const [matchMode, setMatchMode] = useState("bo3");
  const [rounds, setRounds] = useState("");
  const [topEight, setTopEight] = useState(false);

  if (event) return <TournamentPanel key={event.tournamentId} session={session} decks={decks} />;

  return <section className="panel tournament-lobby">
    <div className="tabs">
      <button type="button" aria-pressed={intent === "create"} onClick={() => setIntent("create")}>Create tournament</button>
      <button type="button" aria-pressed={intent === "join"} onClick={() => setIntent("join")}>Join tournament</button>
    </div>
    <form onSubmit={(e) => {
      e.preventDefault();
      if (intent === "join") session.enterTournament(code);
      else session.send("tournament.create", {
        name, format, clubStyle: style, rulesMode: "forge", operationId: crypto.randomUUID(),
        matchMode: style === "conquest" ? "bo3" : matchMode,
        topEight: style === "swiss" && topEight, maxPlayers: style === "swiss" ? 20 : 2,
        plannedRounds: style === "swiss" ? Number(rounds) : undefined,
      });
    }}>
      {intent === "join" ? <label>Tournament code<input required maxLength={16} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label> : <>
        <label>Tournament name<input required maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="form-row">
          <label>Structure<select value={style} onChange={(e) => setStyle(e.target.value === "conquest" ? "conquest" : "swiss")}>
            <option value="swiss">Swiss</option><option value="conquest">Conquest</option>
          </select></label>
          <label>Format<select value={format} onChange={(e) => setFormat(e.target.value as DeckFormat)}>
            {formats.filter((item) => item !== "custom").map((item) => <option key={item} value={item}>{formatLabel(item)}</option>)}
          </select></label>
        </div>
        {style === "swiss" ? <>
          <div className="form-row">
            <label>Swiss rounds<input type="number" min={1} max={20} placeholder="Automatic" value={rounds} onChange={(e) => setRounds(e.target.value)} /></label>
            <label>Swiss matches<select value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
              <option value="bo3">Best of three</option><option value="bo1">Best of one</option>
            </select></label>
          </div>
          <label className="checkbox"><input type="checkbox" checked={topEight} onChange={(e) => setTopEight(e.target.checked)} /> Top eight playoff</label>
        </> : <p>Two players. Win a BO3 with each of your three registered decks.</p>}
      </>}
      <button className="primary" disabled={!online || (intent === "create" && !session.welcome?.forgeRulesAvailable)}>
        {intent === "join" ? "Enter tournament" : "Create Forge tournament"}
      </button>
    </form>
  </section>;
}

function TournamentPanel({ session, decks }: { session: Session; decks: Deck[] }) {
  const event = session.tournament!;
  const [lineup, setLineup] = useState(["", "", ""]);
  const [copied, setCopied] = useState(false);
  const online = session.connection === "online";
  const registered = event.participants.find((player) => player.participantId === event.participantId);
  const organizer = event.role === "organizer";
  const conquest = event.clubStyle === "conquest";
  const active = event.status === "running";
  const registration = event.status === "registration";
  const champion = event.participants.find((player) => player.participantId === event.champion);
  const canSubmitLineup = new Set(lineup).size === 3 && lineup.every((id) => decks.some((deck) => deck.id === id));
  const invitation = new URL(location.pathname, location.origin);
  invitation.searchParams.set("tournament", event.tournamentId);

  return <section className={`panel tournament event-${event.status}`}>
    <header><div><h2>{event.name}</h2><small>{formatLabel(event.format)} · {conquest ? "Conquest" : event.topEight ? "Swiss + Top 8" : "Swiss"}</small></div>
      <button className="quiet" type="button" disabled={!online} onClick={() => session.send("tournament.leave")}>Leave tournament view</button></header>
    <div className="room-code"><span>Tournament code</span><strong>{event.tournamentId}</strong>
      <button className="quiet" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(invitation.href); setCopied(true); }
        catch { setCopied(false); }
      }}>{copied ? "Copied" : "Copy tournament invite"}</button>
    </div>
    {champion && <p className="notice">Winner · {champion.displayName}</p>}
    {event.status === "cancelled" && <p>Tournament cancelled.</p>}
    {registration && <section>
      <h3>Registration</h3>
      <p>{event.checkedIn} checked in · {event.minimumPlayers} needed to start</p>
      <ul>{event.participants.map((player) => <li key={player.participantId} className={player.participantId === event.participantId ? "own-seat" : undefined}>{player.displayName} {player.checkedIn ? "· Checked in" : ""}</li>)}</ul>
      {event.canRegister && <form onSubmit={(e) => {
        e.preventDefault();
        session.send("tournament.register", { tournamentId: event.tournamentId, lineup: conquest ? lineup.map((id) => {
          const deck = decks.find((item) => item.id === id)!;
          return { name: deck.name, format: "modern", deckFormat: event.format, mainboard: deck.mainboard, sideboard: deck.sideboard };
        }) : undefined });
      }}>
        {conquest && lineup.map((id, index) => <label key={index}>Deck {index + 1}
          <select value={id} required onChange={(e) => setLineup(lineup.map((current, i) => i === index ? e.target.value : current))}>
            <option value="">Select a deck</option>{decks.map((deck) => <option key={deck.id} value={deck.id}
              disabled={lineup.includes(deck.id) && id !== deck.id}>{deck.name}</option>)}
          </select>
        </label>)}
        <button className="primary" disabled={!online || (conquest && !canSubmitLineup)}>
          {conquest ? "Validate and register lineup" : "Register as player"}
        </button>
      </form>}
      {registered && <button type="button" className={registered.checkedIn ? undefined : "check-in-action"} disabled={!online} onClick={() => session.send("tournament.check_in", { checkedIn: !registered.checkedIn })}>
        {registered.checkedIn ? "Cancel check-in" : "Check in"}
      </button>}
      {organizer && <button className="primary" type="button" disabled={!online || event.checkedIn < event.minimumPlayers}
        onClick={() => session.send("tournament.start", { expectedStage: "registration", operationId: crypto.randomUUID() })}>Start tournament</button>}
    </section>}

    {conquest && Boolean(event.ownLineup?.length) && <section>
      <h3>Your lineup</h3>
      <ul>{event.ownLineup?.map((deck, index) => <li key={index}>{deck.name} · {deck.locked ? "Locked by a BO3 win" : "Available"}</li>)}</ul>
    </section>}
    <TournamentTables session={session} />
    {organizer && (registration || active) && <button className="quiet" type="button" disabled={!online} onClick={() => {
      if (window.confirm("Cancel this tournament?")) session.send("tournament.cancel");
    }}>Cancel tournament</button>}
  </section>;
}

export function TournamentTables({ session }: { session: Session }) {
  const event = session.tournament!;
  const online = session.connection === "online";
  const [deckIndex, setDeckIndex] = useState("");
  const conquest = event.clubStyle === "conquest";
  const cube = event.clubStyle === "cube";
  const roundRobin = cube && event.maxPlayers === 4;
  const organizer = event.role === "organizer";
  const active = event.status === "running";
  const selected = event.ownChoice !== undefined ? String(event.ownChoice) : deckIndex;
  const currentDeck = selected === "" ? undefined : event.ownLineup?.[Number(selected)];
  const swissFinished = event.currentRound >= event.plannedRounds;
  const roundLabel = conquest ? `Match ${event.currentRound}` : !event.elimination ? `${roundRobin ? "Round robin · Round" : "Swiss round"} ${event.currentRound} of ${event.plannedRounds}`
    : ["Quarterfinals", "Semifinals", "Final"][event.currentRound - event.plannedRounds - 1] ?? "Playoffs";
  return <>
    {event.currentRound > 0 && <section>
      <h3>{roundLabel}</h3>
      {event.pairings.map((pairing) => {
        const ownTable = [pairing.playerAId, pairing.playerBId].includes(event.participantId);
        const open = active && pairing.status === "open" && ownTable && !pairing.bye;
        return <div className={`pairing pairing-${pairing.status}${event.participantId && ownTable ? " own-pairing" : ""}`} key={pairing.pairingId}>
          <strong>{pairing.playerAName} {pairing.bye ? "· Bye" : `vs ${pairing.playerBName}`}</strong>
          {pairing.status === "confirmed" && !pairing.bye && <span>{pairing.playerAWins}–{pairing.playerBWins}
            {pairing.drawnGames ? ` · ${pairing.drawnGames} drawn` : ""}</span>}
          {open && <>
            {conquest && <label>Deck for this BO3<select value={selected} disabled={event.ownChoice !== undefined}
              onChange={(e) => setDeckIndex(e.target.value)}>
              <option value="">Select an unlocked deck</option>
              {event.ownLineup?.map((deck, index) => <option key={index} value={index} disabled={deck.locked}>{deck.name}</option>)}
            </select></label>}
            <button className="primary" type="button" disabled={!online || (conquest && (!currentDeck || currentDeck.locked))}
              onClick={() => session.send("tournament.open_match", { pairingId: pairing.pairingId, deckIndex: conquest ? Number(selected) : undefined })}>Open match</button>
          </>}
        </div>;
      })}
      {organizer && active && !conquest && !cube && <button className="primary" type="button" disabled={!online || !event.roundComplete}
        onClick={() => session.send("tournament.next_round")}>
        {event.elimination ? (event.currentRound === event.plannedRounds + 3 ? "Finish tournament" : "Advance playoff") :
          (swissFinished ? (event.topEight ? "Start Top 8" : "Finish tournament") : "Start next Swiss round")}
      </button>}
    </section>}
    {event.standings.length > 0 && <section>
      <h3>{roundRobin ? "Round-robin standings" : "Swiss standings"}</h3>
      <div className="standings-scroll"><table><thead><tr><th>#</th><th>Player</th><th>W–L–D</th><th>Pts</th><th>OMW</th><th>GW</th><th>OGW</th></tr></thead>
        <tbody>{event.standings.map((row) => <tr key={row.participantId} className={row.participantId === event.participantId ? "own-standing" : undefined}>
          <td>{row.rank}</td><td>{row.displayName}</td><td>{row.wins}–{row.losses}–{row.draws}</td><td>{row.matchPoints}</td>
          <td>{(100 * row.oppMatchWin).toFixed(1)}%</td><td>{(100 * row.gameWin).toFixed(1)}%</td><td>{(100 * row.oppGameWin).toFixed(1)}%</td>
        </tr>)}</tbody></table></div>
    </section>}
  </>;
}
