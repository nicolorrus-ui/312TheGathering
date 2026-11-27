// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { readFile } from "node:fs/promises";

const readJSON = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
const protocolFixture = async (name) => (await readJSON(`../../../testdata/protocol/v3/rules-prompt-${name}.json`)).payload;
const preset = (slug) => readJSON(`../../server/cmd/hexproof-server/cube-presets/${slug}.json`);
const button = (page, name) => page.getByRole("button", { name, exact: true });

const roomId = "ABCDEF";
const gameId = "ABCDEF-1";
const players = ["River", "Rowan"].map((name, seat) =>
  ({ name, seat, life: seat === 0 ? 18 : 20, manaPool: [], status: "playing" }));

function zone(ownerSeat, zone, names, count = names.length) {
  return { zone, ownerSeat, count, cards: names.map((name, i) =>
    ({ id: name === "Cascade Bluffs" ? "card-12" : `${ownerSeat}-${zone}-${i}`,
      identity: { name }, ownerSeat, controllerSeat: ownerSeat, visible: true })) };
}

export const game = {
  roomId, gameId, turn: 4, activeSeat: 0, prioritySeat: 0, step: "main1", gameOver: false, players,
  zones: [zone(0, "battlefield", ["Island", "Cascade Bluffs", "Ornithopter"]),
    zone(0, "hand", ["Ponder", "Lightning Bolt", "Counterspell"]), zone(0, "graveyard", ["Brainstorm"]),
    zone(0, "library", [], 39), zone(1, "battlefield", ["Forest", "Birds of Paradise"]),
    zone(1, "hand", [], 3), zone(1, "library", ["Forest"], 42)],
  stack: [],
};
export const room = { roomId, phase: "started", allowSpectators: true, spectatorsSeeHands: true,
  seats: players.map(({ name }) => ({ displayName: name, occupied: true })) };
export const metadata = { roomId, gameNumber: 1, score: [0, 0],
  log: [{ id: 1, kind: "action", text: "River played Cascade Bluffs." }] };

export async function enterGame({ page, send }) {
  send("room.joined", { roomId, seat: 0 });
  send("room.snapshot", room);
  send("rules.snapshot", game);
  send("game.snapshot", metadata);
  await page.getByRole("region", { name: "Duel table" }).waitFor();
}

async function captureCube({ page, send, capture }) {
  await page.route("**/club-cubes/*", async (route) => {
    const slug = new URL(route.request().url()).pathname.split("/").at(-1);
    await route.fulfill({ json: await preset(slug) });
  });
  await button(page, "Cube").click();
  await capture("cube-vintage", ".cube-list-column");
  await button(page, "100 Ornithopters").click();
  await page.getByText("×100", { exact: true }).waitFor();
  await capture("cube-ornithopters");
  await button(page, "Customed").click();
  await capture("cube-custom", ".cube-empty");
  await button(page, "Join cube").click();
  await capture("cube-join", ".cube-join");

  const tournamentId = "CUBE04";
  const people = ["River", "Rowan", "Alex", "Morgan"].map((displayName, i) =>
    ({ participantId: "p" + i, displayName, online: true, checkedIn: true }));
  const draftSettings = { mode: "booster", packsPerPlayer: 3, packsPerBatch: 1, cardsPerPack: 15 };
  const event = { tournamentId, name: "Friday Vintage Cube", format: "limited", clubStyle: "cube", eventType: "cube_draft",
    maxPlayers: 4, registered: 4, checkedIn: 4, participants: people, plannedRounds: 3, currentRound: 0,
    status: "registration", stage: "registration", pairings: [], standings: [], draftSettings };
  const update = (changes) => send("tournament.snapshot", { ...event, participantId: "p0", role: "organizer", ...changes });

  update({ role: "viewer", participantId: undefined, canRegister: true, registered: 2, checkedIn: 2,
    participants: people.slice(1, 3) });
  await button(page, "Join seat").waitFor();
  await capture("cube-room-viewer");
  update({});
  await button(page, "Start draft").waitFor();
  await capture("cube-room-organizer");

  const names = ["Lightning Bolt", "Brainstorm", "Ponder", "Opt", "Ornithopter", "Forest", "Island", "Counterspell"];
  const draftCard = (name, i) => ({ instanceId: "card-" + i, name, setCode: "", collectorNumber: "" });
  const pack = names.slice(0, 6).map(draftCard);
  const pool = [...names.slice(1), "Ornithopter", "Ornithopter"].map((name, i) => draftCard(name, 20 + i));
  const limited = { tournamentId, stage: "draft", packRound: 1, direction: 1, currentPack: pack, pool,
    mainboardInstanceIds: [], basicLands: [], minimumDeckCards: 40, deckSubmitted: false,
    participants: people.map((p) => ({ ...p, picked: pool.length, packCards: pack.length, queuedPacks: 1, deckSubmitted: false })) };
  update({ status: "running", stage: "draft" });
  send("limited.snapshot", limited);
  await capture("cube-booster", ".cube-pack button");
  update({ status: "running", stage: "draft", draftSettings: { ...draftSettings, mode: "rochester" } });
  send("limited.snapshot", { ...limited, currentPack: [], rochester: {
    activeParticipantId: "p1", openerId: "p0", packNumber: 1, cards: pack, picks: [{ participantId: "p0", card: pool[0] }],
  } });
  await capture("cube-rochester", ".cube-public-picks");
  update({ stage: "deck_building", status: "running" });
  send("limited.snapshot", { ...limited, stage: "deck_building", currentPack: [], buildDeadline: new Date(Date.now() + 25 * 60000).toISOString(),
    mainboardInstanceIds: [pool[0].instanceId, pool[1].instanceId], basicLands: [{ name: "Island", count: 8 }] });
  await capture("cube-build", ".cube-build-list .deck-row-action");
  await button(page, "Basic lands").click();
  await capture("cube-basic-lands", ".cube-basics-dialog[open]");
  await button(page, "Cancel").click();
  update({ stage: "competition", status: "running", currentRound: 1,
    pairings: [[0, 2], [1, 3]].map(([a, b], i) => ({ pairingId: "r1t" + i, playerAId: people[a].participantId,
      playerBId: people[b].participantId, playerAName: people[a].displayName, playerBName: people[b].displayName, status: "open" })),
    standings: people.map((person, i) => ({ ...person, rank: i + 1, wins: 0, losses: 0, draws: 0,
      matchPoints: 0, oppMatchWin: 0, gameWin: 0, oppGameWin: 0 })) });
  await page.getByRole("heading", { name: "Round-robin standings" }).waitFor();
  await capture("cube-pairings");
  send("tournament.left", { tournamentId });
}

