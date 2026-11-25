// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const baseURL = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const ignoreHTTPSErrors = process.env.CLUB_TEST_TLS_TEST_CERT === "1";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const deck = "Deck\n12 Mountain (M11) 242\n12 Evolving Wilds (ROE) 228\n36 Lightning Bolt (M11) 149\n\nSideboard\n2 Mountain";
const matchMode = process.env.CLUB_TEST_MATCH ?? "bo1";
const verifyLayout = process.env.CLUB_TEST_LAYOUT === "1";
const verifyImages = process.env.CLUB_TEST_IMAGES === "1";
const verifyMobileImages = process.env.CLUB_TEST_MOBILE_IMAGES === "1";
const verifyCapacity = process.env.CLUB_TEST_CAPACITY === "1";
const imageRequests = [];
let verifiedHandAndPreview = false;
let verifiedTable = false;
let verifiedDecision = false;
let verifiedStack = false;
let verifiedSpellClick = false;
const seenBattlefieldOrientations = new Set();
const forbidden = ["game.set_tapped", "room.list", "room.ai.configure", "tournament.create"];
const stats = { actions: 0, tapped: 0, floatingMana: 0, targetedFace: 0, resolutions: 0, privateSearch: 0, reconnect: 0, drag: 0 };
const pageErrors = [];

function collect(page, name) {
  const peer = { page, name, messages: [], responseCount: 0, prompt: undefined, game: undefined, welcome: undefined };
  if (verifyImages) page.on("request", (request) => {
    if (request.resourceType() === "image") imageRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => {
    const frame = JSON.parse(payload.toString());
    if (frame.type === "rules.priority") peer.priorityPreferences = frame.payload;
    if (frame.type === "rules.respond") peer.responseCount += 1;
  }));
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(payload.toString());
    peer.messages.push(frame);
    if (frame.type === "rules.snapshot") peer.game = frame.payload;
    if (frame.type === "rules.prompt") peer.prompt = frame.payload;
    if (frame.type === "session.welcome") peer.welcome = frame.payload;
  }));
  return peer;
}

async function fillDeck(peer, text) {
  await peer.page.getByRole("button", { name: "Import deck" }).click();
  await peer.page.getByLabel("Deck name").fill("Browser fixture");
  await peer.page.getByLabel("MTGA or MTGO decklist").fill(text);
  await peer.page.getByRole("button", { name: "Save deck" }).click();
}

async function enter(context, name, list) {
  const peer = collect(await context.newPage(), name);
  if (verifyMobileImages) {
    await peer.page.route("**/assets/cards/index.json", (route) => route.fulfill({ status: 404 }));
  }
  await peer.page.goto(baseURL);
  await peer.page.getByLabel("Player name").fill(name);
  await peer.page.getByRole("button", { name: "Enter club" }).click();
  await peer.page.getByText("online", { exact: true }).waitFor();
  await fillDeck(peer, list);
  return peer;
}

async function create(host, format, match = "bo1") {
  await host.page.getByLabel("Room name").fill("Browser integration duel");
  await host.page.getByLabel("Format", { exact: true }).selectOption(format);
  await host.page.getByLabel("Match", { exact: true }).selectOption(match);
  await host.page.getByLabel("Room password").fill("correct room password");
  await host.page.getByRole("button", { name: "Create private duel" }).click();
  return host.page.locator(".room-code strong").innerText();
}

async function join(guest, roomId, password) {
  await guest.page.getByRole("button", { name: "Join room", exact: true }).click();
  await guest.page.getByLabel("Room code").fill(roomId);
  await guest.page.getByLabel("Room password").fill(password);
  await guest.page.getByRole("button", { name: "Join duel" }).click();
}

async function selectDeck(peer) {
  const deck = peer.page.getByLabel("Your deck");
  await deck.selectOption({ label: "Browser fixture" });
  await peer.page.getByRole("button", { name: "Use deck" }).click();
}

async function ready(peer) {
  try { await peer.page.getByRole("button", { name: "Ready", exact: true }).click({ timeout: 60000 }); }
  catch (error) { throw new Error(`Could not ready ${peer.name}: ${await peer.page.locator("body").innerText()}`, { cause: error }); }
}

async function startGuestFirst(host, guest) {
  await ready(guest);
  await guest.page.getByRole("button", { name: "Cancel ready", exact: true }).waitFor();
  await ready(host);
}

