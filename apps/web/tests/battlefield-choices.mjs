// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const roomId = "TABLE", gameId = "table-choices";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const card = (id, name, seat) => ({ id, identity: { name }, visible: true, ownerSeat: seat, controllerSeat: seat });
const mine = card("card-1", "Temple Garden", 0), theirs = card("card-2", "Temple Garden", 1);
mine.land = theirs.land = true;
const bear = card("card-3", "Grizzly Bears", 1), bolt = card("card-4", "Lightning Bolt", 1);
const zones = [
  { ownerSeat: 0, zone: "battlefield", cards: [mine], count: 1 },
  { ownerSeat: 1, zone: "battlefield", cards: [theirs, bear], count: 2 },
  { ownerSeat: 1, zone: "hand", cards: [bolt], count: 1 },
];
const target = (card, responseId) => ({ kind: "card", responseId, objectId: card.id, label: card.identity.name, ...card.identity });
const candidate = (card) => ({ id: card.id, ...card.identity });

async function exercise(touch) {
  const page = await browser.newPage({ viewport: touch ? { width: 844, height: 390 } : { width: 1440, height: 900 },
    hasTouch: touch, isMobile: touch });
  const errors = [], events = new EventEmitter();
  page.on("pageerror", (error) => errors.push(error.message));
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  await page.route("**/assets/cards/index.json", (r) => r.fulfill({ json: { version: 1, names: {}, printings: {} } }));
  await page.route("**/card-art?**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === "rules.respond") events.emit("answer", payload);
      if (type !== "session.hello") return;
      send("session.welcome", { seat: 0, resumeToken: "table-seat", roomId, forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map(({ name }) => ({ occupied: true, displayName: name })) });
      send("rules.snapshot", { roomId, gameId, turn: 1, activeSeat: 0, prioritySeat: 0, step: "main1",
        players, zones, stack: [], gameOver: false });
    });
  });
  await page.goto(process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320");
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  const table = (card) => page.locator(`.battlefield button[data-card-id="${card.id}"]`);
  await table(theirs).waitFor();
  const panel = page.locator(".decision");
  const dock = page.getByRole("group", { name: "Priority controls" });
  const select = (button) => touch ? button.tap() : button.press("Enter");
  async function prompt(kind, fields, direct) {
    const title = `Choose ${++promptId}`;
    send("rules.prompt", { roomId, gameId, title, promptId, kind, supported: true, pending: true, cards: [], targets: [],
      contextCards: [], choices: [], options: [], orderItems: [], scryDestinations: [], combatSources: [], combatTargets: [], damageTargets: [], ...fields });
    if (direct) {
      await dock.getByText(title, { exact: true }).waitFor();
      assert.equal(await panel.count(), 0);
    } else await panel.getByRole("heading", { name: title }).waitFor();
  }
  async function answer(button, fields) {
    const [[received]] = await Promise.all([once(events, "answer", { signal: AbortSignal.timeout(6000) }), select(button)]);
    assert.deepEqual(received, { promptId, responseId: "$submit", ...fields });
  }
  await prompt("chooseBoardTargets", { minSelections: 1, maxSelections: 1, cancellable: true,
    targets: [target(mine, "target:0"), target(theirs, "target:1")] }, true);
  assert.equal(await table(bear).getAttribute("data-actionable"), "false");
  await answer(table(theirs), { targetIds: ["target:1"] });

  await prompt("chooseBoardTargets", { minSelections: 0, maxSelections: 1, targets: [target(bear, "target:0")] }, true);
  await answer(dock.getByRole("button", { name: "Skip" }), { targetIds: [] });
  await prompt("chooseCards", { minCardSelections: 1, maxCardSelections: 1, cancellable: true, cards: [candidate(bear)] }, true);
  await answer(dock.getByRole("button", { name: "Cancel" }), { responseId: "$cancel" });
  await prompt("chooseCards", { minCardSelections: 1, maxCardSelections: 1, cards: [candidate(bear)] }, true);
  await answer(table(bear), { cardIds: [bear.id] });
  await prompt("chooseBoardTargets", { minSelections: 2, maxSelections: 2,
    targets: [target(bear, "target:0"), target(mine, "target:1")] }, true);
  await select(table(mine)); await select(table(bear));
  await answer(dock.getByRole("button", { name: "Confirm" }), { targetIds: ["target:1", "target:0"] });
  await prompt("chooseCards", { minCardSelections: 1, maxCardSelections: 2, cards: [mine, theirs, bear].map(candidate) }, true);
  const confirm = dock.getByRole("button", { name: "Confirm" });
  assert.equal(await confirm.isDisabled(), true);
  await select(table(theirs)); await select(table(mine));
  assert.equal(await table(bear).getAttribute("data-actionable"), "false");
  await select(table(mine)); await select(table(bear));
  await answer(confirm, { cardIds: [theirs.id, bear.id] });

  for (const cards of [[bear, bolt], [bear]]) {
    await prompt("chooseCards", { includesOtherZones: true, minCardSelections: 0, maxCardSelections: 1, cards: cards.map(candidate) }, false);
    await select(panel.getByRole("button", { name: bear.identity.name, exact: true }));
    await answer(panel.getByRole("button", { name: "Confirm" }), { cardIds: [bear.id] });
  }
  const player = { kind: "player", responseId: "target:1", seat: 1, label: "Bob · Seat 2" };
  await prompt("chooseBoardTargets", { minSelections: 1, maxSelections: 1, targets: [target(bear, "target:0"), player] }, false);
  await select(panel.getByRole("button", { name: player.label }));
  await answer(panel.getByRole("button", { name: "Confirm" }), { targetIds: [player.responseId] });
  assert.deepEqual(errors, []);
  await page.close();
}
try {
  await exercise(false);
  await exercise(true);
  console.log("Passed desktop and touch battlefield target, card selection, cancellation, and mixed-zone decisions");
} finally { await browser.close(); }
