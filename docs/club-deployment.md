# Hexproof Club deployment

The club build serves the React client and private 1v1 rooms from one Go
process. A separate headless Forge JVM owns each live game. You can run the
same deployment on Linux x86-64 and ARM64.

## Build

Use Git, Python 3.12 or later, Go 1.26, Node 22.12 or later, and a Java 21 JDK.
Run the following from the source root.

```sh
java -version
javac -version
./deploy/club/build.sh
```

The build checks the pinned Forge base and matching source archives, compiles
the current adapter, builds the browser client and Go binary, and stages a
self-contained application directory under `build/club-deploy/`. Java remains
a system dependency. The first build downloads approximately 449 MiB of Forge
inputs. Later builds reuse the verified archives. Set `CLUB_GOARCH=arm64`
to build an ARM64 bundle on x86-64. Use `CLUB_FORGE_CACHE` to point to a
prepared download cache.

Run `./run.sh` inside the staged directory and open
[http://127.0.0.1:57320](http://127.0.0.1:57320). Each browser tab keeps its
seat credential in session storage. Use separate browser profiles for local
two-player testing. Room creation requires a password. Share the six-character
room code or invitation link and the password with the other player. Decklists
are stored in that browser's local storage. A displayed user name serves as a
screen name. The server-issued seat credential grants control of a seat.

## Duel controls

Your hand is at the bottom. Scroll horizontally if it does not fit, and drag
a playable card onto the battlefield. The opponent's hand area shows card
backs based on the public count. The web client reuses the classic Magic
back shipped with Hexproof's desktop client. The phase track on the right
highlights the current Forge step. Priority controls sit at the bottom right.

Forge selection windows open in the center. Use **Minimize** to free the
board, then **Expand** near the priority controls to return to the same
selection. With a board-target decision minimized, you can still select a
target on the board and confirm it at the bottom right.

## Card image packs

The club server serves the image pack from its deployed `web/assets/cards/`
directory. To build or extend a pack, save MTGA or MTGO deck exports as UTF-8
text files, then run the importer on your Linux host or in WSL.

```sh
bundle=/path/to/the/running/club-bundle
python3 deploy/club/scryfall-pack.py --output "$bundle/web/assets/cards" \
  ./alice-deck.txt ./bob-deck.txt
```

For the live-duel sample, use `deploy/club/scryfall-demo-deck.txt`. The importer
uses official Scryfall collection metadata and normal-size JPEGs. Explicit
`(SET) collector-number` entries import the requested printing. Name-only
entries use Scryfall's selected printing. The web client prefers an imported
exact printing and uses an imported image of the same name if the exact
printing is absent. A card without a matching image falls back to text. Each
import handles up to 150 distinct entries, combines with the existing pack, and
reuses downloaded JPEGs. It reports card entries that Scryfall cannot resolve.

The browser fetches images only from its own club server. Refresh both pages
after an import. Copy the `web/assets/cards/` directory into a new bundle before
switching releases, or place the pack in `apps/web/public/assets/cards/` before
building. To transfer a pack between your own machines, copy the entire
directory, including `index.json` and the corresponding JPEGs.

Card images come from [Scryfall](https://scryfall.com/) and remain the property
of their respective rights holders. Hexproof Club is an unofficial fan
project. Wizards of the Coast does not endorse it. Refer to
[Scryfall API guidance](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17)
and the [Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
when deciding how to use or distribute card art.

## Run as a service

Install a Java 21 runtime and Caddy on the Linux host. Create a system user
named `hexproof-club` and copy a built directory to
`/opt/hexproof-club/releases/<release>`. Keep this tree readable by the
service account and owned by the deployment user. Point
`/opt/hexproof-club/current` at the selected release.

```sh
sudo useradd --system --user-group --shell /usr/sbin/nologin hexproof-club
sudo install -m 644 deploy/club/club.env.example /etc/hexproof-club.env
sudo install -m 644 deploy/club/hexproof-club.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hexproof-club
curl -fsS http://127.0.0.1:57320/readyz
```

Use `systemctl stop hexproof-club` to stop and `systemctl start hexproof-club`
to start it. The service runs on loopback. Set `CLUB_HOST` to the site's DNS
name in Caddy's environment, then adopt the supplied
[`Caddyfile`](../deploy/club/Caddyfile). Keep its upstream port aligned with
`CLUB_PORT`. Point DNS at the VM and allow inbound TCP 80 and 443 in the
cloud and host firewalls for public automatic HTTPS. Keep 57320 on loopback.
Caddy proxies WebSocket upgrades over the same public HTTPS origin as the
page. Configure the public hostname and certificates before giving out links.

[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) ·
[Oracle Cloud Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)

## Operate and update

- Inspect the service with `journalctl -u hexproof-club -f` and check
  `/healthz` and `/readyz` through the reverse proxy. Safe server diagnostics
  report startup or runtime failures. The JVM command inherits the Java runtime
  from `JAVA_HOME` or PATH.
- Keep the initial cap at one active duel. Waiting rooms do not take up a game
  slot. One JVM launches per active game, and a BO3 holds its slot through
  sideboarding. **Leave room** ends the match and frees its slot after the
  JVM exits. Players in a waiting room can then press **Ready** again with
  their existing decks. The default maximum heap is 1536 MiB. JVM resident
  memory can exceed the heap cap. Measure Go and Java using
  `ps -C hexproof-server,java -o pid,rss,etime,comm`.
- Build the next release as a separate directory. Schedule a maintenance
  window after matches finish, switch the `current` link, restart the unit,
  and recheck readiness. Restore the previous link and restart to roll back.
- Back up the server state directory from `CLUB_STATE_DIR` while the service is
  stopped or through a consistent filesystem snapshot. It may contain private
  retained match data and diagnostics. Restore it with the service down and
  preserve ownership and permissions. Decklists are browser-local. Keep the
  original export text if you need to move a deck to another browser.
- Reconnecting to a running Go server keeps the original Forge match within the
  configured seat-hold window. Restarting the Go process or losing the JVM
  ends that live session. Readiness checks connectivity and configuration.
  A test match exercises full startup, card loading and session release.
- For a real browser regression, install Chromium, start the service on
  loopback, and run `CHROMIUM=/path/to/chromium npm --prefix apps/web run test:live`
  from the source root. The test creates disposable rooms and completes a real
  Forge duel. It also checks that an invalid Modern deck is rejected.
  With a one-game cap, add `CLUB_TEST_CAPACITY=1` to test rejection and retry
  from a second room.
  Run `npm --prefix apps/web run test:club` to check practice, reconnect
  after closing a tab, drag-and-drop, and a three-match Conquest series.
  Run the same command with `CLUB_TEST_SWISS=1` for an eight-player Swiss
  round and its complete Top 8. Keep the local game cap at one for these tests.

## Browser play

- Render Logs reports match startup as `Forge ready`. Read `worker` for
  worker acquisition, `create` for deck and game setup, `first_prompt`
  for the first decision, and `layout` for the initial projections.
  Successful decision processing at or above one second produces a
  `slow Forge decision` line with queue, validation, submission,
  next-prompt, and publication timings. These are server timings.
- The first Forge JVM stays warm after service startup. Use the Render HTTP
  health-check path `/readyz` to publish a new instance after its probe passes.
  An idle worker is used for the next match, and the hub warms its replacement
  when the old process exits. Waiting rooms can submit Ready once a worker is
  available. Between games, a BO3 owns its slot and can wait for a replacement.

- Reopening the same browser profile resumes its held seat, if the server
  still has that match. The browser stores the current room credential
  and replaces it each time the server rotates the token. Leaving the room
  clears the credential. By default the server holds a disconnected seat
  for three minutes.
- Practice is a private BO1 against a Forge-controlled seat with a server
  deck. The seat passes ordinary priority and declines voluntary plays and
  combat. Forge still resolves any required game decisions. The human
  plays their own deck and receives the ordinary prompts.
- Swiss uses Forge results and the existing Swiss points and tiebreakers.
  A Swiss event with Top 8 needs eight checked-in players. The organizer
  advances the completed Swiss rounds, then starts seeded quarterfinals,
  semifinals and a final. Elimination matches are BO3 and do not affect
  the Swiss standings.
- Conquest is a two-player event. Forge validates all three registered
  decks against the selected format. Each player chooses an unlocked
  deck per BO3. The winner's selected deck locks on a confirmed Forge
  match win. The losing deck remains available. Three locked decks win
  the event. The registration lists and selection remain private.
- Events currently live in the running Go service. A service restart ends
  the active Forge matches and clears the in-memory tournament registry.
  On a single-slot host, pairing rooms may wait at the same time. Their
  Forge matches and lineup validation run one at a time.

Keep the base Forge distribution's corresponding source available when
redistributing that runtime. For a distributable modified overlay source
bundle, use `python3 third_party/forge-runtime/build-overlay.py --source-output
build/hexproof-club-forge-source.tar.gz`. The repository retains the original
licenses, third-party notices and matching build recipes.
