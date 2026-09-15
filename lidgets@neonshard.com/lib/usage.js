import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(settings, path, provider) {
        const title = provider === 'codex' ? 'Codex' : 'Claude';
        super._init(0.0, title, false);
        this._provider = provider;
        this._title = title;
        this._path = path;
        this._dead = false;
        this._process = null;
        this._deadline = 0;
        this._snapshot = null;
        this._error = null;
        this._cancellable = new Gio.Cancellable();
        this._label = new St.Label({text: `${title} …`,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'lidgets-label'});
        this.add_child(this._label);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._render();
        });
        this.connect('destroy', () => {
            this._dead = true;
            GLib.source_remove(this._timer);
            if (this._deadline)
                GLib.source_remove(this._deadline);
            this._cancellable.cancel();
            this._process?.send_signal(15);
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    _refresh() {
        if (this._process || this._dead)
            return;
        try {
            const process = Gio.Subprocess.new(
                ['python3', `${this._path}/lib/usage-helper.py`, this._provider],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._process = process;
            this._deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
                this._deadline = 0;
                process.send_signal(15);
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, this._cancellable, (source, result) => {
                if (this._dead)
                    return;
                if (this._deadline) {
                    GLib.source_remove(this._deadline);
                    this._deadline = 0;
                }
                this._process = null;
                try {
                    const [, stdout] = source.communicate_utf8_finish(result);
                    const data = JSON.parse(stdout);
                    this._error = data.error ?? null;
                    if (!this._error) {
                        if (!Array.isArray(data.windows) || !Number.isFinite(data.updatedAt))
                            throw new Error('Invalid usage snapshot');
                        this._snapshot = data;
                    }
                } catch {
                    this._error = 'unavailable';
                }
                this._render();
            });
        } catch {
            this._error = 'unavailable';
            this._render();
        }
    }

    _render() {
        const now = Date.now() / 1000;
        const snapshot = this._snapshot;
        const stale = Boolean(this._error) || (snapshot && (now - snapshot.updatedAt > 300 ||
            snapshot.windows.some(w => w.resetsAt && w.resetsAt <= now)));
        const windows = (snapshot?.windows ?? []).filter(w =>
            Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100 &&
            Number.isFinite(w.minutes) && w.minutes > 0);
        const period = w => w.minutes === 300 ? '5h' : w.minutes === 10080 ? '1w' : `${w.minutes}m`;
        // Passing a reset does not prove a new allowance is available.
        const remaining = w => w.resetsAt && w.resetsAt <= now ? '—' : `${Math.floor(w.remaining)}%`;
        let label;
        if (this._provider === 'codex') {
            const values = [300, 10080].map(minutes => {
                const window = windows.find(w => w.minutes === minutes);
                return window ? remaining(window).replace('%', '') : '—';
            });
            label = `${this._title} (${values.join('/')})`;
        } else {
            label = `${this._title} ${windows.length
                ? windows.map(w => `${period(w)}: ${remaining(w)}`).join(' · ') : '—'}`;
        }
        this._label.text = `${label}${stale ? ' *' : ''}`;
        this.menu.removeAll();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Allowance remaining'), {reactive: false}));
        for (const w of windows) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `${period(w)}: ${remaining(w)}`, {reactive: false}));
            if (w.resetsAt) {
                const reset = GLib.DateTime.new_from_unix_local(Math.floor(w.resetsAt));
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    `${_('Resets')}: ${reset?.format('%a %H:%M') ?? '—'}`, {reactive: false}));
            }
        }
        if (snapshot) {
            const updated = GLib.DateTime.new_from_unix_local(Math.floor(snapshot.updatedAt));
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `${_('Last updated')}: ${updated?.format('%a %H:%M') ?? '—'}`, {reactive: false}));
        }
        let message = '';
        if (this._error === 'codex-missing')
            message = _('Install Codex CLI to read usage');
        else if (this._error === 'claude-setup')
            message = _('Connect Claude Code in Lidgets preferences, then use Claude Code');
        else if (this._error)
            message = _('Usage unavailable — check your CLI login');
        else if (!windows.length)
            message = _('No subscription limits reported');
        else if (stale)
            message = _('Stale reading — waiting for fresh usage');
        if (message)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(message, {reactive: false}));
        if (this._provider === 'claude')
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Updates when Claude Code is used'), {reactive: false}));
        this.menu.addAction(_('Refresh'), () => this._refresh());
    }
});

export const CodexIndicator = GObject.registerClass(
class CodexIndicator extends UsageIndicator {
    _init(settings, path) {
        super._init(settings, path, 'codex');
    }
});

export const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends UsageIndicator {
    _init(settings, path) {
        super._init(settings, path, 'claude');
    }
});
