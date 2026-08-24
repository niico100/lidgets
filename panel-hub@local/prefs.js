/*
 * Panel Hub preferences.
 *
 * The metrics page is built from the sensors this machine actually exposes,
 * so it never offers a switch for a reading that would only ever show "--".
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Sensors, listMountPoints} from './lib/sensors.js';

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
    try {
        const zones = Intl.supportedValuesOf('timeZone');
        if (Array.isArray(zones) && zones.length > 0)
            return zones;
    } catch {
        // Older SpiderMonkey without supportedValuesOf.
    }
    return FALLBACK_TIMEZONES;
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
        title: 'Time zone',
        model: Gtk.StringList.new(timezones),
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

export default class PanelHubPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(760, 820);
        window.search_enabled = true;

        window.add(this._generalPage(settings));
        window.add(this._clocksPage(settings));
        window.add(this._weatherPage(settings));
        window.add(this._metricsPage(settings));
    }

    /* ---------------------------------------------------------------- general */

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const main = new Adw.PreferencesGroup({
            title: 'Panel Hub',
            description: 'Turn the whole set of widgets on or off, and choose where they sit.',
        });
        page.add(main);

        const master = new Adw.SwitchRow({
            title: 'Show Panel Hub',
            subtitle: 'Master switch for every widget below',
        });
        settings.bind('master-enabled', master, 'active', Gio.SettingsBindFlags.DEFAULT);
        main.add(master);

        const widgets = new Adw.PreferencesGroup({
            title: 'Widgets',
            description: 'Each widget is a separate item in the panel.',
        });
        page.add(widgets);

        for (const [key, title, subtitle] of [
            ['clocks-enabled', 'World clocks', 'Times for the zones you follow'],
            ['weather-enabled', 'Weather', 'Current conditions and an 8-hour forecast'],
            ['metrics-enabled', 'System metrics', 'CPU, GPU, memory, disk and more'],
            ['remote-enabled', 'Remote desktop banner',
                'A red warning while RDP or VNC is accepting connections'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            // The master switch gates everything, so grey these out when it is off.
            settings.bind('master-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
            widgets.add(row);
        }

        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        page.add(placement);

        placement.add(makeChoiceRow(settings, 'panel-box', 'Panel area', null, [
            {label: 'Right', value: 'right'},
            {label: 'Centre', value: 'center'},
            {label: 'Left', value: 'left'},
        ]));

        const indexAdjustment = new Gtk.Adjustment({
            lower: 0, upper: 20, step_increment: 1, page_increment: 1,
        });
        bindIntAdjustment(settings, 'panel-index', indexAdjustment);
        placement.add(new Adw.SpinRow({
            title: 'Position',
            subtitle: 'Lower numbers sit further to the left within that area',
            adjustment: indexAdjustment,
        }));

        const drawer = new Adw.PreferencesGroup({
            title: 'When space is tight',
            description: 'The widgets can fold into a single drawer button. ' +
                'They keep running while collapsed.',
        });
        page.add(drawer);

        const modeRow = makeChoiceRow(settings, 'drawer-mode',
            'Collapse into a drawer', null, [
                {label: 'When the widgets would not fit', value: 'auto'},
                {label: 'When the screen is narrower than a set width', value: 'width'},
                {label: 'Always', value: 'always'},
                {label: 'Never', value: 'never'},
            ]);
        drawer.add(modeRow);

        const fractionAdjustment = new Gtk.Adjustment({
            lower: 10, upper: 80, step_increment: 5, page_increment: 10,
        });
        bindIntAdjustment(settings, 'drawer-space-fraction', fractionAdjustment);
        const fractionRow = new Adw.SpinRow({
            title: 'Fold once the widgets exceed',
            subtitle: 'Percent of the panel width. Measured against the widgets ' +
                'themselves, so it follows both the screen and how many are on.',
            adjustment: fractionAdjustment,
        });
        drawer.add(fractionRow);

        const widthAdjustment = new Gtk.Adjustment({
            lower: 640, upper: 7680, step_increment: 32, page_increment: 128,
        });
        bindIntAdjustment(settings, 'drawer-max-width', widthAdjustment);
        const widthRow = new Adw.SpinRow({
            title: 'Collapse below this width',
            subtitle: 'Logical pixels on the monitor holding the panel',
            adjustment: widthAdjustment,
        });
        drawer.add(widthRow);

        // Only one of the two thresholds applies at a time; grey out the other.
        const syncThresholdRows = () => {
            const mode = settings.get_string('drawer-mode');
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
            title: 'Clocks',
            icon_name: 'preferences-system-time-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: 'Display'});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: 'Show world clocks'});
        settings.bind('clocks-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        const format = new Adw.SwitchRow({
            title: '24-hour clock',
            subtitle: 'Off shows am/pm',
        });
        settings.bind('clock-24h', format, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(format);

        const separator = new Adw.EntryRow({title: 'Separator between clocks'});
        settings.bind('clock-separator', separator, 'text', Gio.SettingsBindFlags.DEFAULT);
        options.add(separator);

        const timezones = allTimezones();

        const list = new Adw.PreferencesGroup({
            title: 'Clocks',
            description: 'The label is free text, so a flag emoji, a city name, ' +
                'or nothing at all all work.',
        });
        page.add(list);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add a clock',
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        list.set_header_suffix(addButton);

        /*
         * Rows are rebuilt only on add, remove and reorder. Editing a label
         * writes straight to settings without a rebuild, so the entry keeps
         * focus while you type.
         */
        let rows = [];
        const clocks = settings.get_value('clocks').deepUnpack();

        const save = () => settings.set_value(
            'clocks', new GLib.Variant('a(ss)', clocks));

        const rebuild = () => {
            for (const row of rows)
                list.remove(row);
            rows = [];

            if (clocks.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No clocks',
                    subtitle: 'Use + to add one',
                });
                list.add(empty);
                rows.push(empty);
                return;
            }

            clocks.forEach((clock, index) => {
                const row = new Adw.ExpanderRow({
                    title: clock[0] || clock[1],
                    subtitle: clock[1],
                });

                const up = makeFlatButton('go-up-symbolic', 'Move earlier');
                up.sensitive = index > 0;
                up.connect('clicked', () => {
                    [clocks[index - 1], clocks[index]] =
                        [clocks[index], clocks[index - 1]];
                    save();
                    rebuild();
                });

                const down = makeFlatButton('go-down-symbolic', 'Move later');
                down.sensitive = index < clocks.length - 1;
                down.connect('clicked', () => {
                    [clocks[index + 1], clocks[index]] =
                        [clocks[index], clocks[index + 1]];
                    save();
                    rebuild();
                });

                const remove = makeFlatButton('user-trash-symbolic', 'Remove this clock');
                remove.connect('clicked', () => {
                    clocks.splice(index, 1);
                    save();
                    rebuild();
                });

                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(remove);

                const label = new Adw.EntryRow({title: 'Label'});
                label.text = clock[0];
                label.connect('changed', () => {
                    clocks[index][0] = label.text;
                    row.title = label.text || clocks[index][1];
                    save();
                });
                row.add_row(label);

                row.add_row(makeTimezoneRow(timezones, clock[1], zone => {
                    clocks[index][1] = zone;
                    row.subtitle = zone;
                    if (!clocks[index][0])
                        row.title = zone;
                    save();
                }));

                list.add(row);
                rows.push(row);
            });
        };

        addButton.connect('clicked', () => {
            clocks.push(['', 'UTC']);
            save();
            rebuild();
            rows[rows.length - 1].expanded = true;
        });

        rebuild();
        return page;
    }

    /* ---------------------------------------------------------------- weather */

    _weatherPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Weather',
            icon_name: 'weather-few-clouds-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: 'Display'});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: 'Show weather'});
        settings.bind('weather-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        options.add(makeChoiceRow(settings, 'weather-units', 'Units', null, [
            {label: 'Celsius', value: 'metric'},
            {label: 'Fahrenheit', value: 'imperial'},
        ]));

        const showCity = new Adw.SwitchRow({
            title: 'Show the place name in the panel',
        });
        settings.bind('weather-show-city', showCity, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        options.add(showCity);

        const refreshAdjustment = new Gtk.Adjustment({
            lower: 5, upper: 360, step_increment: 5, page_increment: 30,
        });
        bindIntAdjustment(settings, 'weather-refresh-minutes', refreshAdjustment);
        options.add(new Adw.SpinRow({
            title: 'Refresh every',
            subtitle: 'Minutes between forecast updates',
            adjustment: refreshAdjustment,
        }));

        const locationGroup = new Adw.PreferencesGroup({title: 'Location'});
        page.add(locationGroup);

        const modeRow = makeChoiceRow(settings, 'weather-location-mode',
            'Find my location', null, [
                {label: 'Automatically, from my IP address', value: 'auto'},
                {label: 'Use the place set below', value: 'manual'},
            ]);
        locationGroup.add(modeRow);

        const currentRow = new Adw.ActionRow({title: 'Current place'});
        locationGroup.add(currentRow);

        const latAdjustment = new Gtk.Adjustment({
            lower: -90, upper: 90, step_increment: 0.01, page_increment: 1,
        });
        const lonAdjustment = new Gtk.Adjustment({
            lower: -180, upper: 180, step_increment: 0.01, page_increment: 1,
        });

        const refreshCurrent = () => {
            const city = settings.get_string('weather-city');
            const lat = settings.get_double('weather-latitude');
            const lon = settings.get_double('weather-longitude');
            const manual = settings.get_string('weather-location-mode') === 'manual';

            currentRow.subtitle = manual
                ? `${city || 'Unnamed place'}  ·  ${lat.toFixed(3)}, ${lon.toFixed(3)}`
                : 'Detected from your IP address each time the forecast refreshes';
            searchGroup.sensitive = manual;
            coordsGroup.sensitive = manual;
        };

        const searchGroup = new Adw.PreferencesGroup({
            title: 'Search for a place',
            description: 'Names are looked up with Open-Meteo’s geocoder.',
        });
        page.add(searchGroup);

        const searchRow = new Adw.EntryRow({title: 'Town or city'});
        const searchButton = new Gtk.Button({
            icon_name: 'system-search-symbolic',
            tooltip_text: 'Search',
            valign: Gtk.Align.CENTER,
        });
        searchButton.add_css_class('flat');
        searchRow.add_suffix(searchButton);
        searchGroup.add(searchRow);

        const resultsGroup = new Adw.PreferencesGroup();
        page.add(resultsGroup);

        const coordsGroup = new Adw.PreferencesGroup({
            title: 'Coordinates',
            description: 'Set directly if you would rather not search.',
        });
        page.add(coordsGroup);

        const nameRow = new Adw.EntryRow({title: 'Place name'});
        settings.bind('weather-city', nameRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        coordsGroup.add(nameRow);

        latAdjustment.set_value(settings.get_double('weather-latitude'));
        latAdjustment.connect('value-changed', () => {
            settings.set_double('weather-latitude', latAdjustment.get_value());
            refreshCurrent();
        });
        coordsGroup.add(new Adw.SpinRow({
            title: 'Latitude', adjustment: latAdjustment, digits: 4,
        }));

        lonAdjustment.set_value(settings.get_double('weather-longitude'));
        lonAdjustment.connect('value-changed', () => {
            settings.set_double('weather-longitude', lonAdjustment.get_value());
            refreshCurrent();
        });
        coordsGroup.add(new Adw.SpinRow({
            title: 'Longitude', adjustment: lonAdjustment, digits: 4,
        }));

        let resultRows = [];
        const clearResults = () => {
            for (const row of resultRows)
                resultsGroup.remove(row);
            resultRows = [];
        };

        const showResults = results => {
            clearResults();

            if (results === null) {
                const row = new Adw.ActionRow({
                    title: 'Search failed',
                    subtitle: 'Could not reach the geocoding service',
                });
                resultsGroup.add(row);
                resultRows.push(row);
                return;
            }
            if (results.length === 0) {
                const row = new Adw.ActionRow({title: 'No matches'});
                resultsGroup.add(row);
                resultRows.push(row);
                return;
            }

            for (const place of results) {
                const where = [place.admin1, place.country]
                    .filter(Boolean).join(', ');
                const row = new Adw.ActionRow({
                    title: place.name,
                    subtitle: `${where}  ·  ${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`,
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
                    settings.set_string('weather-location-mode', 'manual');
                    modeRow.selected = 1;
                    latAdjustment.set_value(place.latitude);
                    lonAdjustment.set_value(place.longitude);
                    clearResults();
                    refreshCurrent();
                });
                resultsGroup.add(row);
                resultRows.push(row);
            }
        };

        const session = new Soup.Session();
        const runSearch = () => {
            const query = searchRow.text.trim();
            if (query === '') {
                clearResults();
                return;
            }

            const url = 'https://geocoding-api.open-meteo.com/v1/search' +
                `?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
            const message = Soup.Message.new('GET', url);
            session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    try {
                        const bytes = source.send_and_read_finish(result);
                        if (message.get_status() !== Soup.Status.OK) {
                            showResults(null);
                            return;
                        }
                        const text = new TextDecoder('utf-8')
                            .decode(bytes.get_data());
                        showResults(JSON.parse(text).results ?? []);
                    } catch {
                        showResults(null);
                    }
                });
        };

        searchButton.connect('clicked', runSearch);
        searchRow.connect('entry-activated', runSearch);
        modeRow.connect('notify::selected', refreshCurrent);
        settings.connect('changed::weather-city', refreshCurrent);

        refreshCurrent();
        return page;
    }

    /* ---------------------------------------------------------------- metrics */

    _metricsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Metrics',
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const options = new Adw.PreferencesGroup({title: 'Display'});
        page.add(options);

        const enabled = new Adw.SwitchRow({title: 'Show system metrics'});
        settings.bind('metrics-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        options.add(enabled);

        const labels = new Adw.SwitchRow({
            title: 'Label each reading',
            subtitle: 'Shows "CPU 12%" rather than just "12%"',
        });
        settings.bind('metrics-show-labels', labels, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        options.add(labels);

        const refreshAdjustment = new Gtk.Adjustment({
            lower: 1, upper: 60, step_increment: 1, page_increment: 5,
        });
        bindIntAdjustment(settings, 'metrics-refresh-seconds', refreshAdjustment);
        options.add(new Adw.SpinRow({
            title: 'Sample every',
            subtitle: 'Seconds between readings',
            adjustment: refreshAdjustment,
        }));

        const sensors = new Sensors();
        const available = sensors.available();

        const group = new Adw.PreferencesGroup({
            title: 'Show in the panel',
            description: `Detected ${available.length} sensors on this machine. ` +
                'Everything is listed in the widget’s dropdown either way — ' +
                'these switches only choose what is shown inline.',
        });
        page.add(group);

        /*
         * metrics-show is an ordered list, so a switch adds to or removes from
         * it rather than rewriting it: turning something off and back on keeps
         * the rest of the panel order intact.
         */
        const readingsPreview = new Map();
        const current = sensors.sample();

        for (const def of available) {
            const row = new Adw.SwitchRow({
                title: def.title,
                subtitle: current[def.id]?.detail ?? '',
            });
            row.active = settings.get_strv('metrics-show').includes(def.id);
            row.connect('notify::active', () => {
                const shown = settings.get_strv('metrics-show');
                const index = shown.indexOf(def.id);
                if (row.active && index === -1)
                    shown.push(def.id);
                else if (!row.active && index !== -1)
                    shown.splice(index, 1);
                settings.set_strv('metrics-show', shown);
            });
            group.add(row);
            readingsPreview.set(def.id, row);
        }

        // A live preview makes it obvious which sensor is which.
        const previewId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            const readings = sensors.sample();
            for (const [id, row] of readingsPreview) {
                if (readings[id])
                    row.subtitle = readings[id].detail;
            }
            return GLib.SOURCE_CONTINUE;
        });
        page.connect('destroy', () => GLib.source_remove(previewId));

        const diskGroup = new Adw.PreferencesGroup({title: 'Free space'});
        page.add(diskGroup);

        const mounts = listMountPoints();
        const mountRow = new Adw.ComboRow({
            title: 'Report free space on',
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
