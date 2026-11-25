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

## Offline debugging

Build the portable packages on Linux with the tools listed above and the
`zip` utility for Windows builds.

```sh
CLUB_OFFLINE_TARGET=windows-amd64 ./deploy/club/build.sh build/club-offline-debug
CLUB_OFFLINE_TARGET=linux-amd64 ./deploy/club/build.sh build/club-offline-debug
```

The build fetches the pinned Forge and Java inputs on first use. Each resulting
archive includes a Java 21 runtime, Forge, the browser client with source maps,
a searchable card and printing catalog, a Modern practice deck, and launch
instructions. A SHA-256 checksum accompanies each archive.

Extract the whole archive to a writable directory. On Windows x64 double-click
`Start-Club.cmd`. On Linux x64 run `./start-club.sh`. The launcher opens
`http://127.0.0.1:57325/` after the server is ready. Search, practice matches,
two-player rooms, and the spectator view run on the same computer while offline.
Use separate browser profiles to control both seats. The local server downloads
missing artwork from Scryfall as cards are viewed and caches successful downloads
under `state/card-art/` for future sessions. In the portable deck builder,
**Download deck art** fetches the distinct main-deck and sideboard printings in
one pass and reports how many are ready for offline use.
Artwork requests identify a printing by set and collector number, or by card
name for entries without a printing. The game and deck catalog stay on loopback.
With no network connection, existing images remain available
and missing images show a local rules-text card face. To use your own compatible
art pack, place its index and images in `web/assets/cards/` and restart.

Inspect the browser's developer tools for client and WebSocket activity.
The server writes `state/club-debug.log`. Set `CLUB_STATE_DIR` to move the
server data, `CLUB_PORT` to change the port, or `CLUB_NO_BROWSER=1` to launch
from a terminal without opening a browser.

Both portable launchers allow one active Forge match at a time. Waiting rooms
and spectators can share the same server. A best-of-three match keeps its slot
while players sideboard. If a start reports `capacity`, wait for the active match
to finish and Forge to become ready, then ready up again in the same room.

## Deck builder

Open **Deck builder** in the club lobby, tournament, or waiting room. Choose
**New deck** or select a saved deck. Paste an MTGA or MTGO list under **Import
decklist**, or use **Card search** to add individual cards to either board.
Both views edit the same deck. The main deck and sideboard show card images
and quantities as you work. Click a card to choose how many copies to move,
remove, or change to another printing. **Save deck** makes the edited list
available for room selection and tournament registration in this browser.

## Duel controls

Your hand fans out across the bottom of the table. Scroll horizontally if it
does not fit. To play a land or cast a spell, drag the card onto your
battlefield and release it. Moving the card back over your hand before
release cancels the drag. Hover over a visible card to see its larger art
on the left. The opponent's hand shows the cards revealed to you and a card
back for each remaining card. Click a player's library when its top card is
visible to you. The preview follows the current top and closes when it becomes hidden.
The phase track on the right highlights the current Forge step. Priority
controls sit at the bottom right. **Concede game** is in the upper-right
corner of the game page and asks for confirmation.
After dragging a spell onto the battlefield, choose its targets and modes
if prompted. Mana payment stays on the battlefield. When Forge offers
automatic payment, **Auto Pay** appears in the usual **Pass priority** position.
Click it to pay, or select mana sources on the board to pay manually.
After you cast a spell or activate an ability that uses the stack, priority
passes to the opponent. Turn on **Hold priority** to respond to your own action.
You can still respond when an opponent's spell or ability goes on top of it.
Auto Pay first tries to leave enough
mana to cast the most spells from your remaining hand together. Ties favor
access to more colors, then sources that cost less life to use later. The
search has a work limit for large boards. Forge checks the payment and handles
mana abilities with costs that depend on other permanents.
Spells and abilities overlap directly on the battlefield at the right-hand edge,
centered vertically. The newest object sits in front and resolves first. Hover
over an older object's exposed edge to preview it. When Forge offers an
on-board target, that edge can also be clicked to select it.
As a spell leaves the stack, its card moves
to the zone Forge selected. A hidden destination uses a card back. The browser
honors the system's reduced-motion preference.

Simple yes/no decisions use the priority buttons. When a shock land enters,
choose **Pay 2 life** or **Enters tapped**. Optional effects offer **Yes** and
**No** alongside the question.

