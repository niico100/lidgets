# lidgets

GNOME Shell panel widgets for this machine (Fedora 44, GNOME Shell 50.4, Wayland).

## panel-hub@neonshard.com

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
editing source: `gnome-extensions prefs panel-hub@neonshard.com`.

After editing anything under `panel-hub@neonshard.com/`, see
[RELOADING.md](RELOADING.md) — disabling and re-enabling the extension does not
pick up code changes on Wayland.

### Layout

```
panel-hub@neonshard.com/
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

Inline metric readings can use compact symbols (for example, `⚙ 12%`) or text
labels (`CPU 12%`), selected in preferences. Their dropdown keeps the full
descriptive names.

### Folding

Default mode is `manual`: a `›` button in the panel folds the widgets into the
drawer. Once folded, the panel shows `‹` to put them back inline and an arrow
toward the drawer to open it. No threshold, no measurement, no guessing —
portable by construction.

The fold state is remembered per monitor, keyed by `WIDTHxHEIGHT` of the screen
holding the panel, so docking and undocking restores the choice already made on
each screen instead of needing another click. Keying on size rather than
connector keeps it stable across cable and port changes.

The automatic modes remain available:

| Mode | Behaviour |
|---|---|
| `manual` (default) | button only, remembered per monitor |
| `auto` | folds when the widgets exceed `drawer-space-fraction` (35%) of the panel |
| `width` | folds when the monitor is narrower than `drawer-max-width` |
| `always` / `never` | forced |

`auto` measures the natural width of its own indicators, so it needs no
knowledge of the monitor, of Dash to Panel, or of other extensions. Two details
keep it stable, and both are load-bearing:

- `.panel-hub-drawer-item` sets height only. If it changed width, the measured
  figure would depend on whether the widgets were already folded, and the
  decision would oscillate.
- Unfolding requires clearing the budget by `EXPAND_HYSTERESIS`, so a metric
  gaining a digit cannot make the panel flap.

Only `auto` runs the periodic re-measure; the other modes cannot change their
own mind, so they do no work on a timer.

### Dash to Panel

Not required. It is used where available for extra precision — which monitor
the panel is on, and which screen edge it occupies — and every reference is
optional-chained with a plain-GNOME fallback.

### Weather location

Always chosen by the user: type a place, pick it from the live-searched list.
Nothing looks up the IP address — that used to mean a plaintext `http://`
request to a third party that answered with the user's city, which is a poor
default to ship.

The compact panel reading omits the city to save space; clicking the weather
opens a forecast headed with the selected location.

On first run the place is guessed from the machine's own IANA timezone, which
names a city: `Europe/London` → `London`, `America/Argentina/Buenos_Aires` →
`Buenos Aires`. That name is geocoded like any typed one. If it does not
resolve (`UTC`, say) the panel asks the user to pick one.

The clock list is seeded the same way, from the same timezone. A GSettings
default must be a fixed literal, so it cannot be "whatever this machine is set
to" — hence `clocks-seeded`, which distinguishes "never configured" from "the
user deleted every clock" so an empty list is not silently repopulated.

### Translations

`gettext-domain` is `panel-hub`; `po/panel-hub.pot` carries 86 strings.
Regenerate it after changing user-visible text:

```
xgettext --files-from=po/POTFILES --output=po/panel-hub.pot \
  --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=N_
```

`lib/sensors.js` is imported by the preferences process, which has no access to
the shell's gettext, so its metric titles are marked with a no-op `N_()` and
wrapped with `_()` at each display site instead.

## Development

The extension is symlinked into place:

```
~/.local/share/gnome-shell/extensions/panel-hub@neonshard.com -> this directory
```

After editing the schema, recompile it:

```
glib-compile-schemas /home/niico/data/src/lidgets/panel-hub@neonshard.com/schemas/
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

`revert.sh` restores the extension set that was enabled before Lidgets
(recorded in `enabled-extensions.backup`), then log out and back in.
