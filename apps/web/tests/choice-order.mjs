// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const roomId = "CHOICE", gameId = "choice-order";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const cards = [
  { name: "Island", readOnly: true }, { name: "Ponder" }, { name: "Grizzly Bears", readOnly: true }, { name: "Opt" },
].map((card, index) => ({ ...card, id: `card-${index}` }));

try {
  const page = await browser.newPage();
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      if (JSON.parse(raw.toString()).type !== "session.hello") return;
      send("session.welcome", { seat: 0, resumeToken: "choice-seat", roomId, forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map(({ name }) => ({ occupied: true, displayName: name })) });
      send("rules.snapshot", { roomId, gameId, turn: 1, activeSeat: 0, prioritySeat: 0, step: "main1",
        players, zones: [], stack: [], gameOver: false });
    });
  });
  await page.goto(process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320");
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  await page.getByRole("region", { name: "Your hand" }).waitFor();

  async function show(kind, fields) {
    const title = "Testing " + kind;
    send("rules.prompt", { roomId, gameId, promptId: ++promptId, kind, title, pending: true, supported: true,
      cards: [], choices: [], targets: [], options: [], contextCards: [], orderItems: [], damageTargets: [],
      scryDestinations: [], combatSources: [], combatTargets: [], ...fields });
    await page.getByRole("heading", { name: title }).waitFor();
  }
  const grid = page.locator(".decision .choice-card");
  const names = () => grid.locator("strong").allTextContents();
  await show("chooseCards", { cards, minCardSelections: 0, maxCardSelections: 1 });
  assert.deepEqual(await names(), ["Ponder", "Opt", "Island", "Grizzly Bears"]);
  await grid.filter({ hasText: "Opt" }).click();
  assert.deepEqual(await names(), ["Opt", "Island", "Ponder", "Grizzly Bears"]);
  assert.equal(await page.locator(".choice-card:enabled").count(), 1);
  await grid.first().click();
  assert.deepEqual(await names(), ["Ponder", "Opt", "Island", "Grizzly Bears"]);

  await show("chooseBoardTargets", { minSelections: 0, maxSelections: 2,
    targets: ["Already chosen", "First", "Second"].map((label, i) =>
      ({ label, responseId: `target:${i}`, selected: i === 0 })) });
  assert.deepEqual(await page.locator(".decision .choices button").allTextContents(), ["First", "Second", "Already chosen"]);

  await show("chooseFromSelection", { minChoiceTotal: 1, maxChoiceTotal: 2,
    choices: ["Heavy", "One", "Two"].map((label, i) => ({ label, responseId: `choice:${i}`, weight: i === 0 ? 2 : 1 })) });
  await page.getByRole("button", { name: "One", exact: true }).click();
  assert.deepEqual(await page.locator(".decision .choices button").allTextContents(), ["One", "Two", "Heavy"]);
  assert.ok(await page.getByRole("button", { name: "Heavy" }).isDisabled());

  await show("revealCards", { cards });
  assert.deepEqual(await names(), cards.map((card) => card.name));
  await show("reorder", { orderItems: cards.map(({ id, name }) => ({ responseId: id, name })) });
  assert.deepEqual(await page.locator(".order-list li > div:first-child").allTextContents(), cards.map((card) => card.name));
  await show("scry", { cards, scryDestinations: ["libraryTop", "libraryBottom"] });
  assert.deepEqual(await page.locator(".order-list select").evaluateAll((items) =>
    items.map((item) => item.getAttribute("aria-label"))), cards.map((card) => "Destination for " + card.name));
  console.log("Verified stable selectable-first cards, targets and weighted choices, and unchanged reveal, reorder and scry order.");
} finally { await browser.close(); }
