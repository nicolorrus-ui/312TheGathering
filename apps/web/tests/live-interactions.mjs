// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { importDeck } from "./deck-import.mjs";

const baseURL = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const password = "local test seat password";
const deck = "Deck\n34 Forest\n26 Exploration";
const sideboardName = (name) => name === "Live Host" ? "Island" : "Mountain";
const peers = [];

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(30);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function observe(page, name) {
  const peer = { page, name, sent: [], received: [], handled: new Set(), errors: [] };
  page.on("pageerror", (error) => peer.errors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => peer.sent.push(JSON.parse(payload.toString())));
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(payload.toString());
      peer.received.push(frame);
      if (frame.type === "rules.snapshot") peer.game = frame.payload;
      if (frame.type === "rules.prompt") peer.prompt = frame.payload;
    });
  });
  return peer;
}

const button = (peer, name) => peer.page.getByRole("button", { name, exact: true });
const hand = (peer) => peer.page.getByRole("region", { name: "Your hand" });
const field = (peer) => peer.page.getByRole("region", { name: "Your battlefield" });
const card = (zone, name) => zone.locator(`[data-card-id][aria-label="${name}"]`);
const actionable = (zone, name) => card(zone, name).and(zone.locator('[data-actionable="true"]'));
const ownSeat = (peer) => peer.game.players.find((player) => player.name === peer.name).seat;
const zoneFor = (peer, name, seat = ownSeat(peer)) =>
  peer.game.zones.find((zone) => zone.zone === name && zone.ownerSeat === seat)?.cards ?? [];
const mana = (peer) => peer.game.players.find((player) => player.seat === ownSeat(peer)).manaPool
  .reduce((total, entry) => total + entry.value, 0);
const forests = (peer) => zoneFor(peer, "battlefield").filter((entry) => entry.identity?.name === "Forest");

async function enter(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const player = observe(await context.newPage(), name);
  await player.page.goto(baseURL);
  await player.page.getByLabel("Player name").fill(name);
  await button(player, "Enter club").click();
  await player.page.getByText("online", { exact: true }).waitFor();
  await importDeck(player.page, "Undo fixture", `${deck}\n\nSideboard\n1 ${sideboardName(name)}`);
  return player;
}

async function selectDeck(player) {
  await player.page.getByLabel("Your deck").selectOption({ label: "Undo fixture" });
  await button(player, "Use deck").click();
}

async function nextDecision() {
  return until(() => peers.find(({ game, prompt, handled }) =>
    game && prompt?.pending && prompt.gameId === game.gameId && !handled.has(prompt.promptId)), "a fresh Forge decision", 60000);
}

async function answer(player, action) {
  const id = player.prompt.promptId;
  player.handled.add(id);
  await action();
  await until(() => player.sent.some(({ type, payload }) => type === "rules.respond" && payload.promptId === id),
    `decision ${id} sent`);
}

function click(player, name) {
  return answer(player, () => button(player, name).click());
}

function playFromHand(player, name) {
  return answer(player, () => actionable(hand(player), name).first().dragTo(field(player), {
    targetPosition: { x: 12, y: 12 },
  }));
}

async function tapForest(player) {
  await answer(player, () => actionable(field(player), "Forest").and(
    field(player).locator('[data-tapped="false"]')).first().click());
}

async function progress(player) {
  switch (player.prompt.kind) {
    case "chooseAction":
      return click(player, "Pass priority");
    case "mulligan":
      return click(player, "Keep hand");
    case "payManaCost":
      return answer(player, () => player.page.getByRole("button", { name: /^(Confirm payment|Auto Pay)$/ }).first().click());
    case "chooseBoolean":
      return answer(player, () => player.page.getByRole("group", { name: "Priority controls" }).getByRole("button",
        { name: player.prompt.choices[0].label, exact: true }).click());
    case "chooseCards": {
      assert.equal(player.game.step, "cleanup", "the fixture only uses hand-size discard");
      const panel = player.page.locator(".decision");
      const selectable = panel.locator(".choice-card:enabled").and(panel.getByRole("button", { pressed: false }));
      const spells = selectable.and(panel.getByRole("button", { name: "Exploration", exact: true }));
      for (let index = 0; index < player.prompt.minCardSelections; index++) {
        await (await spells.count() ? spells : selectable).first().click();
      }
      return click(player, "Confirm");
    }
    case "chooseAttackers":
      return click(player, "No Attack");
    case "chooseBlockers":
      return click(player, "Confirm");
    case "acknowledge":
    case "diceRolled":
      return click(player, "Continue");
    default:
      throw new Error(`Unexpected prompt ${player.prompt.kind} at ${player.game.step}: ${player.prompt.title}`);
  }
}

