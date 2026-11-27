// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const base = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const mode = process.env.CLUB_CUBE_DRAFT ?? "rochester";
const count = Number(process.env.CLUB_CUBE_SEATS ?? 4);
const preset = process.env.CLUB_CUBE_PRESET;
const playMatches = process.env.CLUB_CUBE_MATCHES !== "0";
assert.ok(["booster", "rochester"].includes(mode) && count >= 4 && count <= 8);
const browser = await chromium.launch({executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]});
const button = (page, name) => page.getByRole("button", {name, exact: true});
const errors = [];
async function until(test, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await sleep(30); }
  throw new Error("Timed out waiting for " + label);
}

async function enter(index, invite) {
  const context = await browser.newContext({viewport: {width: 1360, height: 900}, reducedMotion: "reduce"});
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const player = {page, name: "Cube player " + (index + 1)};
  page.on("pageerror", error => errors.push(String(error)));
  page.on("websocket", ws => ws.on("framereceived", ({payload}) => {
    const {type, payload: data} = JSON.parse(payload.toString());
    if (type === "tournament.snapshot") player.event = data;
    if (type === "limited.snapshot") player.limited = data;
    if (type === "limited.deck_submitted") player.saved = data;
    if (type === "error") errors.push(player.name + ": " + data.message);
  }));
  // The test uses real Forge identities, with deterministic art responses.
  await page.route("**/card-art?**", route => route.fulfill({contentType:"image/svg+xml",
    body:'<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"/>'}));
  await page.goto(invite ? new URL("?cube=" + invite, base).href : base);
  await page.getByLabel("Player name").fill(player.name);
  await button(page, "Enter club").click();
  await page.getByText("online", {exact: true}).waitFor();
  return player;
}

async function setUp() {
  const host = await enter(0);
  const page = host.page;
  await button(page, "Cube").click();
  await button(page, preset ?? "Customed").click();
  if (!preset) {
    await page.getByLabel("Import cube list").setInputFiles({name:"Cube test.txt", mimeType:"text/plain",
      buffer:Buffer.from(`100 Ornithopter\n${45 * count - 100} Memnite\n`)});
    await page.getByLabel("Cube name").fill("Browser cube");
  }
  await page.getByLabel("Players").selectOption(String(count));
  await page.getByLabel("Draft format").selectOption(mode);
  await button(page, "Start cube").click();
  await until(() => host.event?.participantId, "host seat");
  const guests = await Promise.all(Array.from({length: count - 1}, (_, i) => enter(i + 1, host.event.tournamentId)));
  for (const guest of guests) {
    await button(guest.page, "Join room").click();
    await button(guest.page, "Join seat").click();
  }
  const players = [host, ...guests];
  for (const p of players) {
    const check = button(p.page, "Check in");
    if (await check.isVisible()) await check.click();
  }
  await button(page, "Start draft").click();
  await until(() => players.every(p => p.limited?.stage === "draft"), "all draft seats");
  return players;
}

async function draft(players) {
  let seen = 0;
  while (seen < 45 * count) {
    await until(() => players.some(p => p.limited.currentPack?.length), "available pack");
    if (mode === "rochester") {
      await until(() => {
        const frames = players.map(p => p.limited.rochester);
        const first = frames[0];
        return first && frames.every(f => f && f.activeParticipantId === first.activeParticipantId &&
          f.packNumber === first.packNumber && f.cards.length === first.cards.length) &&
          players.filter(p => p.limited.currentPack?.length).length === 1;
      }, "synchronized Rochester pack");
    }
    const picking = players.filter(p => p.limited.currentPack?.length);
    if (mode === "rochester") {
      assert.equal(picking.length, 1);
      const actor = picking[0], active = actor.event.participantId;
      await until(() => players.every(p => p.limited.rochester?.activeParticipantId === active), "shared active seat");
      const publicCard = actor.limited.currentPack[0];
      for (const p of players) assert.ok(p.limited.rochester.cards.some(c => c.instanceId === publicCard.instanceId));
    }
    await Promise.all(picking.map(async p => {
      const before = p.limited.pool.length;
      const pack = p.page.getByRole("group", {name:"Draft pack"});
      await pack.locator("button[data-instance-id]:enabled").first().click();
      await until(() => p.limited.pool.length > before, "committed pick");
    }));
    seen += picking.length;
    if (seen === 1 || mode === "booster" && seen === count) {
      const p = picking[0], owned = p.limited.pool.map(c => c.instanceId), id = p.event.participantId;
      p.limited = undefined;
      await p.page.reload();
      await until(() => p.event?.participantId === id && owned.every(card => p.limited?.pool.some(c => c.instanceId === card)), "resumed draft and owned cards");
    }
  }
  await until(() => players.every(p => p.limited?.stage === "deck_building"), "deck construction");
  const ids = players.flatMap(p => p.limited.pool.map(c => c.instanceId));
  assert.equal(new Set(ids).size, 45 * count);
  assert.ok(players.every(p => p.limited.pool.length === 45));
  if (preset === "100 Ornithopters" && count === 8) {
    const thopters = players.flatMap(p => p.limited.pool).filter(c => c.name === "Ornithopter");
    assert.equal(thopters.length, 100);
  }
}

