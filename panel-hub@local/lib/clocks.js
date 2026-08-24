/*
 * World clocks: a compact strip of times in the panel, and a dropdown with the
 * full date and UTC offset for each zone.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

function formatTime(timeZone, use24h) {
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: !use24h,
        }).format(new Date());
    } catch {
        // An invalid zone in settings should degrade, not break the panel.
        return '--:--';
    }
}

function formatDate(timeZone) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
        }).format(new Date());
    } catch {
        return '';
    }
}

function formatOffset(timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            timeZoneName: 'shortOffset',
        }).formatToParts(new Date());
        return parts.find(part => part.type === 'timeZoneName')?.value ?? '';
    } catch {
        return '';
    }
}

export const ClocksIndicator = GObject.registerClass(
class ClocksIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'World Clocks', false);

        this._settings = settings;
        this._tickId = 0;

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'panel-hub-label',
        });
        this.add_child(this._label);

        this._settingsIds = ['clocks', 'clock-24h', 'clock-separator'].map(
            key => settings.connect(`changed::${key}`, () => this._refresh()));

        this.connect('destroy', () => this._onDestroy());

        this._refresh();
        this._scheduleTick();
    }

    _clocks() {
        return this._settings.get_value('clocks').deepUnpack();
    }

    _refresh() {
        const use24h = this._settings.get_boolean('clock-24h');
        const separator = this._settings.get_string('clock-separator');
        const clocks = this._clocks();

        this._label.text = clocks
            .map(([name, zone]) => `${name} ${formatTime(zone, use24h)}`.trim())
            .join(separator);

        this._rebuildMenu(clocks, use24h);
    }

    _rebuildMenu(clocks, use24h) {
        this.menu.removeAll();

        if (clocks.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No clocks configured', {reactive: false}));
            return;
        }

        for (const [name, zone] of clocks) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            box.add_child(new St.Label({
                text: `${name || zone}   ${formatTime(zone, use24h)}`,
                style: 'font-weight: bold;',
            }));
            box.add_child(new St.Label({
                text: `${formatDate(zone)}  ·  ${zone}  ${formatOffset(zone)}`,
                style_class: 'panel-hub-dim',
                // Relative to the theme's own colour, so light themes work too.
                opacity: 160,
            }));

            item.add_child(box);
            this.menu.addMenuItem(item);
        }
    }

    /*
     * Tick on the minute boundary rather than every N seconds, so the displayed
     * minute is never stale and the shell wakes up exactly once a minute.
     */
    _scheduleTick() {
        const delay = Math.max(1, 60 - new Date().getSeconds());
        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._tickId = 0;
                this._refresh();
                this._scheduleTick();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onDestroy() {
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
});