async function progressUntil(condition, label, inspecting = () => {}) {
  for (let count = 0; count < 160; count += 1) {
    const player = await nextDecision();
    inspecting(player);
    if (condition(player)) return player;
    await progress(player);
  }
  throw new Error(`Could not reach ${label}`);
}

function normalMain(player) {
  return player.prompt.kind === "chooseAction" && player.game.step === "main1" &&
    player.game.activeSeat === ownSeat(player) && !player.game.stack.length;
}

async function requireNextFor(player) {
  assert.equal((await nextDecision()).name, player.name, "these actions should retain priority");
}

async function checkSpectator(viewer, host) {
  await until(() => viewer.game?.gameId === host.game?.gameId && Boolean(viewer.game), "spectator game");
  for (const player of peers) {
    const seat = ownSeat(player);
    const other = peers.find((opponent) => opponent !== player);
    const ownHand = zoneFor(player, "hand", seat);
    const watchedHand = zoneFor(viewer, "hand", seat);
    assert.ok(ownHand.length > 0);
    assert.deepEqual(watchedHand.map((entry) => entry.identity), ownHand.map((entry) => entry.identity));
    assert.ok(zoneFor(other, "hand", seat).every((entry) => !entry.visible && !entry.identity));
    assert.ok(zoneFor(viewer, "library", seat).every((entry) => !entry.visible && !entry.identity));
  }
  const page = viewer.page;
  const preview = page.locator(".card-hover-preview");
  for (const player of peers) {
    const tab = page.getByRole("tab", { name: player.name, exact: true });
    await tab.click();
    const list = page.getByRole("tabpanel", { name: player.name, exact: true });
    const sideboard = list.getByRole("region", { name: "Sideboard" });
    await sideboard.getByText(sideboardName(player.name)).hover();
    await preview.locator("img, .card-image-fallback").waitFor();
    await tab.hover();
    await preview.waitFor({ state: "hidden" });
    await list.getByRole("region", { name: "Main deck" }).getByText("Exploration").hover();
    await preview.locator("img, .card-image-fallback").waitFor();
    assert.equal(await list.getByRole("region", { name: "Main deck" }).locator("li").count(), 2);
    assert.equal(await tab.getAttribute("aria-selected"), "true");
    assert.ok(!player.received.some(({ type, payload }) => type === "room.snapshot" && payload.liveDeckLists));
    const shownHand = page.getByRole("region", { name: new RegExp(`${player.name}.*hand`, "i") });
    await shownHand.locator("[data-card-id]").last().hover();
    await page.locator(".card-hover-preview").waitFor();
    assert.equal(await shownHand.locator('[draggable="true"]').count(), 0);
  }
  assert.ok(await page.getByRole("switch", { name: "Hold priority" }).isDisabled());
  const stops = page.locator(".phase-stop");
  assert.ok(await stops.count() > 0);
  assert.equal(await stops.count(), await page.locator(".phase-stop:disabled").count());
  assert.equal(await button(viewer, "Pass priority").count(), 0);
  assert.equal(await button(viewer, "Concede game").count(), 0);
  assert.ok(!viewer.received.some(({ type, payload }) => type === "rules.prompt" && payload.pending));
  assert.deepEqual(viewer.sent.map(({ type }) => type), ["session.hello", "room.join"]);
  assert.equal(viewer.sent[0].payload.resumeToken, undefined);
  assert.equal(viewer.sent[1].payload.asSpectator, true);
  assert.equal(viewer.sent[1].payload.password, undefined);
}

