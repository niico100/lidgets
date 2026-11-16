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

import {Sensors, formatBytes} from './sensors.js';
import {ProcessSampler} from './processes.js';

// GPU readings under each device's name, in this order.
const GPU_ORDER = ['gpu', 'vram', 'gpu-temp', 'gpu-freq'];
const N_ = text => text;
const TOP_APPS = 5;
const GPU_LABELS = {gpu: N_('Load'), vram: N_('RAM'), 'gpu-temp': N_('Temp'), 'gpu-freq': N_('Clock')};

export const MetricsIndicator = GObject.registerClass(
class MetricsIndicator extends PanelMenu.Button {
    _init(settings, extensionPath) {
        super._init(0.0, _('System Metrics'), false);

        this._settings = settings;
        this._sensors = new Sensors(settings);
        this._available = this._sensors.available();
        this._tickId = 0;
        this._detailLabels = new Map();
        this._gpuItems = new Map();
        this._panelLabels = new Map();
        this._iconPath = GLib.build_filenamev([extensionPath, 'icons']);

        this._sensors.setDiskMount(settings.get_string('metrics-disk-mount'));

        this._panelBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-metrics',
        });
        this.add_child(this._panelBox);

        this._rebuildPanel();

        this._settingsIds = [
            settings.connect('changed::metrics-show', () => {
                this._rebuildPanel();
                this._tick();
            }),
            settings.connect('changed::metrics-primary-gpu', () => this._tick()),
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

        // CPU use needs two samples, so take one on open and another a second later.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (this._topId) {
                GLib.source_remove(this._topId);
                this._topId = 0;
            }
            if (!open)
                return;
            this._updateTopApps();
            this._topId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._topId = 0;
                this._updateTopApps();
                return GLib.SOURCE_REMOVE;
            });
        });

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

        // Preferences only write known ids, but external settings edits can
        // contain duplicates or an arbitrarily long list. At most one actor
        // per metric definition can ever be useful.
        const selected = [...new Set(this._settings.get_strv('metrics-show'))]
            .slice(0, this._available.length);
        const useSymbols = this._settings.get_boolean('metrics-show-labels');

        for (const id of selected) {
            const def = this._available.find(candidate => candidate.id === id);
            if (!def)
                continue;

            const metric = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'lidgets-metric',
            });

            if (useSymbols) {
                const iconFile = Gio.File.new_for_path(
                    GLib.build_filenamev([this._iconPath, def.icon]));
                metric.add_child(new St.Icon({
                    gicon: new Gio.FileIcon({file: iconFile}),
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'system-status-icon lidgets-metric-icon',
                }));
            }

            const label = new St.Label({
                text: useSymbols ? '--' : `${def.label ?? def.name} --`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            metric.add_child(label);
            this._panelBox.add_child(metric);
            this._panelLabels.set(id, {label, def, metric});
        }

        // Keep the dropdown reachable if every selected GPU is unplugged.
        this._emptyLabel = new St.Label({
            text: '⋯',
            y_align: Clutter.ActorAlign.CENTER,
            visible: this._panelLabels.size === 0,
        });
        this._panelBox.add_child(this._emptyLabel);
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
        this._gpuItems = new Map();

        if (this._available.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('No sensors detected'), {reactive: false}));
            return;
        }

        for (const def of this._available.filter(d => !d.gpuId))
            this._addDetailRow(_(def.title), def.id);

        // One block per GPU: its full name, then each reading on its own row.
        const gpus = new Map();
        for (const def of this._available.filter(d => d.gpuId)) {
            if (!gpus.has(def.gpuId))
                gpus.set(def.gpuId, []);
            gpus.get(def.gpuId).push(def);
        }
        if (gpus.size > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('GPUs')));
        for (const [gpuId, defs] of gpus) {
            const heading = new PopupMenu.PopupMenuItem(defs[0].gpuName,
                {reactive: false, can_focus: false});
            heading.label.style = 'font-weight: bold;';
            this.menu.addMenuItem(heading);
            const items = [heading];
            defs.sort((a, b) => GPU_ORDER.indexOf(a.type) - GPU_ORDER.indexOf(b.type));
            for (const def of defs)
                items.push(this._addDetailRow(_(GPU_LABELS[def.type] ?? def.title), def.id, true));
            this._gpuItems.set(gpuId, {items, ids: defs.map(d => d.id)});
        }

        this._topRows = {cpu: this._addTopSection(_('Top CPU')), ram: this._addTopSection(_('Top RAM'))};
    }

    // A divider and TOP_APPS name/value rows, filled while the menu is open.
    _addTopSection(title) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
        const rows = [];
        for (let i = 0; i < TOP_APPS; i++) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const row = new St.BoxLayout({x_expand: true});
            const name = new St.Label({
                text: i === 0 ? '…' : '',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const value = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: bold; padding-left: 24px;',
            });
            row.add_child(name);
            row.add_child(value);
            item.add_child(row);
            this.menu.addMenuItem(item);
            rows.push({item, name, value});
        }
        return rows;
    }

    _updateTopApps() {
        if (!this._topRows || !this.menu.isOpen)
            return;
        const top = this._processes.sample(TOP_APPS);
        const fill = (rows, entries, format) => {
            if (entries.length === 0)
                return;
            rows.forEach((row, i) => {
                row.item.visible = i < entries.length;
                if (i < entries.length) {
                    row.name.text = entries[i].name;
                    row.value.text = format(entries[i]);
                }
            });
        };
        fill(this._topRows.cpu, top.cpu, e => `${e.percent.toFixed(1)}%`);
        fill(this._topRows.ram, top.ram, e => formatBytes(e.bytes));
    }

    _addDetailRow(text, id, indent = false) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const row = new St.BoxLayout({x_expand: true});
        row.add_child(new St.Label({
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: indent ? 'padding-left: 12px;' : null,
        }));

        const value = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; padding-left: 24px;',
        });
        row.add_child(value);

        item.add_child(row);
        this.menu.addMenuItem(item);
        this._detailLabels.set(id, value);
        return item;
    }

    _tick() {
        const readings = this._sensors.sample();
        const available = this._sensors.available();
        if (JSON.stringify(available) !== JSON.stringify(this._available)) {
            this._available = available;
            this._rebuildPanel();
            this._buildMenu();
        }

        // Keep the established boolean key so existing settings remain valid:
        // true selects symbols and false selects text.
        const useSymbols = this._settings.get_boolean('metrics-show-labels');

        // With several GPUs selected, show one per reading type: the primary
        // (chosen, or else automatic) while connected, otherwise the first
        // connected one.
        const primary = this._settings.get_string('metrics-primary-gpu') ||
            this._sensors.autoPrimaryGpu?.();
        const gpuShown = new Map();
        const connected = [...this._panelLabels.values()]
            .filter(({def}) => def.gpuId && readings[def.id] && !readings[def.id].disconnected);
        for (const {def} of connected) {
            if (!gpuShown.has(def.type) || def.gpuId === primary)
                gpuShown.set(def.type, def.id);
        }

        for (const [id, {label, def, metric}] of this._panelLabels) {
            const reading = readings[id];
            if (!reading)
                continue;
            metric.visible = !reading.disconnected && (!def.gpuId || gpuShown.get(def.type) === id);
            if (!metric.visible)
                continue;
            label.text = useSymbols ? reading.short : `${def.label ?? def.name} ${reading.short}`;
        }
        this._emptyLabel.visible = ![...this._panelLabels.values()]
            .some(({metric}) => metric.visible);

        for (const [id, label] of this._detailLabels) {
            if (readings[id])
                label.text = readings[id].disconnected ? _('Disconnected') : readings[id].detail;
        }

        this._updateTopApps();

        // Only GPUs that are plugged in get a block.
        for (const {items, ids} of this._gpuItems?.values() ?? []) {
            const present = ids.some(id => readings[id] && !readings[id].disconnected);
            for (const item of items)
                item.visible = present;
        }
    }

    _onDestroy() {
        if (this._topId) {
            GLib.source_remove(this._topId);
            this._topId = 0;
        }
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._sensors.destroy();
        this._detailLabels.clear();
        this._panelLabels.clear();
    }
});
