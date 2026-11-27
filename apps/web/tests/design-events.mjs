// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { readFile } from "node:fs/promises";

const fixtures = new URL("../../../testdata/protocol/v3/", import.meta.url);
async function payload(name) {
  return JSON.parse(await readFile(new URL(name + ".json", fixtures), "utf8")).payload;
}

const [swiss, room, game] = await Promise.all([
  payload("tournament-snapshot-forge"), payload("room-snapshot-club-live"), payload("rules-snapshot-relationships"),
]);

export async function captureEvents({page, capture, send, goto, login}) {
  const button = (name) => page.getByRole("button", {name, exact: true});
  await goto("/");
  await login();
  await button("Tournaments").click();
  await capture("tournament-create", ".lobby-content form");
  await page.getByLabel("Structure").selectOption("conquest");
  await capture("tournament-conquest", ".lobby-content form");
  await button("Join tournament").click();
  await capture("tournament-join", ".lobby-content form");

  const entrants = ["River", "Rowan", "Morgan", "Sage"].map((displayName, i) => ({
    ...swiss.participants[0], participantId: "p-" + (i + 1), displayName,
  }));
  const registration = { ...swiss, currentRound: 0, clubStyle: "swiss", name: "Friday Night Swiss",
    stage: "registration", status: "registration", role: "organizer", organizerName: "River",
    participants: entrants, checkedIn: entrants.length, pairings: [], standings: [] };
  await send("tournament.snapshot", registration);
  await capture("tournament-registration", ".tournament .room-code");

  const pairings = [0, 2].map(i => ({
    ...swiss.pairings[0], pairingId: "table-" + (i / 2 + 1), table: i / 2 + 1,
    playerAId: entrants[i].participantId, playerAName: entrants[i].displayName,
    playerBId: entrants[i + 1].participantId, playerBName: entrants[i + 1].displayName,
    ...(i === 2 ? {status: "confirmed", playerAWins: 2, playerBWins: 1} : {}),
  }));
  const standings = entrants.map((player, i) => ({
    ...swiss.standings[0], ...player, rank: i + 1, wins: i < 2 ? 1 : 0, losses: i < 2 ? 0 : 1,
    matchPoints: i < 2 ? 3 : 0, gameWin: i < 2 ? 0.67 : 0.33,
  }));
  const competition = { ...swiss, clubStyle: "swiss", name: registration.name, currentRound: 2,
    role: "organizer", participants: entrants, pairings, standings };
  await send("tournament.snapshot", competition);
  await capture("tournament-pairings", ".standings-scroll");
  await send("tournament.snapshot", { ...competition, status: "completed", champion: entrants[0].participantId,
    currentRound: 3, roundComplete: true, pairings: pairings.map(p => ({...p, status: "confirmed", playerAWins: 2, playerBWins: 1})) });
  await capture("tournament-complete", ".tournament .notice");

  const liveRooms = [
    { roomId: room.roomId, name: "Friday feature match", deckFormat: "modern", matchMode: "bo3", phase: "started", joinable: true },
    { roomId: "LUNCH2", name: "Lunchtime draft", deckFormat: "limited", matchMode: "bo3", phase: "waiting", joinable: true },
  ];
  await page.route("**/live-rooms", route => route.fulfill({json: liveRooms}));
  await goto("/?watch");
  await capture("watch-lobby", ".live-room-list");
  await goto("/?watch=" + room.roomId);
  await page.getByRole("button", {name: "Leave live view"}).waitFor();
  await send("room.joined", { roomId: room.roomId, role: "spectator" });
  await send("room.snapshot", { ...room, name: liveRooms[0].name, phase: "waiting" });
  await capture("watch-waiting", ".live-decks");
  await send("room.snapshot", { ...room, name: liveRooms[0].name });
  await send("rules.snapshot", game);
  await capture("watch-match", ".watch-layout .battlefield.home");
  // The same expanded panel can be captured at every size; expose the compact
  // toggle as keyboard users would on mobile. Desktop shows the tabs directly.
  const toggle = page.locator(".live-deck-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("tab", {name: room.seats[1].displayName}).click();
  await capture("watch-decklist", "#live-deck-panel");
}
