/*
 * System metrics indicator.
 *
 * The panel shows only the metrics selected in prefs; the dropdown always
 * lists every sensor this machine has, so the panel can stay short without
 * losing access to the rest.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Sensors, METRIC_DEFS} from './sensors.js';

export const MetricsIndicator = GObject.registerClass(
class MetricsIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'System Metrics', false);

        this._settings = settings;
        this._sensors = new Sensors();
        this._available = this._sensors.available();
        this._tickId = 0;
        this._detailLabels = new Map();

        this._sensors.setDiskMount(settings.get_string('metrics-disk-mount'));

        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-hub-label',
        });
        this.add_child(this._label);

        this._settingsIds = [
            settings.connect('changed::metrics-show', () => this._tick()),
            settings.connect('changed::metrics-show-labels', () => this._tick()),
            settings.connect('changed::metrics-disk-mount', () => {
                this._sensors.setDiskMount(settings.get_string('metrics-disk-mount'));
                this._tick();
            }),
            settings.connect('changed::metrics-refresh-seconds',
                () => this._restartTimer()),
        ];

        this.connect('destroy', () => this._onDestroy());

        this._buildMenu();

        /*
         * CPU and network are rate metrics, so the first sample only seeds the
         * counters. Prime them here so the first visible tick has real numbers.
         */
        this._sensors.sample();
        this._tick();
        this._restartTimer();
    }

    _restartTimer() {
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        const seconds = this._settings.get_int('metrics-refresh-seconds');
        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, seconds, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _buildMenu() {
        this.menu.removeAll();
        this._detailLabels.clear();

        if (this._available.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No sensors detected', {reactive: false}));
            return;
        }

        for (const def of this._available) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const row = new St.BoxLayout({x_expand: true});
            row.add_child(new St.Label({
                text: def.title,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const value = new St.Label({
                text: '--',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: bold; padding-left: 24px;',
            });
            row.add_child(value);

            item.add_child(row);
            this.menu.addMenuItem(item);
            this._detailLabels.set(def.id, value);
        }
    }

    _tick() {
        const readings = this._sensors.sample();

        const selected = this._settings.get_strv('metrics-show');
        const showLabels = this._settings.get_boolean('metrics-show-labels');

        const parts = [];
        for (const id of selected) {
            const reading = readings[id];
            if (!reading)
                continue;
            const def = METRIC_DEFS.find(d => d.id === id);
            parts.push(showLabels && def
                ? `${def.name} ${reading.short}`
                : reading.short);
        }

        this._label.text = parts.length > 0 ? parts.join('   ') : '⋯';

        for (const [id, label] of this._detailLabels) {
            if (readings[id])
                label.text = readings[id].detail;
        }
    }

    _onDestroy() {
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._detailLabels.clear();
    }
});
