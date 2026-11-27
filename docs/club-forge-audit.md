# 312TheGathering source audit and verification

## Source baseline

- Hexproof `f2b56e2bd77710488041e6530fffb90a4748264a`, GPL-3.0-or-later.
  The fork retains its licenses, notices, and unrelated desktop sources.
- Forge `0485ad49fb10c8ef5b3eda2a002c963d59be71dc`, GPL-3.0-or-later.
  The immutable adapter-25 archive supplies the Java classes, library JARs
  and data. Hexproof's adapter-34 overlay replaces the patched classes and
  native adapter ahead of the base JAR. The fork rebuilds its own overlay from
  the same pinned inputs and ships alongside a Java 21 runtime installed on
  the host. The upstream Maven parent is compiled for Java 17 and the current
  Hexproof host and overlay use JDK 21.
- `third_party/forge-runtime/native-host/native-hooks.patch` lists the exact
  modified upstream files across `forge-core`, `forge-game`, `forge-gui`
  and `forge-ai`. The patch supports native input queues, scoped game threads
  and RNG, payment and target data, cancellation, projection, and runtime
  supervision. Club additions are adapter changes. The upstream patch is
  unchanged.
- Forge loads scripts, token definitions and editions through `FModel` and
  `CardStorageReader` from `forge-gui/res`. Forge's `GameFormat.Collection`
  reads format legality from the same pinned resources. Format rotations and
  ban list changes therefore follow the selected Forge revision.

## Architecture

| Component | Source and decision |
| --- | --- |
| Room, join, reconnect, projection | Reuse `apps/server/internal/server` and room reducers. A short command allowlist and room admission policy enforce private, password-protected, server-hosted 1v1 games. Background loading avoids depending on a card-image preload handshake. |
| Public protocol | Reuse `hexproof.v3` at `/ws`, its opaque response IDs, and existing room, deck, sideboard and game messages. Add optional card display metadata and a private deck rejection code. The protocol schema and rules snapshot fixture cover these fields. |
| Engine boundary | Reuse `apps/server/internal/rulesengine/forge/client.go` and `NativeHost` for private request/response JSONL over subprocess pipes. The server probes Java at startup, starts it on demand, and releases it after game completion or failure. |
| Rules | Keep native Forge decisions and responses. `NativeGuiGame` and `NativeDecisionController` bridge GUI decisions, and `prompt*.go` normalizes and validates submissions. The club adds rules-authoritative deck checks by calling Forge's `DeckFormat.Constructed` and `GameFormat` when a sanctioned game starts. |
| Browser | Implement React and TypeScript against existing projections. A browser sends the currently offered choice ID and typed selections. It receives only the server's viewer-specific snapshot and prompt. Private deck issues go only to their owner. |
| Identity | Reuse the random server-issued resume credential and rotate it on reconnect. Room passwords admit new players. The server keeps seats bound to authenticated connections during a live match. On reload the original tab sends its private token. |
| Manual and multiplayer | The club entry point blocks Manual, AI, Commander, tournaments, hosting workers, spectator joins and legacy mutation commands. Shared upstream source still contains the desktop and Manual implementation. |
| Deployment | Build one Go binary, static assets and the pinned native overlay. Run an isolated JVM per active game. Caddy exposes the application over HTTPS/WSS. |

The principal resource cost is JVM initialization and card data. Runtime count
is bounded independently of the room count. The current desktop regression
fixtures and native tests reuse real Forge where flagged `engineintegration`.
Read-only viewer validation, room admission and disconnect semantics also have
Go coverage.

## Rule support and limits

The adapter surfaces ordinary priority, spells and legal activation candidates,
mana sources and special payment decisions, native card selections, hand and
library prompts, ordered choices and piles, card naming, numbers, colors,
replacement choices, combat declarations and damage distribution. An unknown
prompt is displayed as an explicit unavailable decision. Forge handles native
game losses and draws, alternative and additional costs, casting from other
zones, and control changes. The selection flow needs representative browser
regressions across these families before claiming complete card coverage.

The public journal observes redacted game snapshots. It records phase, life,
zones, tap status, stack transitions and results. The snapshot-based journal
can miss intermediate events between publications and does not classify every
exit from the stack as a resolution or a counter. The UI shows card name and
Forge rules text using local data. Packaged card artwork and remote image
traffic are currently absent.

A room stores one game in memory, so matching a resume credential reconnects
to a surviving process. An interrupted VM or JVM cannot resume from a
serialized game checkpoint. A game started with an invalid sanctioned deck
returns to its waiting room. When an invalid post-sideboard deck reaches the
engine, existing upstream rollback can also return the match to the waiting
room. This still needs a retry path that preserves the BO3 score and pending
partition.

