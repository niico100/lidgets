# Changelog

## Unreleased

- Allow clock separators to be hidden while retaining spacing between clocks.
- Make timezone search city-first, so queries such as `Prague` and `New York`
  find their canonical IANA zones.
- Include the country flag in automatically generated clock labels where tzdata
  identifies one, and keep that label in sync when its timezone changes.
- Add a per-clock option to show the city or display only its country flag.

## 1.0.0 — 2026-08-24

Initial public release.

- Configurable world clocks with automatic local-time-zone seeding.
- Open-Meteo weather and location search.
- CPU, GPU, memory, storage, network, fan, temperature, and battery metrics.
- Compact Vitals-derived symbolic icons or text prefixes for panel readings.
- Manual and automatic folding into a panel drawer, remembered per monitor.
- Optional remote-desktop warning banner.
- GNOME Shell 50 support.
