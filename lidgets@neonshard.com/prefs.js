/*
 * Lidgets preferences.
 *
 * The metrics page is built from the sensors this machine actually exposes,
 * and remembers removable GPUs so their selections survive disconnects.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Sensors, listMountPoints} from './lib/sensors.js';
import {geocode, makeJsonFetcher, describePlace} from './lib/geocode.js';
import {
    clockLabel, makeClockEntry, timezoneFlag, timezoneLocality,
} from './lib/timezones.js';
import {USER_AGENT, searchSymbols, shortSymbol} from './lib/quotes.js';

/*
 * Long enough that ordinary typing produces one request rather than one per
 * letter, short enough that the list still feels like it follows the keyboard.
 */
const SEARCH_DEBOUNCE_MS = 400;
const HTTP_TIMEOUT_SECONDS = 15;

/*
 * A practical ceiling, not a technical one: beyond ten the strip is wider
 * than any panel and folding it away stops helping. Zero is valid.
 */
const MAX_CLOCKS = 10;
const MAX_TICKERS = 12;

function localTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

const FALLBACK_TIMEZONES = [
    'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Moscow', 'America/Los_Angeles',
    'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto',
    'America/Mexico_City', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Karachi',
    'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Hong_Kong',
    'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Perth',
    'Australia/Sydney', 'Pacific/Auckland',
];

function allTimezones() {
    let zones;
    try {
        zones = Intl.supportedValuesOf('timeZone');
    } catch {
        // Older SpiderMonkey without supportedValuesOf.
    }
    if (!Array.isArray(zones) || zones.length === 0)
        zones = FALLBACK_TIMEZONES;

    return [...zones].sort((left, right) =>
        timezoneSearchLabel(left).localeCompare(timezoneSearchLabel(right)));
}

/*
 * Adw.ComboRow searches from the beginning of its display string. Put the
 * locality first so ordinary queries such as "Prague" and "New York" find
 * Europe/Prague and America/New_York, while retaining the canonical zone for
 * disambiguation and storage.
 */
function timezoneSearchLabel(zone) {
    const parts = zone.split('/');
    const locality = timezoneLocality(zone);
    return parts.length === 1
        ? locality
        : `${locality} — ${zone.replaceAll('_', ' ')}`;
}

/*
 * GSettings' default bind mapping will not marshal an integer key onto a
 * double 'value' property, so integer adjustments are wired up by hand.
 */
function bindIntAdjustment(settings, key, adjustment) {
    adjustment.set_value(settings.get_int(key));
    adjustment.connect('value-changed',
        () => settings.set_int(key, Math.round(adjustment.get_value())));
}

/*
 * A ComboRow over a fixed set of string values, mapped to a string key.
 */
function makeChoiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? null,
        model: Gtk.StringList.new(choices.map(c => c.label)),
    });

    const values = choices.map(c => c.value);
    const current = values.indexOf(settings.get_string(key));
    row.selected = current === -1 ? 0 : current;

    row.connect('notify::selected',
        () => settings.set_string(key, values[row.selected]));
    return row;
}

function makeTimezoneRow(timezones, selectedZone, onChanged) {
    const row = new Adw.ComboRow({
        title: _('Time zone'),
        model: Gtk.StringList.new(timezones.map(timezoneSearchLabel)),
        enable_search: true,
    });
    // enable-search needs an expression to know what text to match against.
    row.expression = Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string');

    const index = timezones.indexOf(selectedZone);
    row.selected = index === -1 ? 0 : index;
    row.connect('notify::selected', () => onChanged(timezones[row.selected]));
    return row;
}

function makeFlatButton(iconName, tooltip) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('flat');
    return button;
}

