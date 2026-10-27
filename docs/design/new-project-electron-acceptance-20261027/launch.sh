#!/bin/zsh
set -eu
REVIEW_ROOT='/private/tmp/nodu-new-project-electron-20261027-tDbP3p'
INTEGRATION_ROOT='/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio'
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
export NODU_PROFILE_DIR="$REVIEW_ROOT/profile"
export THEIA_CONFIG_DIR="$REVIEW_ROOT/profile/config"
export NODU_ARDUINO_HOME="$REVIEW_ROOT/arduino-home"
export NODU_ARDUINO_OFFLINE_BUNDLES="$INTEGRATION_ROOT/desktop/.tools/arduino-release"
export NODU_ARDUINO_RESOURCES="$INTEGRATION_ROOT/desktop/scope-extension/resources/arduino"
unset ELECTRON_RUN_AS_NODE
exec "$REVIEW_ROOT/Nodu New Project Check.app/Contents/MacOS/Electron" "$INTEGRATION_ROOT/desktop/electron-app" --hostname=127.0.0.1 --port=24386 "--plugins=local-dir:$INTEGRATION_ROOT/desktop/plugins" "--user-data-dir=$REVIEW_ROOT/profile/electron" "--electronUserData=$REVIEW_ROOT/profile/electron"
