/*
 * Folds the Lidgets indicators into a single drawer button when there is not
 * enough horizontal room to show them inline.
 *
 * The indicators are reparented, not redrawn: the real actors move into the
 * drawer, so they stay live, keep ticking, and their menus still work.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const DRAWER_GAP = 6;
const SCREEN_EDGE_MARGIN = 8;
const PANEL_ROLE = 'lidgets-drawer';
const RESTORE_ROLE = 'lidgets-restore';

/*
 * How much narrower than the budget the widgets must get before an already
 * collapsed drawer expands again, in logical pixels.
 */
const EXPAND_HYSTERESIS = 48;

/*
 * Widget text changes width as clocks tick and metrics move, so the fit is
 * rechecked on a slow timer. Ten measurements of our own actors is far too
 * cheap to be worth driving off allocation signals, which would risk
 * re-entering during a relayout.
 */
const RECHECK_SECONDS = 5;

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
        this._idleId = 0;
        this._recheckId = 0;

        this._buildToggle();
        this._buildDrawer();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this.sync());
        this._settingsIds =
            ['drawer-mode', 'drawer-max-width', 'drawer-space-fraction',
                'drawer-collapsed-per-monitor'].map(
                key => settings.connect(`changed::${key}`, () => this.sync()));

        this.sync();

        /*
         * At construction the indicators have not been allocated yet, so their
         * preferred width is not yet meaningful. Re-decide once the first
         * layout has happened, then keep checking as the text changes.
         */
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idleId = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
        this._recheckId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, RECHECK_SECONDS, () => {
                // Only the fit-measuring mode can change its mind on its own.
                if (this._settings.get_string('drawer-mode') === 'auto')
                    this.sync();
                return GLib.SOURCE_CONTINUE;
            });
    }

    /* ---------------------------------------------------------------- setup */

    _buildToggle() {
        this._toggle = new PanelMenu.Button(0.0, _('Lidgets'), true);
        this._toggleIcon = new St.Icon({
            icon_name: 'pan-end-symbolic',
            style_class: 'system-status-icon',
        });
        this._toggle.add_child(this._toggleIcon);

        /*
         * Shell 50 drives panel buttons with a ClickGesture, and passing
         * dontCreateMenu leaves that gesture disabled. Add our own so the
         * button toggles the drawer instead of opening a menu.
         *
         * Shells before 49 have no ClickGesture, so fall back to the button
         * press signal those versions used.
         */
        if (Clutter.ClickGesture) {
            const click = new Clutter.ClickGesture();
            click.set_recognize_on_press(true);
            click.connect('recognize', () => this._toggleDrawer());
            this._toggle.add_action(click);
        } else {
            this._toggle.connect('button-press-event', () => {
                this._toggleDrawer();
                return Clutter.EVENT_STOP;
            });
        }

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

        /*
         * Once folded, manual mode exposes two separate panel actions: this
         * button puts the widgets back inline, while _toggle opens the drawer.
         * Registering this second at the same index places it immediately
         * before _toggle, giving the panel the compact "<  up" pair.
         */
        this._restoreToggle = new PanelMenu.Button(
            0.0, _('Show these in the panel'), true);
        this._restoreToggle.add_child(new St.Icon({
            icon_name: 'pan-start-symbolic',
            style_class: 'system-status-icon',
        }));
        this._restoreToggle.set_accessible_name(_('Show these in the panel'));

        if (Clutter.ClickGesture) {
            const click = new Clutter.ClickGesture();
            click.set_recognize_on_press(true);
            click.connect('recognize', () => this._restoreFromPanel());
            this._restoreToggle.add_action(click);
        } else {
            this._restoreToggle.connect('button-press-event', () => {
                this._restoreFromPanel();
                return Clutter.EVENT_STOP;
            });
        }

        const staleRestore = Main.panel.statusArea[RESTORE_ROLE];
        if (staleRestore && staleRestore !== this._restoreToggle)
            staleRestore.destroy();

        Main.panel.addToStatusArea(RESTORE_ROLE, this._restoreToggle,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-box'));
        this._setRestoreVisible(false);
    }

    _buildDrawer() {
        this._drawerBox = new St.BoxLayout({
            style_class: 'lidgets-drawer-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._drawer = new St.Bin({
            style_class: 'lidgets-drawer popup-menu-content',
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

    _setRestoreVisible(visible) {
        if (!this._restoreToggle)
            return;
        this._restoreToggle.visible = visible;
        this._restoreToggle.container.visible = visible;
    }

    _restoreFromPanel() {
        this.close();
        this._setManualCollapsed(false);
        this.sync();
    }

    /*
     * Manual mode needs the button permanently, since it is the only way to
     * fold the widgets away. The automatic modes only need it once something
     * has actually been folded. Either way it is pointless with nothing to
     * collapse.
     */
    _toggleShouldBeVisible() {
        const mode = this._settings.get_string('drawer-mode');
        if (mode === 'never')
            return false;
        if (this._getIndicators().length === 0)
            return false;
        return mode === 'manual' ? true : this._collapsed;
    }

    _updateToggle() {
        this._setToggleVisible(this._toggleShouldBeVisible());

        /*
         * Inline, the button folds the widgets sideways into the drawer. Once
         * folded it points the way the drawer will appear, while a separate
         * adjacent panel button points back toward the restored widgets.
         */
        this._toggleIcon.icon_name = this._collapsed
            ? (this._panelAtBottom() ? 'pan-up-symbolic' : 'pan-down-symbolic')
            : 'pan-end-symbolic';
        this._toggle.set_accessible_name(this._collapsed
            ? _('Show folded Lidgets widgets')
            : _('Fold Lidgets widgets away'));

        // Manual restoration would immediately be undone in automatic modes.
        this._setRestoreVisible(this._collapsed &&
            this._settings.get_string('drawer-mode') === 'manual');
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

    /*
     * Which way the drawer opens, which is also which way the toggle points
     * once the widgets are folded.
     *
     * Ask Dash to Panel which edge it occupies. Inferring the edge from
     * transformed actor coordinates can report the original GNOME top-panel
     * location even while the visible Dash to Panel panel is at the bottom.
     */
    _panelAtBottom() {
        const dashPanel = this._dashToPanelForActor(this._toggle);
        if (dashPanel?.geom?.position !== undefined)
            return dashPanel.geom.position === St.Side.BOTTOM;

        const monitor = this._panelMonitor();
        if (!monitor)
            return false;

        const [, toggleY] = this._toggle.get_transformed_position();
        return toggleY > monitor.y + monitor.height / 2;
    }

    /*
     * The natural width our own indicators need, whether they are currently
     * inline or already in the drawer. The drawer style class deliberately
     * changes only height, so this figure does not depend on which state we
     * are in -- which is what stops the decision below from oscillating.
     */
    _widgetsWidth() {
        let total = 0;
        for (const indicator of this._getIndicators()) {
            if (!indicator || this._isDead(indicator))
                continue;
            const [, natural] = this._movable(indicator).get_preferred_width(-1);
            total += natural;
        }
        return total;
    }

    /*
     * "Do my widgets fit?" rather than "is the screen small?".
     *
     * A fixed pixel threshold has to be guessed per machine, and guesses wrong
     * as soon as the screen, the scale factor or the set of enabled widgets
     * changes. Measuring our own actors against a share of the panel needs no
     * knowledge of the monitor, of Dash to Panel, or of other extensions.
     */
    /*
     * Manual fold state is stored per monitor size, so docking and undocking
     * restores the choice already made on that screen. Keying on the size
     * rather than the connector keeps it stable across cable and port changes.
     */
    _monitorKey() {
        const monitor = this._panelMonitor();
        return monitor ? `${monitor.width}x${monitor.height}` : 'unknown';
    }

    _manualCollapsed() {
        const remembered = this._settings
            .get_value('drawer-collapsed-per-monitor').deepUnpack();
        return remembered[this._monitorKey()] ?? false;
    }

    _setManualCollapsed(collapsed) {
        const remembered = this._settings
            .get_value('drawer-collapsed-per-monitor').deepUnpack();
        remembered[this._monitorKey()] = collapsed;
        this._settings.set_value('drawer-collapsed-per-monitor',
            new GLib.Variant('a{sb}', remembered));
    }

    _shouldCollapse() {
        const mode = this._settings.get_string('drawer-mode');
        if (mode === 'never')
            return false;
        if (mode === 'always')
            return true;
        if (mode === 'manual')
            return this._manualCollapsed();

        const monitor = this._panelMonitor();
        if (!monitor)
            return false;

        if (mode === 'width')
            return monitor.width < this._settings.get_int('drawer-max-width');

        const width = this._widgetsWidth();
        // Before the first allocation the actors have no meaningful size; stay
        // inline and let the recheck timer settle it a moment later.
        if (width === 0)
            return this._collapsed;

        const budget = monitor.width *
            (this._settings.get_int('drawer-space-fraction') / 100);

        /*
         * Asymmetric thresholds: once collapsed, require a clear margin before
         * expanding again, so a metric reading gaining a digit cannot make the
         * panel flap back and forth on the boundary.
         */
        return this._collapsed
            ? width > budget - EXPAND_HYSTERESIS
            : width > budget;
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

        this._updateToggle();

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
            indicator.add_style_class_name('lidgets-drawer-item');
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
                indicator.remove_style_class_name('lidgets-drawer-item');

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

    /*
     * In manual mode the button is the whole mechanism: while the widgets are
     * inline it folds them away, and once folded it opens the drawer to reach
     * them. In the automatic modes the button only ever appears when already
     * collapsed, so it is purely an open/close control.
     */
    _toggleDrawer() {
        if (this._settings.get_string('drawer-mode') === 'manual' &&
            !this._collapsed) {
            this._setManualCollapsed(true);
            this.sync();
            return;
        }

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

        const y = this._panelAtBottom()
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

        for (const id of [this._idleId, this._recheckId]) {
            if (id !== 0)
                GLib.source_remove(id);
        }
        this._idleId = 0;
        this._recheckId = 0;

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
        if (this._restoreToggle) {
            this._restoreToggle.destroy();
            this._restoreToggle = null;
        }
    }
}
