#!/usr/bin/env bash
# Restore the extension set that was enabled before Panel Hub was installed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gsettings set org.gnome.shell enabled-extensions "$(cat "$DIR/enabled-extensions.backup")"
echo "Restored. Log out and back in to apply."
