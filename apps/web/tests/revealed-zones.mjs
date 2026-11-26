// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = new URL(process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const roomId = "REVEAL", gameId = "known-zones";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const card = (id, name) => ({ id, visible: true, ownerSeat: 1, controllerSeat: 1, identity: { name } });
const bolt = card("bolt", "Lightning Bolt"), island = card("island", "Island"), forest = card("forest", "Forest");
const printing = (collectorNumber, setCode, count) => ({ name: "Lightning Bolt", setCode, collectorNumber, count });
const lists = [
  { seat: 0, name: "Alice's deck", mainboard: [printing("149", "M11", 1), printing("141", "A25", 1), printing("149", "M11", 2)], sideboard: [] },
  { seat: 1, name: "Bob's deck", mainboard: [], sideboard: [printing("141", "A25", 1)] },
];

try {
  for (const watch of [false, true]) {
    const page = await browser.newPage();
    let socket;
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
    function snapshot(hand, library, marked = true) {
      send("rules.snapshot", { roomId, gameId, activeSeat: 0, prioritySeat: 0, turn: 3, step: "main1",
        players, gameOver: false, stack: [
          { id: "stack-copy", copy: true, controllerSeat: 1, identity: { name: "Counterspell" }, text: "Counterspell" },
          { id: "stack-original", controllerSeat: 1, identity: { name: "Counterspell" }, text: "Counterspell" },
        ], zones: [
          { zone: "battlefield", ownerSeat: 1, count: 2, cards: [
            { ...card("clone", "Grizzly Bears"), copy: marked, summoningSick: marked },
            card("original", "Grizzly Bears"),
          ] },
          { zone: "hand", ownerSeat: 1, count: 3, cards: hand },
          { zone: "library", ownerSeat: 1, count: 40, cards: library },
          { zone: "hand", ownerSeat: 0, count: 2, cards: [] },
        ] });
    }
    await page.route("**/card-art?**", (route) => route.fulfill({ contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="18"/>' }));
    await page.route("**/assets/cards/index.json", (route) => route.fulfill({ json: { version: 1, printings: {}, names: {} } }));
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const { type } = JSON.parse(raw.toString());
        if (type === "session.hello") {
          send("session.welcome", { seat: watch ? -1 : 0, roomId, resumeToken: "known-zones-token", forgeRulesAvailable: true });
          if (watch) return;
        } else if (type === "room.join" && watch) send("room.joined", { roomId });
        else return;
        send("room.snapshot", { roomId, phase: "started", seats: players.map(({ name }) => ({ displayName: name, occupied: true })),
          ...(watch ? { liveDeckLists: lists } : {}) });
        snapshot([bolt], [island]);
      });
    });
    const url = new URL(base);
    if (watch) url.searchParams.set("watch", roomId);
    await page.goto(url.href);
    if (!watch) {
      await page.getByLabel("Player name").fill("Alice");
      await page.getByRole("button", { name: "Enter club" }).click();
    } else {
      const rail = page.getByRole("complementary", { name: "Registered decklists" });
      const preview = page.locator(".card-hover-preview img");
      for (const [player, section, total, expected] of [
        ["Alice", "Main deck", 2, [["M11", "149", "3"], ["A25", "141", "1"]]],
        ["Bob", "Sideboard", 1, [["A25", "141", "1"]]],
      ]) {
        await rail.getByRole("tab", { name: player }).click();
        await preview.waitFor({ state: "detached" });
        const rows = rail.getByRole("region", { name: section }).getByRole("listitem");
        assert.equal(await rows.count(), total);
        for (const [set, number, count] of expected) {
          const row = rows.filter({ hasText: set + " " + number });
          assert.equal(await row.locator(".deck-quantity").textContent(), count);
          await row.hover();
          await preview.waitFor();
          const query = new URL(await preview.getAttribute("src"), base).searchParams;
          assert.deepEqual([query.get("set"), query.get("number"), query.get("size")], [set.toLowerCase(), number, "normal"]);
        }
      }
    }
    const clone = page.locator('[data-card-id="clone"]');
    await clone.locator(".copy-tag").waitFor();
    await clone.locator(".sickness-tag").waitFor();
    assert.equal(await page.locator('[data-card-id="original"] .permanent-status').count(), 0);
    await page.locator('[data-stack-id="stack-copy"] .copy-tag').waitFor();
    assert.equal(await page.locator('[data-stack-id="stack-original"] .copy-tag').count(), 0);
    snapshot([bolt], [island], false);
    await clone.locator(".permanent-status").first().waitFor({ state: "detached" });
    const revealed = page.locator(".opponent-hand [data-card-id]");
    await revealed.waitFor();
    assert.equal(await revealed.getAttribute("aria-label"), "Lightning Bolt");
    assert.equal(await page.locator(".opponent-hand .opponent-card-back").count(), 2);
    await revealed.hover();
    await page.locator(".card-hover-preview").waitFor();
    snapshot([{ ...bolt, faceDown: true, oracle: "Private rules text" }], [island]);
    await revealed.waitFor({ state: "detached" });
    await page.locator(".card-hover-preview").waitFor({ state: "detached" });
    assert.equal(await page.locator(".opponent-hand .opponent-card-back").count(), 3);
    assert.doesNotMatch(await page.locator(".opponent-hand").innerHTML(), /Lightning Bolt|Private rules text|data-card-id=/i);
    const library = page.locator(".opponent-info").getByRole("button", { name: /library/i });
    await library.click();
    const top = page.getByRole("region", { name: "Library top" });
    await top.locator('img[src*="name=island"]').waitFor();
    snapshot([], [forest]);
    await top.locator('img[src*="name=forest"]').waitFor();
    snapshot([], []);
    await top.waitFor({ state: "detached" });
    assert.ok(await library.isDisabled());
    assert.equal(await page.locator('[data-card-id="bolt"], [data-card-id="forest"]').count(), 0);
    snapshot([], [island]);
    await page.waitForFunction(() => !document.querySelector(".opponent-info [data-motion-zone=library]").disabled);
    assert.equal(await top.count(), 0);
    await page.close();
  }
  console.log("Verified known cards, library tops, copy badges and summoning sickness for a player and a spectator");
} finally { await browser.close(); }
