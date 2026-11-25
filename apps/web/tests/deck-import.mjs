// SPDX-License-Identifier: GPL-3.0-or-later

export async function importDeck(page, name, text) {
  const nav = page.getByRole("navigation", { name: "Club lobby" });
  const previous = await nav.getByRole("button", { pressed: true }).innerText();
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Deck builder").click();
  await button("New deck").click();
  await button("Import decklist").click();
  await page.getByLabel("Deck name", { exact: true }).fill(name);
  await page.getByLabel("MTGA or MTGO decklist").fill(text);
  await button("Save deck").click();
  await page.getByText("Deck saved.", { exact: true }).waitFor();
  await nav.getByRole("button", { name: previous, exact: true }).click();
}
