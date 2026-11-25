// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const baseURL = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const errors = [];

async function waitFor(condition, description) {
  for (let until = Date.now() + 60000; Date.now() < until;) {
    const value = await condition();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("Timed out waiting for " + description);
}

function observe(page) {
  const state = { page, game: undefined, prompt: undefined, welcome: undefined };
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const event = JSON.parse(payload.toString());
    if (event.type === "rules.snapshot") state.game = event.payload;
    if (event.type === "rules.prompt") state.prompt = event.payload;
    if (event.type === "session.welcome") state.welcome = event.payload;
  }));
  return state;
}

async function enter(context, name) {
  const state = observe(await context.newPage());
  await state.page.goto(baseURL);
  await state.page.getByLabel("Player name").fill(name);
  await button(state.page, "Enter club").click();
  await state.page.getByText("online", { exact: true }).waitFor();
  return state;
}

async function importDeck(page, name, list) {
  await button(page, "Import deck").click();
  await page.getByLabel("Deck name").fill(name);
  await page.getByLabel("MTGA or MTGO decklist").fill(list);
  await button(page, "Save deck").click();
}

async function concede(page) {
  page.once("dialog", (dialog) => dialog.accept());
  await button(page, "Concede game").click();
}

async function practiceAndResume() {
  const context = await browser.newContext();
  let player = await enter(context, "Practice");
  await importDeck(player.page, "Mountains", "60 Mountain");
  await player.page.getByLabel("Opponent").selectOption("practice");
  await button(player.page, "Create practice room").click();
  await player.page.getByLabel("Your deck").selectOption({label: "Mountains"});
  await button(player.page, "Use deck").click();
  await button(player.page, "Ready").click();
  if (process.env.CLUB_TEST_SLOW_READY === "1") {
    // Run against a test Forge launcher that delays the startGame response.
    // The JVM itself is already warmed before Ready is enabled.
    await player.page.getByText("Setting up the match…", { exact: true }).waitFor();
    await player.page.reload();
    await waitFor(() => player.welcome?.resumed, "resume during practice startup");
  }
  const initial = await waitFor(() => player.game, "practice start");
  assert.equal(initial.players[1].name, "Practice opponent");

  for (let attempt = 0; attempt < 18 && player.game.turn < 3; attempt++) {
    const prompt = await waitFor(() => player.prompt?.pending && player.prompt, "human practice prompt");
    if (prompt.kind === "mulligan") await button(player.page, "Keep hand").click();
    else if (prompt.kind === "chooseAction") {
      const readyLand = player.page.getByRole("region", { name: "Your hand" }).locator('[data-actionable="true"][aria-label="Mountain"]').first();
      if (player.game.zones.every((zone) => zone.zone !== "battlefield" || zone.cards.length === 0) && await readyLand.count()) {
        await readyLand.dragTo(player.page.getByRole("region", { name: "Your battlefield" }), { targetPosition: { x: 12, y: 12 } });
      } else await button(player.page, "Pass priority").click();
    } else await player.page.locator(".decision .choices button").first().click();
    await waitFor(() => player.prompt?.promptId !== prompt.promptId || player.game.turn >= 3,
      `Forge advance from ${prompt.kind} on turn ${player.game.turn}, step ${player.game.step}`);
  }
  assert.ok(player.game.turn >= 3, "passive opponent must allow turn advancement");
  assert.ok(player.game.zones.some((zone) => zone.zone === "battlefield" && zone.ownerSeat === 0 && zone.cards.some((card) => card.identity?.name === "Mountain")));
  assert.ok(!player.game.zones.some((zone) => zone.zone === "battlefield" && zone.ownerSeat === 1 && zone.cards.length > 0));
  const gameId = player.game.gameId;
  const roomId = player.game.roomId;
  await player.page.reload();
  await waitFor(() => player.welcome?.resumed && player.game?.gameId === gameId, "reload resume");
  await player.page.close();
  player = observe(await context.newPage());
  await player.page.goto(baseURL);
  await waitFor(() => player.welcome?.resumed && player.game?.gameId === gameId, "closed-tab resume");
  assert.equal(player.welcome.roomId, roomId);
  assert.equal(player.welcome.seat, 0);
  await concede(player.page);
  await waitFor(() => player.game?.gameOver, "practice finished");
  await context.close();
  console.log("Practice advanced turns with no AI plays, accepted a real card drag, and resumed the same seat after reload and after closing the tab");
}

async function registerLineup(player, checkInvalid = false) {
  const page = player.page;
  for (const [index, name] of ["Mountain", "Swamp", "Forest"].entries()) {
    await importDeck(page, name, "60 " + name);
    await page.getByLabel("Deck " + (index + 1)).selectOption({label: name});
  }
  if (checkInvalid) {
    await importDeck(page, "Illegal short deck", "59 Mountain");
    await page.getByLabel("Deck 1").selectOption({label: "Illegal short deck"});
    await button(page, "Validate and register lineup").click();
    await page.getByRole("alert").filter({ hasText: /Forge rejected deck 1.*format_violation/ }).waitFor({timeout: 60000});
    await page.getByLabel("Deck 1").selectOption({label: "Mountain"});
  }
  await button(page, "Validate and register lineup").click();
  await button(page, "Check in").click({timeout: 60000});
}

