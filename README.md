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

Read from `/proc` and `/sys`. `available()` advertises only what the machine
can actually answer, so no metric ever shows a permanent `--`.

GPU support is per vendor, because they expose entirely different things:

| Vendor | Load | VRAM | Temp | Clock |
|---|---|---|---|---|
| AMD (`gpu_busy_percent`) | yes | yes | hwmon | — |
| NVIDIA (`nvidia-smi`) | yes | yes | yes | — |
| Intel | no sysfs counter | integrated | hwmon | yes |

NVIDIA needs a subprocess, so it is sampled on its own 5-second clock with the
last answer reused in between, rather than at the panel's rate. Detection
requires `/proc/driver/nvidia/gpus` to be non-empty — `nvidia-smi` is often
installed on machines with no NVIDIA card, since it ships with CUDA tooling.

Free space is queried asynchronously because it can touch a real filesystem;
everything else is memory-backed and sampled synchronously.

### Drawer collapse

The default `auto` mode asks *"do my widgets fit?"* rather than *"is the screen
small?"*: it measures the natural width of its own indicators against a share
of the panel (`drawer-space-fraction`, default 35%). That needs no knowledge of
the monitor, of Dash to Panel, or of other extensions, and adapts to both the
screen and how many widgets are switched on.

Two details keep it stable:

- `.panel-hub-drawer-item` sets height only. If it changed width, the measured
  figure would depend on whether the widgets were already collapsed, and the
  decision would oscillate.
- Expanding again requires clearing the budget by `EXPAND_HYSTERESIS`, so a
  metric gaining a digit cannot make the panel flap.

`width` mode is the older fixed-pixel behaviour, kept as an explicit option.

### Dash to Panel

Not required. It is used where available for extra precision — which monitor
the panel is on, and which screen edge it occupies — and every reference is
optional-chained with a plain-GNOME fallback.

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
