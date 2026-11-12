/*
 * Stock and crypto prices.
 *
 * Tickers live in GSettings with a per-ticker choice of whether the price is
 * shown in the panel or only in the dropdown. The panel shows the 24-hour
 * change; the dropdown adds 7-day, 1-month and 6-month changes. Clicking a
 * ticker in the dropdown unfolds a price graph with 1d/1w/1m/1y/5y ranges.
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
    GRAPH_RANGES, PERIODS, USER_AGENT, chartUrl, formatChange, formatPrice,
    historyUrl, parseChart, parseHistory, shortSymbol,
} from './quotes.js';

const HTTP_TIMEOUT_SECONDS = 15;
const REFRESH_SECONDS = 5 * 60;
const PANEL_SEPARATOR = '  ·  ';
// Shown whenever no price or change is in the panel; names alone say nothing.
const PLACEHOLDER = '₿ $';

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
        this._range = GRAPH_RANGES[0].id;
        this._history = new Map();
        this._historyPending = new Set();
        this._expanded = null;
        this._graph = null;
        this._rows = new Map();
        this._menuKey = null;
        this._rebuilding = false;

        this._label = new St.Label({
            text: PLACEHOLDER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-label',
        });
        this.add_child(this._label);

        /*
         * Switched off in preferences, the panel keeps only a ₿ placeholder,
         * but the dropdown still lists every price. Toggling the setting
         * rebuilds every widget, so this is decided once here.
         */
        this._panelOff = !settings.get_boolean('markets-enabled');

        this._session = new Soup.Session({
            timeout: HTTP_TIMEOUT_SECONDS,
            user_agent: USER_AGENT,
        });
        this._cancellable = new Gio.Cancellable();
        this._fetchJson = makeJsonFetcher(this._session, this._cancellable);

        this._settingsId = settings.connect('changed::market-symbols',
            () => this._queueReload());
        this._displayIds = ['market-panel-price', 'market-panel-change'].map(key =>
            settings.connect(`changed::${key}`, () => this._render()));
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
        const parts = [name];
        if (this._settings.get_boolean('market-panel-price'))
            parts.push(formatPrice(quote.price, quote.currency, true));
        if (this._settings.get_boolean('market-panel-change')) {
            const change = formatChange(quote.changes['24h'], 1);
            parts.push(parts.length > 1 ? `(${change})` : change);
        }
        return parts.join(' ') + stale;
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

    _rowMarkup(ticker) {
        const esc = text => GLib.markup_escape_text(text, -1);
        return `${esc(this._popupText(ticker))}\n` +
            `<span size="small" alpha="63%">${esc(ticker.name)}</span>`;
    }

    _render() {
        const tickers = this._tickers();
        const inPanel = tickers.filter(t => t.inPanel);
        const showValues = this._settings.get_boolean('market-panel-price') ||
            this._settings.get_boolean('market-panel-change');
        this._label.text = !this._panelOff && showValues && inPanel.length > 0
            ? inPanel.map(t => this._panelText(t)).join(PANEL_SEPARATOR)
            : PLACEHOLDER;
        this._buildMenu(tickers);
    }

    /*
     * Quote refreshes only relabel the rows, so an unfolded graph does not
     * collapse or flicker every time a price arrives.
     */
    _buildMenu(tickers) {
        const key = JSON.stringify(tickers.map(t => [t.symbol, t.name]));
        if (key === this._menuKey) {
            for (const ticker of tickers)
                this._rows.get(ticker.symbol)?.label.clutter_text.set_markup(this._rowMarkup(ticker));
            if (this._updatedLabel && this._updatedAt)
                this._updatedLabel.text = `${_('Last updated')}: ${this._updatedAt.format('%H:%M')}`;
            return;
        }
        this._menuKey = key;

        this._rebuilding = true;
        this.menu.removeAll();
        this._rebuilding = false;
        this._rows.clear();
        this._graph = null;
        this._updatedLabel = null;

        const heading = new PopupMenu.PopupMenuItem(
            _('Stocks and crypto'), {reactive: false, can_focus: false});
        heading.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(heading);

        if (tickers.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Add tickers in Preferences → Markets'),
                {reactive: false, can_focus: false}));
        }

        let reopen = null;
        for (const ticker of tickers) {
            const row = new PopupMenu.PopupSubMenuMenuItem('', false);
            row.label.clutter_text.set_markup(this._rowMarkup(ticker));
            row.menu.addMenuItem(this._buildGraph(ticker.symbol));
            row.menu.connect('open-state-changed', (_menu, open) => {
                if (this._rebuilding)
                    return;
                if (open) {
                    this._expanded = ticker.symbol;
                    this._showGraph(ticker.symbol);
                } else if (this._expanded === ticker.symbol) {
                    this._expanded = null;
                }
            });
            this.menu.addMenuItem(row);
            this._rows.set(ticker.symbol, row);
            if (ticker.symbol === this._expanded)
                reopen = row;
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const updated = new PopupMenu.PopupMenuItem(
            this._updatedAt ? `${_('Last updated')}: ${this._updatedAt.format('%H:%M')}` : '',
            {reactive: false, can_focus: false});
        updated.label.add_style_class_name('lidgets-dim');
        updated.label.opacity = 160;
        this.menu.addMenuItem(updated);
        this._updatedLabel = updated.label;
        this.menu.addAction(_('Refresh prices'), () => this._fetchAll());

        if (reopen)
            reopen.menu.open(false);
        else
            this._expanded = null;
    }

    _buildGraph(symbol) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'lidgets-graph',
        });
        item.add_child(box);

        const buttonRow = new St.BoxLayout({style_class: 'lidgets-graph-ranges'});
        const buttons = new Map();
        for (const range of GRAPH_RANGES) {
            const button = new St.Button({
                label: range.label,
                style_class: 'lidgets-graph-range',
                can_focus: true,
                checked: range.id === this._range,
            });
            button.connect('clicked', () => {
                this._range = range.id;
                this._showGraph(symbol);
            });
            buttons.set(range.id, button);
            buttonRow.add_child(button);
        }
        box.add_child(buttonRow);

        const summary = new St.Label({text: '…', style_class: 'lidgets-dim'});
        box.add_child(summary);

        const area = new St.DrawingArea({style_class: 'lidgets-graph-area', x_expand: true});
        area.connect('repaint', () => this._paintGraph(area, symbol));
        box.add_child(area);

        item._lidgetsGraph = {symbol, buttons, summary, area};
        this._graphs ??= new Map();
        this._graphs.set(symbol, item._lidgetsGraph);
        item.connect('destroy', () => {
            if (this._graphs?.get(symbol) === item._lidgetsGraph)
                this._graphs.delete(symbol);
        });
        return item;
    }

    _showGraph(symbol) {
        const graph = this._graphs?.get(symbol);
        if (!graph)
            return;
        this._graph = graph;
        for (const [id, button] of graph.buttons)
            button.checked = id === this._range;
        this._updateGraph();
        this._loadHistory(symbol, this._range);
    }

    _historyKey(symbol, range) {
        return `${symbol}|${range}`;
    }

    _loadHistory(symbol, range) {
        const key = this._historyKey(symbol, range);
        const cached = this._history.get(key);
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._destroyed || this._historyPending.has(key) ||
            (cached?.data && now - cached.at < REFRESH_SECONDS))
            return;
        this._historyPending.add(key);
        this._fetchJson(historyUrl(symbol, range), data => {
            if (this._destroyed)
                return;
            this._historyPending.delete(key);
            const parsed = parseHistory(data);
            // On failure keep any earlier series rather than blanking it.
            this._history.set(key, {
                data: parsed ?? cached?.data ?? null,
                at: parsed ? GLib.get_monotonic_time() / 1e6 : cached?.at ?? 0,
                failed: !parsed,
            });
            if (this._graph?.symbol === symbol && this._range === range)
                this._updateGraph();
        });
    }

    _updateGraph() {
        const graph = this._graph;
        if (!graph)
            return;
        const entry = this._history.get(this._historyKey(graph.symbol, this._range));
        const points = entry?.data?.points;
        if (!points) {
            graph.summary.text = entry?.failed ? _('Graph unavailable') : '…';
        } else {
            const values = points.map(p => p[1]);
            const currency = entry.data.currency;
            const change = (values.at(-1) - values[0]) / values[0] * 100;
            graph.summary.text = `${formatChange(change)}  ·  ` +
                `${_('Low')} ${formatPrice(Math.min(...values), currency)}  ·  ` +
                `${_('High')} ${formatPrice(Math.max(...values), currency)}`;
        }
        graph.area.queue_repaint();
    }

    _paintGraph(area, symbol) {
        const cr = area.get_context();
        try {
            if (symbol !== this._graph?.symbol)
                return;
            const points = this._history.get(this._historyKey(symbol, this._range))?.data?.points;
            if (!points)
                return;
            const [width, height] = area.get_surface_size();
            const values = points.map(p => p[1]);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const pad = 4;
            const span = max - min || 1;
            // Spread by index, not time, so nights and weekends leave no gaps.
            const x = i => pad + i / (values.length - 1) * (width - 2 * pad);
            const y = v => pad + (max - v) / span * (height - 2 * pad);

            const [r, g, b] = values.at(-1) >= values[0]
                ? [0.34, 0.80, 0.45] : [0.93, 0.36, 0.36];

            // Dashed line at the starting price.
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
            cr.setLineWidth(1);
            cr.setDash([3, 3], 0);
            cr.moveTo(pad, y(values[0]));
            cr.lineTo(width - pad, y(values[0]));
            cr.stroke();
            cr.setDash([], 0);

            cr.moveTo(x(0), y(values[0]));
            for (let i = 1; i < values.length; i++)
                cr.lineTo(x(i), y(values[i]));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.strokePreserve();
            cr.lineTo(x(values.length - 1), height - pad);
            cr.lineTo(x(0), height - pad);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.15);
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._graph = null;
        this._graphs = null;
        this._generation++;
        for (const id of [this._refreshId, this._reloadId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshId = 0;
        this._reloadId = 0;
        this._range = GRAPH_RANGES[0].id;
        this._history = new Map();
        this._historyPending = new Set();
        this._expanded = null;
        this._graph = null;
        this._rows = new Map();
        this._menuKey = null;
        this._rebuilding = false;
        this._stopNetworkWatch?.();
        this._stopNetworkWatch = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session = null;
        this._fetchJson = null;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        for (const id of this._displayIds ?? [])
            this._settings.disconnect(id);
        this._displayIds = [];
        this._settingsId = 0;
    }
});