async function build(player, inspect) {
  const {page} = player;
  const pool = page.getByRole("region", {name:"Drafted cards"});
  if (inspect) {
    const ms = Date.parse(player.limited.buildDeadline) - Date.now();
    assert.ok(ms > 28 * 60000 && ms <= 30 * 60000 + 1000);
    assert.equal(await pool.getByRole("button").count(), new Set(player.limited.pool.map(card => card.name)).size);
    await pool.getByRole("button").first().click();
    const main = page.getByRole("region", {name:"Main deck"});
    await main.getByRole("button").first().click();
    await button(page, "Basic lands").click();
    const modal = page.getByRole("dialog", {name:"Basic lands"});
    await modal.getByRole("spinbutton", {name:"Forest"}).fill("9");
    await button(modal, "Cancel").click();
    assert.equal(await main.getByRole("button", {name:"Remove Forest"}).count(), 0);
  }
  await pool.getByRole("button").first().click();
  for (const n of [20, 19]) {
    await button(page, "Basic lands").click();
    const modal = page.getByRole("dialog", {name:"Basic lands"});
    await modal.getByRole("spinbutton", {name:"Forest"}).fill(String(n));
    await button(modal, "Confirm").click();
  }
  await until(() => player.saved?.mainboardCount === 40, "acknowledged 40-card deck");
  if (inspect) {
    player.limited = undefined;
    await page.reload();
    await until(() => player.limited?.basicLands?.some(c => c.name === "Forest" && c.count === 39) &&
      player.limited?.mainboardInstanceIds?.length === 1, "saved deck after reload");
  }
  await button(page, "Ready").click();
}

async function playPair(a, b) {
  for (const p of [a, b]) await button(p.page, "Open match").click();
  for (const p of [a, b]) await button(p.page, "Ready").click();
  for (let game = 1; game <= 2; game++) {
    b.page.once("dialog", dialog => dialog.accept());
    await button(b.page, "Concede game").click();
    if (game === 1) {
      for (const p of [a, b]) {
        await p.page.getByRole("heading", {name:"Sideboard for game 2"}).waitFor();
        const draw = button(p.page, "Draw first");
        if (await draw.isVisible()) await draw.click();
        await button(p.page, "Ready for next game").click();
      }
    }
  }
  await button(b.page, "Return to tournament").click();
  const back = button(a.page, "Return to tournament"), leave = button(a.page, "Leave");
  await until(async () => await back.isVisible() || await leave.isVisible() || await a.page.locator(".cube-event").isVisible(), "return to event");
  if (await back.isVisible()) await back.click();
  else if (await leave.isVisible()) await leave.click();
}

try {
  const players = await setUp();
  console.log("Draft started", mode, players[0].event.tournamentId);
  await draft(players);
  console.log("Completed 45 picks per seat");
  for (const [i, player] of players.entries()) await build(player, i === 0);
  const host = players[0];
  await until(() => host.event?.currentRound === 1 && host.event.pairings.length > 0, "first pairings");
  assert.equal(host.event.pairings.filter(p => p.bye).length, count % 2);
  console.log("Started competition", host.event.pairings.length, "tables or byes");
  if (playMatches) {
    const pairs = new Set();
    for (let round = 1; round <= 3; round++) {
      await until(() => host.event.currentRound === round, "round " + round);
      const pairings = host.event.pairings.filter(p => !p.bye);
      assert.equal(pairings.length, Math.floor(count / 2));
      for (const pair of pairings) {
        const key = [pair.playerAId, pair.playerBId].sort().join("/");
        assert.ok(!pairs.has(key)); pairs.add(key);
        const lookup = id => players.find(p => p.event.participantId === id);
        await playPair(lookup(pair.playerAId), lookup(pair.playerBId));
        console.log("Finished match", round, key);
      }
    }
    await until(() => host.event.status === "completed", "final standings");
  }
  assert.deepEqual(errors, []);
  console.log(`Passed ${count}-seat ${mode} draft, 45 unique picks per seat, saved deck construction and ${playMatches ? "three rounds of Forge matches" : "round-one pairings"}`);
} finally { await browser.close(); }
