#!/usr/bin/env bash
# Install, refresh or remove the LaunchAgent that copies Drafter's encrypted
# nightly backups into iCloud Drive (scripts/backup-offsite.mjs), every night
# at 03:30 on this Mac.
#
#   scripts/install-offsite-backup.sh              write it (or rewrite it) and load it
#   scripts/install-offsite-backup.sh --uninstall  unload it and delete it
#
# The agent does not run this checkout. The installer pins a copy of the few
# files it needs — the script, what it imports, and this checkout's link to the
# Supabase project — into ~/Library/Application Support/Drafter/offsite, and the
# agent runs that: switching branches, a half-finished edit or moving the
# checkout changes nothing at night. Run this again to take a change (or a new
# `supabase link`) into the copy, and after changing node: the node and supabase
# on your PATH at this moment are named in full, once.
#
# It prints exactly what it writes. It runs nothing at load: the first copy
# happens at 03:30, or when you start it by hand (the last lines say how). A
# failed night, or copies more than 3 days old (once a week), shows a
# notification.
set -euo pipefail

LABEL="app.drafter.backup-offsite"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
LOG="$HOME/Library/Logs/drafter-backup-offsite.log"
SUPPORT="$HOME/Library/Application Support/Drafter"
PINNED="$SUPPORT/offsite"
DOMAIN="gui/$(id -u)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$REPO/scripts/backup-offsite.mjs"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-offsite-backup: this installs a macOS LaunchAgent; run it on the Mac." >&2
  exit 1
fi

case "${1:-}" in
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    if [ -f "$PLIST" ]; then
      rm -f "$PLIST"
      echo "Unloaded $LABEL and deleted $PLIST."
    else
      echo "Nothing to remove: $PLIST does not exist."
    fi
    rm -rf "$PINNED" "$SUPPORT/offsite-state.json"
    echo "Deleted the copy it ran ($PINNED)."
    echo "The copies already in iCloud Drive (Drafter Backups) and the log ($LOG) are left as they are."
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [--uninstall]" >&2
    exit 2
    ;;
esac

NODE="$(command -v node || true)"
SUPABASE="$(command -v supabase || true)"
if [ -z "$NODE" ]; then
  echo "install-offsite-backup: node is not on your PATH." >&2
  exit 1
fi
if [ -z "$SUPABASE" ]; then
  echo "install-offsite-backup: the supabase CLI is not on your PATH (brew install supabase/tap/supabase)." >&2
  exit 1
fi
if [ ! -f "$REPO/supabase/.temp/project-ref" ]; then
  echo "Warning: this checkout is not linked to a Supabase project yet. Run 'supabase link' in $REPO and then this again (the link is copied at install), or every night will fail."
fi
if [ ! -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
  echo "Warning: iCloud Drive is not on for this Mac. Turn it on, or every night will fail."
fi

# the copy the agent runs, refreshed from this checkout
"$NODE" "$SCRIPT" --pin "$PINNED"
echo

# the plist comes from the pinned copy itself, whose tests hold its shape: it
# names the copy and its folder, never this checkout
TEXT="$("$NODE" "$PINNED/scripts/backup-offsite.mjs" --launch-agent --node "$NODE" --supabase "$SUPABASE")"

mkdir -p "$AGENTS" "$(dirname "$LOG")"
TMP="$(mktemp "$AGENTS/.$LABEL.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$TEXT" > "$TMP"
plutil -lint "$TMP" >/dev/null
chmod 644 "$TMP"
mv -f "$TMP" "$PLIST"
trap - EXIT

echo "Wrote $PLIST:"
echo
cat "$PLIST"
echo

# a rewrite takes effect only once the old copy is unloaded
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "Loaded $LABEL. It copies new encrypted snapshots into"
echo "  $HOME/Library/Mobile Documents/com~apple~CloudDocs/Drafter Backups"
echo "every night at 03:30 (a Mac asleep then catches up when it wakes), keeps 60 days, and logs to"
echo "  $LOG"
echo
echo "It runs the copy in $PINNED, not this checkout: run this again to take a change into it."
echo "A failed night, or copies more than 3 days old (once a week), shows a notification. If none"
echo "ever appears, allow notifications for Script Editor (System Settings → Notifications)."
echo
echo "Try it now:  launchctl kickstart $DOMAIN/$LABEL   then:  tail $LOG"
echo "If the log says 'Operation not permitted', macOS is keeping the agent out of iCloud Drive:"
echo "give $NODE Full Disk Access (System Settings → Privacy & Security) and try again."
echo "Remove it with: $0 --uninstall"