See [deployment instructions](club-deployment.md) for build inputs and
operating commands.

## Executed verification

Test runs used Linux x86-64, Go 1.26.3, Java 21.0.12.1 and Chromium
145.0.7632.6. The browser tests use independent profiles and interact through
rendered controls. Every live match runs real Forge with card scripts from the
pinned runtime.

| Phase | Changed files and verified behavior | Remaining work |
| --- | --- | --- |
| 1. Source and baseline | Cloned both repositories. The original Go WebSocket BO1 and BO3 games naturally reached lethal damage. The pinned upstream overlay passed eight Java regressions and five Go/Java test groups, including Lotus Bloom, mana undo, private snapshots and JVM failures. | Keep both source pins and matching source archives with future releases. |
| 2. Private server | Added the club command gate to the existing Go handler. Live browser tests rejected Manual, four-player room creation, spectator join, AI and tournament commands, and an invalid room password. | Remove unused Manual and desktop paths from the fork's source tree if the fork drops upstream desktop compatibility. |
| 3. Web duel | Added `apps/web`. A packaged BO1 through local Caddy HTTPS/WSS reached lethal in 181 real responses and exercised drag-and-drop, tapped cards, mana payment, target selection, hidden opponent state, library searches and a reconnect. | Test physical users and additional browser families. |
| 4. Rules prompts | Mapped all decision families currently enumerated by the Go normalizer to browser controls. The changed Java overlay passed live grouped targets, Lotus Bloom, Serum Powder, mana undo and process-abort tests. | Build end-to-end browser fixtures for complex replacement effects, trigger ordering, special costs and combat damage distributions. |
| 5. BO3 and decks | Added text imports, browser persistence, private sideboarding and play/draw selection. A browser BO3 completed three natural games and 556 decisions, moved one name-only sideboard entry, and verified the actual first player after two draw choices. An invalid 59-card Modern deck was rejected privately. | Preserve the BO3 score and sideboard screen when Forge rejects the next partition. |
| 6. Deployment | Added build and launch scripts, systemd and Caddy configuration. Built and started the Linux x86-64 bundle, and verified HTTPS plus a live WSS game against the patched overlay. Cross-compiled the Linux ARM64 Go binary. | Run the suite on the target Oracle ARM64 VM and measure its JVM, I/O, and connection performance. |

Browser tests also check that names, rules text and printing information for
the opponent's private hand and library do not appear in the received game
projection. Testing both seats does not substitute for testing every
authorized reveal or effect-specific visibility change.

The focused Go room, protocol, engine and server suites passed on x86-64.
The full upstream Go suite hit UNIX socket and WebRTC/netlink restrictions
in this workspace. The upstream concurrent-start race test initially exceeded
its time budget when instrumented child processes retained the default race
exit delay. Those results are distinct from the real-JVM boundary tests.

Artifact identity for the tested overlay:
`0485ad49fb10c8ef5b3eda2a002c963d59be71dc-adapter34-e17a1faab533d3fb1e0304c9a8cd4208eb755363ba80e0346168d60dcc4cdd6a`.
The overlay JAR SHA-256 is
`877bc261d6406793e4821814b8acb4c80f6c04b61dcd4d1aa0661a88abb8715c`.

To reproduce the latest browser BO3, bring up a club build and run

```sh
CLUB_TEST_MATCH=bo3 CHROMIUM=/path/to/chromium npm --prefix apps/web run test:live
```

### Resource sample and evidence

The Caddy-served BO1 run sampled Linux process RSS every 0.5 seconds from
service startup through the completed duel and the deck-rejection check.
The server reached 44,852 KiB peak RSS (43.8 MiB) and the Forge JVM
reached 739,196 KiB (721.9 MiB). Convert KiB to MiB by dividing by 1,024.
The sample used the default 1,536 MiB Java heap ceiling and one active game.
These measurements are specific to the x86-64 run.

Browser action, search and reconnect counts come from the summary emitted by
`apps/web/tests/live-duel.mjs` after its assertions pass. Baseline BO1 and BO3
evidence comes from `TestLiveForgeWebSocketMatch` and
`TestLiveForgeWebSocketBO3Match` in the server's tagged Go suite.
The pinned overlay build and original native cases are reproduced by
`python3 tools/run-forge-regression.py`. The packaged browser test runs the
same source through the `deploy/club` launch path.
