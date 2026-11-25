// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const roomId = "MOTION", identity = { name: "Grizzly Bears", setCode: "10e", collectorNumber: "268" };
const at = (zone, seat, objectId) => ({ zone, seat, objectId });
const card = (id, ownerSeat = 0) => ({ id, ownerSeat, controllerSeat: ownerSeat, visible: true, identity });
const spell = { id: "stack-4", identity, text: identity.name, controllerSeat: 0 };
const empty = () => ({ roomId, gameId: "motion-test", turn: 1, activeSeat: 0, prioritySeat: 0,
  step: "main1", players, stack: [], gameOver: false, zones: players.flatMap(({ seat }) =>
    ["library", "hand", "battlefield", "exile", "graveyard"].map((zone) => ({ zone, ownerSeat: seat, count: 0, cards: [] }))) });
const point = (rect) => [rect.x + rect.width / 2, rect.y + rect.height / 2];
const near = (a, b) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 3, `centers ${a} / ${b}`);

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(6000);
  // Pause real Web Animations so Chromium can measure the start, midpoint and landing.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const run = animate.apply(this, args);
      if (this.matches(".moving-card")) run.pause();
      return run;
    };
  });
  await page.route("**/assets/cards/index.json", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/card-art?**", (r) => r.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="green"/></svg>' }));
  let socket, count = 0, connections = 0;
  const events = new EventEmitter();
  const moves = [];
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  const update = (game, ...next) => {
    moves.push(...next.map(([from, to]) => ({ id: ++count, from, to })));
    send("rules.snapshot", { ...game, cardMoves: [...moves] });
  };
  const stack = () => ({ ...empty(), stack: [spell] });
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      if (JSON.parse(raw).type !== "session.hello") return;
      ++connections;
      send("session.welcome", { seat: 0, resumed: connections > 1, resumeToken: "motion-seat", roomId, forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map((p) => ({ occupied: true, displayName: p.name })) });
      update(stack(), [at("hand", 0), at("stack", 0, spell.id)]);
      if (connections > 1) events.emit("resumed");
    });
  });
  await page.goto(url);
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  const tray = page.getByRole("complementary", { name: "Spell and ability stack" });
  const thumbnail = tray.getByRole("button", { name: identity.name });
  await thumbnail.waitFor();
  const ghost = page.locator(".moving-card");
  assert.equal(await ghost.count(), 0, "historical moves replayed at join");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const [table, pile, image] = await Promise.all([page.locator(".table"), tray, thumbnail.locator("img")].map((e) => e.boundingBox()));
    assert.ok(pile.x > table.x + table.width / 2 && Math.abs(point(pile)[1] - page.viewportSize().height / 2) < 2);
    assert.ok(image.width >= 40 && image.height > image.width, "stack should show a portrait thumbnail");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".table").evaluate((el) => { el.style.minHeight = "1650px"; window.scrollTo(0, 420); });
  const scrolled = await tray.boundingBox();
  assert.ok(Math.abs(point(scrolled)[1] - 480) < 2, "stack must remain centered when the battlefield scrolls");
  await page.locator(".table").evaluate((el) => { el.style.minHeight = ""; window.scrollTo(0, 0); });
  const finish = async () => {
    await ghost.evaluate((e) => e.getAnimations()[0].finish());
    await ghost.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-arriving]").count(), 0);
  };
  // Public destinations use the exact visible card; hidden destinations expose only the pile.
  for (const [zone, seat, known] of [["hand", 0, true], ["hand", 1, false], ["library", 0, false],
    ["battlefield", 0, true], ["graveyard", 0, true], ["exile", 0, true]]) {
    update(stack());
    await thumbnail.waitFor();
    const from = point(await thumbnail.boundingBox());
    const result = empty();
    const pile = result.zones.find((z) => z.ownerSeat === seat && z.zone === zone);
    pile.count = 1;
    if (known) pile.cards = [card("card-4", seat)];
    update(result, [at("stack", 0, spell.id), at(zone, seat, known ? "card-4" : undefined)]);
    await ghost.waitFor();
    assert.equal(await tray.count(), 0);
    assert.equal(await ghost.evaluate((e) => e.classList.contains("card-back")), !known);
    assert.equal(await ghost.locator("img").count(), known ? 1 : 0);
    near(point(await ghost.boundingBox()), from);
    const target = known && (zone === "hand" || zone === "battlefield") ? page.locator('[data-card-id="card-4"]')
      : page.locator(`[data-motion-zone="${zone}"][data-seat="${seat}"]`);
    const to = point(await target.boundingBox());
    const sample = async (fraction) => {
      await ghost.evaluate((e, f) => {
        const animation = e.getAnimations()[0];
        animation.currentTime = animation.effect.getTiming().duration * f;
      }, fraction);
      return point(await ghost.boundingBox());
    };
    const mid = await sample(.4);
    assert.ok(Math.hypot(mid[0] - from[0], mid[1] - from[1]) > 5 && Math.hypot(mid[0] - to[0], mid[1] - to[1]) > 5);
    near(await sample(.999), to);
    await finish();
    update(result);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await ghost.count(), 0, "the next snapshot replayed a move");
  }
  function single(endpoint) {
    const game = empty();
    const zone = game.zones.find((z) => z.ownerSeat === endpoint.seat && z.zone === endpoint.zone);
    zone.count = 1;
    if (endpoint.objectId) zone.cards.push(card(endpoint.objectId, endpoint.seat));
    return game;
  }
  for (const [from, to] of [[at("library", 0), at("hand", 0, "card-4")],
    [at("hand", 0, "card-4"), at("battlefield", 0, "card-4")],
    [at("hand", 0, "card-4"), at("graveyard", 0, "card-4")],
    [at("battlefield", 0, "card-4"), at("hand", 0, "card-4")]]) {
    update(single(from));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const arrived = single(to);
    update(arrived, [from, to]);
    await ghost.waitFor();
    assert.equal(await ghost.locator("img").count(), from.objectId ? 1 : 0);
    if (to.zone === "battlefield") {
      arrived.zones.find((zone) => zone.zone === to.zone).cards[0].faceDown = true;
      update(arrived);
      await ghost.locator("img").waitFor({ state: "detached" });
      assert.equal(await ghost.textContent(), "");
    }
    await finish();
  }
  const anonymousHand = at("hand", 1), grave = at("graveyard", 1, "card-9"), board = at("battlefield", 1, "card-4");
  update(single(board));
  await page.locator('.away [data-card-id="card-4"]').waitFor();
  update(single(grave), [board, anonymousHand], [anonymousHand, grave]);
  await page.waitForFunction(() => document.querySelectorAll(".moving-card.card-back").length === 2);
  assert.equal(await ghost.locator("img").count(), 0, "an anonymous hand must not link two physical cards");
  await ghost.evaluateAll((cards) => cards.forEach((e) => e.getAnimations()[0].finish()));
  await ghost.first().waitFor({ state: "detached" });
  const hand = single(at("hand", 0, "card-4"));
  const held = at("hand", 0, "card-4"), onStack = at("stack", 0, spell.id), library = at("library", 0);
  update(hand);
  await page.locator('.own-hand [data-card-id="card-4"]').waitFor();
  update(stack(), [held, onStack]);
  await page.locator('.moving-card[data-to="stack"]').waitFor();
  await ghost.evaluate((e) => { e.getAnimations()[0].currentTime = 100; });
  const inFlight = point(await ghost.boundingBox());
  update(empty(), [onStack, library]);
  await page.locator('.moving-card[data-to="library"]').waitFor();
  near(point(await ghost.boundingBox()), inFlight);
  assert.equal(await ghost.evaluate((e) => e.getAnimations()[0].effect.getKeyframes().length), 3);
  await finish();
  update(hand);
  await page.locator('.own-hand [data-card-id="card-4"]').waitFor();
  update(empty(), [held, onStack], [onStack, library]);
  await ghost.waitFor();
  assert.equal(await ghost.evaluate((e) => e.getAnimations()[0].effect.getKeyframes().length), 3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ghost.waitFor({ state: "detached" });
  update(stack(), [library, onStack]);
  await thumbnail.waitFor();
  assert.equal(await ghost.count(), 0);
  assert.equal(await page.locator("[data-arriving]").count(), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await Promise.all([once(events, "resumed", { signal: AbortSignal.timeout(6000) }),
    socket.close({ code: 1001, reason: "exercise resumption" })]);
  await thumbnail.waitFor();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await ghost.count(), 0, "reconnecting should not replay the server's recent history");
  assert.deepEqual(errors, []);
  console.log("PASS centered stack thumbnails, stack and ordinary zone moves, private endpoints and revocation, joined paths, replay and reduced motion");
} finally {
  await browser.close();
}