async function capturePrompts({ page, capture, send }) {
  await enterGame({ page, send });
  const home = page.locator(".own-info");
  await home.getByRole("button", { name: /graveyard/i }).click();
  await capture("duel-zone", '[aria-label="Zone contents"]');
  await button(page.locator(".inspection"), "Close").click();
  await page.locator(".opponent-info").getByRole("button", { name: /library/i }).click();
  await capture("duel-library-top", '[aria-label="Library top"]');
  await button(page.locator(".inspection"), "Close").click();
  await page.locator(".hand.own-hand .table-card").first().click();
  await capture("duel-card-preview", '[aria-label="Card preview"]');
  await button(page.locator(".inspection"), "Close").click();

  let promptId = 1000;
  async function show(name, fields = {}) {
    const payload = await protocolFixture(name);
    send("rules.prompt", { ...payload, roomId, gameId, promptId: ++promptId, ...fields });
    if (["payManaCost", "chooseAttackers", "chooseAction"].includes(payload.kind) || name === "mana-source") return;
    if (name === "replacement") return;
    await page.getByRole("heading", { name: fields.title ?? payload.title, exact: true }).waitFor();
  }
  for (const [name, scene] of [
    ["card-name", "choose-name"], ["cards-disclosure", "choose-cards"], ["reveal", "reveal"], ["scry", "scry"],
    ["replacement-order", "order-replacements"], ["order-abilities", "order-triggers"], ["damage-assignment", "assign-damage"],
    ["multiple-blocks", "choose-blockers"], ["card-choice", "choose-mode"],
    ["acknowledge", "acknowledge"],
  ]) {
    await show(name);
    await capture("duel-" + scene, ".decision-body");
  }
  await show("card-choice", { searchKind: "type", title: "Choose a creature type", choices: ["Elf", "Human", "Merfolk", "Wizard"]
    .map((label, i) => ({ label, responseId: "type:" + i, weight: 1, canRepeat: false })) });
  await capture("duel-choose-type", '.decision input[type="search"]');
  await show("replacement");
  await capture("duel-confirmation", ".confirmation-question");
  await show("payment", { options: [{ kind: "autoPay", responseId: "$auto-pay", label: "Auto pay" },
    { kind: "spendFloatingMana", responseId: "pool", label: "U", manaSymbols: ["U"] }] });
  await capture("duel-payment", ".mana-payment");
  await show("mana-source");
  await capture("duel-mana-menu", ".mana-choice-menu");
}

export async function captureExtra(helpers) {
  await helpers.goto();
  await helpers.login();
  await captureCube(helpers);
  await capturePrompts(helpers);
}
