// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

const manaGlyphs: Record<string, number> = {
  W: 0xe600, U: 0xe601, B: 0xe602, R: 0xe603, G: 0xe604, X: 0xe615, S: 0xe619, C: 0xe904,
};

export function ManaPip({ symbol }: { symbol: string }) {
  if (symbol === "//") return <span>//</span>;
  let code = manaGlyphs[symbol];
  if (/^(?:[0-9]|1[0-5])$/.test(symbol)) code = 0xe605 + Number(symbol);
  else if (/^(?:1[6-9]|20)$/.test(symbol)) code = 0xe62a + Number(symbol) - 16;
  const text = /^[2WUBRGCP]{2,3}$/.test(symbol) && !/^\d+$/.test(symbol) ? [...symbol].join("/") : symbol;
  return <span className="deck-pip" data-color={symbol} data-glyph={Boolean(code)}>
    {code ? String.fromCodePoint(code) : text}
  </span>;
}
