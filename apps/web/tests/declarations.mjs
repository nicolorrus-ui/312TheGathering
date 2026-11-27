// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const roomId = "NAMES", gameId = "declaration-game";
const named = "Asmoranomardicadaistinaculdacar";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const room = { roomId, phase: "started", seats: players.map(({ name }) => ({ occupied: true, displayName: name })) };
const announcements = [`Alice named ${named}.`, "Bob chose Wizard."];
const personal = { id: 1, turn: 3, text: "Crumbling Vestige picked {W}" };
const metadata = { roomId, gameNumber: 1, score: [0, 0],
  log: announcements.map((text, id) => ({ id, kind: "declaration", text })) };
function permanent(id, name, seat, annotation, tapped = false) {
  return { id, identity: { name }, ownerSeat: seat, controllerSeat: seat, visible: true, tapped,
    typeLine: "Artifact", annotations: [annotation] };
}
const cards = [permanent("needle", "Pithing Needle", 0, { kind: "namedCard", value: named }, true),
  permanent("horn", "Herald’s Horn", 1, { kind: "chosenType", value: "Wizard" })];
const game = { roomId, gameId, turn: 3, activeSeat: 0, prioritySeat: 0, step: "main1", gameOver: false,
  players, stack: [], zones: cards.map((card, ownerSeat) => ({ ownerSeat, zone: "battlefield", count: 1, cards: [card] })) };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function verify(seat, width) {
  const spectator = seat === null;
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(6000);
  const errors = [], events = new EventEmitter();
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  const gameState = () => {
    send("room.snapshot", room);
    // Also exercise the read-only board's defense against an unredacted snapshot.
    send("rules.snapshot", seat === 1 || spectator ? { ...game, viewerNotices: [personal] } : game);
    send("game.snapshot", metadata);
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/card-art?**", (route) => route.abort());
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw);
      if (type === "session.hello") {
        send("session.welcome", { roomId, seat, role: spectator ? "spectator" : "player",
          resumeToken: "declaration-view", forgeRulesAvailable: true });
        if (!spectator) gameState();
      } else if (type === "room.join" && spectator) {
        assert.equal(payload.asSpectator, true);
        send("room.joined", { roomId, role: "spectator" });
        gameState();
      } else if (type === "rules.respond") events.emit("answer", payload);
    });
  });
  await page.goto(spectator ? `${url}?watch=${roomId}` : url);
  if (!spectator) {
    await page.getByLabel("Player name").fill(players[seat].name);
    await page.getByRole("button", { name: "Enter club" }).click();
  }
  await page.getByRole("region", { name: "Duel table" }).waitFor();
  const panel = page.locator(".decision");
  for (const [id, expected] of [["needle", `Named: ${named}`], ["horn", "Type: Wizard"]]) {
    const card = page.locator(`[data-card-id="${id}"]`);
    const badge = page.locator(".card-slot").filter({ has: card }).locator(".permanent-declaration");
    await badge.waitFor();
    assert.equal(await badge.innerText(), expected);
    assert.equal(await card.getAttribute("aria-description"), expected);
    assert.equal(await card.getAttribute("data-tapped"), String(id === "needle"));
    const geometry = await badge.evaluate((label) => {
      const box = label.getBoundingClientRect(), slot = label.parentElement.getBoundingClientRect();
      const text = new Range();
      text.selectNodeContents(label);
      return { box: box.toJSON(), slot: slot.toJSON(), lines: [...text.getClientRects()].map((r) => r.toJSON()) };
    });
    const contains = (box, content) => content.left >= box.left - 1 && content.right <= box.right + 1
      && content.top >= box.top - 1 && content.bottom <= box.bottom + 1;
    assert.ok(contains(geometry.slot, geometry.box) && geometry.lines.every((line) => contains(geometry.box, line)),
      `Declaration ${id} at ${width}px: ${JSON.stringify(geometry)}`);
  }
  await page.getByText("Game log", { exact: true }).click();
  assert.deepEqual(await page.getByRole("list", { name: "Game log" }).getByRole("listitem").allTextContents(), announcements);
  assert.deepEqual(await page.getByRole("list", { name: "Your notices" }).getByRole("listitem").allTextContents(),
    seat === 1 ? [`Turn 3 · ${personal.text}`] : []);
  await page.getByText("Game log", { exact: true }).click();
  assert.equal(await panel.count(), 0);

  if (seat === 0) {
    async function prompt(kind, fields) {
      const title = `Declaration ${++promptId}`;
      send("rules.prompt", { roomId, gameId, kind, title, promptId, supported: true, pending: true,
        choices: [], cards: [], contextCards: [], orderItems: [], damageTargets: [], scryDestinations: [],
        combatSources: [], combatTargets: [], options: [], targets: [], ...fields });
      await panel.getByRole("heading", { name: title }).waitFor();
    }
    const confirm = panel.getByRole("button", { name: "Confirm", exact: true });
    async function submit(fields) {
      const [[sent]] = await Promise.all([once(events, "answer", { signal: AbortSignal.timeout(6000) }), confirm.click()]);
      assert.deepEqual(sent, { promptId, responseId: "$submit", ...fields });
    }
    const legalNames = ["Dark Ritual", "Ritual of Soot", "Forest", "Island", "Mountain", "Plains", "Swamp",
      "Force of Will", "Counterspell", "Opt", "Ponder", "Duress", "Fatal Push", "Brainstorm", "Sol Ring", "Mana Vault",
      "Skullclamp", "Lotus Field", "Spelunking", "Cabal Coffers", "Pithing Needle", "Grizzly Bears", named];
    await prompt("chooseCardName", { legalNames });
    const field = panel.getByRole("searchbox", { name: "Card name", exact: true }), results = panel.locator(".declaration-results").getByRole("button");
    assert.equal(await results.count(), 20);
    assert.ok(await confirm.isDisabled());
    await field.fill("lightning bolt");
    await panel.getByRole("status").waitFor();
    assert.equal(await results.count(), 0);
    assert.ok(await confirm.isDisabled());
    await field.fill("RiTuaL");
    assert.deepEqual(await results.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["Ritual of Soot", "Dark Ritual"]);
    assert.equal(await results.locator(".decision-art").count(), 2);
    await panel.getByRole("button", { name: "Dark Ritual", exact: true }).click();
    await submit({ name: "Dark Ritual" });

    for (const [searchKind, labels, query] of [
      ["type", ["Human", "Wizard", "Lizard"], "ZarD"], ["name", ["Ponder", "Brainstorm", "Island"], "stoRM"],
    ]) {
      const choices = labels.map((label, i) => ({ label, responseId: `opaque:${i * 17 + 11}`, weight: 1, canRepeat: false }));
      await prompt("chooseFromSelection", { searchKind, choices, minChoiceTotal: 1, maxChoiceTotal: 1 });
      const search = panel.getByRole("searchbox", { name: searchKind === "type" ? "Search types" : "Search card names" });
      await search.fill("absent");
      await panel.getByText("No matching options.").waitFor();
      assert.ok(await confirm.isDisabled());
      await search.fill(query);
      assert.deepEqual(await panel.locator(".choices button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? item.textContent)), labels.filter((label) =>
        label.toLowerCase().includes(query.toLowerCase())));
      await panel.getByRole("button", { name: labels[1], exact: true }).click();
      await submit({ choiceIds: [choices[1].responseId] });
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
}
try {
  for (const [seat, width] of [[0, 1440], [0, 390], [1, 1440], [null, 390]]) await verify(seat, width);
  console.log("PASS Club name and type searches, legal answers, public permanent declarations and game logs");
} finally {
  await browser.close();
}
