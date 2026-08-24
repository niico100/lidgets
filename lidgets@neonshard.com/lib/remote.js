/*
 * A hard-to-miss banner while the RDP or VNC server is accepting connections.
 *
 * This is not a panel indicator: it is injected into every visible panel's
 * right box so it shows on all monitors, and it hides itself entirely when
 * remote desktop is off rather than sitting there as a dormant icon.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SCHEMAS = [
    'org.gnome.desktop.remote-desktop.rdp',
    'org.gnome.desktop.remote-desktop.vnc',
];

export class RemoteBanner {
    constructor() {
        this._indicators = [];
        this._settings = [];
        this._signalIds = [];
        this._dashToPanelId = 0;

        for (const schemaId of SCHEMAS)
            this._watch(schemaId);

        this._rebuild();

        // Dash to Panel destroys and recreates its panels on monitor changes,
        // which throws away anything we injected. Re-inject when it does.
        if (global.dashToPanel) {
            this._dashToPanelId = global.dashToPanel.connect(
                'panels-created', () => this._rebuild());
        }
    }

    _watch(schemaId) {
        if (!Gio.SettingsSchemaSource.get_default().lookup(schemaId, true))
            return;

        const settings = new Gio.Settings({schema_id: schemaId});
        this._signalIds.push(
            settings.connect('changed::enable', () => this._sync()));
        this._settings.push(settings);
    }

    _createIndicator() {
        const indicator = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-remote-banner',
        });
        indicator.add_child(new St.Icon({
            icon_name: 'computer-symbolic',
            icon_size: 15,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 5px;',
        }));
        indicator.add_child(new St.Label({
            text: _('REMOTE DESKTOP ON'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return indicator;
    }

    _rebuild() {
        this._destroyIndicators();

        const boxes = global.dashToPanel?.panels
            ?.map(panel => panel._rightBox)
            .filter(box => box !== null) ?? [Main.panel._rightBox];

        for (const box of boxes) {
            const indicator = this._createIndicator();
            box.insert_child_at_index(indicator, 0);
            this._indicators.push(indicator);
        }

        this._sync();
    }

    _sync() {
        const enabled = this._settings.some(s => s.get_boolean('enable'));
        for (const indicator of this._indicators)
            indicator.visible = enabled;
    }

    _destroyIndicators() {
        for (const indicator of this._indicators)
            indicator.destroy();
        this._indicators = [];
    }

    destroy() {
        for (let i = 0; i < this._settings.length; i++)
            this._settings[i].disconnect(this._signalIds[i]);
        this._settings = [];
        this._signalIds = [];

        if (this._dashToPanelId !== 0 && global.dashToPanel) {
            global.dashToPanel.disconnect(this._dashToPanelId);
            this._dashToPanelId = 0;
        }

        this._destroyIndicators();
    }
}
