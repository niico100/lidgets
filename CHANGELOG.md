# Changelog

## Unreleased

- Rename the extension identity from Panel Hub to Lidgets, with a one-time
  migration for existing settings.
- Allow clock separators to be hidden while retaining spacing between clocks.
- Make timezone search city-first, so queries such as `Prague` and `New York`
  find their canonical IANA zones.
- Include the country flag in automatically generated clock labels where tzdata
  identifies one, and keep that label in sync when its timezone changes.
- Add independent per-clock switches for the country flag and the city name, so
  a clock can show either, both, or neither. Custom label text survives a flag
  toggle, and the flag switch explains itself on zones tzdata gives no country.
- Stop the "Show city" switch and the clock label from driving each other in a
  loop, which hung the preferences window and wrote a blank label to settings.
- Show the moon in its current phase instead of a sun when the sky is clear
  after dark, mirrored in the southern hemisphere, and drop the sun from the
  partly cloudy, drizzle and shower symbols at night.
- Bound and coalesce clock refreshes, constrain malformed display settings,
  and ignore stale or post-destruction weather callbacks.

## 1.0.0 — 2026-08-24

Initial public release.

- Configurable world clocks with automatic local-time-zone seeding.
- Open-Meteo weather and location search.
- CPU, GPU, memory, storage, network, fan, temperature, and battery metrics.
- Compact Vitals-derived symbolic icons or text prefixes for panel readings.
- Manual and automatic folding into a panel drawer, remembered per monitor.
- Optional remote-desktop warning banner.
- GNOME Shell 50 support.
