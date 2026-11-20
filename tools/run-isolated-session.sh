#!/bin/bash
# Keep services activated by a preview bus away from the desktop's runtime files.
set -euo pipefail

if (( $# == 0 )); then
    echo "Usage: $0 COMMAND [ARGUMENT...]" >&2
    exit 2
fi

desktop_runtime=${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must identify the desktop session}
case ${WAYLAND_DISPLAY:-} in
    ''|/*) ;;
    *) export WAYLAND_DISPLAY="$desktop_runtime/$WAYLAND_DISPLAY" ;;
esac

preview_runtime=$(mktemp -d "$desktop_runtime/lidgets-session.XXXXXXXX")
trap 'rm -rf -- "$preview_runtime"' EXIT
export XDG_RUNTIME_DIR="$preview_runtime"
export LIDGETS_SESSION_ISOLATED=1
dbus-run-session -- "$@"
