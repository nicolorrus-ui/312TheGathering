# Hexproof Club development handoff

Use `nicolorrus-ui/312TheGathering` and start from
`codex/continue-development`. This branch includes the latest verified duel
UI (commit `07831f3`). Treat `main` as the release branch. Check the live
commit and auto-deploy settings in Render before changing the release branch.

## Scope and code map

- Hexproof Club is a Forge-only browser platform for private 1v1 MTG games
  for a small school club. It supports human duels, passive practice,
  BO1/BO3, sideboarding, reconnect, Swiss with optional Top 8, and Conquest.
- The React/TypeScript client is in `apps/web/`. Start with `Board.tsx`,
  `PhaseControls.tsx`, `Decisions.tsx`, `CardImages.tsx` and `style.css`
  under `apps/web/src/` for duel interface work.
- `apps/server/` is the Go room, seat and WebSocket service. The Java
  adapter is under `third_party/forge-runtime/native-host/`. Go controls
  access and sends authorized actions over a local process pipe. Forge
  remains the only rules authority. Keep each player's private state
  isolated. Use real Forge sessions to verify changes to play.
- Deployment sources are `Dockerfile` and `deploy/club/`. See
  [Hexproof Club deployment](club-deployment.md) for build, readiness,
  card image imports and operations. Upstream guides cover the separate
  native product. Keep club changes in this repository.

## Reproduce the current baseline

Use Linux, Go 1.26, Node 22.12 or later, Python 3.12 or later, and JDK 21.
The first bundle build downloads about 449 MiB of pinned Forge inputs.
Use Chromium or a Playwright Chromium Headless Shell for browser checks.

```sh
npm --prefix apps/web ci
npm --prefix apps/web run build
bash deploy/club/build.sh
```

Run `./run.sh` from the bundle directory printed by the build.
Wait for `http://127.0.0.1:57320/readyz` to succeed. From the repository
root, run the live test in a separate terminal:

```sh
CHROMIUM=/path/to/chromium CLUB_TEST_LAYOUT=1 npm --prefix apps/web run test:live
```

For image verification, import the sample deck into the bundle as described
in the deployment guide and run with `CLUB_TEST_IMAGES=1`. The latest real
two-browser BO1 passed the layout and pack-backed image checks, including
390 px phone width, phase controls, the stack, and minimizing a live Forge
choice without losing selections. The online Scryfall fallback was not
verified in that environment.

## Open work

- If continuing interface work, preserve the current gradient, top opponent
  hand, bottom fanned hand, right-side action and phase controls, and
  minimizable choice windows. Test on desktop and phone widths. Use test
  accounts and local disposable rooms.
- For performance work, production logs showed warm workers and roughly
  11–13 seconds in game creation. A slow action spent about 19.6 seconds in
  `submit` and 3 milliseconds in `publish`. Reproduce and measure Java
  queueing, rule advancement and snapshot capture around the same action.
  Correlate with JVM GC and Render CPU/memory before choosing changes.
  The club code already disables native replay capture.
- For a production crash, use the report ID from **View crash report** or
  Render Logs, then inspect the recorded failure and exit status. The
  earlier production crash remains undiagnosed. Use the smallest
  reproducible case with public or fixture data.
