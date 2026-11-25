#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime="$root/hexproof-forge-runtime"
state="${CLUB_STATE_DIR:-$root/state}"
umask 077
mkdir -p -m 700 "$state"
exec "$root/hexproof-server" -bind 127.0.0.1 -port "${CLUB_PORT:-57320}" \
  -club-web-root "$root/web" -forge-harness "$runtime/forge-harness.jar" -forge-home "$runtime/forge-gui" \
  -forge-overlay "$root/forge-overlay.jar" -forge-java "${JAVA_HOME:+$JAVA_HOME/bin/}java" \
  -forge-start-timeout "${CLUB_FORGE_START_TIMEOUT:-4m}" \
  -forge-heap-mib "${CLUB_FORGE_HEAP_MIB:-1536}" -max-forge-games "${CLUB_MAX_GAMES:-1}" \
  -max-connections "${CLUB_MAX_CONNECTIONS:-64}" -max-rooms "${CLUB_MAX_ROOMS:-40}" \
  -reconnect-window "${CLUB_RECONNECT_WINDOW:-3m}" -retention-dir "$state/retained"
