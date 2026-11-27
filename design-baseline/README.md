# Visual and DOM baseline

The screenshots in the width directories show the Club web client at commit `a254e913724f86d3d9b2cc760d34d8b2ff905f12`, before the rebrand. The browser viewports are 390 × 844, 768 × 1024 and 1440 × 900 CSS pixels. Each width has the same 54 named scenes covering the lobby, sign-in, deck editor, Cube, tournaments, live audience, duel board and game decisions.

From the repository root, install the existing web dependencies with `npm ci --prefix apps/web` and use a locally installed Chromium. Set `CHROMIUM` to its executable if it is outside `/usr/bin/chromium`. Run the structural and branding check with one command.

```sh
node apps/web/tests/design-audit.mjs verify
```

The runner builds the production client, serves it on an ephemeral loopback port and drives its actual pages. WebSocket messages, server responses and card-art requests use deterministic test fixtures. The landscape artwork is a synthetic sizing reference. System confirmation prompts, file pickers, and clipboard permission dialogs belong to the browser or operating system and have no document subtree.

- `verify` compares each scene with its checked-in baseline. It checks the title and wordmark on every page.
- `after` runs those checks, checks document overflow, and writes WebP screenshots in `design-after/<width>/`.
- `baseline` writes reference screenshots and signatures. To reproduce the historical baseline, run the current harness with `DESIGN_DIST` pointing to the production build of the baseline commit. Use `DESIGN_BASELINE_REPLAY=1` with `verify` only when replaying the historical build with its old branding.
- `DESIGN_GROUPS=core,events,extra` and `DESIGN_WIDTHS=390,768,1440` can be narrowed to investigate one suite or viewport. `DESIGN_ACCESSIBILITY_DIR` enables the additional rendered accessibility audit.

Each manifest under `dom/` maps a scene name to the SHA-256 of its complete signature. The corresponding `<hash>.jsonl` records every element in reading order starting with `html`. Each line contains the depth, zero-based sibling index, tag and sorted name/value pairs for its ID, role, ARIA and data attributes. CSS classes, styles and text are excluded. Identical signatures share one human-readable file across viewport sizes.