async function conquest() {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const [host, guest] = await Promise.all([enter(hostContext, "Conquest Host"), enter(guestContext, "Conquest Guest")]);
  await button(host.page, "Tournaments").click();
  await host.page.getByLabel("Tournament name").fill("Browser Conquest");
  await host.page.getByLabel("Structure").selectOption("conquest");
  await button(host.page, "Create Forge tournament").click();
  const code = await host.page.locator(".room-code strong").innerText();
  await button(guest.page, "Tournaments").click();
  await button(guest.page, "Join tournament").click();
  await guest.page.getByLabel("Tournament code").fill(code);
  await button(guest.page, "Enter tournament").click();
  await registerLineup(host, true);
  await registerLineup(guest);
  await button(host.page, "Start tournament").click();
  for (let match = 0; match < 3; match++) {
    const open = (page) => button(page, "Open match");
    await host.page.getByRole("heading", {name: "Match " + (match + 1), exact: true}).waitFor();
    assert.equal(await host.page.getByText("Locked by a BO3 win").count(), match);
    assert.equal(await guest.page.getByText("Locked by a BO3 win").count(), 0);
    await host.page.getByLabel("Deck for this BO3").selectOption(String(match));
    await open(host.page).click();
    await guest.page.getByLabel("Deck for this BO3").selectOption("0");
    await open(guest.page).click();
    assert.ok(await host.page.getByLabel("Your deck").isDisabled());
    await button(guest.page, "Ready").click();
    await button(host.page, "Ready").click();
    await finishBO3(host, guest);
    await button(guest.page, "Return to tournament").click();
    await button(host.page, "Leave").click();
  }
  for (const player of [host, guest]) await player.page.getByText("Winner · Conquest Host", {exact: true}).waitFor();
  assert.equal(await host.page.getByText("Locked by a BO3 win").count(), 3);
  assert.equal(await guest.page.getByText("Locked by a BO3 win").count(), 0);
  await hostContext.close();
  await guestContext.close();
  console.log("Conquest validated and registered both lineups, ran three Forge BO3 matches, and crowned the player whose three decks won");
}

async function finishBO3(host, guest) {
  await concede(guest.page);
  for (const player of [host, guest]) {
    await player.page.getByRole("heading", {name: "Sideboard for game 2"}).waitFor();
    const draw = button(player.page, "Draw first");
    if (await draw.count()) await draw.click();
    await button(player.page, "Ready for next game").click();
  }
  await concede(guest.page);
  await button(guest.page, "Return to tournament").waitFor();
}

async function swissTopEight() {
  const count = 8;
  const players = [];
  for (let index = 0; index < count; index++) {
    const context = await browser.newContext();
    const name = `Swiss player ${index + 1}`;
    players.push({ ...await enter(context, name), context, name });
  }
  const organizer = players[0];
  await button(organizer.page, "Tournaments").click();
  await organizer.page.getByLabel("Tournament name").fill("Browser Swiss Top 8");
  await organizer.page.getByLabel("Swiss rounds").fill("1");
  await organizer.page.getByLabel("Swiss matches").selectOption("bo1");
  await organizer.page.getByLabel("Top eight playoff").check();
  await button(organizer.page, "Create Forge tournament").click();
  const code = await organizer.page.locator(".room-code strong").innerText();
  await Promise.all(players.map(async (player) => {
    if (player !== organizer) {
      await button(player.page, "Tournaments").click();
      await button(player.page, "Join tournament").click();
      await player.page.getByLabel("Tournament code").fill(code);
      await button(player.page, "Enter tournament").click();
    }
    await importDeck(player.page, "Mountains", "60 Mountain");
    await button(player.page, "Register as player").click();
    await button(player.page, "Check in").click();
  }));
  await button(organizer.page, "Start tournament").click();
  for (const [label, count, next] of [
    ["Swiss round 1 of 1", 4, "Start Top 8"],
    ["Quarterfinals", 4, "Advance playoff"],
    ["Semifinals", 2, "Advance playoff"],
    ["Final", 1, "Finish tournament"],
  ]) {
    await organizer.page.getByRole("heading", { name: label, exact: true }).waitFor();
    const tables = await organizer.page.locator(".pairing strong").allTextContents();
    assert.equal(tables.length, count);
    for (const table of tables) {
      const [host, guest] = table.split(" vs ").map((name) => players.find((player) => player.name === name));
      await button(host.page, "Open match").click();
      await button(guest.page, "Open match").click();
      if (label.startsWith("Swiss")) {
        for (const player of [host, guest]) {
          await player.page.getByLabel("Your deck").selectOption({label: "Mountains"});
          await button(player.page, "Use deck").click();
        }
      } else {
        for (const player of [host, guest]) assert.ok(await player.page.getByLabel("Your deck").isDisabled());
      }
      await button(guest.page, "Ready").click();
      await button(host.page, "Ready").click();
      if (label.startsWith("Swiss")) {
        await concede(guest.page);
        await button(guest.page, "Return to tournament").waitFor();
      } else await finishBO3(host, guest);
      await button(guest.page, "Return to tournament").click();
      await button(host.page, "Leave").click();
    }
    await button(organizer.page, next).click();
  }
  await organizer.page.getByText(/^Winner · Swiss player /).waitFor();
  for (const player of players) await player.context.close();
  console.log("Swiss paired eight players, advanced the seeded Top 8, and crowned a winner after eleven real matches");
}

try {
  if (process.env.CLUB_TEST_SWISS === "1") await swissTopEight();
  else {
    await practiceAndResume();
    await conquest();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