async function checkCapacityGate() {
  const contexts = await Promise.all([browser.newContext({ ignoreHTTPSErrors }), browser.newContext({ ignoreHTTPSErrors })]);
  const [host, guest] = await Promise.all([
    enter(contexts[0], "Waiting host", deck),
    enter(contexts[1], "Waiting guest", deck),
  ]);
  const room = await create(host, "custom", "bo3");
  await join(guest, room, "correct room password");
  await Promise.all([selectDeck(host), selectDeck(guest)]);
  for (const peer of [host, guest]) {
    await peer.page.getByText("Forge is occupied by another match.", { exact: true }).waitFor();
    assert.ok(await peer.page.getByRole("button", { name: "Ready", exact: true }).isDisabled());
    assert.equal(await peer.page.locator(".room-code strong").innerText(), room);
    assert.equal(await peer.page.locator(".selected-deck").innerText(), "Browser fixture selected");
    assert.ok(!peer.messages.some(({ type }) => type === "match.started"));
  }
  return { host, guest };
}

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(15);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function verifyPrivacy(peer) {
  const own = peer.game.players.find((player) => player.name === peer.name).seat;
  for (const zone of peer.game.zones) {
    if (zone.ownerSeat !== own && (zone.zone === "library" || zone.zone === "hand")) {
      assert.ok(zone.cards.every((card) => !card.visible && !card.identity && !card.oracle && !card.typeLine),
        `opponent ${zone.zone} exposed to ${peer.name} at ${peer.prompt?.kind}`);
    }
  }
}

async function verifyImage(locator) {
  const image = locator.first();
  await image.scrollIntoViewIfNeeded();
  await until(() => image.evaluate((element) => element.complete && element.naturalWidth > 0), "a decoded card image");
}

async function verifyTable(peer) {
  const { page, game } = peer;
  const opponent = game.players.find((player) => player.name !== peer.name);
  const count = game.zones.find((zone) => zone.ownerSeat === opponent.seat && zone.zone === "hand")?.count ?? 0;
  const backs = page.locator(".opponent-card-back");
  await until(async () => await backs.count() === count, "opponent hand backs");
  assert.ok(count > 0);
  assert.equal(await page.locator(".opponent-hand img, .opponent-hand [data-card-id]").count(), 0);
  const backURL = await backs.first().evaluate((back) => {
    const background = getComputedStyle(back).backgroundImage;
    return background.match(/^url\("(.+)"\)$/)?.[1];
  });
  assert.ok(backURL && new URL(backURL).origin === new URL(baseURL).origin);
  const cardBack = await page.request.get(backURL);
  assert.ok(cardBack.ok() && cardBack.headers()["content-type"]?.startsWith("image/jpeg"));
  await page.locator(`.phase-track [data-phase="${game.step}"][aria-current="step"]`).waitFor();
  const fan = page.locator(".own-hand .card-slot");
  assert.match(await fan.first().evaluate((slot) => slot.style.getPropertyValue("--fan-angle")), /^-/);
  assert.ok(parseFloat(await fan.last().evaluate((slot) => slot.style.getPropertyValue("--fan-angle"))) > 0);
  const [hand, opponentHand, board, phases, controls] = await Promise.all(
    [".own-hand", ".opponent-hand", ".table", ".phase-rail", ".action-dock"].map((selector) => page.locator(selector).boundingBox()));
  assert.ok(opponentHand.y < board.y + board.height / 2 && hand.y > board.y + board.height / 2);
  assert.ok(phases.x >= board.x + board.width && controls.x >= hand.x + hand.width);
  assert.equal(await page.getByRole("complementary", { name: "Spell and ability stack" }).count(), 0);
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const mine = page.getByRole("button", { name: "My turn · Upkeep stop", exact: true });
  const theirs = page.getByRole("button", { name: "Opponent's turn · Upkeep stop", exact: true });
  assert.equal(await mine.getAttribute("aria-pressed"), "true");
  assert.equal(await theirs.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "Opponent's turn · Draw stop", exact: true }).getAttribute("aria-pressed"), "false");
  assert.ok((await mine.boundingBox()).x < (await theirs.boundingBox()).x);
  await mine.click();
  await until(() => peer.priorityPreferences && !peer.priorityPreferences.stops.includes("own:upkeep"), "left stop sent to Forge");
  assert.equal(await theirs.getAttribute("aria-pressed"), "true");
  await mine.click();
  const hold = page.getByRole("switch", { name: "Hold priority" });
  await hold.click();
  await until(() => peer.priorityPreferences?.hold === true, "hold enabled for Forge");
  await hold.click();
  await until(() => peer.priorityPreferences?.hold === false, "hold disabled for Forge");
  if (verifyMobileImages || verifyImages) {
    const art = page.locator(".own-hand img.table-card-image").first();
    await verifyImage(art);
    if (verifyMobileImages) assert.match(await art.getAttribute("src"), /^\/card-art\?/);
    assert.equal(await art.getAttribute("loading"), "eager");
    assert.equal(await page.locator(".opponent-hand img").count(), 0);
  }
  await page.setViewportSize(desktop);
}

