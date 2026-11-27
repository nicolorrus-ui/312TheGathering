# Updated web screens

Each of the 54 named states has a WebP at [390 px](390), [768 px](768) and [1440 px](1440). The [original screens and DOM manifests](../design-baseline) have identical filenames. Both sets use the same deterministic game and card-image fixtures; production uses the existing art service.

| State | Before | After |
| --- | --- | --- |
| Sign-in | [1440 px](../design-baseline/1440/sign-in.webp) | [1440 px](1440/sign-in.webp) |
| Duels | [390 px](../design-baseline/390/duels.webp) | [390 px](390/duels.webp) |
| Cube board | [1440 px](../design-baseline/1440/cube-ornithopters.webp) | [1440 px](1440/cube-ornithopters.webp) |
| Cube basic lands | [390 px](../design-baseline/390/cube-basic-lands.webp) | [390 px](390/cube-basic-lands.webp) |
| Deck builder | [1440 px](../design-baseline/1440/deck-builder.webp) | [1440 px](1440/deck-builder.webp) |
| Printing editor | [768 px](../design-baseline/768/deck-printing-dialog.webp) | [768 px](768/deck-printing-dialog.webp) |
| Pairings and standings | [1440 px](../design-baseline/1440/tournament-pairings.webp) | [1440 px](1440/tournament-pairings.webp) |
| Spectator deck list | [390 px](../design-baseline/390/watch-decklist.webp) | [390 px](390/watch-decklist.webp) |
| Mana payment | [390 px](../design-baseline/390/duel-payment.webp) | [390 px](390/duel-payment.webp) |

## Checks and boundaries

The new page title and both home-link wordmarks read **312TheGathering**. DOM signatures cover tags, nesting, sibling order, IDs, data attributes, roles and ARIA attributes. Production and local-debug builds use the same theme. The local-debug build also has its existing download-art control. Browser storage and room credentials retain their original identifiers so saved decks and resumable seats keep working.

Keyboard checks visit the sequential stops, measure the amber ring and use arrows within the spectator tabs and grouped choices. Contrast measurements use computed styles and alpha-composited colors. Actual card artwork can vary by printing. Check overlays against both light and dark illustrations on a real display. The Windows release includes the heading and body fonts and their SIL licenses.

Across the three widths the audit sampled 13,515 text runs and placeholders. The lowest measured active contrast was 5.58:1. All 6,446 sequential focus stops and 22 arrow-key stops were reached. Saved-deck lists and the compact spectator switch have extra space for the entire focus ring. No sampled page overflowed horizontally. All 54 states also passed the 1920 px desktop boundary check. [Rendered accessibility results](accessibility.json)

Two players and a spectator also exercised a real local Forge match, including casting, payment, undo, public previews, deck switching and spectator reconnection. Separate runs covered practice, seat recovery and three best-of-three matches.

## Needs markup change

| Goal | Existing element and reason |
| --- | --- |
| Main tabs centered between the wordmark and account | In [main.tsx](../apps/web/src/main.tsx), the account is inside `header.topbar` and `nav.lobby-nav` follows the page title inside `main`. Moving the tabs visually ahead of the account would reverse the order of keyboard focus. The tabs share the title row on large screens. |
| Deck statistics and new filters | [DeckBuilder.tsx](../apps/web/src/DeckBuilder.tsx) renders search, a board destination and galleries. It has no mana-curve histogram, color-breakdown data or color-filter inputs. Those features need values, elements and event handlers. |
| Keyboard activation for drag-only cards and spectator preview | In [Board.tsx](../apps/web/src/Board.tsx), a drag-only hand card has no keyboard cast action. An inactive spectator card has `tabIndex=-1`, so its hover preview has no keyboard equivalent on the card itself. Spectator deck-list rows do accept keyboard focus. |
| Inspection panel focus | The board's card, library and zone inspectors are ordinary sections after the phase controls. They appear over the board, while Tab follows the underlying controls before the close button. A managed focus transition requires a change to the inspector. |
| Browser and OS dialogs | The existing `window.confirm`, `window.prompt` and file inputs call the browser or OS UI. The browser owns their styling. These captures cover the application's own dialogs. |
