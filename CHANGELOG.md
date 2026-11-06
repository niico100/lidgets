# Changelog

## Unreleased

- Add an optional stocks and crypto widget. Search for tickers in
  **Preferences → Markets** and tick which prices show in the panel with their
  24-hour change; the dropdown lists every ticker with 24-hour, 7-day, 1-month
  and 6-month changes. Prices come from Yahoo Finance and refresh every five
  minutes.
- Keep the currency panel placeholder after old lookups, including across
  reboots and automatic rate refreshes.
- Refetch weather and exchange rates when the network comes back, instead of
  staying offline until the next scheduled refresh.
- Move the fold button to the right of the widgets so it stays reachable when
  they overflow the left edge of the panel.
- Add an optional drawer-aware currency converter with editable amount and
  currency pair, two-decimal symbol-based values, six-hour reference-rate
  refreshes, and offline stale marking.
- Add optional Codex and Claude Code widgets showing subscription allowance
  remaining, reset times, and stale readings. Include a Claude Code status-line
  connection that preserves the existing command.
- Add an option to show the 5-hour reset time and weekly reset day and time in
  the Codex and Claude Code panel labels.
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