async function verifyStack(peer) {
  const { page, game } = peer;
  const tray = page.getByRole("complementary", { name: "Spell and ability stack" });
  await tray.waitFor();
  assert.equal(await tray.getByRole("button").count(), game.stack.length);
  const [board, bounds, phases] = await Promise.all(
    [page.locator(".table"), tray, page.locator(".phase-rail")].map((element) => element.boundingBox()));
  assert.ok(bounds.x > board.x + board.width / 2 && bounds.x + bounds.width < phases.x);
  const desktop = page.viewportSize();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await tray.isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally {
    await page.setViewportSize(desktop);
  }
}

async function verifyDecisionWindow(peer, panel, selection) {
  const { page, prompt } = peer;
  const minimize = panel.getByRole("button", { name: "Minimize" });
  const expand = panel.getByRole("button", { name: "Expand" });
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 2);
  assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 2);

  const confirm = await panel.getByRole("button", { name: "Confirm", exact: true }).boundingBox();
  assert.ok(confirm && confirm.y + confirm.height <= box.y + box.height);

  const selectedId = prompt.promptId;
  await minimize.click();
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  assert.ok(!await selection.isVisible());
  const dock = await panel.boundingBox();
  assert.ok(dock.x + dock.width / 2 > viewport.width / 2 && dock.y > box.y && dock.width < box.width);
  await expand.click();
  assert.equal(await minimize.getAttribute("aria-expanded"), "true");
  assert.ok(await selection.isVisible());
  assert.equal(await selection.getAttribute("aria-pressed"), "true");
  assert.equal(peer.prompt.promptId, selectedId);
}

async function clickFirst(locator) {
  await locator.first().click({ timeout: 4500 });
}

function ownBattlefield(page) {
  return page.getByRole("region", { name: "Your battlefield" });
}

async function dragToBattlefield(page, card) {
  await card.first().dragTo(ownBattlefield(page), { targetPosition: { x: 12, y: 12 }, timeout: 4500 });
  stats.drag += 1;
}

async function verifyInertHandClick(peer, card) {
  const responses = peer.responseCount;
  await card.click();
  assert.equal(peer.responseCount, responses, "clicking a hand card must not play it");
}

async function verifyCardInteraction(peer, card) {
  const { page } = peer;
  const preview = page.locator(".card-hover-preview");
  await card.hover();
  await preview.waitFor();
  const previewBox = await preview.boundingBox();
  const cardBox = await card.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(previewBox.width > cardBox.width, "hover art is larger than the hand card");
  assert.ok(previewBox.x + previewBox.width / 2 < viewport.width / 2, "hover art appears on the left");
  assert.ok(Math.abs(previewBox.y + previewBox.height / 2 - viewport.height / 2) <= 2, "hover art is vertically centered");
  if (verifyImages) await verifyImage(preview.locator("img"));

  await verifyInertHandClick(peer, card);
  const responses = peer.responseCount;

  const battlefield = await ownBattlefield(page).boundingBox();
  const hand = await page.getByRole("region", { name: "Your hand" }).boundingBox();
  const fieldX = battlefield.x + 12;
  const fieldY = battlefield.y + 12;
  const handX = hand.x + hand.width / 2;
  const handY = hand.y + hand.height / 2;
  const floating = page.locator(".floating-hand-card");
  await page.mouse.down();
  try {
    await page.mouse.move(fieldX, fieldY, { steps: 8 });
    await page.mouse.move(fieldX, fieldY);
    await floating.waitFor({ timeout: 4500 });
    await page.mouse.move(handX, handY, { steps: 8 });
    await page.mouse.move(handX, handY);
    await floating.waitFor({ state: "hidden", timeout: 4500 });
    await page.mouse.move(fieldX, fieldY, { steps: 8 });
    await page.mouse.move(fieldX, fieldY);
  } finally {
    await page.mouse.up();
  }
  await floating.waitFor({ state: "hidden", timeout: 4500 });
  assert.equal(peer.responseCount, responses, "returning a dragged card to the hand must cancel the gesture");
  assert.equal(await card.getAttribute("data-actionable"), "true", "the canceled card remains playable");
  console.log("Verified centered hover art, floating drag, drag cancellation and inert hand clicks");
}

