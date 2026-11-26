// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const baseURL = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const jpg = fileURLToPath(new URL("../../client-qt/qml/assets/card-back.jpg", import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const bolt = { name: "Lightning Bolt", setCode: "M11", collectorNumber: "149", setName: "Magic 2011" };
const older = { ...bolt, setCode: "4ED", collectorNumber: "208", setName: "Fourth Edition" };
const forest = { name: "Forest", setCode: "M11", collectorNumber: "246", setName: "Magic 2011" };
const swamp = { name: "Swamp", setCode: "M11", collectorNumber: "238", setName: "Magic 2011" };
const filename = "01234567-1234-1234-1234-1234567890ab.jpg";
const storage = "hexproof-club.decks.v1";

async function verifyDeckExport(page) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const exportButton = button("Export decklist");
  const main = page.getByRole("region", { name: "Main deck" });
  const side = page.getByRole("region", { name: "Sideboard" });
  const input = page.getByLabel("MTGA or MTGO decklist");
  const legacy = { id: "legacy-export", name: "Legacy/牌表", text: [
    "2 Lightning Bolt (M11) 149", "1 Lightning Bolt (4ED) 208", "1 Fire // Ice", "1 Fire", "1 Dead/Gone",
    "1 Unholy Annex // Ritual Chamber", "2 Delver of Secrets // Insectile Aberration", "1 Brazen Borrower // Petty Theft",
    "1 SP//dr, Piloted by Peni", "1 Summon: Choco/Mog", "", "Sideboard", "1 Lightning Bolt", "2 Lim-Dûl's Vault",
  ].join("\n") };
  await page.evaluate(({ key, deck }) => {
    const decks = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify([...decks, deck]));
  }, { key: storage, deck: legacy });
  await page.reload();
  await button("Deck builder").click();
  await page.getByRole("button", { name: /Legacy\/牌表/ }).click();
  async function download() {
    const [file] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
    return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
  }
  const saved = await download();
  assert.deepEqual(saved, { name: "Legacy_牌表.txt", text: [
    "3 Lightning Bolt", "2 Fire/Ice", "1 Dead/Gone", "1 Unholy Annex/Ritual Chamber", "2 Delver of Secrets",
    "1 Brazen Borrower", "1 SP//dr, Piloted by Peni", "1 Summon: Choco/Mog", "", "1 Lightning Bolt", "2 Lim-Dûl's Vault", "",
  ].join("\r\n") });

  await button("New deck").click();
  await button("Import decklist").click();
  assert.ok(await exportButton.isDisabled(), "an empty draft has no main deck to export");
  await input.fill(saved.text);
  await main.getByRole("button", { name: "3 × Lightning Bolt, Default printing" }).waitFor();
  for (const [count, name] of [[2, "Fire // Ice"], [1, "Dead // Gone"], [1, "Unholy Annex // Ritual Chamber"],
    [2, "Delver of Secrets // Insectile Aberration"], [1, "Brazen Borrower // Petty Theft"],
    [1, "SP//dr, Piloted by Peni"], [1, "Summon: Choco/Mog"]]) {
    const row = main.getByRole("button", { name: `${count} × ${name}, Default printing` });
    const image = row.locator("img");
    await image.waitFor();
    assert.equal(new URL(await image.getAttribute("src"), baseURL).searchParams.get("name"), name.toLowerCase());
  }
  await side.getByRole("button", { name: "1 × Lightning Bolt, Default printing" }).waitFor();
  await side.getByRole("button", { name: "2 × Lim-Dûl's Vault, Default printing" }).waitFor();
  assert.deepEqual(await download(), { name: "Deck.txt", text: saved.text }, "an unsaved re-import must export identically");
  await input.fill("3 Forest");
  assert.equal((await download()).text, "3 Forest\r\n", "a main-only deck has no sideboard separator");
  await input.fill("1 SP//dr, Piloted by Peni\n2 SP");
  assert.equal((await download()).text, "1 SP//dr, Piloted by Peni\r\n2 SP\r\n", "literal slashes must not merge names");
  await input.fill("invalid input");
  assert.ok(await exportButton.isDisabled(), "a malformed draft must not export stale cards");
}

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
  await page.route("**/card-art?**", (route) => {
    const missing = new URL(route.request().url()).searchParams.get("name")?.toLowerCase() === "swamp";
    return route.fulfill(missing ? { status: 404 } : { path: jpg });
  });
  await page.route("**/card-search?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const q = params.get("q");
    const cards = params.has("name") ? (params.get("name") === bolt.name ? [bolt, older] : [])
      : q === "bolt" ? [bolt] : q === "swamp" ? [swamp] : [forest];
    return route.fulfill({ json: { cards, hasMore: false } });
  });
  await page.goto(baseURL);
  const legacyText = ["  # Keep for Friday  ", "// Mainboard", "2 Lightning Bolt", "// Burn package",
    "2 Lightning Bolt (M11) 149", "", "// Sideboard", "  // Games two and three", "1 LIGHTNING BOLT (4ED) 208", ""].join("\r\n");
  await page.evaluate(([key, text]) => localStorage.setItem(key, JSON.stringify([
    { id: "old", name: "Old list", text },
  ])), [storage, legacyText]);
  const storedLegacy = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).find((deck) => deck.id === "old"), storage);
  await page.reload();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const main = page.getByRole("region", { name: "Main deck" });
  const side = page.getByRole("region", { name: "Sideboard" });
  await page.getByLabel("Player name").fill("Deck builder");
  await button("Enter club").click();
  await page.getByLabel("Room name").fill("Keep this room draft");
  await button("Deck builder").click();
  await page.getByRole("button", { name: /Old list/ }).click();
  const row = (zone, name, count, edition) => zone.getByRole("button", { name: `${count} × ${name}, ${edition}`, exact: true });
  await row(main, bolt.name, 4, "M11 #149").waitFor();
  await row(side, bolt.name, 1, "M11 #149").waitFor();
  assert.equal((await storedLegacy()).text, legacyText, "opening a mixed-printing deck must preserve its exact source");
  await button("New deck").click();
  await page.getByLabel("Deck name").fill("Unified editions");
  await button("Import decklist").click();
  const text = page.getByLabel("MTGA or MTGO decklist");
  await text.fill("Deck\n2 Lightning Bolt (M11) 149\n1 Lightning Bolt (M11) 149\n\nSideboard\n1 Lightning Bolt (4ED) 208");
  const original = row(main, bolt.name, 3, "M11 #149");
  async function assertArtwork(control, quantity) {
    const img = control.locator("img");
    await img.waitFor();
    await img.evaluate((element) => element.decode());
    assert.equal(await control.innerText(), quantity ? "×" + quantity : "");
  }
  await assertArtwork(original, 3);
  await original.click();
  const dialog = page.getByRole("dialog");
  const copies = dialog.getByLabel("Copies", { exact: true });
  assert.equal(await copies.inputValue(), "4");
  assert.equal(await dialog.getAttribute("aria-label"), "Edit Lightning Bolt in main deck");
  assert.doesNotMatch(await dialog.innerText(), /Lightning Bolt/);
  await dialog.getByLabel("Printing", { exact: true }).selectOption({ label: "Fourth Edition · 4ED #208" });
  assert.match(await dialog.locator("img").getAttribute("src"), /\/card-art\?.*set=4ed&number=208/);
  await copies.fill("");
  assert.ok(await button("Apply changes").isDisabled());
  await copies.fill("-1");
  assert.ok(await button("Apply changes").isDisabled());
  await copies.fill("6");
  await button("Apply changes").click();
  await row(side, bolt.name, 1, "4ED #208").waitFor();
  await row(main, bolt.name, 5, "4ED #208").click();
  await dialog.getByLabel("Copies to move").fill("2");
  await button("Move to sideboard").click();
  await row(main, bolt.name, 3, "4ED #208").waitFor();
  await row(side, bolt.name, 3, "4ED #208").click();
  assert.equal(await copies.inputValue(), "6");
  await copies.fill("2");
  await button("Apply changes").click();
  await row(main, bolt.name, 2, "4ED #208").waitFor();
  assert.equal(await side.getByRole("button").count(), 0);

  await button("Card search").click();
  const search = page.getByLabel("Search cards");
  await search.fill("bolt");
  const addBolt = button("Add Lightning Bolt to Main deck");
  await assertArtwork(addBolt);
  await addBolt.click(); // the catalog returns M11, the deck keeps 4ED
  await row(main, bolt.name, 3, "4ED #208").waitFor();
  await page.getByLabel("Add to").selectOption("sideboard");
  await button("Add Lightning Bolt to Sideboard").click();
  await row(side, bolt.name, 1, "4ED #208").click();
  await button("Move to main deck").click();
  await row(main, bolt.name, 4, "4ED #208").waitFor();
  await button("Add Lightning Bolt to Sideboard").click();

  await page.getByLabel("Add to").selectOption("mainboard");
  await search.fill("fore");
  await button("Add Forest to Main deck").click();
  await page.getByLabel("Add to").selectOption("sideboard");
  await button("Add Forest to Sideboard").click();
  await row(side, forest.name, 1, "M11 #246").click();
  await copies.fill("1");
  await button("Apply changes").click();
  await row(main, forest.name, 1, "M11 #246").waitFor();

  await search.fill("swamp");
  const missingArt = button("Add Swamp to Sideboard");
  await missingArt.getByText("Swamp", { exact: true }).waitFor();
  await missingArt.click();
  await page.getByLabel("Add to").selectOption("mainboard");
  await button("Add Swamp to Main deck").click();
  await row(main, swamp.name, 1, "M11 #238").getByText("Swamp", { exact: true }).click();
  await copies.fill("0");
  await button("Apply changes").click();
  assert.equal(await main.getByRole("button", { name: /Swamp/ }).count(), 0);
  assert.equal(await side.getByRole("button", { name: /Swamp/ }).count(), 0);

  await button("Save deck").click();
  await page.getByText("Deck saved.", { exact: true }).waitFor();
  const legacy = await storedLegacy();
  assert.equal(legacy.text, legacyText, "saving a different deck must preserve the legacy source and comments");
  assert.deepEqual([legacy.mainboard[0], legacy.sideboard[0]].map(({ count, setCode }) => [count, setCode]),
    [[4, "M11"], [1, "M11"]], "the saved room and tournament lists must use a single printing");
  await page.getByRole("button", { name: /Old list/ }).click();
  await page.getByLabel("Deck name").fill("Friday deck");
  await button("Save deck").click();
  await page.getByText("Deck saved.", { exact: true }).waitFor();
  assert.equal((await storedLegacy()).text, legacyText, "renaming must preserve CRLF, spaces and both comment styles");
  await row(main, bolt.name, 4, "M11 #149").click();
  await copies.fill("6");
  await button("Apply changes").click();
  await button("Save deck").click();
  await page.getByText("Deck saved.", { exact: true }).waitFor();
  const rebuilt = (await storedLegacy()).text;
  assert.ok(rebuilt.includes("  # Keep for Friday  \r\n5 Lightning Bolt (M11) 149\r\n// Burn package"));
  assert.ok(rebuilt.includes("Sideboard\r\n  // Games two and three\r\n1 Lightning Bolt (M11) 149"));
  await button("Duels").click();
  assert.equal(await page.getByLabel("Room name").inputValue(), "Keep this room draft");
  await page.reload();
  await button("Deck builder").click();
  await page.getByRole("button", { name: /Unified editions/ }).click();
  await button("Import decklist").click();
  assert.equal(await text.inputValue(), "Deck\n4 Lightning Bolt (4ED) 208\n1 Forest (M11) 246\n\nSideboard\n1 Lightning Bolt (4ED) 208");
  await page.setViewportSize({ width: 360, height: 780 });
  await main.getByRole("button", { name: /Forest/ }).click();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  await verifyDeckExport(page);
  assert.deepEqual(errors, []);
  console.log("Deck builder kept one printing per card, edited total copies, moved copies both ways, rendered card art and persisted the deck after reload.");
} finally {
  await browser.close();
}
