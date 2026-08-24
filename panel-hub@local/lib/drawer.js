/*
 * Folds the Panel Hub indicators into a single drawer button when there is not
 * enough horizontal room to show them inline.
 *
 * The indicators are reparented, not redrawn: the real actors move into the
 * drawer, so they stay live, keep ticking, and their menus still work.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const DRAWER_GAP = 6;
const SCREEN_EDGE_MARGIN = 8;
const PANEL_ROLE = 'panel-hub-drawer';

export class Drawer {
    /*
     * `getIndicators` is a callback rather than a fixed array because the
     * extension rebuilds its widgets whenever prefs change, and the drawer
     * must always act on the current set.
     */
    constructor(settings, getIndicators) {
        this._settings = settings;
        this._getIndicators = getIndicators;
        this._stashed = [];
        this._collapsed = false;
        this._open = false;
        this._capturedEventId = 0;

        this._buildToggle();
        this._buildDrawer();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this.sync());
        this._settingsIds = ['drawer-mode', 'drawer-max-width'].map(
            key => settings.connect(`changed::${key}`, () => this.sync()));

        this.sync();
    }

    /* ---------------------------------------------------------------- setup */

    _buildToggle() {
        this._toggle = new PanelMenu.Button(0.0, 'Panel Hub', true);
        this._toggle.add_child(new St.Icon({
            icon_name: 'view-list-symbolic',
            style_class: 'system-status-icon',
        }));

        /*
         * Shell 50 drives panel buttons with a ClickGesture, and passing
         * dontCreateMenu leaves that gesture disabled. Add our own so the
         * button toggles the drawer instead of opening a menu.
         */
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => this._toggleDrawer());
        this._toggle.add_action(click);

        // Reclaim the role if a previous run died before releasing it.
        // Destroying the old indicator is what deletes the statusArea entry.
        const stale = Main.panel.statusArea[PANEL_ROLE];
        if (stale && stale !== this._toggle)
            stale.destroy();

        // Sit in the same panel area as the widgets it collapses.
        Main.panel.addToStatusArea(PANEL_ROLE, this._toggle,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-box'));
        this._setToggleVisible(false);
    }

    _buildDrawer() {
        this._drawerBox = new St.BoxLayout({
            style_class: 'panel-hub-drawer-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._drawer = new St.Bin({
            style_class: 'panel-hub-drawer popup-menu-content',
            child: this._drawerBox,
            reactive: true,
        });

        // addChrome only accepts trackFullscreen and affectsStruts; the input
        // region for chrome actors is maintained by the layout manager itself.
        Main.layoutManager.addChrome(this._drawer, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        /*
         * The drawer's natural size is not final until it has been styled and
         * allocated, and it changes again as the clock and metric text grows or
         * shrinks. Re-anchor whenever that happens. set_position() does not
         * alter width or height, so this cannot feed back on itself.
         */
        this._drawer.connect('notify::width', () => {
            if (this._open)
                this._position();
        });
        this._drawer.connect('notify::height', () => {
            if (this._open)
                this._position();
        });

        this._drawer.hide();
    }

    /*
     * ButtonBox does not bind its own visibility to its container, so hiding
     * only the button would leave the wrapper behind as an empty gap.
     */
    _setToggleVisible(visible) {
        if (!this._toggle)
            return;
        this._toggle.visible = visible;
        this._toggle.container.visible = visible;
    }

    /* ------------------------------------------------------------- geometry */

    _isDescendant(actor, ancestor) {
        if (!ancestor)
            return false;
        for (let a = actor; a; a = a.get_parent()) {
            if (a === ancestor)
                return true;
        }
        return false;
    }

    _dashToPanelForActor(actor) {
        return global.dashToPanel?.panels
            ?.find(panel => this._isDescendant(actor, panel.panel)) ?? null;
    }

    /*
     * Dash to Panel can place Main.panel inside a transformed container and
     * creates separate panel actors on additional monitors. Prefer its own
     * monitor record so both the collapse threshold and drawer placement refer
     * to the panel that actually contains our toggle.
     */
    _panelMonitor() {
        const dashPanel = this._dashToPanelForActor(this._toggle);
        if (dashPanel?.monitor)
            return dashPanel.monitor;

        const monitor = Main.panel.get_stage()
            ? Main.layoutManager.findMonitorForActor(Main.panel)
            : null;
        return monitor ?? Main.layoutManager.primaryMonitor;
    }

    _shouldCollapse() {
        const mode = this._settings.get_string('drawer-mode');
        if (mode === 'never')
            return false;
        if (mode === 'always')
            return true;

        const monitor = this._panelMonitor();
        return !!monitor &&
            monitor.width < this._settings.get_int('drawer-max-width');
    }

    /* ------------------------------------------------------------- collapse */

    /*
     * PanelMenu.Button wraps itself in `this.container = new St.Bin({child: this})`,
     * and it is that wrapper -- not the button -- that sits in the panel box.
     * Moving the button alone would strand an empty container in the panel.
     */
    _movable(actor) {
        return actor.container ?? actor;
    }

    /*
     * Where to put an indicator back when its original parent has been
     * destroyed under us -- the configured panel area, not always the right.
     */
    _fallbackBox() {
        switch (this._settings.get_string('panel-box')) {
        case 'left':
            return Main.panel._leftBox;
        case 'center':
            return Main.panel._centerBox;
        default:
            return Main.panel._rightBox;
        }
    }

    _isDead(actor) {
        // A destroyed GObject throws on any property access.
        try {
            void actor.visible;
            return false;
        } catch {
            return true;
        }
    }

    sync() {
        if (!this._toggle)
            return;

        if (this._shouldCollapse())
            this._collapse();
        else
            this._restore();

        this._setToggleVisible(this._collapsed);

        if (!this._collapsed)
            this.close();
        else if (this._open)
            this._position();
    }

    _collapse() {
        for (const indicator of this._getIndicators()) {
            if (!indicator || this._isDead(indicator))
                continue;

            const movable = this._movable(indicator);
            const parent = movable.get_parent();
            if (!parent || parent === this._drawerBox)
                continue;

            this._stashed.push({
                indicator,
                movable,
                parent,
                index: parent.get_children().indexOf(movable),
                wasVisible: movable.visible,
            });

            parent.remove_child(movable);
            this._drawerBox.add_child(movable);
            indicator.add_style_class_name('panel-hub-drawer-item');
            movable.show();
            indicator.show();
        }

        this._collapsed = this._stashed.length > 0;
    }

    _restore() {
        // Reverse order so recorded indices still line up as we put things back.
        for (const entry of this._stashed.reverse()) {
            const {indicator, movable, parent, index, wasVisible} = entry;

            if (this._isDead(movable))
                continue;

            if (movable.get_parent() === this._drawerBox)
                this._drawerBox.remove_child(movable);
            if (!this._isDead(indicator))
                indicator.remove_style_class_name('panel-hub-drawer-item');

            /*
             * Dash to Panel rebuilds its boxes on monitor changes, so the
             * original parent may be gone by now. Fall back to the live right
             * box rather than dropping the indicator on the floor.
             */
            let destination = parent;
            if (!destination || this._isDead(destination) || !destination.get_stage())
                destination = this._fallbackBox();

            const clamped = Math.max(
                0, Math.min(index, destination.get_children().length));
            destination.insert_child_at_index(movable, clamped);
            movable.visible = wasVisible;
        }

        this._stashed = [];
        this._collapsed = false;
    }

    /* --------------------------------------------------------- open / close */

    _toggleDrawer() {
        if (this._open)
            this.close();
        else
            this._openDrawer();
    }

    _openDrawer() {
        if (!this._collapsed || this._open)
            return;

        this._open = true;
        this._drawer.show();
        this._position();
        this._toggle.add_style_pseudo_class('active');

        this._capturedEventId = global.stage.connect(
            'captured-event', (actor, event) => this._onCapturedEvent(event));
    }

    close() {
        if (!this._open)
            return;

        this._open = false;

        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        this._drawer?.hide();
        this._toggle?.remove_style_pseudo_class('active');
    }

    _position() {
        const monitor = this._panelMonitor();
        if (!monitor)
            return;

        const [, natWidth] = this._drawer.get_preferred_width(-1);
        const [, natHeight] = this._drawer.get_preferred_height(natWidth);

        const [toggleX, toggleY] = this._toggle.get_transformed_position();
        const toggleWidth = this._toggle.width;
        const toggleHeight = this._toggle.height;

        let x = Math.round(toggleX + toggleWidth / 2 - natWidth / 2);
        x = Math.max(
            monitor.x + SCREEN_EDGE_MARGIN,
            Math.min(x, monitor.x + monitor.width - natWidth - SCREEN_EDGE_MARGIN));

        /*
         * Ask Dash to Panel which edge it occupies. Inferring the edge from
         * transformed actor coordinates can report the original GNOME top-panel
         * location even while the visible Dash to Panel panel is at the bottom.
         */
        const dashPanel = this._dashToPanelForActor(this._toggle);
        const panelAtBottom = dashPanel?.geom?.position !== undefined
            ? dashPanel.geom.position === St.Side.BOTTOM
            : toggleY > monitor.y + monitor.height / 2;

        const y = panelAtBottom
            ? Math.round(toggleY - natHeight - DRAWER_GAP)
            : Math.round(toggleY + toggleHeight + DRAWER_GAP);

        this._drawer.set_position(x, y);
    }

    _onCapturedEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const source = event.get_source();
        if (!source)
            return Clutter.EVENT_PROPAGATE;

        // Clicks inside the drawer, on the toggle, or in a popup one of the
        // collapsed indicators just opened must not close us.
        if (this._isDescendant(source, this._drawer) ||
            this._isDescendant(source, this._toggle) ||
            this._isInOpenMenu(source))
            return Clutter.EVENT_PROPAGATE;

        this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    _isInOpenMenu(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            const menu = a._delegate?.menu ?? a._delegate;
            if (menu?.isOpen)
                return true;
        }
        return false;
    }

    /* ------------------------------------------------------------- teardown */

    destroy() {
        this.close();

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];

        // Always put the indicators back before going away.
        this._restore();

        if (this._drawer) {
            try {
                Main.layoutManager.removeChrome(this._drawer);
            } catch {
                // Not tracked as chrome; destroying it below is enough.
            }
            this._drawer.destroy();
            this._drawer = null;
            this._drawerBox = null;
        }

        if (this._toggle) {
            this._toggle.destroy();
            this._toggle = null;
        }
    }
}