**Undo land** and **Undo mana** appear in the priority controls when Forge
can reverse the last eligible action of that kind. Undo is available with
an empty stack during the same priority window. When several actions
qualify, select Undo repeatedly to reverse them in order. Forge commits
land plays that also change other game state, such as paying life
while the land enters.

During **Declare attackers**, click a creature on the battlefield. If it has
one legal defender the board assigns it immediately. With multiple defenders,
click the highlighted opposing avatar, planeswalker, or battle. **All Strike**
assigns eligible creatures to the opposing player. **Confirm** submits your
plan, **Cancel** clears it, and **No Attack** submits an empty declaration.
Selected attackers tilt 30 degrees while you edit the plan. After confirmation,
Forge determines which attackers tap, including the exception for vigilance.
Forge enforces attack requirements when you submit the declaration.

Library search displays eligible cards first. The rest of the cards Forge
lets the searching player see follow them. Forge selection windows open in the
center. Use **Minimize** to free the
board, then **Expand** near the priority controls to return to the same
selection. With a board-target decision minimized, you can still select a
target on the board and confirm it at the bottom right.

## Live duels

Enable **Live mode** when creating a two-player duel, then share **Copy watch
link** with viewers. The watch link or room code allows spectators to see
both hands and both registered decklists without a password. Viewers can
switch between players in the decklist panel and see the quantities in each
registered main deck and sideboard. Hover over a card in either list to preview
that printing just as you would a card on the board. The lists stay fixed through sideboarding.
Library order and private decisions are hidden. Players use the regular invite
and room password to take a seat. Viewers can hover over visible cards for a
close-up and follow the active phase in the read-only phase track.

Run `node apps/web/tests/live-interactions.mjs` against the local bundle
to check spectator visibility, reload, and repeated Forge undo in Chromium.

## Card image packs

Deck search and printing selection use the club server’s `/card-search` endpoint.
The server requests matching cards from Scryfall, caches each results page for
ten minutes, and shares its request limit with card-art lookups. Each result
identifies the set and collector number used to display and save that printing.

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
exact printing. When a requested printing is missing from the pack, the client
looks up its artwork before falling back to local art of the same name.
Each import handles up to 150 distinct entries, combines
with the existing pack, and reuses downloaded JPEGs. It reports card entries
that Scryfall cannot resolve.

Missing or unreadable local art falls back to a same-origin lookup at
`/card-art`. The Go service caches Scryfall metadata and rate-limits misses,
then redirects the browser to the approved Scryfall image CDN. The battlefield
and hand request compact images immediately using eager loading, including at
mobile widths. If the CDN cannot be reached or has no image, card text remains
available.

Refresh both pages after an import. Copy the `web/assets/cards/` directory into a new bundle before
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

- Every phase has a left stop for your turn and a right stop for the opponent's
  turn. Upkeep, both main phases, all combat steps, and the end step start on
  for both turns. Stops preserve only priority windows Forge actually offers.
  **Hold priority** pauses automatic priority passing until it is turned off.
- Run `node apps/web/tests/declare-attackers.mjs` against a built Club client
  to check player, planeswalker and battle targeting at desktop and phone widths.
- Run the live test with `CLUB_TEST_LAYOUT=1 CLUB_TEST_MOBILE_IMAGES=1` to verify
  the two stop columns, the stack tray, and a visible card image at mobile
  width with the imported index withheld. The test server and browser need
  Scryfall access.

- Render Logs reports match startup as `Forge ready`. Read `worker` for
  worker acquisition, `create` for deck and game setup, `first_prompt`
  for the first decision, and `layout` for the initial projections.
  Successful decision processing at or above one second produces a
  `slow Forge decision` line with queue, validation, submission,
  next-prompt, and publication timings. `submit` includes Forge applying
  the action, running the game to its next input, and capturing native
  views. These are server timings. Failed actions log the stage and duration.
- If a match shows **Forge stopped**, open **View crash report** and use
  **Copy report**. The corresponding `Forge crash` line in Render Logs
  includes the report ID, failure code, and any observed exit status.
  Use Render Events to check for a service restart or memory-limit event
  at the same time. The report stays limited to shareable diagnostic data.
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
