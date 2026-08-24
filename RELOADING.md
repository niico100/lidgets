# Reloading after a code change

Fedora 44, GNOME Shell 50.4, Wayland. Verified on 2026-08-24.

## The short version

`gnome-extensions disable … && gnome-extensions enable …` does **not** pick up
edited code. It re-runs `enable()` on the module the shell already imported.

To load changed code without logging out, hot-swap the module from Looking
Glass. To load it properly, log out and back in.

## Why disable/enable is not enough

`extensionSystem.js` imports an extension exactly once, by plain file URI with
no cache-busting:

```js
extensionModule = await import(extensionJs.get_uri());
// Extensions can only be imported once, so add a property to avoid
// attempting to re-import an extension.
extension.isImported = true;
```

Everything follows from that:

- The gjs module cache is keyed on the URI, so a second import of the same path
  returns the stale module.
- `unloadExtension()` records the version in `_unloadedExtensions`, and
  `_canLoad()` then refuses to load a *different* version of the same UUID
  until the shell restarts.
- The D-Bus method that used to force a reload is gone:
  `org.gnome.Shell.Extensions.ReloadExtension` now returns
  `NotSupported: ReloadExtension is deprecated and does not work`.
- Installing a copy under a fresh UUID would get a fresh import, but the shell
  only scans the extensions directory once at startup (`_loadExtensions()` is
  guarded by `_initializationPromise`, and there is no file monitor), so a new
  directory is invisible until restart.
- On Wayland the shell is the compositor, so there is no `Alt+F2` `r`.

## Hot-swapping the drawer (no logout)

gjs *does* honour a query string as a distinct module-cache key — same URI
returns the cached module, `?v=<timestamp>` re-reads the file. `lib/drawer.js`
imports nothing relative (only `gi://` and `resource:///`), so it can be
imported standalone and the drawer rebuilt in place.

`Alt+F2` → `lg` → **Evaluator** tab → paste as one line, replacing
`/absolute/path/to/lidgets` with the checkout path:

```js
const E = Main.extensionManager.lookup('panel-hub@neonshard.com').stateObj; const M = await import('file:///absolute/path/to/lidgets/panel-hub@neonshard.com/lib/drawer.js?v=' + Date.now()); E._drawer.destroy(); E._drawer = new M.Drawer(E._settings, () => E._indicators); 'drawer reloaded'
```

Looking Glass evaluates through `AsyncFunction`, so top-level `await` is fine.
It splits the input on `;` and prefixes the last fragment with `return`, so end
on an expression.

If it throws, the drawer is gone but the widgets fall back inline; recover with
`gnome-extensions disable panel-hub@neonshard.com && gnome-extensions enable
panel-hub@neonshard.com`.

This only swaps `lib/drawer.js`. Changes to `extension.js` itself, or to which
widgets are constructed, still need a real restart.

## Testing without touching the live session

A headless shell imports the extension fresh, so it always runs current code:

```sh
ADDR=$(dbus-daemon --session --print-address --fork)
env DBUS_SESSION_BUS_ADDRESS="$ADDR" \
    gnome-shell --headless --virtual-monitor 1280x800 --wayland-display=phtest &
env DBUS_SESSION_BUS_ADDRESS="$ADDR" gnome-extensions info panel-hub@neonshard.com
env DBUS_SESSION_BUS_ADDRESS="$ADDR" gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.GetExtensionErrors panel-hub@neonshard.com
```

`--nested` was removed in Shell 50; plain `--wayland` runs nested, and
`--display-server` is what asks for a full display server.

Drive it through GSettings rather than the mouse — e.g. set
`drawer-collapsed-per-monitor` to `{'1280x800': true}` to force the fold path.
The nested shell shares your dconf, so use a monitor key that is not one of
yours and put the key back afterwards.

Two things do **not** work for inspecting it: `org.gnome.Shell.Eval` (Shell 50
dropped the settable `UnsafeMode` property, so it always returns `false`), and
`org.gnome.Shell.Screenshot` (returns `AccessDenied`, headless or not).
