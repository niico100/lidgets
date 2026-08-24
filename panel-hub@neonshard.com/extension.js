/*
 * Panel Hub -- world clocks, weather and system metrics in one extension.
 *
 * Each widget is an independent panel indicator so it can be toggled, ordered
 * and collapsed on its own. The drawer folds whichever ones exist into a single
 * button when the panel runs out of room.
 */

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClocksIndicator} from './lib/clocks.js';
import {WeatherIndicator} from './lib/weather.js';
import {MetricsIndicator} from './lib/metrics.js';
import {RemoteBanner} from './lib/remote.js';
import {Drawer} from './lib/drawer.js';

/*
 * Widgets are added left to right in this order. The role is what claims the
 * slot in Main.panel.statusArea, so it has to be stable and unique.
 */
const WIDGETS = [
    {key: 'clocks-enabled', role: 'panel-hub-clocks', ctor: ClocksIndicator},
    {key: 'weather-enabled', role: 'panel-hub-weather', ctor: WeatherIndicator},
    {key: 'metrics-enabled', role: 'panel-hub-metrics', ctor: MetricsIndicator},
];

/*
 * Changing any of these changes which actors exist, so the whole set is torn
 * down and rebuilt. Everything else is handled inside the widgets themselves,
 * which update in place without a rebuild.
 */
const STRUCTURAL_KEYS = [
    'master-enabled', 'panel-box', 'panel-index', 'remote-enabled',
    ...WIDGETS.map(w => w.key),
];

export default class PanelHubExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicators = [];
        this._drawer = null;
        this._remote = null;

        this._seedClocks();

        this._settingsIds = STRUCTURAL_KEYS.map(
            key => this._settings.connect(`changed::${key}`, () => this._rebuild()));

        this._build();
    }

    disable() {
        this._teardown();

        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._settings = null;
    }

    /*
     * A GSettings default has to be a fixed literal, so it cannot be "whatever
     * time zone this machine is set to". Seed that once on first run instead.
     *
     * The separate seeded flag is what distinguishes "never configured" from
     * "the user deleted every clock" -- without it, removing the last clock
     * would silently bring one back on the next login.
     */
    _seedClocks() {
        if (this._settings.get_boolean('clocks-seeded'))
            return;

        let zone;
        try {
            zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
            zone = null;
        }

        if (zone) {
            // "America/Los_Angeles" -> "Los Angeles"
            const label = zone.split('/').pop().replace(/_/g, ' ');
            this._settings.set_value('clocks',
                new GLib.Variant('a(ss)', [[label, zone]]));
        }

        this._settings.set_boolean('clocks-seeded', true);
    }

    _rebuild() {
        this._teardown();
        this._build();
    }

    _build() {
        if (!this._settings.get_boolean('master-enabled'))
            return;

        /*
         * If a widget constructor throws, the shell would otherwise park the
         * extension in ERROR without calling disable(), stranding whatever was
         * already added in statusArea and making every later enable fail with
         * an extension point conflict. Undo our own work instead.
         */
        try {
            this._buildWidgets();
        } catch (e) {
            this._teardown();
            throw e;
        }
    }

    _buildWidgets() {
        const box = this._settings.get_string('panel-box');
        const baseIndex = this._settings.get_int('panel-index');

        let offset = 0;
        for (const widget of WIDGETS) {
            if (!this._settings.get_boolean(widget.key))
                continue;

            // Reclaim the role if a previous run died before releasing it.
            const stale = Main.panel.statusArea[widget.role];
            if (stale)
                stale.destroy();

            const indicator = new widget.ctor(this._settings, this.path);
            Main.panel.addToStatusArea(
                widget.role, indicator, baseIndex + offset, box);
            this._indicators.push(indicator);
            offset++;
        }

        if (this._settings.get_boolean('remote-enabled'))
            this._remote = new RemoteBanner();

        // Built last so the indicators it collapses already exist.
        this._drawer = new Drawer(this._settings, () => this._indicators);
    }

    _teardown() {
        // The drawer holds reparented indicators, so it must put them back
        // before anything else destroys them.
        this._drawer?.destroy();
        this._drawer = null;

        this._remote?.destroy();
        this._remote = null;

        for (const indicator of this._indicators ?? [])
            indicator.destroy();
        this._indicators = [];
    }
}
