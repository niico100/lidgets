# Desktop preview safety

- Run nested GNOME sessions and preview scripts through
  `bash tools/run-isolated-session.sh COMMAND [ARGUMENT...]`.
- Never run a preview with plain `dbus-run-session` sharing the desktop's
  `XDG_RUNTIME_DIR`. Its document portal can replace and then unmount the live
  desktop portal, preventing Signal and other Flatpak applications from opening.
- The runner preserves access to the parent Wayland socket while giving preview
  services a private runtime directory. Also isolate preview XDG config, data and
  cache directories to avoid changing the user's desktop settings.
- Do not repair preview-induced desktop damage with a polling recovery service.
