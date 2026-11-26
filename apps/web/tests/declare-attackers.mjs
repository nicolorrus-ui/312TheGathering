// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

// Drive the actual Club client with a repeatable, seat-specific combat prompt.
// Forge's native regression exercises the legality of this side of the protocol.
const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const roomId = "COMBAT", gameId = "combat-controls";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
function card(id, name, controllerSeat, typeLine) {
  return { id, identity: { name }, visible: true, ownerSeat: controllerSeat, controllerSeat, typeLine };
}
const mine = [card("bear", "Grizzly Bears", 0, "Creature"), card("lion", "Serra Angel", 0, "Creature"),
  card("siege", "Invasion of Zendikar", 0, "Battle — Siege")];
const theirs = [card("walker", "Jace Beleren", 1, "Planeswalker"), card("land", "Island", 1, "Basic Land")];
const game = { roomId, gameId, turn: 4, activeSeat: 0, prioritySeat: 0, step: "combatDeclareAttackers",
  gameOver: false, players, stack: [], zones: [mine, theirs].map((cards, ownerSeat) =>
    ({ zone: "battlefield", ownerSeat, count: cards.length, cards })) };
const prompt = { roomId, gameId, kind: "chooseAttackers", pending: true, supported: true,
  options: [], targets: [], choices: [], cards: [], contextCards: [], orderItems: [], damageTargets: [], scryDestinations: [],
  combatSources: [
    { responseId: "source-bear", objectId: "bear", validTargetIds: ["face", "jace", "battle"] },
    { responseId: "source-lion", objectId: "lion", validTargetIds: ["face"] },
  ],
  combatTargets: [{ responseId: "face", kind: "player", label: "Bob", seat: 1 },
    { responseId: "jace", kind: "card", label: "Jace Beleren", objectId: "walker" },
    { responseId: "battle", kind: "card", label: "Invasion of Zendikar", objectId: "siege" }],
};

try {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    let socket, promptId = 0;
    const responses = [];
    const events = new EventEmitter();
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
    const declare = () => send("rules.prompt", { ...prompt, promptId: ++promptId });
    await page.route("**/card-art?**", (route) => route.abort());
    await page.routeWebSocket("**/ws", (route) => {
      socket = route;
      route.onMessage((raw) => {
        const { type, payload } = JSON.parse(raw.toString());
        if (type === "rules.respond") { responses.push(payload); events.emit("response", payload); }
        if (type !== "session.hello") return;
        send("session.welcome", { seat: 0, resumeToken: "combat-seat", roomId, forgeRulesAvailable: true });
        send("room.snapshot", { roomId, phase: "started", seats: players.map((player) => ({ occupied: true, displayName: player.name })) });
        send("rules.snapshot", game);
        declare();
      });
    });
    await page.goto(url);
    await page.getByLabel("Player name").fill("Alice");
    await page.getByRole("button", { name: "Enter club" }).click();
    const controls = page.getByRole("group", { name: "Priority controls" });
    const button = (name) => controls.getByRole("button", { name, exact: true });
    const permanent = (id) => page.locator(`[data-card-id="${id}"]`);
    const angle = (id) => permanent(id).evaluate(async (card) => {
      await Promise.allSettled(card.getAnimations().filter((animation) => animation.transitionProperty === "transform")
        .map((animation) => animation.finished));
      const transform = getComputedStyle(card).transform;
      if (transform === "none") return 0;
      const matrix = new DOMMatrix(transform);
      return Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
    });
    const avatar = page.getByRole("button", { name: "Target Bob" });
    const confirm = button("Confirm"), cancel = button("Cancel");
    async function expectResponse(action, assignments) {
      const before = responses.length;
      const [reply] = await Promise.all([once(events, "response", { signal: AbortSignal.timeout(6000) }), action.click()]);
      assert.equal(responses.length, before + 1);
      assert.deepEqual(reply[0], { promptId, responseId: "$submit", assignments });
    }

    await confirm.waitFor();
    assert.equal(await page.locator(".decision").count(), 0);
    assert.equal(await button("Pass priority").count(), 0);
    assert.equal(await cancel.count(), 0);
    await permanent("bear").click();
    assert.equal(await angle("bear"), 30);
    for (const target of [avatar, permanent("walker"), permanent("siege")]) {
      assert.equal(await target.getAttribute("data-attack-state"), "target");
    }
    assert.notEqual(await permanent("land").getAttribute("data-attack-state"), "target");
    await permanent("walker").click();
    await permanent("lion").click(); // one legal defender
    assert.equal(await permanent("lion").getAttribute("data-attack-state"), "attacking");
    assert.deepEqual(await Promise.all(["bear", "lion"].map(angle)), [30, 30]);
    assert.equal(responses.length, 0);
    await cancel.click();
    assert.equal(await cancel.count(), 0);
    assert.equal(await page.locator('[data-attack-state="attacking"]').count(), 0);
    assert.deepEqual(await Promise.all(["bear", "lion"].map(angle)), [0, 0]);
    await button("All Strike").click();
    assert.equal(await page.locator('[data-attack-state="attacking"]').count(), 2);
    assert.equal(responses.length, 0);
    await expectResponse(confirm, [{ sourceId: "source-bear", targetId: "face" }, { sourceId: "source-lion", targetId: "face" }]);
    send("rules.snapshot", { ...game, zones: [{ ...game.zones[0], cards: mine.map((card) => ({
      ...card, tapped: card.id === "bear", attacking: card.id !== "siege",
    })) }, game.zones[1]] });
    await page.locator('[data-card-id="bear"][data-tapped="true"]').waitFor();
    assert.deepEqual(await Promise.all(["bear", "lion"].map(angle)), [90, 0]);
    send("rules.snapshot", game);

    for (const [target, id] of [[permanent("walker"), "jace"], [permanent("siege"), "battle"], [avatar, "face"]]) {
      declare();
      await permanent("bear").click();
      await target.click();
      await expectResponse(confirm, [{ sourceId: "source-bear", targetId: id }]);
    }
    declare();
    await button("All Strike").click();
    await expectResponse(button("No Attack"), []);
    send("rules.prompt", { ...prompt, promptId: ++promptId, kind: "chooseAction", combatSources: [], combatTargets: [],
      options: [{ responseId: "$pass", kind: "pass", label: "Pass" }] });
    await button("Pass priority").waitFor();
    assert.equal(await button("Confirm").count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Verified attack declarations, legal defender highlights and submissions at ${viewport.width}px.`);
  }
} finally {
  await browser.close();
}
