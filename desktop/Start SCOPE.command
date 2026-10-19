#!/bin/zsh
# SPDX-License-Identifier: MIT
set -euo pipefail

SCOPE_ROOT="${0:A:h}"
SCOPE_NODE=""
for candidate in "/opt/homebrew/opt/node@24/bin/node" "/usr/local/opt/node@24/bin/node" "$SCOPE_ROOT/.tools/node_modules/node/bin/node" "$(command -v node || true)"; do
    if [[ -x "$candidate" ]] && [[ "$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == "24" ]]; then
        SCOPE_NODE="$candidate"
        break
    fi
done

if [[ -z "$SCOPE_NODE" ]]; then
    print -u2 'SCOPE requires Node.js 24. Install or activate Node 24, then open this launcher again.'
    exit 1
fi
export PATH="${SCOPE_NODE:h}:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
    print -u2 'npm was not found. Install Node.js 24 with npm before starting SCOPE.'
    exit 1
fi

cd "$SCOPE_ROOT"
exec npm run start:electron -- "$@"
