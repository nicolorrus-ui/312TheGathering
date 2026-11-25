// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const baseURL = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const jpg = fileURLToPath(new URL("../../client-qt/qml/assets/card-back.jpg", import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const bolt = { name: "Lightning Bolt", setCode: "M11", collectorNumber: "149", setName: "Magic 2011" };
const older = { ...bolt, setCode: "4ED", collectorNumber: "208", setName: "Fourth Edition" };
const forest = { name: "Forest", setCode: "M11", collectorNumber: "246", setName: "Magic 2011" };
const filename = "01234567-1234-1234-1234-1234567890ab.jpg";
const storage = "hexproof-club.decks.v1";
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  // The club also runs on HTTP LAN origins without crypto.randomUUID.
  await page.addInitScript(() => Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**/ws", (socket) => socket.onMessage((raw) => {
    if (JSON.parse(raw).type === "session.hello") socket.send(JSON.stringify({ type: "session.welcome",
      payload: { resumeToken: "test", resumed: false, forgeRulesAvailable: true } }));
  }));
  await page.route("**/assets/cards/index.json", (route) => route.fulfill({ json: { version: 1,
    printings: { "m11/149": { front: filename, faces: {} } }, names: { "lightning bolt": filename } } }));
  await page.route("**/assets/cards/*.jpg", (route) => route.fulfill({ path: jpg }));
  await page.route("**/card-art?**", (route) => route.fulfill({ path: jpg }));
  await page.route("**/card-search?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { cards: params.has("name") ? [bolt, older] : [forest], hasMore: false } });
  });
  await page.goto(baseURL);
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify([
    { id: "old", name: "Old list", text: "4 Lightning Bolt (M11) 149" },
  ])), storage);
  await page.reload();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const main = page.getByRole("region", { name: "Main deck" });
  const side = page.getByRole("region", { name: "Sideboard" });
  await page.getByLabel("Player name").fill("Deck builder");
  await button("Enter club").click();
  await page.getByLabel("Room name").fill("Keep this room draft");
  await button("Deck builder").click();
  await page.getByRole("button", { name: /Old list/ }).click();
  await main.getByRole("button", { name: "4 × Lightning Bolt, M11 #149" }).waitFor();
  await button("New deck").click();
  await page.getByLabel("Deck name").fill("Split editions");
  await button("Import decklist").click();
  const text = page.getByLabel("MTGA or MTGO decklist");
  await text.fill("Deck\n2 Lightning Bolt (M11) 149\n1 Lightning Bolt (M11) 149\n\nSideboard\n1 Lightning Bolt (4ED) 208");
  const original = main.getByRole("button", { name: "3 × Lightning Bolt, M11 #149" });
  await original.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Printing", { exact: true }).selectOption({ label: "Fourth Edition · 4ED #208" });
  assert.match(await dialog.locator("img").getAttribute("src"), /\/card-art\?.*set=4ed&number=208/);
  await button("Apply printing").click();
  const changed = main.getByRole("button", { name: "1 × Lightning Bolt, 4ED #208" });
  await changed.click();
  await button("Move to sideboard").click();
  await side.getByRole("button", { name: "2 × Lightning Bolt, 4ED #208" }).click();
  await button("Move to main deck").click();
  await button("Card search").click();
  await page.getByLabel("Search cards").fill("fore");
  await button("Add Forest to Main deck").click();
  await page.getByLabel("Add to").selectOption("sideboard");
  await button("Add Forest to Sideboard").click();
  await side.getByRole("button", { name: /Forest/ }).click();
  await button("Remove from deck").click();
  await button("Save deck").click();
  await page.getByText("Deck saved.", { exact: true }).waitFor();
  await button("Duels").click();
  assert.equal(await page.getByLabel("Room name").inputValue(), "Keep this room draft");
  await page.reload();
  await button("Deck builder").click();
  await page.getByRole("button", { name: /Split editions/ }).click();
  await button("Import decklist").click();
  assert.equal(await text.inputValue(), "Deck\n2 Lightning Bolt (M11) 149\n1 Lightning Bolt (4ED) 208\n1 Forest (M11) 246\n\nSideboard\n1 Lightning Bolt (4ED) 208");
  await page.setViewportSize({ width: 360, height: 780 });
  await main.getByRole("button", { name: /Forest/ }).click();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(errors, []);
  console.log("Deck builder imported and searched cards, split printings, moved copies both ways, and persisted the deck after reload.");
} finally {
  await browser.close();
}