async function act(peer, opponent) {
  const { prompt, page, game } = peer;
  const panel = page.locator(".decision").last();
  switch (prompt.kind) {
    case "chooseAction": {
      const seat = game.players.find((player) => player.name === peer.name).seat;
      const availableMountain = game.zones.some((zone) => zone.zone === "battlefield" && zone.cards.some((card) =>
        card.controllerSeat === seat && !card.tapped && card.identity?.name === "Mountain"));
      const floated = game.players[seat].manaPool.some(({ value }) => value > 0);
      const hand = page.getByRole("region", { name: "Your hand" });
      const wilds = hand.locator('[data-actionable="true"][aria-label="Evolving Wilds"]');
      const mountain = hand.locator('[data-actionable="true"][aria-label="Mountain"]');
      const activeWilds = ownBattlefield(page)
        .locator('[data-actionable="true"][aria-label="Evolving Wilds"]');
      const bolt = hand.locator('[data-actionable="true"][aria-label="Lightning Bolt"]');
      const handLand = await wilds.count() ? wilds : mountain;
      if (await handLand.count()) {
        if (!stats.drag) await verifyCardInteraction(peer, handLand.first());
        await dragToBattlefield(page, handLand);
      } else if (await activeWilds.count()) {
        await clickFirst(activeWilds);
      } else if ((availableMountain || floated) && await bolt.count()) {
        const manaLand = ownBattlefield(page)
          .locator('[data-actionable="true"][data-tapped="false"][aria-label="Mountain"]');
        if (!stats.floatingMana && await manaLand.count()) await clickFirst(manaLand);
        else {
          if (!verifiedSpellClick) {
            await verifyInertHandClick(peer, bolt.first());
            verifiedSpellClick = true;
          }
          await dragToBattlefield(page, bolt);
        }
      } else {
        await page.getByRole("button", { name: "Pass priority", exact: true }).click({ timeout: 4500 });
      }
      break;
    }
    case "chooseBoolean":
      await panel.locator(".choices button").nth(1).click({ timeout: 4500 });
      await panel.getByRole("button", { name: "Confirm", exact: true }).click({ timeout: 4500 });
      break;
    case "chooseFromSelection":
    case "chooseColor":
      await clickFirst(panel.locator(".choices button"));
      await panel.getByRole("button", { name: "Confirm", exact: true }).click({ timeout: 4500 });
      break;
    case "mulligan":
      await panel.getByRole("button", { name: "Keep hand" }).click({ timeout: 4500 });
      break;
    case "chooseBoardTargets": {
      const face = page.getByRole("button", { name: `Target ${opponent.name}` });
      if (await face.isEnabled()) {
        await face.click();
        stats.targetedFace += 1;
      } else {
        for (let i = 0; i < prompt.minSelections; i++) await panel.locator(".choices button:not([disabled])").nth(i).click();
      }
      await panel.getByRole("button", { name: "Confirm", exact: true }).click({ timeout: 4500 });
      break;
    }
    case "payManaCost": {
      const payment = panel.getByRole("button", { name: /Confirm payment|Auto-pay/ });
      if (await payment.count()) await clickFirst(payment);
      else {
        const source = page.getByRole("region", { name: "Your battlefield" })
          .locator('[data-actionable="true"][data-tapped="false"][aria-label="Mountain"]');
        if (await source.count()) {
          await panel.getByRole("button", { name: "Minimize" }).click();
          await clickFirst(source);
        } else await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      break;
    }
    case "chooseCards": {
      const selected = panel.locator(".choice-card:not([disabled])").filter({ hasText: /Mountain/ });
      if (await selected.count()) {
        await until(() => opponent.prompt?.pending === false, "private search projection");
        verifyPrivacy(opponent);
        if (verifyImages) {
          await verifyImage(selected.locator("img"));
          assert.equal(await opponent.page.locator(".decision .choice-card img").count(), 0);
        }
        await clickFirst(selected);
        if (verifyLayout && !verifiedDecision) {
          await verifyDecisionWindow(peer, panel, selected.first());
          verifiedDecision = true;
        }
        stats.privateSearch += 1;
      } else {
        for (let i = 0; i < prompt.minCardSelections; i++) await panel.locator(".choice-card:not([disabled])").nth(i).click();
      }
      await panel.getByRole("button", { name: "Confirm", exact: true }).click({ timeout: 4500 });
      break;
    }
    case "chooseAttackers":
    case "chooseBlockers":
      await panel.getByRole("button", { name: "Confirm", exact: true }).click({ timeout: 4500 });
      break;
    case "acknowledge":
    case "diceRolled":
    case "revealCards":
      await panel.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 4500 });
      break;
    default:
      throw new Error(`Unexpected synthetic duel prompt ${prompt.kind} at turn ${game.turn}`);
  }
}

