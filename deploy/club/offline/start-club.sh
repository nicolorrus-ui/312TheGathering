#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
set -euo pipefail
cd -- "$(dirname -- "$0")"
root="$(pwd -P)"
runtime="$root/hexproof-forge-runtime"
port="${CLUB_PORT:-57325}"
state="${CLUB_STATE_DIR:-$root/state}"
open_browser=()
if [[ "${CLUB_NO_BROWSER:-0}" != 1 ]]; then
  open_browser=(-club-open-browser)
fi
printf 'Starting Offline Club at http://127.0.0.1:%s/ (Ctrl+C to stop).\n' "$port"
exec "$root/hexproof-server" -club-offline "${open_browser[@]}" -bind 127.0.0.1 -port "$port" \
  -club-web-root "$root/web" -forge-java "$root/jre/bin/java" -forge-home "$runtime/forge-gui" \
  -forge-harness "$runtime/forge-harness.jar" -forge-overlay "$root/forge-overlay.jar" \
  -forge-start-timeout 4m -max-forge-games 1 -retention-dir "$state/retained"