export default class LidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(760, 820);
        window.search_enabled = true;

        window.add(this._generalPage(settings));
        window.add(this._clocksPage(settings));
        window.add(this._weatherPage(settings));
        window.add(this._marketsPage(settings));
        window.add(this._metricsPage(settings));
    }

    /* ---------------------------------------------------------------- general */

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const main = new Adw.PreferencesGroup({
            title: _('Lidgets'),
            description: _('Turn the whole set of widgets on or off, and choose where they sit.'),
        });
        page.add(main);

        const master = new Adw.SwitchRow({
            title: _('Show Lidgets'),
            subtitle: _('Master switch for every widget below'),
        });
        settings.bind('master-enabled', master, 'active', Gio.SettingsBindFlags.DEFAULT);
        main.add(master);

        const widgets = new Adw.PreferencesGroup({
            title: _('Widgets'),
            description: _('Each widget is a separate item in the panel.'),
        });
        page.add(widgets);

        for (const [key, title, subtitle] of [
            ['clocks-enabled', _('World clocks'), _('Times for the zones you follow')],
            ['weather-enabled', _('Weather'), _('Current conditions and an 8-hour forecast')],
            ['currency-enabled', _('Currency converter'),
                _('Live reference-rate conversion; configure it from the panel popup')],
            ['markets-enabled', _('Stocks and crypto'),
                _('Prices with 24-hour change; choose tickers on the Markets page')],
            ['metrics-enabled', _('System metrics'), _('CPU, GPU, memory, disk and more')],
            ['codex-enabled', _('Codex limits'), _('Subscription allowance remaining; requires Codex CLI login')],
            ['claude-enabled', _('Claude Code limits'), _('5-hour and weekly allowance remaining; connect below')],
            ['usage-show-resets', _('Show limit reset times'),
                _('Add the 5-hour reset time and weekly reset day to the Codex and Claude labels')],
            ['remote-enabled', _('Remote desktop banner'),
                _('A red warning while RDP or VNC is accepting connections')],
        ]) {
            const row = new Adw.SwitchRow(subtitle ? {title, subtitle} : {title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            // The master switch gates everything, so grey these out when it is off.
            settings.bind('master-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
            widgets.add(row);
        }

        const connection = new Adw.ActionRow({
            title: _('Claude Code connection'),
            subtitle: _('Shares usage with Lidgets while preserving your existing status line. Restart Claude Code after connecting.'),
        });
        const connect = new Gtk.Button({label: _('Connect Claude Code'), valign: Gtk.Align.CENTER});
        connection.add_suffix(connect);
        connect.connect('clicked', () => {
            connect.sensitive = false;
            try {
                const process = Gio.Subprocess.new(
                    ['python3', `${this.path}/lib/usage-helper.py`, 'install-claude'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                process.communicate_utf8_async(null, null, (source, result) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(result);
                        connection.subtitle = JSON.parse(stdout).ok
                            ? _('Connected. Restart Claude Code and send a prompt to populate usage.')
                            : _('Could not connect. Check that Claude settings.json is valid and writable.');
                    } catch {
                        connection.subtitle = _('Could not connect Claude Code.');
                    }
                    connect.sensitive = true;
                });
            } catch {
                connection.subtitle = _('Python 3 is required to connect Claude Code.');
                connect.sensitive = true;
            }
        });
        widgets.add(connection);

        const placement = new Adw.PreferencesGroup({title: _('Placement')});
        page.add(placement);

        placement.add(makeChoiceRow(settings, 'panel-box', _('Panel area'), null, [
            {label: _('Right'), value: 'right'},
            {label: _('Centre'), value: 'center'},
            {label: _('Left'), value: 'left'},
        ]));

        const indexAdjustment = new Gtk.Adjustment({
            lower: 0, upper: 20, step_increment: 1, page_increment: 1,
        });
        bindIntAdjustment(settings, 'panel-index', indexAdjustment);
        placement.add(new Adw.SpinRow({
            title: _('Position'),
            subtitle: _('Lower numbers sit further to the left within that area'),
            adjustment: indexAdjustment,
        }));

        const drawer = new Adw.PreferencesGroup({
            title: _('Folding'),
            description: _('The widgets can fold into a single drawer button to save room in the panel. They keep running while folded.'),
        });
        page.add(drawer);

        const modeRow = makeChoiceRow(settings, 'drawer-mode',
            _('Fold the widgets away'), null, [
                {label: _('When I click the button'), value: 'manual'},
                {label: _('When they would not fit'), value: 'auto'},
                {label: _('When the screen is narrower than a set width'), value: 'width'},
                {label: _('Always'), value: 'always'},
                {label: _('Never'), value: 'never'},
            ]);
        drawer.add(modeRow);

        const manualHint = new Adw.ActionRow({
            title: _('Remembered per monitor'),
            subtitle: _('Fold once on each screen and the choice is restored when you dock or undock. Use ‹ inside the drawer to unfold.'),
        });
        drawer.add(manualHint);

        const fractionAdjustment = new Gtk.Adjustment({
            lower: 10, upper: 80, step_increment: 5, page_increment: 10,
        });
        bindIntAdjustment(settings, 'drawer-space-fraction', fractionAdjustment);
        const fractionRow = new Adw.SpinRow({
            title: _('Fold once the widgets exceed'),
            subtitle: _('Percent of the panel width. Measured against the widgets themselves, so it follows both the screen and how many are on.'),
            adjustment: fractionAdjustment,
        });
        drawer.add(fractionRow);

        const widthAdjustment = new Gtk.Adjustment({
            lower: 640, upper: 7680, step_increment: 32, page_increment: 128,
        });
        bindIntAdjustment(settings, 'drawer-max-width', widthAdjustment);
        const widthRow = new Adw.SpinRow({
            title: _('Collapse below this width'),
            subtitle: _('Logical pixels on the monitor holding the panel'),
            adjustment: widthAdjustment,
        });
        drawer.add(widthRow);

        // At most one of these applies at a time; grey out the rest.
        const syncThresholdRows = () => {
            const mode = settings.get_string('drawer-mode');
            manualHint.sensitive = mode === 'manual';
            fractionRow.sensitive = mode === 'auto';
            widthRow.sensitive = mode === 'width';
        };
        settings.connect('changed::drawer-mode', syncThresholdRows);
        syncThresholdRows();

        return page;
    }

    /* ----------------------------------------------------------------- clocks */

    _clocksPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Clocks'),
            icon_name: 'preferences-system-time-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: _('Display')});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: _('Show world clocks')});
        settings.bind('clocks-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        const format = new Adw.SwitchRow({
            title: _('24-hour clock'),
            subtitle: _('Off shows am/pm'),
        });
        settings.bind('clock-24h', format, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(format);

        const showSeparator = new Adw.SwitchRow({
            title: _('Show separator between clocks'),
            subtitle: _('Off keeps spacing without punctuation'),
        });
        showSeparator.active = settings.get_string('clock-separator').trim() !== '';
        options.add(showSeparator);

        const separator = new Adw.EntryRow({title: _('Separator')});
        settings.bind('clock-separator', separator, 'text', Gio.SettingsBindFlags.DEFAULT);
        separator.sensitive = showSeparator.active;
        options.add(separator);

        let syncingSeparator = false;
        const syncSeparator = () => {
            syncingSeparator = true;
            showSeparator.active = settings.get_string('clock-separator').trim() !== '';
            separator.sensitive = showSeparator.active;
            syncingSeparator = false;
        };
        showSeparator.connect('notify::active', () => {
            if (syncingSeparator)
                return;
            settings.set_string('clock-separator',
                showSeparator.active ? '  ·  ' : '   ');
        });
        const separatorChangedId = settings.connect(
            'changed::clock-separator', syncSeparator);
        page.connect('destroy', () => settings.disconnect(separatorChangedId));

        const timezones = allTimezones();

        const list = new Adw.PreferencesGroup({
            title: _('Clocks'),
            description: _('Each clock shows its country flag, a name, or both. The name is the city this time zone is named after, unless you give the clock custom text of your own.'),
        });
        page.add(list);
        settings.bind('clocks-enabled', list, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        list.set_header_suffix(addButton);

        /*
         * Ten is a practical ceiling rather than a technical one: past that
         * the strip is wider than any panel, and the drawer stops helping.
         * Zero is perfectly valid -- the widget simply shows nothing.
         */
        const updateAddButton = count => {
            const room = count < MAX_CLOCKS;
            addButton.sensitive = room;
            addButton.tooltip_text = room
                ? _('Add a clock')
                : _('Ten clocks is the maximum');
            list.title = `${_('Clocks')}  (${count}/${MAX_CLOCKS})`;
        };

        /*
         * Rows are rebuilt only on add, remove and reorder. Editing a clock
         * writes straight to settings without a rebuild, so the entry keeps
         * focus while you type.
         */
        let rows = [];
        const entries = settings.get_value('clock-entries').deepUnpack();

        const save = () => settings.set_value(
            'clock-entries', new GLib.Variant('a(sbbs)', entries));

        const rebuild = () => {
            for (const row of rows)
                list.remove(row);
            rows = [];
            updateAddButton(entries.length);

            if (entries.length === 0) {
                const empty = new Adw.ActionRow({
                    title: _('No clocks'),
                    subtitle: _('Use + to add one'),
                });
                list.add(empty);
                rows.push(empty);
                return;
            }

            entries.forEach((entry, index) => {
                const row = new Adw.ExpanderRow({
                    title: clockLabel(entry) || entry[0],
                    subtitle: entry[0],
                });

                const up = makeFlatButton('go-up-symbolic', _('Move earlier'));
                up.sensitive = index > 0;
                up.connect('clicked', () => {
                    [entries[index - 1], entries[index]] =
                        [entries[index], entries[index - 1]];
                    save();
                    rebuild();
                });

                const down = makeFlatButton('go-down-symbolic', _('Move later'));
                down.sensitive = index < entries.length - 1;
                down.connect('clicked', () => {
                    [entries[index + 1], entries[index]] =
                        [entries[index], entries[index + 1]];
                    save();
                    rebuild();
                });

                const remove = makeFlatButton('user-trash-symbolic', _('Remove this clock'));
                remove.connect('clicked', () => {
                    entries.splice(index, 1);
                    save();
                    rebuild();
                });

                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(remove);

                const showFlag = new Adw.SwitchRow({title: _('Show flag')});
                const showCity = new Adw.SwitchRow({title: _('Show name')});
                const customText = new Adw.EntryRow({title: _('Custom text')});
                showFlag.active = entries[index][1];
                showCity.active = entries[index][2];
                customText.text = entries[index][3];

                /*
                 * Every control owns one field of the entry and nothing else
                 * writes back to it, so the row has no way to talk itself into
                 * a loop. Only the summary -- which is what the panel will
                 * actually show -- is recomputed from all of them.
                 */
                const refresh = () => {
                    const zone = entries[index][0];
                    const flag = timezoneFlag(zone);
                    row.title = clockLabel(entries[index]) || zone;
                    showFlag.sensitive = flag !== '';
                    showFlag.subtitle = flag === ''
                        ? _('No flag is known for this time zone')
                        : `${_('The country flag for this time zone')}  ${flag}`;
                    showCity.subtitle = entries[index][3].trim() === ''
                        ? `${_('The city name')}:  ${timezoneLocality(zone)}`
                        : _('Your custom text, below');
                };
                refresh();

                showFlag.connect('notify::active', () => {
                    entries[index][1] = showFlag.active;
                    refresh();
                    save();
                });
                showCity.connect('notify::active', () => {
                    entries[index][2] = showCity.active;
                    refresh();
                    save();
                });
                // Kept whether or not the name is currently shown, so turning
                // the name back on returns the text rather than the city.
                customText.connect('changed', () => {
                    entries[index][3] = customText.text;
                    refresh();
                    save();
                });

                row.add_row(showFlag);
                row.add_row(showCity);
                row.add_row(customText);

                row.add_row(makeTimezoneRow(timezones, entry[0], zone => {
                    entries[index][0] = zone;
                    row.subtitle = zone;
                    refresh();
                    save();
                }));

                list.add(row);
                rows.push(row);
            });
        };

        addButton.connect('clicked', () => {
            if (entries.length >= MAX_CLOCKS)
                return;

            // Start from the machine's own zone: more often right than UTC,
            // and it gives the new row a meaningful title straight away.
            entries.push(makeClockEntry(localTimezone()));
            save();
            rebuild();
            // Open the new row so the clock is ready to edit.
            rows[rows.length - 1].expanded = true;
        });

        rebuild();
        return page;
    }

    /* ---------------------------------------------------------------- weather */

    _weatherPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Weather'),
            icon_name: 'weather-few-clouds-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: _('Display')});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: _('Show weather')});
        settings.bind('weather-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        options.add(makeChoiceRow(settings, 'weather-units', _('Units'), null, [
            {label: _('Celsius'), value: 'metric'},
            {label: _('Fahrenheit'), value: 'imperial'},
        ]));

        const refreshAdjustment = new Gtk.Adjustment({
            lower: 5, upper: 360, step_increment: 5, page_increment: 30,
        });
        bindIntAdjustment(settings, 'weather-refresh-minutes', refreshAdjustment);
        options.add(new Adw.SpinRow({
            title: _('Refresh every'),
            subtitle: _('Minutes between forecast updates'),
            adjustment: refreshAdjustment,
        }));

        /* ------------------------------------------------------------ location */

        const locationGroup = new Adw.PreferencesGroup({
            title: _('Location'),
            description: _('Type a town or city, then pick it from the list. Your location is never looked up from your IP address.'),
        });
        page.add(locationGroup);

        const currentRow = new Adw.ActionRow({title: _('Using')});
        locationGroup.add(currentRow);

        const searchRow = new Adw.EntryRow({title: _('Search for a place')});
        const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER});
        searchRow.add_suffix(spinner);
        locationGroup.add(searchRow);

        const resultsGroup = new Adw.PreferencesGroup();
        page.add(resultsGroup);

        const refreshCurrent = () => {
            const city = settings.get_string('weather-city');
            const lat = settings.get_double('weather-latitude');
            const lon = settings.get_double('weather-longitude');
            currentRow.subtitle = city === ''
                ? _('Not set yet — it will be guessed from your time zone')
                : `${city}  ·  ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        };

        let resultRows = [];
        const clearResults = () => {
            for (const row of resultRows)
                resultsGroup.remove(row);
            resultRows = [];
        };

        const addMessage = title => {
            const row = new Adw.ActionRow({title});
            resultsGroup.add(row);
            resultRows.push(row);
        };

        const showResults = places => {
            clearResults();

            if (places === null) {
                addMessage(_('Could not reach the place lookup service'));
                return;
            }
            if (places.length === 0) {
                addMessage(_('No matching places'));
                return;
            }

            for (const place of places) {
                const row = new Adw.ActionRow({
                    title: place.name,
                    subtitle: describePlace(place),
                    activatable: true,
                });
                row.add_suffix(new Gtk.Image({
                    icon_name: 'go-next-symbolic',
                    valign: Gtk.Align.CENTER,
                }));
                row.connect('activated', () => {
                    settings.set_double('weather-latitude', place.latitude);
                    settings.set_double('weather-longitude', place.longitude);
                    settings.set_string('weather-city', place.name);
                    searchRow.text = '';
                    clearResults();
                    refreshCurrent();
                });
                resultsGroup.add(row);
                resultRows.push(row);
            }
        };

        const session = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        const searchCancellable = new Gio.Cancellable();
        const fetchJson = makeJsonFetcher(session, searchCancellable);

        /*
         * Search as they type, but only once they pause: a request per
         * keystroke would be both wasteful and racy, since replies can arrive
         * out of order and overwrite a newer result with an older one.
         */
        let searchTimeoutId = 0;
        let searchSerial = 0;

        const runSearch = () => {
            const query = searchRow.text.trim();
            if (query.length < 2) {
                clearResults();
                spinner.stop();
                return;
            }

            const serial = ++searchSerial;
            spinner.start();
            geocode(fetchJson, query, places => {
                // A later keystroke already superseded this reply.
                if (serial !== searchSerial)
                    return;
                spinner.stop();
                showResults(places);
            });
        };

        searchRow.connect('changed', () => {
            if (searchTimeoutId !== 0)
                GLib.source_remove(searchTimeoutId);
            searchTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                    searchTimeoutId = 0;
                    runSearch();
                    return GLib.SOURCE_REMOVE;
                });
        });

        // The window outliving a pending timeout would fire into dead widgets.
        page.connect('destroy', () => {
            if (searchTimeoutId !== 0) {
                GLib.source_remove(searchTimeoutId);
                searchTimeoutId = 0;
            }
            searchSerial++;
            searchCancellable.cancel();
        });

        settings.connect('changed::weather-city', refreshCurrent);
        refreshCurrent();
        return page;
    }

    /* ---------------------------------------------------------------- markets */

    _marketsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Markets'),
            icon_name: 'x-office-spreadsheet-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: _('Display')});
        page.add(options);

        const enabled = new Adw.SwitchRow({
            title: _('Show stock and crypto prices'),
            subtitle: _('Off leaves a chart icon in the panel; click it for every price'),
        });
        settings.bind('markets-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        for (const [key, title, subtitle] of [
            ['market-panel-price', _('Show price in panel')],
            ['market-panel-change', _('Show 24-hour change in panel')],
            ['market-graphs-expanded', _('Show graphs in the dropdown'),
                _('Off, click a ticker to unfold its graph')],
        ]) {
            const row = new Adw.SwitchRow(subtitle ? {title, subtitle} : {title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            options.add(row);
        }

        const list = new Adw.PreferencesGroup({
            title: _('Tickers'),
            description: _('Ticked prices show in the panel with their 24-hour change. Every ticker is listed in the dropdown with its 24-hour, 7-day, 1-month and 6-month change.'),
        });
        page.add(list);

        /*
         * Like the clock list, rows are rebuilt only on add, remove and
         * reorder; a checkbox writes straight to settings.
         */
        let rows = [];
        const tickers = settings.get_value('market-symbols').deepUnpack();
        const save = () => settings.set_value(
            'market-symbols', new GLib.Variant('a(ssb)', tickers));

        const rebuild = () => {
            for (const row of rows)
                list.remove(row);
            rows = [];
            list.title = `${_('Tickers')}  (${tickers.length}/${MAX_TICKERS})`;

            if (tickers.length === 0) {
                const empty = new Adw.ActionRow({
                    title: _('No tickers'),
                    subtitle: _('Search below to add a stock or crypto'),
                });
                list.add(empty);
                rows.push(empty);
                return;
            }

            tickers.forEach(([symbol, name], index) => {
                const row = new Adw.ActionRow({
                    title: shortSymbol(symbol),
                    subtitle: name === symbol ? '' : `${name}  ·  ${symbol}`,
                    activatable: true,
                });

                const check = new Gtk.CheckButton({
                    active: tickers[index][2],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Show the price in the panel'),
                });
                check.connect('toggled', () => {
                    tickers[index][2] = check.active;
                    save();
                });
                row.add_prefix(check);
                row.activatable_widget = check;

                const up = makeFlatButton('go-up-symbolic', _('Move earlier'));
                up.sensitive = index > 0;
                up.connect('clicked', () => {
                    [tickers[index - 1], tickers[index]] =
                        [tickers[index], tickers[index - 1]];
                    save();
                    rebuild();
                });

                const down = makeFlatButton('go-down-symbolic', _('Move later'));
                down.sensitive = index < tickers.length - 1;
                down.connect('clicked', () => {
                    [tickers[index + 1], tickers[index]] =
                        [tickers[index], tickers[index + 1]];
                    save();
                    rebuild();
                });

                const remove = makeFlatButton('user-trash-symbolic', _('Remove this ticker'));
                remove.connect('clicked', () => {
                    tickers.splice(index, 1);
                    save();
                    rebuild();
                });

                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(remove);
                list.add(row);
                rows.push(row);
            });
        };

        /* ------------------------------------------------------------ search */

        const searchGroup = new Adw.PreferencesGroup({
            title: _('Add a stock or crypto'),
            description: _('Search by name or symbol, such as Apple, AAPL or Bitcoin, then pick a result. Prices come from Yahoo Finance.'),
        });
        page.add(searchGroup);

        const searchRow = new Adw.EntryRow({title: _('Search')});
        const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER});
        searchRow.add_suffix(spinner);
        searchGroup.add(searchRow);

        const resultsGroup = new Adw.PreferencesGroup();
        page.add(resultsGroup);

        // Tickers stay editable when the panel is off: the dropdown lists them.
        let resultRows = [];
        const clearResults = () => {
            for (const row of resultRows)
                resultsGroup.remove(row);
            resultRows = [];
        };

        const addMessage = title => {
            const row = new Adw.ActionRow({title});
            resultsGroup.add(row);
            resultRows.push(row);
        };

        const typeLabels = {
            EQUITY: _('Stock'),
            ETF: _('ETF'),
            CRYPTOCURRENCY: _('Crypto'),
            INDEX: _('Index'),
            MUTUALFUND: _('Fund'),
        };

        const showResults = results => {
            clearResults();
            if (results === null) {
                addMessage(_('Could not reach Yahoo Finance'));
                return;
            }
            if (results.length === 0) {
                addMessage(_('No matching stocks or crypto'));
                return;
            }

            for (const result of results) {
                const added = tickers.some(t => t[0] === result.symbol);
                const row = new Adw.ActionRow({
                    title: `${result.symbol}  ·  ${result.name}`,
                    subtitle: [typeLabels[result.type], result.exchange]
                        .filter(Boolean).join('  ·  '),
                    activatable: !added,
                });
                row.add_suffix(new Gtk.Image({
                    icon_name: added ? 'object-select-symbolic' : 'list-add-symbolic',
                    valign: Gtk.Align.CENTER,
                }));
                row.connect('activated', () => {
                    if (tickers.length >= MAX_TICKERS ||
                        tickers.some(t => t[0] === result.symbol))
                        return;
                    tickers.push([result.symbol, result.name, true]);
                    save();
                    rebuild();
                    searchRow.text = '';
                    clearResults();
                });
                resultsGroup.add(row);
                resultRows.push(row);
            }
        };

        const session = new Soup.Session({
            timeout: HTTP_TIMEOUT_SECONDS,
            user_agent: USER_AGENT,
        });
        const searchCancellable = new Gio.Cancellable();
        const fetchJson = makeJsonFetcher(session, searchCancellable);

        // Debounced and serialised the same way as the place search.
        let searchTimeoutId = 0;
        let searchSerial = 0;

        const runSearch = () => {
            const query = searchRow.text.trim();
            if (query.length < 1) {
                clearResults();
                spinner.stop();
                return;
            }
            if (tickers.length >= MAX_TICKERS) {
                clearResults();
                addMessage(_('Remove a ticker before adding another'));
                return;
            }

            const serial = ++searchSerial;
            spinner.start();
            searchSymbols(fetchJson, query, results => {
                if (serial !== searchSerial)
                    return;
                spinner.stop();
                showResults(results);
            });
        };

        searchRow.connect('changed', () => {
            if (searchTimeoutId !== 0)
                GLib.source_remove(searchTimeoutId);
            searchTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                    searchTimeoutId = 0;
                    runSearch();
                    return GLib.SOURCE_REMOVE;
                });
        });

        page.connect('destroy', () => {
            if (searchTimeoutId !== 0) {
                GLib.source_remove(searchTimeoutId);
                searchTimeoutId = 0;
            }
            searchSerial++;
            searchCancellable.cancel();
        });

        rebuild();
        return page;
    }

    /* ---------------------------------------------------------------- metrics */

    _metricsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Metrics'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: _('Display')});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: _('Show system metrics')});
        settings.bind('metrics-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        const prefixStyle = new Adw.ComboRow({
            title: _('Reading prefixes'),
            subtitle: _('Choose icons or text labels'),
            model: Gtk.StringList.new([_('Icons'), _('Text')]),
        });
        prefixStyle.selected = settings.get_boolean('metrics-show-labels') ? 0 : 1;
        prefixStyle.connect('notify::selected', () =>
            settings.set_boolean('metrics-show-labels', prefixStyle.selected === 0));
        settings.bind('metrics-enabled', prefixStyle, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
        options.add(prefixStyle);

        const refreshAdjustment = new Gtk.Adjustment({
            lower: 1, upper: 60, step_increment: 1, page_increment: 5,
        });
        bindIntAdjustment(settings, 'metrics-refresh-seconds', refreshAdjustment);
        options.add(new Adw.SpinRow({
            title: _('Sample every'),
            subtitle: _('Seconds between readings'),
            adjustment: refreshAdjustment,
        }));

        const sensors = new Sensors(settings);
        let available = sensors.available();

        const group = new Adw.PreferencesGroup({
            title: _('Show in the panel'),
            description: 'Connected and remembered GPU sensors are listed here. ' +
                'Everything is listed in the widget’s dropdown either way — these switches only choose what is shown inline.',
        });
        page.add(group);

        /*
         * metrics-show is an ordered list, so a switch adds to or removes from
         * it rather than rewriting it: turning something off and back on keeps
         * the rest of the panel order intact.
         */
        const readingsPreview = new Map();
        const current = sensors.sample();

        /*
         * With two or more GPUs, the panel shows one of them: the primary one
         * while connected, otherwise another selected one that is connected.
         */
        let primaryRow = null;
        const rebuildPrimary = () => {
            if (primaryRow)
                options.remove(primaryRow);
            primaryRow = null;
            const gpus = [...new Map(available.filter(def => def.gpuId)
                .map(def => [def.gpuId, def.gpuName])).entries()];
            if (gpus.length < 2)
                return;
            primaryRow = new Adw.ComboRow({
                title: _('Primary GPU'),
                subtitle: _('Shown in the panel when connected; otherwise another selected GPU is'),
                model: Gtk.StringList.new(gpus.map(([, name]) => name)),
            });
            const index = gpus.findIndex(([id]) => id === settings.get_string('metrics-primary-gpu'));
            primaryRow.selected = Math.max(index, 0);
            if (index < 0)
                settings.set_string('metrics-primary-gpu', gpus[0][0]);
            primaryRow.connect('notify::selected', () =>
                settings.set_string('metrics-primary-gpu', gpus[primaryRow.selected]?.[0] ?? ''));
            options.add(primaryRow);
        };

        const rebuildRows = current => {
            for (const row of readingsPreview.values())
                group.remove(row);
            readingsPreview.clear();
            for (const def of available) {
                const check = new Gtk.CheckButton({
                    active: settings.get_strv('metrics-show').includes(def.id),
                    valign: Gtk.Align.CENTER,
                });

                const row = new Adw.ActionRow({
                    title: def.gpuName ? `${_(def.title)}: ${def.gpuName}` : _(def.title),
                    subtitle: current[def.id]?.disconnected ? _('Disconnected') : current[def.id]?.detail ?? '',
                    activatable: true,
                });
                row.add_prefix(check);
                // Makes the whole row a hit target for the checkbox.
                row.activatable_widget = check;

                check.connect('toggled', () => {
                    const shown = settings.get_strv('metrics-show');
                    const index = shown.indexOf(def.id);
                    if (check.active && index === -1)
                        shown.push(def.id);
                    else if (!check.active && index !== -1)
                        shown.splice(index, 1);
                    settings.set_strv('metrics-show', shown);
                });

                group.add(row);
                readingsPreview.set(def.id, row);
            }
            rebuildPrimary();
        };
        rebuildRows(current);

        /*
         * Choosing which readings to show is meaningless while the widget
         * itself is off, so the whole selection follows the master switch.
         */
        settings.bind('metrics-enabled', group, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);

        // A live preview makes it obvious which sensor is which.
        const previewId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            const readings = sensors.sample();
            const updated = sensors.available();
            if (JSON.stringify(updated) !== JSON.stringify(available)) {
                available = updated;
                rebuildRows(readings);
            }
            for (const [id, row] of readingsPreview) {
                if (readings[id])
                    row.subtitle = readings[id].disconnected ? _('Disconnected') : readings[id].detail;
            }
            return GLib.SOURCE_CONTINUE;
        });
        page.connect('destroy', () => {
            GLib.source_remove(previewId);
            sensors.destroy();
        });

        const diskGroup = new Adw.PreferencesGroup({title: _('Free space')});
        page.add(diskGroup);
        settings.bind('metrics-enabled', diskGroup, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);

        const mounts = listMountPoints();
        const mountRow = new Adw.ComboRow({
            title: _('Report free space on'),
            model: Gtk.StringList.new(mounts),
        });
        const currentMount = mounts.indexOf(settings.get_string('metrics-disk-mount'));
        mountRow.selected = currentMount === -1 ? 0 : currentMount;
        mountRow.connect('notify::selected',
            () => settings.set_string('metrics-disk-mount', mounts[mountRow.selected]));
        diskGroup.add(mountRow);

        return page;
    }
}
