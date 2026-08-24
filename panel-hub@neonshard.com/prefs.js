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

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Sensors, listMountPoints} from './lib/sensors.js';
import {geocode, makeJsonFetcher, describePlace} from './lib/geocode.js';

/*
 * Long enough that ordinary typing produces one request rather than one per
 * letter, short enough that the list still feels like it follows the keyboard.
 */
const SEARCH_DEBOUNCE_MS = 400;

/*
 * A practical ceiling, not a technical one: beyond ten the strip is wider
 * than any panel and folding it away stops helping. Zero is valid.
 */
const MAX_CLOCKS = 10;

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
        title: _('Time zone'),
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
            ['metrics-enabled', _('System metrics'), _('CPU, GPU, memory, disk and more')],
            ['remote-enabled', _('Remote desktop banner'),
                _('A red warning while RDP or VNC is accepting connections')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            // The master switch gates everything, so grey these out when it is off.
            settings.bind('master-enabled', row, 'sensitive',
                Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);
            widgets.add(row);
        }

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

        const separator = new Adw.EntryRow({title: _('Separator between clocks')});
        settings.bind('clock-separator', separator, 'text', Gio.SettingsBindFlags.DEFAULT);
        options.add(separator);

        const timezones = allTimezones();

        const list = new Adw.PreferencesGroup({
            title: _('Clocks'),
            description: _('The label is free text, so a flag emoji, a city name, or nothing at all all work.'),
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
            updateAddButton(clocks.length);

            if (clocks.length === 0) {
                const empty = new Adw.ActionRow({
                    title: _('No clocks'),
                    subtitle: _('Use + to add one'),
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

                const up = makeFlatButton('go-up-symbolic', _('Move earlier'));
                up.sensitive = index > 0;
                up.connect('clicked', () => {
                    [clocks[index - 1], clocks[index]] =
                        [clocks[index], clocks[index - 1]];
                    save();
                    rebuild();
                });

                const down = makeFlatButton('go-down-symbolic', _('Move later'));
                down.sensitive = index < clocks.length - 1;
                down.connect('clicked', () => {
                    [clocks[index + 1], clocks[index]] =
                        [clocks[index], clocks[index + 1]];
                    save();
                    rebuild();
                });

                const remove = makeFlatButton('user-trash-symbolic', _('Remove this clock'));
                remove.connect('clicked', () => {
                    clocks.splice(index, 1);
                    save();
                    rebuild();
                });

                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(remove);

                const label = new Adw.EntryRow({title: _('Label')});
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
            if (clocks.length >= MAX_CLOCKS)
                return;

            // Start from the machine's own zone: more often right than UTC,
            // and it gives the new row a meaningful title straight away.
            const zone = localTimezone();
            clocks.push([zone.split('/').pop().replace(/_/g, ' '), zone]);
            save();
            rebuild();
            // Open the new row so the label and zone are ready to edit.
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

        const session = new Soup.Session();
        const fetchJson = makeJsonFetcher(session, null);

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
        });

        settings.connect('changed::weather-city', refreshCurrent);
        refreshCurrent();
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

        const sensors = new Sensors();
        const available = sensors.available();

        const group = new Adw.PreferencesGroup({
            title: _('Show in the panel'),
            description: `Detected ${available.length} sensors on this machine. ` +
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

        for (const def of available) {
            const check = new Gtk.CheckButton({
                active: settings.get_strv('metrics-show').includes(def.id),
                valign: Gtk.Align.CENTER,
            });

            const row = new Adw.ActionRow({
                title: _(def.title),
                subtitle: current[def.id]?.detail ?? '',
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

        /*
         * Choosing which readings to show is meaningless while the widget
         * itself is off, so the whole selection follows the master switch.
         */
        settings.bind('metrics-enabled', group, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.NO_SENSITIVITY);

        // A live preview makes it obvious which sensor is which.
        const previewId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            const readings = sensors.sample();
            for (const [id, row] of readingsPreview) {
                if (readings[id])
                    row.subtitle = readings[id].detail;
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
