/*
 * Weather from Open-Meteo, with an 8-hour temperature and rain dropdown.
 *
 * Location is either a fixed coordinate from prefs, or resolved from the
 * public IP with a chain of fallbacks for networks that block the first one.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const LOCATION_REFRESH_SECONDS = 6 * 60 * 60;

// WMO weather code -> symbol, per https://open-meteo.com/en/docs
const WMO_SYMBOLS = {
    0: '☀️',
    1: '🌤️',
    2: '⛅',
    3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌦️',
    56: '🌧️', 57: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️',
    66: '🌧️', 67: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '🌨️',
    77: '🌨️',
    80: '🌦️', 81: '🌦️', 82: '⛈️',
    85: '🌨️', 86: '🌨️',
    95: '⛈️', 96: '⛈️', 99: '⛈️',
};

function symbolFor(code) {
    return WMO_SYMBOLS[code] ?? '❓';
}

export const WeatherIndicator = GObject.registerClass(
class WeatherIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'Weather', false);

        this._settings = settings;
        this._weatherTimeoutId = 0;
        this._locationTimeoutId = 0;
        this._reloadId = 0;
        this._lat = null;
        this._lon = null;
        this._city = null;
        this._forecast = null;

        this._label = new St.Label({
            text: '⏳ loading weather…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-hub-label',
        });
        this.add_child(this._label);

        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();

        /*
         * A location or unit change invalidates the cached forecast entirely,
         * so it has to re-resolve; the display-only keys just re-render.
         */
        this._settingsIds = [
            ...['weather-location-mode', 'weather-latitude', 'weather-longitude',
                'weather-city', 'weather-units'].map(
                key => settings.connect(`changed::${key}`, () => this._reload())),
            settings.connect('changed::weather-show-city', () => this._render()),
            settings.connect('changed::weather-refresh-minutes',
                () => this._restartWeatherTimer()),
        ];

        this.connect('destroy', () => this._onDestroy());

        this._buildMenu();
        this._doReload();
        this._restartWeatherTimer();

        this._locationTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, LOCATION_REFRESH_SECONDS, () => {
                if (this._settings.get_string('weather-location-mode') === 'auto')
                    this._reload();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _restartWeatherTimer() {
        if (this._weatherTimeoutId !== 0) {
            GLib.source_remove(this._weatherTimeoutId);
            this._weatherTimeoutId = 0;
        }
        const minutes = this._settings.get_int('weather-refresh-minutes');
        this._weatherTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                this._fetchWeather();
                return GLib.SOURCE_CONTINUE;
            });
    }

    /*
     * Dragging a coordinate spinner or typing a place name in prefs emits
     * changed:: on every step, so coalesce a burst of edits into one fetch
     * rather than hammering the API while the user is still adjusting.
     */
    _reload() {
        if (this._reloadId !== 0)
            GLib.source_remove(this._reloadId);

        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._reloadId = 0;
            this._doReload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _doReload() {
        this._forecast = null;

        if (this._settings.get_string('weather-location-mode') === 'manual') {
            this._lat = this._settings.get_double('weather-latitude');
            this._lon = this._settings.get_double('weather-longitude');
            this._city = this._settings.get_string('weather-city') || null;
            this._fetchWeather();
            return;
        }

        this._lat = null;
        this._lon = null;
        this._city = null;
        this._locateThenFetch();
    }

    /* ----------------------------------------------------------------- http */

    _fetchJson(url, onDone) {
        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.get_status() !== Soup.Status.OK) {
                        onDone(null);
                        return;
                    }
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    onDone(JSON.parse(text));
                } catch {
                    onDone(null);
                }
            });
    }

    _locateThenFetch() {
        // Primary: ip-api.com (no key, generous rate limit, http only on free tier)
        this._fetchJson('http://ip-api.com/json/', data => {
            if (data && data.status === 'success' && data.lat !== undefined) {
                this._setLocation(data.lat, data.lon, data.city || data.regionName);
                return;
            }
            // HTTPS fallback for networks where the free ip-api endpoint is blocked.
            this._fetchJson('https://ipwho.is/', secure => {
                if (secure && secure.success && secure.latitude !== undefined) {
                    this._setLocation(secure.latitude, secure.longitude,
                        secure.city || secure.region);
                    return;
                }
                this._fetchJson('https://geolocation-db.com/json/', fallback => {
                    if (fallback && fallback.latitude !== undefined &&
                        fallback.latitude !== -1) {
                        this._setLocation(fallback.latitude, fallback.longitude,
                            fallback.city || fallback.region);
                    } else if (!this._forecast) {
                        this._label.text = '📍 location unavailable';
                    }
                });
            });
        });
    }

    _setLocation(lat, lon, city) {
        this._lat = lat;
        this._lon = lon;
        this._city = city || null;
        this._fetchWeather();
    }

    _fetchWeather() {
        if (this._lat === null || this._lon === null) {
            this._locateThenFetch();
            return;
        }

        const imperial = this._settings.get_string('weather-units') === 'imperial';

        /*
         * best_match auto-selects the highest-resolution model available for
         * these coordinates (regional nests like ICON-D2/AROME/HRRR/UKV where
         * covered, falling back to ECMWF/GFS globally) -- Open-Meteo's own
         * recommendation rather than hardcoding one global model everywhere.
         */
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${this._lat}&longitude=${this._lon}` +
            '&models=best_match' +
            '&current=temperature_2m,weather_code' +
            '&hourly=temperature_2m,precipitation_probability,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min' +
            (imperial ? '&temperature_unit=fahrenheit' : '') +
            '&forecast_days=2&timezone=auto';

        this._fetchJson(url, data => {
            if (!data || !data.current || !data.hourly || !data.daily) {
                if (!this._forecast)
                    this._label.text = '🌐 weather unavailable';
                return;
            }
            this._forecast = data;
            this._render();
        });
    }

    /* ------------------------------------------------------------------- ui */

    _degreeSuffix() {
        return this._settings.get_string('weather-units') === 'imperial' ? '°F' : '°C';
    }

    /*
     * The hourly arrays start at midnight, so find where "now" sits before
     * slicing the next eight entries out of them.
     */
    _currentHourIndex(data) {
        const currentHour = `${data.current.time.slice(0, 13)}:00`;
        const index = data.hourly.time.indexOf(currentHour);
        return index === -1 ? 0 : index;
    }

    _render() {
        const data = this._forecast;
        if (!data)
            return;

        const start = this._currentHourIndex(data);
        const nextEight = data.hourly.precipitation_probability.slice(start, start + 8);
        const rainChance = nextEight.length > 0 ? Math.max(...nextEight) : 0;

        const showCity = this._settings.get_boolean('weather-show-city');
        const city = showCity && this._city ? `${this._city} ` : '';
        const current = Math.round(data.current.temperature_2m);
        const high = Math.round(data.daily.temperature_2m_max[0]);
        const low = Math.round(data.daily.temperature_2m_min[0]);

        this._label.text =
            `${city}${symbolFor(data.current.weather_code)} ${current}°  ` +
            `${rainChance}%🌧  H:${high}° L:${low}°`;

        this._buildMenu();
    }

    _buildMenu() {
        this.menu.removeAll();

        const data = this._forecast;
        if (!data) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'Forecast is loading…', {reactive: false}));
            return;
        }

        const unit = this._degreeSuffix();
        const current = Math.round(data.current.temperature_2m);
        const high = Math.round(data.daily.temperature_2m_max[0]);
        const low = Math.round(data.daily.temperature_2m_min[0]);

        const heading = new PopupMenu.PopupMenuItem(
            `${symbolFor(data.current.weather_code)}  ${current}${unit}   Today ${high}° / ${low}°`,
            {reactive: false, can_focus: false});
        heading.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(heading);

        const location = new PopupMenu.PopupMenuItem(
            `Weather for ${this._city || 'unknown location'}`,
            {reactive: false, can_focus: false});
        location.label.add_style_class_name('panel-hub-dim');
        location.label.opacity = 160;
        this.menu.addMenuItem(location);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Next 8 hours'));

        const forecastBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const start = this._currentHourIndex(data);
        const end = Math.min(start + 8, data.hourly.time.length);
        let previousDate = '';
        for (let i = start; i < end; i++) {
            const timestamp = data.hourly.time[i];
            const date = timestamp.slice(0, 10);
            if (date !== previousDate) {
                const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString(
                    undefined, {weekday: 'long', month: 'short', day: 'numeric'});
                forecastBox.add_child(new St.Label({
                    text: dateLabel,
                    style: 'font-weight: bold; padding: 8px 12px 3px 12px;',
                }));
                previousDate = date;
            }

            const hour = timestamp.slice(11, 16);
            const temperature = Math.round(data.hourly.temperature_2m[i]);
            const rain = data.hourly.precipitation_probability[i] ?? 0;
            forecastBox.add_child(new St.Label({
                text: `${hour}    ${symbolFor(data.hourly.weather_code[i])}  ` +
                      `${temperature}${unit}       Rain ${rain}%`,
                style: 'padding: 3px 12px;',
            }));
        }

        const scrollView = new St.ScrollView({
            style: 'min-width: 290px; max-height: 480px;',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scrollView.set_child(forecastBox);

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(scrollView);
        this.menu.addMenuItem(section);
    }

    _onDestroy() {
        for (const id of [this._weatherTimeoutId, this._locationTimeoutId,
            this._reloadId]) {
            if (id !== 0)
                GLib.source_remove(id);
        }
        this._weatherTimeoutId = 0;
        this._locationTimeoutId = 0;
        this._reloadId = 0;

        this._cancellable?.cancel();
        this._cancellable = null;
        this._session = null;

        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._forecast = null;
    }
});
