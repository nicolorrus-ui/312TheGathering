#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
resources="$(cd -- "${1:?Provide the extracted Forge resource directory}" && pwd)"

# Apply to the extracted resources independently of the source checkout.
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    GIT_CEILING_DIRECTORIES="$(dirname -- "$resources")" \
    git -C "$resources" apply --whitespace=error "$here/forge-resources.patch"
