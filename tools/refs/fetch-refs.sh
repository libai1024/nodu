#!/usr/bin/env bash
# Re-fetch the pinned 0.1.3 reference sources (see docs/0.1.3/references.md).
# Default target: ../nodu-refs relative to the repo root; override with
# NODU_REFS_DIR or the first argument.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${1:-${NODU_REFS_DIR:-$REPO_ROOT/../nodu-refs}}"
RETRIES=5

retry() {
    local n=0
    until "$@"; do
        n=$((n + 1))
        if [ "$n" -ge "$RETRIES" ]; then
            echo "FAILED after $RETRIES attempts: $*" >&2
            return 1
        fi
        echo "retry $n/$RETRIES: $*" >&2
        sleep $((n * 3))
    done
}

fetch() {
    local name="$1" url="$2" sha="$3"; shift 3
    local sparse=("$@")
    local dir="$TARGET/$name"
    mkdir -p "$dir"
    if [ ! -d "$dir/.git" ]; then
        retry git init -q "$dir"
        git -C "$dir" remote add origin "$url"
        if [ "${#sparse[@]}" -gt 0 ]; then
            git -C "$dir" sparse-checkout init --cone
            git -C "$dir" sparse-checkout set "${sparse[@]}"
        fi
    fi
    retry git -C "$dir" fetch -q --depth 1 origin "$sha"
    retry git -C "$dir" checkout -q FETCH_HEAD
    local head
    head="$(git -C "$dir" rev-parse HEAD)"
    if [ "$head" != "$sha" ]; then
        echo "PIN MISMATCH $name: got $head want $sha" >&2
        return 1
    fi
    echo "$name @ $sha ok"
}

mkdir -p "$TARGET"
fetch openmv-qt-creator https://github.com/openmv/qt-creator.git \
    af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv
fetch MaixPy-v1 https://github.com/sipeed/MaixPy-v1.git \
    d8901fd2272f000226f1c1037c1eb7c412b88e66 \
    components/micropython/port/src/omv \
    components/micropython/port/builtin_py \
    components/micropython/port/src/standard_lib/machine \
    components/boards projects/maixpy_k210
fetch MaixPy-v1_scripts https://github.com/sipeed/MaixPy-v1_scripts.git \
    8d7c5f98ba654d226f433d31718d852674cab08d
fetch MaixPy_Doc_Zh_Cn_Backup https://github.com/sipeed/MaixPy_Doc_Zh_Cn_Backup.git \
    2734af3bcf182e3359cde4ed5a3a5d7d9b75aaf1
fetch kflash.py https://github.com/sipeed/kflash.py.git \
    550828c768b16ef329695d3f5eace3f6bcf14af2