async function testForgeBoundaryWithoutBrowser(roomId) {
  // This extra local connection verifies admission policy only.
  const ws = new WebSocket(baseURL.replace(/^http/, "ws") + "/ws");
  const messages = [];
  ws.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  function send(type, id, payload = {}) { ws.send(JSON.stringify({ type, id, payload })); }
  try {
    send("session.hello", "hello", { displayName: "Unseated", clientVersion: "club-smoke", protocol: "hexproof.v3" });
    await until(() => messages.find((item) => item.type === "session.welcome"), "unseated welcome");
    for (const type of forbidden) send(type, type);
    const room = { name: "Invalid test", format: "modern", deckFormat: "custom", matchMode: "bo1",
      maxSeats: 2, allowSpectators: false, spectatorsSeeHands: false, rulesMode: "forge", password: "fixture" };
    send("room.create", "manual", { ...room, rulesMode: "manual" });
    send("room.create", "multiplayer", { ...room, maxSeats: 4 });
    send("room.join", "spectator", { roomId, asSpectator: true, password: "correct room password" });
    for (const id of [...forbidden, "manual", "multiplayer", "spectator"]) {
      const reply = await until(() => messages.find((item) => item.id === id), id);
      assert.equal(reply.type, "error", id);
    }
  } finally {
    ws.close();
  }
}

