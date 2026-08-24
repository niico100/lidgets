/*
 * System metrics indicator.
 *
 * The panel shows only the metrics selected in prefs; the dropdown always
 * lists every sensor this machine has, so the panel can stay short without
 * losing access to the rest.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Sensors, METRIC_DEFS} from './sensors.js';

export const MetricsIndicator = GObject.registerClass(
class MetricsIndicator extends PanelMenu.Button {
    _init(settings, extensionPath) {
        super._init(0.0, _('System Metrics'), false);

        this._settings = settings;
        this._sensors = new Sensors();
        this._available = this._sensors.available();
        this._tickId = 0;
        this._detailLabels = new Map();
        this._panelLabels = new Map();
        this._iconPath = GLib.build_filenamev([extensionPath, 'icons']);

        this._sensors.setDiskMount(settings.get_string('metrics-disk-mount'));

        this._panelBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-hub-metrics',
        });
        this.add_child(this._panelBox);

        this._rebuildPanel();

        this._settingsIds = [
            settings.connect('changed::metrics-show', () => {
                this._rebuildPanel();
                this._tick();
            }),
            settings.connect('changed::metrics-show-labels', () => {
                this._rebuildPanel();
                this._tick();
            }),
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

    _rebuildPanel() {
        this._panelBox.destroy_all_children();
        this._panelLabels.clear();

        const selected = this._settings.get_strv('metrics-show');
        const useSymbols = this._settings.get_boolean('metrics-show-labels');

        for (const id of selected) {
            const def = METRIC_DEFS.find(candidate => candidate.id === id);
            if (!def || !this._available.some(candidate => candidate.id === id))
                continue;

            const metric = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-hub-metric',
            });

            if (useSymbols) {
                const iconFile = Gio.File.new_for_path(
                    GLib.build_filenamev([this._iconPath, def.icon]));
                metric.add_child(new St.Icon({
                    gicon: new Gio.FileIcon({file: iconFile}),
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'system-status-icon panel-hub-metric-icon',
                }));
            }

            const label = new St.Label({
                text: useSymbols ? '--' : `${def.name} --`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            metric.add_child(label);
            this._panelBox.add_child(metric);
            this._panelLabels.set(id, {label, def});
        }

        if (this._panelLabels.size === 0) {
            this._panelBox.add_child(new St.Label({
                text: '⋯',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
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
                _('No sensors detected'), {reactive: false}));
            return;
        }

        for (const def of this._available) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const row = new St.BoxLayout({x_expand: true});
            row.add_child(new St.Label({
                text: _(def.title),
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

        // Keep the established boolean key so existing settings remain valid:
        // true selects symbols and false selects text.
        const useSymbols = this._settings.get_boolean('metrics-show-labels');

        for (const [id, {label, def}] of this._panelLabels) {
            const reading = readings[id];
            if (!reading)
                continue;
            label.text = useSymbols
                ? reading.short
                : `${def.name} ${reading.short}`;
        }

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
        this._panelLabels.clear();
    }
});
