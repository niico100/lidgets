# lidgets

GNOME Shell panel widgets for this machine (Fedora 44, GNOME Shell 50.4, Wayland).

## panel-hub@local

One extension replacing what used to be five separate ones, plus Vitals:

| Replaced | What it did |
|---|---|
| `world-panel-clock@local` | three hardcoded world clocks |
| `weather-panel@local` | weather, location fixed to IP lookup |
| `weather-panel-v2@local` | byte-identical duplicate of the above |
| `panel-extras@local` | drawer that collapsed the others on narrow screens |
| `panel-extras-toggle@local`, `panel-extras-auto@local` | dead prototypes |
| `Vitals@CoreCoding.com` | system metrics (third-party) |

Everything is now configurable from the preferences window instead of by
editing source: `gnome-extensions prefs panel-hub@local`.

### Layout

```
panel-hub@local/
  extension.js     entry point; builds/tears down widgets from settings
  prefs.js         Adw preferences window (4 pages)
  stylesheet.css
  lib/
    sensors.js     /proc + /sys sampling; imported by prefs.js too
    metrics.js     metrics panel indicator
    clocks.js      world clocks indicator
    weather.js     Open-Meteo indicator
    remote.js      "REMOTE DESKTOP ON" banner
    drawer.js      narrow-screen collapse
  schemas/         GSettings schema + compiled binary
```

`sensors.js` deliberately imports only GLib/Gio — no shell APIs — so the prefs
process can run the same hardware detection and offer exactly the metrics this
machine supports.

### Metrics

Read directly from `/proc` and `/sys`; no subprocesses, no external libraries.
On this machine all eleven are available: CPU load, CPU temp (k10temp), GPU
load and temp plus VRAM (amdgpu `gpu_busy_percent` / `mem_info_vram_used`),
RAM, swap, free space, network throughput, fan (gpdfan), battery.

Free space is queried asynchronously because it can touch a real filesystem;
everything else is memory-backed and sampled synchronously.

## Development

The extension is symlinked into place:

```
~/.local/share/gnome-shell/extensions/panel-hub@local -> this directory
```

After editing the schema, recompile it:

```
glib-compile-schemas /home/niico/data/src/lidgets/panel-hub@local/schemas/
```

**Reloading is constrained on this machine.** New extension directories are
only scanned at shell startup, ES modules are cached per file URI, and an
extension that throws in `enable()` is locked out until restart. On Wayland
that means a full log out / log back in for *any* code change — there is no
`Alt+F2 r`. Audit statically before restarting; you get one attempt per login.

The shell's own source is readable for checking APIs:

```
gresource extract /usr/lib64/gnome-shell/libshell-18.so /org/gnome/shell/ui/panel.js
```

Prefs can be tested without a restart by stubbing `ExtensionPreferences` and
running the file under plain `gjs -m` against a real `Adw.PreferencesWindow`.

## Reverting

`revert.sh` restores the extension set that was enabled before Panel Hub
(recorded in `enabled-extensions.backup`), then log out and back in.
