# 312TheGathering web style

The player client and spectator client share the same wordmark, shell and theme. The document title and both home links read **312TheGathering**. The 28 px amber mark uses the existing decorative span. The browser loads Inter, Space Grotesk and the mana font locally. Font licenses travel with the web build.

## Tokens and type

Use the custom properties in [tokens.css](apps/web/src/tokens.css). Reserve Inter 400–600 for text and controls, and Space Grotesk 500–700 for headings and the wordmark. The base text size is 16 px, controls and labels use 14 px, and group labels use 12 px with .06em tracking. Apply the existing mana font to symbol glyphs.

| Role | Tokens | Use |
| --- | --- | --- |
| Canvas and hierarchy | `--ink`, `--surface`, `--raised` | Page, panels and selected or elevated surfaces |
| Boundaries and copy | `--line`, `--line-bright`, `--text`, `--muted` | Borders, hovering, primary and supporting text |
| Action | `--amber`, `--on-amber` | The next available primary action and keyboard focus |
| Status | `--teal`, `--danger` | Live and success indicators, and errors. Pair color with text or a symbol. |
| Mana | `--mana-w`, `--mana-u`, `--mana-b`, `--mana-r`, `--mana-g`, `--mana-c`, `--mana-multi` | Mana symbols, small chips, thin column borders and 18% row tints |

The spacing scale is 4, 8, 12, 16, 24, 32 and 48 px. Use a 1 px border and radii of 8, 12 or 16 px, with 10 px controls. Use a 2 px amber focus outline and a 2 px offset. Controls have a target height of at least 44 px. Reduced-motion mode suppresses decorative travel.

## Layout and interaction

Keep the wordmark and account controls in the top bar. The main tabs sit beside the page title when space permits and wrap below it on compact screens. Put subviews in a second row of pills. Cap the main content width at 1440 px. A spectator or waiting screen can have no available primary action.

- Cube columns use sticky headers and independent vertical scrolling. Narrow screens can pan the board horizontally. Focusing or hovering a list row reveals the full name.
- In Deck builder, the desktop card search sits to the left of the deck gallery. Mobile places the same controls above the gallery in reading order. Selecting a card image opens its printing editor.
- Use a quiet surface and dividers for pairings, standings and deck lists. The player's row has an amber edge. Ready/live states retain their explicit labels.
- Put the fan-content line in normal document flow. Keep native dialogs and their browser-managed keyboard behavior. Production card art uses the existing card-art service and cache.

## Verify a change

Run `node apps/web/tests/design-audit.mjs verify` from the repository root after installing the existing web dependencies and Chromium. The checks compare the tag, sibling position, nesting and protected attributes of each element against the original client. They also verify the new brand. Use `after` to capture the new screenshots. See [the baseline](design-baseline/README.md) and [the updated screens](design-after) for the captured states and viewports.

For the browser accessibility checks, set `DESIGN_ACCESSIBILITY_DIR` to an output directory when running `verify` or `after`, then run `node apps/web/tests/design-accessibility.mjs <output-directory>`. Check artwork, popup focus and touch behavior on real hardware when changing interactive game elements.
