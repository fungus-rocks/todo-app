#!/bin/bash
# Installs the launchd agent that keeps the vault's todo note synced with GitHub.
# Re-run after changing settings; `./install.sh uninstall` removes it.
set -euo pipefail

LABEL=com.todo-app.sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/todo-sync.log"
HERE="$(cd "$(dirname "$0")" && pwd)"

TODO_FILE="${TODO_FILE:-$HOME/Z/Ideaverse/Todo-Main.md}"
TODO_REPO="${TODO_REPO:-fungus-rocks/ideaverse}"
TODO_BRANCH="${TODO_BRANCH:-main}"
TODO_PATH="${TODO_PATH:-Todo-Main.md}"
PYTHON="$(command -v python3)"
GH="$(command -v gh)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

[[ -f "$TODO_FILE" ]] || { echo "Not found: $TODO_FILE" >&2; exit 1; }
"$GH" auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first" >&2; exit 1; }

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PYTHON</string><string>$HERE/todo_sync.py</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$GH"):/usr/bin:/bin</string>
    <key>GH</key><string>$GH</string>
    <key>TODO_FILE</key><string>$TODO_FILE</string>
    <key>TODO_REPO</key><string>$TODO_REPO</string>
    <key>TODO_BRANCH</key><string>$TODO_BRANCH</string>
    <key>TODO_PATH</key><string>$TODO_PATH</string>
  </dict>
  <key>StartInterval</key><integer>60</integer>
  <key>WatchPaths</key><array><string>$TODO_FILE</string></array>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: syncing $TODO_FILE <-> $TODO_REPO@$TODO_BRANCH:$TODO_PATH"
echo "Log: $LOG"