try {
  const hostContext = await browser.newContext({ ignoreHTTPSErrors, viewport: { width: 1440, height: 980 } });
  const guestContext = await browser.newContext({ ignoreHTTPSErrors, viewport: { width: 1440, height: 980 } });
  const [host, guest] = await Promise.all([enter(hostContext, "Browser A", deck), enter(guestContext, "Browser B", deck)]);
  const room = await create(host, "custom", matchMode);
  await testForgeBoundaryWithoutBrowser(room);
  await join(guest, room, "incorrect room password");
  await guest.page.getByRole("alert").waitFor();
  assert.match(await guest.page.getByRole("alert").innerText(), /password/i);
  await join(guest, room, "correct room password");
  await guest.page.getByRole("heading", { name: "Duel room" }).waitFor();
  await Promise.all([selectDeck(host), selectDeck(guest)]);
  await startGuestFirst(host, guest);
  await until(() => host.game && guest.game, "guest-first Forge start", 60000);
  const waiting = verifyCapacity ? await checkCapacityGate() : undefined;
  const answered = new Set();
  let gamesFinished = 0;
  let sideboardMoves = 0;
  let playDrawChoices = 0;
  while (true) {
    if (host.game?.gameOver) {
      const terminal = host.game;
      const winner = terminal.winnerSeat;
      assert.ok(winner === 0 || winner === 1);
      assert.ok(terminal.players.some((player) => player.seat !== winner && player.life <= 0), "Forge ended on lethal damage");
      gamesFinished += 1;
      const result = await until(() => [...host.messages].reverse().find((frame) =>
        frame.type === "game.snapshot" && frame.payload.gameNumber === gamesFinished && frame.payload.result)?.payload,
        "published match result");
      if (result.result.matchFinished) break;
      assert.ok(result.sideboard, "next game has private sideboarding");
      const previousGameId = terminal.gameId;
      for (const player of [host, guest]) {
        const panel = player.page.locator(".sideboard");
        await panel.waitFor();
        if (verifyImages) await verifyImage(panel.locator(".sideboard-card-image"));
        if (player === host && sideboardMoves === 0) {
          await panel.locator("section").filter({ has: player.page.getByRole("heading", { name: "Sideboard", exact: true }) })
            .getByRole("button", { name: "Move one" }).click();
          await until(() => [...host.messages].reverse().find((frame) => frame.type === "game.snapshot")?.payload
            .sideboard?.sideboard?.reduce((sum, card) => sum + card.count, 0) === 1, "private moved sideboard card");
          sideboardMoves += 1;
        }
        const drawFirst = panel.getByRole("button", { name: "Draw first" });
        if (await drawFirst.count()) {
          await drawFirst.click();
          await until(() => drawFirst.getAttribute("aria-pressed").then((value) => value === "true"), "chosen draw");
          playDrawChoices += 1;
        }
        await panel.getByRole("button", { name: "Ready for next game" }).click();
      }
      await until(() => host.game?.gameId !== previousGameId, "next real Forge game", 35000);
      await until(() => host.messages.some(({ type, payload }) => type === "game.snapshot" && payload.gameNumber === gamesFinished + 1 &&
        payload.startingSeat === winner), "Forge starts with the previous winner after loser chose draw");
    }
    const actor = await until(() => [host, guest].find(({ game, prompt }) =>
      prompt?.pending && prompt.gameId === game?.gameId && !answered.has(prompt.promptId)) ?? (host.game?.gameOver ? "finished" : undefined),
      "the next real Forge prompt", 35000);
    if (actor === "finished") continue;
    const other = actor === host ? guest : host;
    verifyPrivacy(actor);
    if (verifyLayout && !verifiedTable && actor.game.turn >= 1 && !actor.game.stack.length && actor.prompt.kind === "chooseAction") {
      await verifyTable(actor);
      verifiedTable = true;
    }
    if (verifyLayout && !verifiedStack && actor.game.stack.length && actor.prompt.kind === "chooseAction") {
      await verifyStack(actor);
      verifiedStack = true;
    }
    if (verifyImages && !verifiedHandAndPreview && actor.prompt.kind === "chooseAction") {
      const hand = actor.page.getByRole("region", { name: "Your hand" });
      const card = hand.locator(".table-card").first();
      await verifyImage(card.locator("img"));
      await card.click({ button: "right" });
      const preview = actor.page.getByRole("region", { name: "Card preview" });
      await verifyImage(preview.locator("img"));
      await preview.getByRole("button", { name: "Close" }).click();
      assert.equal(await actor.page.locator(".card-back img").count(), 0);
      verifiedHandAndPreview = true;
    }
    if (verifyLayout && seenBattlefieldOrientations.size < 2) {
      const cards = await actor.page.locator(".battlefield .table-card").evaluateAll((elements) => elements.map((element) =>
        ({ tapped: element.dataset.tapped === "true", transform: getComputedStyle(element).transform })));
      for (const { tapped, transform } of cards) {
        assert.equal(transform, tapped ? "matrix(0, 1, -1, 0, 0, 0)" : "none");
        seenBattlefieldOrientations.add(tapped);
      }
    }
    if (actor.game.zones.some((zone) => zone.zone === "battlefield" && zone.cards.some((card) => card.tapped))) stats.tapped += 1;
    if (actor.game.players.some((player) => player.manaPool.some(({ value }) => value > 0))) stats.floatingMana += 1;
    if (actor.prompt.kind === "chooseAction" && actor.game.stack.length) stats.resolutions += 1;
    if (!stats.reconnect && stats.actions > 12) {
      const oldToken = actor.welcome.resumeToken;
      await actor.page.reload();
      await until(() => actor.welcome?.resumed && actor.welcome.resumeToken !== oldToken, "rotated reconnect credential");
      stats.reconnect += 1;
    }
    if (stats.tapped === 1 && process.env.CLUB_TEST_SCREENSHOT) {
      await actor.page.screenshot({ path: process.env.CLUB_TEST_SCREENSHOT });
    }
    if (stats.actions % 25 === 0) console.log(`turn ${actor.game.turn}, decisions ${stats.actions}, kind ${actor.prompt.kind} (${actor.prompt.title})`);
    const id = actor.prompt.promptId;
    try { await act(actor, other); }
    catch (error) {
      console.error("Last Forge prompt", actor.prompt.kind, actor.prompt.title, actor.prompt.options.map((option) => option.kind));
      console.error(await actor.page.locator("body").innerText());
      throw error;
    }
    answered.add(id);
    stats.actions += 1;
    assert.ok(stats.actions <= 1000);
  }
  const winner = host.game.winnerSeat;
  assert.ok(winner === 0 || winner === 1);
  assert.ok(host.game.players.some((player) => player.seat !== winner && player.life <= 0), "Forge ended on lethal damage");
  for (const [name, count] of Object.entries(stats)) assert.ok(count > 0, name);
  assert.ok(matchMode === "bo1" ? gamesFinished === 1 : gamesFinished >= 2 && sideboardMoves > 0 && playDrawChoices === gamesFinished - 1);
  await host.page.getByRole("button", { name: "Return to room" }).waitFor();
  assert.deepEqual(pageErrors, []);
  if (verifyLayout) {
    assert.ok(verifiedTable && verifiedStack && verifiedDecision && seenBattlefieldOrientations.size === 2);
    console.log("Verified phase placement, local card backs, hand fan, stack tray, battlefield rotation, narrow layout, and stateful decision-window minimization");
  }
  if (verifyImages) {
    assert.ok(verifiedHandAndPreview && imageRequests.length > 0);
    assert.ok(imageRequests.every((url) => {
      const image = new URL(url);
      return image.origin === "https://cards.scryfall.io" || (image.origin === new URL(baseURL).origin &&
        (image.pathname === "/card-art" || image.pathname.startsWith("/assets/cards/") || /^\/assets\/card-back-[\w-]+\.jpg$/.test(image.pathname)));
    }));
    console.log(`Verified hand, preview and private search with ${imageRequests.length} approved image requests`);
  }

  if (waiting) {
    await startGuestFirst(waiting.host, waiting.guest);
    await until(() => waiting.host.game && waiting.guest.game, "Forge start after capacity freed", 60000);
    for (const peer of [waiting.host, waiting.guest]) {
      assert.equal(await peer.page.getByRole("alert").count(), 0, "stale capacity alert after retry");
    }
    waiting.guest.page.once("dialog", (dialog) => dialog.accept());
    await waiting.guest.page.getByRole("button", { name: "Concede game", exact: true }).click();
    for (const peer of [waiting.host, waiting.guest]) {
      await peer.page.getByRole("heading", { name: "Sideboard for game 2" }).waitFor();
    }
    waiting.guest.page.once("dialog", (dialog) => dialog.accept());
    await waiting.guest.page.getByRole("button", { name: "Leave room", exact: true }).click();
    await waiting.guest.page.getByRole("heading", { name: "Club lobby" }).waitFor();
    await waiting.host.page.getByRole("heading", { name: "Duel room" }).waitFor();
    console.log("Verified guest-first availability gate, retained decks and seats, successful retry, and leaving BO3 during sideboarding");
  }

  // A marked Modern deck that fails native construction checks must never start.
  const verifyContexts = await Promise.all([browser.newContext({ ignoreHTTPSErrors }), browser.newContext({ ignoreHTTPSErrors })]);
  const [legal, invalid] = await Promise.all([
    enter(verifyContexts[0], "Modern legal", "60 Mountain"),
    enter(verifyContexts[1], "Modern invalid", "59 Mountain"),
  ]);
  const modern = await create(legal, "modern");
  await join(invalid, modern, "correct room password");
  await Promise.all([selectDeck(legal), selectDeck(invalid)]);
  await ready(legal);
  await legal.page.getByRole("button", { name: "Cancel ready", exact: true }).waitFor();
  await ready(invalid);
  await invalid.page.getByText(/Forge rejected your deck for this format/).waitFor({ timeout: 20000 });
  assert.ok(!legal.messages.some(({ type }) => type === "rules.snapshot"));
  assert.ok(!invalid.messages.some(({ type }) => type === "rules.snapshot"));
  const privateFailure = invalid.messages.find((entry) => entry.payload?.rulesStartFailure?.issues?.length);
  assert.equal(privateFailure.payload.rulesStartFailure.issues[0].code, "format_violation");
  assert.ok(!legal.messages.some((entry) => entry.payload?.rulesStartFailure?.issues?.length), "deck validation issues remain private");
  console.log(JSON.stringify({ result: "passed", chromium: browser.version(), matchMode, gamesFinished, winner, sideboardMoves, playDrawChoices, ...stats, modernValidation: "rejected 59-card deck privately" }));
} finally {
  await browser.close();
}