try {
  const [host, guest] = await Promise.all([enter("Live Host"), enter("Live Guest")]);
  peers.push(host, guest);
  await host.page.getByLabel("Format", { exact: true }).selectOption("custom");
  await host.page.getByLabel("Room password").fill(password);
  await host.page.getByLabel("Live mode").check();
  await button(host, "Create live duel").click();
  const room = await host.page.locator(".room-code strong").innerText();
  await button(host, "Copy watch link").waitFor();
  const watchURL = new URL(baseURL);
  watchURL.searchParams.set("watch", "");
  // Reuse the player's storage origin to confirm that the watch page does not resume their seat.
  const viewer = observe(await host.page.context().newPage(), "Spectator");
  await viewer.page.goto(watchURL.href);
  await viewer.page.getByRole("list", { name: "Live rooms" }).locator(`a[href="?watch=${room}"]`).click();
  await viewer.page.getByText("Waiting for the players to start…").waitFor();
  await button(guest, "Join room").click();
  await guest.page.getByLabel("Room code").fill(room);
  await guest.page.getByLabel("Room password").fill(password);
  await button(guest, "Join duel").click();
  await guest.page.getByText("This room appears in Watch live. Viewers can see both hands and registered decklists.").waitFor();
  await Promise.all(peers.map(selectDeck));
  await button(guest, "Ready").click({ timeout: 60000 });
  await button(guest, "Cancel ready").waitFor();
  await button(host, "Ready").click({ timeout: 60000 });
  await until(() => peers.every((player) => player.game), "players' opening hands", 60000);
  const actor = await progressUntil((player) => normalMain(player) &&
    zoneFor(player, "hand").filter((entry) => entry.identity?.name === "Exploration").length >= 2 &&
    zoneFor(player, "hand").filter((entry) => entry.identity?.name === "Forest").length >= 3, "first main with test cards");

  await checkSpectator(viewer, host);
  const previousWelcome = viewer.received.filter(({ type }) => type === "session.welcome").length;
  await viewer.page.reload();
  await until(() => {
    const welcomes = viewer.received.filter(({ type }) => type === "session.welcome");
    return welcomes.length > previousWelcome && welcomes.at(-1).payload.resumed;
  }, "watch-only session restored on reload");
  await viewer.page.locator(".revealed-hand [data-card-id]").first().waitFor();
  await viewer.page.getByRole("tab", { name: host.name, exact: true }).waitFor();
  console.log("Verified live spectator access, private-state boundaries, and spectator reload");

  await playFromHand(actor, "Forest");
  await requireNextFor(actor);
  assert.equal(forests(actor).length, 1);
  const seat = ownSeat(actor);
  await until(() => zoneFor(viewer, "battlefield", seat).some(({ identity }) => identity?.name === "Forest"),
    "land play arrives in live view");
  await click(actor, "Undo land");
  await requireNextFor(actor);
  assert.equal(forests(actor).length, 0);
  await until(() => !zoneFor(viewer, "battlefield", seat).some(({ identity }) => identity?.name === "Forest"),
    "land rollback arrives in live view");
  const opponent = peers.find((peer) => peer !== actor);
  const revealedLand = opponent.page.locator('.opponent-hand [aria-label="Forest"]');
  await revealedLand.waitFor();
  assert.equal(zoneFor(opponent, "hand", seat).filter((card) => card.visible).length, 1);
  await button(actor, "Undo land").waitFor({ state: "hidden" });

  await playFromHand(actor, "Forest");
  await requireNextFor(actor);
  await revealedLand.waitFor({ state: "detached" });
  await playFromHand(actor, "Exploration");
  await requireNextFor(actor);
  assert.equal(actor.prompt.kind, "payManaCost");
  const dock = actor.page.getByRole("group", { name: "Priority controls" });
  const paymentControl = dock.getByRole("button", { name: "Auto Pay", exact: true });
  await paymentControl.waitFor();
  const pendingStack = actor.page.locator(".stack [data-pending]");
  await pendingStack.waitFor();
  assert.equal(await pendingStack.getAttribute("aria-label"), "Exploration");
  const pendingSource = actor.game.pendingCast.from.objectId;
  assert.equal(actor.game.stack.length, 0);
  for (const other of [opponent, viewer]) {
    await other.page.locator(".stack [data-pending][aria-label=Exploration]").waitFor();
    assert.equal(other.game.pendingCast.id, actor.game.pendingCast.id);
    assert.equal(other.game.pendingCast.from.objectId, undefined);
    assert.equal(other.game.pendingCast.sourceId, undefined);
  }
  assert.equal(await actor.page.locator(".decision, .inspection").count(), 0, "payment keeps the board clear");
  assert.equal(await button(actor, "Auto Pay").count(), 1);
  assert.ok(forests(actor).every(({ tapped }) => !tapped), "dropping a spell waits for payment");
  await answer(actor, () => dock.getByRole("button", { name: "Cancel", exact: true }).click());
  await requireNextFor(actor);
  assert.equal(actor.prompt.kind, "chooseAction");
  assert.equal(actor.game.stack.length, 0);
  assert.ok(forests(actor).every(({ tapped }) => !tapped), "cancelling preserves mana sources");
  await pendingStack.waitFor({ state: "detached" });
  await hand(actor).locator(`[data-card-id="${pendingSource}"]`).waitFor();
  const remembered = opponent.page.locator(`.opponent-hand [data-card-id="${pendingSource}"][aria-label=Exploration]`);
  await remembered.waitFor();
  assert.equal(await opponent.page.locator(".opponent-hand [aria-label=Exploration]").count(), 1);
  await playFromHand(actor, "Exploration");
  await requireNextFor(actor);
  await pendingStack.waitFor();
  await pendingStack.evaluate((el) => el.dataset.testContinuity = "unpaid");
  const castId = actor.game.pendingCast.id;
  const otherThumbnails = [opponent, viewer].map((other) => other.page.locator(`[data-stack-id="${castId}"]`));
  for (const thumbnail of otherThumbnails) {
    await thumbnail.waitFor();
    await thumbnail.evaluate((el) => el.dataset.testContinuity = "unpaid");
  }
  await answer(actor, () => paymentControl.click());
  const responder = await nextDecision();
  assert.notEqual(responder.name, actor.name, "the caster yields the first response unless holding priority");
  const real = responder.game.stack.find((spell) => spell.castId === castId);
  assert.equal(real?.identity.name, "Exploration");
  for (const peer of [actor, opponent, viewer]) {
    const paid = peer.page.locator(`[data-stack-id="${real.id}"]`);
    await paid.waitFor({ state: "attached" });
    assert.equal(await paid.getAttribute("data-test-continuity"), "unpaid");
    const inbound = peer.game.cardMoves.find((move) => move.castId === castId);
    assert.equal(inbound?.to.objectId, real.id);
    assert.equal(Boolean(inbound.from.objectId), peer === actor);
  }
  assert.equal(await actor.page.locator(".stack button").count(), 1);
  assert.equal(await pendingStack.count(), 0);
  const nextTurn = actor.game.turn + 2;
  let sawStack = false;
  await progressUntil((player) => player === actor && normalMain(player) && player.game.turn >= nextTurn, "next main with Exploration",
    (player) => {
      if (player.game.stack.length && player.prompt.kind === "chooseAction") {
        sawStack = true;
        assert.ok(player.prompt.options.every(({ kind }) => kind !== "undoLand" && kind !== "undoMana"));
      }
    });
  assert.ok(sawStack, "a cast spell exercised the stack guard");
  assert.ok(zoneFor(actor, "battlefield").some((entry) => entry.identity?.name === "Exploration"));
  assert.ok(!actor.prompt.options.some(({ kind }) => kind === "undoLand"), "passing priority clears previous undo actions");

  await playFromHand(actor, "Forest");
  await requireNextFor(actor);
  const firstTwo = forests(actor).map(({ id }) => id).sort();
  await playFromHand(actor, "Forest");
  await requireNextFor(actor);
  assert.equal(forests(actor).length, 3);
  await click(actor, "Undo land");
  await requireNextFor(actor);
  assert.deepEqual(forests(actor).map(({ id }) => id).sort(), firstTwo);
  await click(actor, "Undo land");
  await requireNextFor(actor);
  assert.equal(forests(actor).length, 1);

  await playFromHand(actor, "Forest");
  await requireNextFor(actor);
  await tapForest(actor);
  await requireNextFor(actor);
  const firstTapped = forests(actor).find(({ tapped }) => tapped).id;
  await tapForest(actor);
  await requireNextFor(actor);
  assert.equal(mana(actor), 2);
  await click(actor, "Undo mana");
  await requireNextFor(actor);
  assert.equal(mana(actor), 1);
  assert.deepEqual(forests(actor).filter(({ tapped }) => tapped).map(({ id }) => id), [firstTapped]);
  await click(actor, "Undo mana");
  await requireNextFor(actor);
  assert.equal(mana(actor), 0);
  assert.ok(forests(actor).every(({ tapped }) => !tapped));
  await button(actor, "Undo mana").waitFor({ state: "hidden" });
  await actor.page.getByRole("switch", { name: "Hold priority" }).click();
  await until(() => actor.received.some(({ type, payload }) => type === "rules.priority" && payload.hold), "Hold priority acknowledged");
  await playFromHand(actor, "Exploration");
  await requireNextFor(actor);
  assert.equal(actor.prompt.kind, "payManaCost");
  assert.equal(await actor.page.locator(".decision").count(), 0);
  await tapForest(actor);
  await requireNextFor(actor);
  assert.equal(actor.prompt.kind, "chooseAction");
  assert.ok(actor.game.stack.some(({ identity }) => identity.name === "Exploration"), "manual payment retains held priority");
  assert.ok(viewer.received.some(({ type }) => type === "rules.snapshot"));
  assert.deepEqual([host, guest, viewer].flatMap(({ errors }) => errors), []);
  console.log("Verified battlefield mana payment, default and held priority, and consecutive Forge land and mana undo");
  await button(viewer, "Leave live view").click();
  await viewer.page.getByRole("heading", { name: "Watch a live duel" }).waitFor();
  actor.page.once("dialog", (dialog) => dialog.accept());
  await button(actor, "Leave room").click();
  await actor.page.getByRole("heading", { name: "Club lobby" }).waitFor();
} finally {
  await browser.close();
}
