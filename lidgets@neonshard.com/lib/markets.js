/*
 * Stock and crypto prices.
 *
 * Tickers live in GSettings with a per-ticker choice of whether the price is
 * shown in the panel or only in the dropdown. The panel shows the 24-hour
 * change; the dropdown adds 7-day, 1-month and 6-month changes.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {makeJsonFetcher, watchNetworkRecovery} from './geocode.js';
import {
    PERIODS, USER_AGENT, chartUrl, formatChange, formatPrice, parseChart, shortSymbol,
} from './quotes.js';

const HTTP_TIMEOUT_SECONDS = 15;
const REFRESH_SECONDS = 5 * 60;
const PANEL_ICON = '📈';
const PANEL_SEPARATOR = '  ·  ';

export const MarketsIndicator = GObject.registerClass(
class MarketsIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('Stocks and crypto'), false);

        this._settings = settings;
        this._destroyed = false;
        this._quotes = new Map();
        this._failed = new Set();
        this._updatedAt = null;
        this._generation = 0;
        this._reloadId = 0;

        this._label = new St.Label({
            text: `${PANEL_ICON} …`,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-label',
        });
        this.add_child(this._label);

        this._session = new Soup.Session({
            timeout: HTTP_TIMEOUT_SECONDS,
            user_agent: USER_AGENT,
        });
        this._cancellable = new Gio.Cancellable();
        this._fetchJson = makeJsonFetcher(this._session, this._cancellable);

        this._settingsId = settings.connect('changed::market-symbols',
            () => this._queueReload());
        this.connect('destroy', () => this._onDestroy());

        this._render();
        this._fetchAll();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._fetchAll();
                return GLib.SOURCE_CONTINUE;
            });
        this._stopNetworkWatch = watchNetworkRecovery(() => {
            if (this._failed.size > 0)
                this._fetchAll();
        });
    }

    // [{symbol, name, inPanel}] in the order chosen in preferences.
    _tickers() {
        return this._settings.get_value('market-symbols').deepUnpack()
            .map(([symbol, name, inPanel]) => ({symbol, name, inPanel}));
    }

    /*
     * Ticking a panel checkbox should not refetch anything, so only tickers
     * with no quote yet are fetched; the rest just re-render.
     */
    _queueReload() {
        if (this._reloadId !== 0)
            return;
        this._reloadId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reloadId = 0;
            const symbols = new Set(this._tickers().map(t => t.symbol));
            for (const symbol of [...this._quotes.keys()]) {
                if (!symbols.has(symbol))
                    this._quotes.delete(symbol);
            }
            for (const symbol of [...this._failed]) {
                if (!symbols.has(symbol))
                    this._failed.delete(symbol);
            }
            const missing = [...symbols].filter(s => !this._quotes.has(s));
            this._fetch(missing, this._generation);
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetchAll() {
        this._fetch(this._tickers().map(t => t.symbol), ++this._generation);
    }

    _fetch(symbols, generation) {
        if (this._destroyed)
            return;
        for (const symbol of symbols) {
            this._fetchJson(chartUrl(symbol), data => {
                if (this._destroyed || generation !== this._generation)
                    return;
                const quote = parseChart(data);
                if (quote) {
                    this._quotes.set(symbol, quote);
                    this._failed.delete(symbol);
                    this._updatedAt = GLib.DateTime.new_now_local();
                } else {
                    // Keep the last price, marked stale, rather than blanking it.
                    this._failed.add(symbol);
                }
                this._render();
            });
        }
    }

    _panelText(ticker) {
        const quote = this._quotes.get(ticker.symbol);
        const name = shortSymbol(ticker.symbol);
        if (!quote)
            return this._failed.has(ticker.symbol) ? `${name} ⚠` : `${name} …`;
        const stale = this._failed.has(ticker.symbol) ? '*' : '';
        return `${name} ${formatPrice(quote.price, quote.currency, true)}` +
            ` (${formatChange(quote.changes['24h'])})${stale}`;
    }

    _popupText(ticker) {
        const quote = this._quotes.get(ticker.symbol);
        const name = shortSymbol(ticker.symbol);
        if (!quote) {
            return this._failed.has(ticker.symbol)
                ? `${name}  ${_('unavailable')}` : `${name}  …`;
        }
        const periods = [{id: '24h', label: '24h'}, ...PERIODS]
            .map(p => `${p.label} ${formatChange(quote.changes[p.id])}`)
            .join(' · ');
        const stale = this._failed.has(ticker.symbol) ? ' *' : '';
        return `${name}  ${formatPrice(quote.price, quote.currency)}  (${periods})${stale}`;
    }

    _render() {
        const tickers = this._tickers();
        const inPanel = tickers.filter(t => t.inPanel);
        this._label.text = inPanel.length > 0
            ? inPanel.map(t => this._panelText(t)).join(PANEL_SEPARATOR)
            : PANEL_ICON;
        this._buildMenu(tickers);
    }

    _buildMenu(tickers) {
        this.menu.removeAll();

        const heading = new PopupMenu.PopupMenuItem(
            _('Stocks and crypto'), {reactive: false, can_focus: false});
        heading.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(heading);

        if (tickers.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Add tickers in Preferences → Markets'),
                {reactive: false, can_focus: false}));
        }

        for (const ticker of tickers) {
            const item = new PopupMenu.PopupMenuItem(
                this._popupText(ticker), {reactive: false, can_focus: false});
            this.menu.addMenuItem(item);

            const detail = new PopupMenu.PopupMenuItem(
                ticker.name, {reactive: false, can_focus: false});
            detail.label.add_style_class_name('lidgets-dim');
            detail.label.opacity = 160;
            this.menu.addMenuItem(detail);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._updatedAt) {
            const updated = new PopupMenu.PopupMenuItem(
                `${_('Last updated')}: ${this._updatedAt.format('%H:%M')}`,
                {reactive: false, can_focus: false});
            updated.label.add_style_class_name('lidgets-dim');
            updated.label.opacity = 160;
            this.menu.addMenuItem(updated);
        }
        this.menu.addAction(_('Refresh prices'), () => this._fetchAll());
    }

    _onDestroy() {
        this._destroyed = true;
        this._generation++;
        for (const id of [this._refreshId, this._reloadId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshId = 0;
        this._reloadId = 0;
        this._stopNetworkWatch?.();
        this._stopNetworkWatch = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session = null;
        this._fetchJson = null;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
    }
});
