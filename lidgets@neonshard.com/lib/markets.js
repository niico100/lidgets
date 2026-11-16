/*
 * Stock and crypto prices.
 *
 * Tickers live in GSettings with a per-ticker choice of whether the price is
 * shown in the panel or only in the dropdown. The panel shows the 24-hour
 * change; the dropdown adds 7-day, 1-month and 6-month changes. Clicking a
 * ticker in the dropdown unfolds a price graph with 1d/1w/1m/1y/5y/max ranges.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import PangoCairo from 'gi://PangoCairo';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {makeJsonFetcher, watchNetworkRecovery} from './geocode.js';
import {
    GRAPH_RANGES, PERIODS, USER_AGENT, chartUrl, formatChange, formatPrice,
    formatDuration, historyUrl, isCrypto, marketStatus, parseChart, parseHistory, shortSymbol,
} from './quotes.js';

const HTTP_TIMEOUT_SECONDS = 15;
const REFRESH_SECONDS = 5 * 60;
// Readable on the dark shell popup.
const CHANGE_UP = '#57e389';
const CHANGE_DOWN = '#f66151';
// Bitcoin orange for crypto, a finance blue for stocks.
const CRYPTO_COLOR = '#f7931a';
const STOCKS_COLOR = '#62a0ea';
const PANEL_SEPARATOR = '  ·  ';
// Shown whenever no price or change is in the panel; names alone say nothing.
const ICON_FILE = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('icons').get_child('markets-symbolic.svg');

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
        this._rows = new Map();
        this._menuKey = null;
        this._rebuilding = false;

        // A panel button lays out one child, so icon and label share a box.
        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: ICON_FILE}),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            text: '',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        /*
         * Switched off in preferences, the panel keeps only a chart icon,
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
        this._displayIds = ['market-panel-price', 'market-panel-change', 'market-graphs-expanded']
            .map(key => settings.connect(`changed::${key}`, () => this._render()));
        // Graphs fetch history only when someone looks at them.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshGraphs();
        });
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
            const change = formatChange(quote.changes['24h'], 0);
            parts.push(parts.length > 1 ? `(${change})` : change);
        }
        return parts.join(' ') + stale;
    }

    // Whole-percent change, green when up and red when down, as Pango markup.
    _changeMarkup(percent, digits = 0) {
        const text = formatChange(percent, digits);
        const color = text.startsWith('+') ? CHANGE_UP : text.startsWith('−') ? CHANGE_DOWN : null;
        return color ? `<span foreground="${color}">${text}</span>` : text;
    }

    _rowMarkup(ticker) {
        const esc = text => GLib.markup_escape_text(text, -1);
        const quote = this._quotes.get(ticker.symbol);
        const name = esc(shortSymbol(ticker.symbol));
        if (!quote) {
            return this._failed.has(ticker.symbol)
                ? `${name}  ${esc(_('unavailable'))}` : `${name}  …`;
        }
        const stale = this._failed.has(ticker.symbol) ? ' *' : '';
        let markup = `<b>${name}</b>  ${esc(formatPrice(quote.price, quote.currency))}${stale}`;
        // Expanded graphs: the change across the range they show.
        const values = this._settings.get_boolean('market-graphs-expanded')
            ? this._history.get(this._historyKey(ticker.symbol, this._range))?.data?.points
                ?.map(p => p[1])
            : null;
        if (values?.length > 1)
            markup += `  ${this._changeMarkup((values.at(-1) - values[0]) / values[0] * 100, 1)}`;
        // Crypto never closes, so only stocks say whether they are open.
        if (!isCrypto(ticker.symbol))
            markup += `    ${this._statusMarkup(quote)}`;
        if (!this._settings.get_boolean('market-graphs-expanded')) {
            markup += '    ' + [{id: '24h', label: '24h'}, ...PERIODS]
                .map(p => `${p.label} ${this._changeMarkup(quote.changes[p.id])}`)
                .join('  ');
        }
        return markup;
    }

    // "NYSE Open (Close 3h)" with the state in green or "Closed (Open 1h)" in red.
    _statusMarkup(quote) {
        const {open, seconds} = marketStatus(quote);
        const word = open ? _('Open') : _('Closed');
        const color = open ? CHANGE_UP : CHANGE_DOWN;
        let detail = '';
        if (seconds !== null) {
            const time = formatDuration(seconds);
            detail = open ? _('Close %s').format(time) : _('Open %s').format(time);
            detail = ` (${GLib.markup_escape_text(detail, -1)})`;
        }
        const exchange = quote.exchange ? `${GLib.markup_escape_text(quote.exchange, -1)} ` : '';
        return `${exchange}<span foreground="${color}">${GLib.markup_escape_text(word, -1)}</span>${detail}`;
    }

    // A labelled separator with its text and line in one color.
    _divider(text, color) {
        const item = new PopupMenu.PopupSeparatorMenuItem(text);
        item.label.style = `color: ${color}; font-weight: bold;`;
        item._separator.style = `background-color: ${color};`;
        return item;
    }

    _render() {
        const tickers = this._tickers();
        const inPanel = tickers.filter(t => t.inPanel);
        const showValues = this._settings.get_boolean('market-panel-price') ||
            this._settings.get_boolean('market-panel-change');
        const showText = !this._panelOff && showValues && inPanel.length > 0;
        this._icon.visible = !showText;
        this._label.visible = showText;
        if (showText)
            this._label.text = inPanel.map(t => this._panelText(t)).join(PANEL_SEPARATOR);
        this._buildMenu(tickers);
    }

    /*
     * Quote refreshes only relabel the rows, so an unfolded graph does not
     * collapse or flicker every time a price arrives.
     */
    _buildMenu(tickers) {
        const expanded = this._settings.get_boolean('market-graphs-expanded');
        const key = JSON.stringify([expanded, tickers.map(t => [t.symbol, t.name])]);
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
        this._graphs = new Map();
        this._rangeButtons = new Map();
        this._updatedLabel = null;

        if (tickers.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Add tickers in Preferences → Markets'),
                {reactive: false, can_focus: false}));
        }

        // Shown graphs share one range, picked once at the top.
        if (expanded && tickers.length > 0) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(this._buildRangeRow());
            this.menu.addMenuItem(item);
        }

        // Stocks first, then crypto, each under its own labelled divider.
        const stocks = tickers.filter(t => !isCrypto(t.symbol));
        const crypto = tickers.filter(t => isCrypto(t.symbol));
        const dividers = new Map([
            [stocks[0], [_('Stocks'), STOCKS_COLOR]],
            [crypto[0], [_('Crypto'), CRYPTO_COLOR]],
        ]);

        let reopen = null;
        for (const ticker of [...stocks, ...crypto]) {
            if (dividers.has(ticker))
                this.menu.addMenuItem(this._divider(...dividers.get(ticker)));
            if (expanded) {
                const row = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
                row.label.clutter_text.set_markup(this._rowMarkup(ticker));
                this.menu.addMenuItem(row);
                this.menu.addMenuItem(this._buildGraph(ticker.symbol, true));
                this._rows.set(ticker.symbol, row);
                continue;
            }
            const row = new PopupMenu.PopupSubMenuMenuItem('', false);
            row.label.clutter_text.set_markup(this._rowMarkup(ticker));
            row.menu.addMenuItem(this._buildGraph(ticker.symbol, false));
            row.menu.connect('open-state-changed', (_menu, open) => {
                if (this._rebuilding)
                    return;
                if (open) {
                    this._expanded = ticker.symbol;
                    this._refreshGraphs();
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
        if (this.menu.isOpen)
            this._refreshGraphs();
    }

    _buildRangeRow() {
        // Buttons share the full width so they span the graphs below.
        const buttonRow = new St.BoxLayout({
            style_class: 'lidgets-graph-ranges',
            x_expand: true,
        });
        for (const range of GRAPH_RANGES) {
            const button = new St.Button({
                label: range.label,
                style_class: 'lidgets-graph-range',
                x_expand: true,
                can_focus: true,
                checked: range.id === this._range,
            });
            button.connect('clicked', () => {
                this._range = range.id;
                this._refreshGraphs();
            });
            this._rangeButtons.set(range.id, button);
            buttonRow.add_child(button);
        }
        return buttonRow;
    }

    /*
     * Compact graphs sit under every ticker at once, so they skip the summary
     * line; the row above already carries the changes.
     */
    _buildGraph(symbol, compact) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'lidgets-graph',
        });
        item.add_child(box);

        let summary = null;
        if (!compact) {
            box.add_child(this._buildRangeRow());
            summary = new St.Label({text: '…', style_class: 'lidgets-dim'});
            box.add_child(summary);
        }

        const area = new St.DrawingArea({
            style_class: compact ? 'lidgets-graph-area lidgets-graph-compact' : 'lidgets-graph-area',
            x_expand: true,
        });
        area.connect('repaint', () => this._paintGraph(area, symbol));
        box.add_child(area);

        this._graphs.set(symbol, {symbol, summary, area});
        return item;
    }

    // Graphs on screen: every one when expanded, else the unfolded ticker's.
    _visibleGraphs() {
        if (!this._graphs || !this.menu.isOpen)
            return [];
        if (this._settings.get_boolean('market-graphs-expanded'))
            return [...this._graphs.values()];
        const graph = this._graphs.get(this._expanded);
        return graph ? [graph] : [];
    }

    _refreshGraphs() {
        for (const [id, button] of this._rangeButtons ?? [])
            button.checked = id === this._range;
        for (const graph of this._visibleGraphs()) {
            this._updateGraph(graph);
            this._loadHistory(graph.symbol, this._range);
        }
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
            const graph = this._graphs?.get(symbol);
            if (graph && this._range === range)
                this._updateGraph(graph);
        });
    }

    _updateGraph(graph) {
        this._rows.get(graph.symbol)?.label.clutter_text.set_markup(
            this._rowMarkup({symbol: graph.symbol}));
        const entry = this._history.get(this._historyKey(graph.symbol, this._range));
        const points = entry?.data?.points;
        if (!graph.summary) {
            // Compact graphs have no summary line.
        } else if (!points) {
            graph.summary.text = entry?.failed ? _('Graph unavailable') : '…';
        } else {
            const values = points.map(p => p[1]);
            const currency = entry.data.currency;
            const change = (values.at(-1) - values[0]) / values[0] * 100;
            const esc = text => GLib.markup_escape_text(text, -1);
            graph.summary.clutter_text.set_markup(`${this._changeMarkup(change)}  ·  ` +
                `${esc(`${_('Low')} ${formatPrice(Math.min(...values), currency)}`)}  ·  ` +
                `${esc(`${_('High')} ${formatPrice(Math.max(...values), currency)}`)}`);
        }
        graph.area.queue_repaint();
    }

    _paintGraph(area, symbol) {
        const cr = area.get_context();
        try {
            const data = this._history.get(this._historyKey(symbol, this._range))?.data;
            const points = data?.points;
            if (!points)
                return;
            const [width, height] = area.get_surface_size();
            const values = points.map(p => p[1]);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const pad = 4;
            const span = max - min || 1;

            // Time labels along the bottom, in the menu's font, a size down.
            const node = area.get_theme_node();
            const font = node.get_font().copy();
            const size = Math.round(font.get_size() * 0.75);
            if (font.get_size_is_absolute())
                font.set_absolute_size(size);
            else
                font.set_size(size);
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(font);
            layout.set_text('0', -1);
            const labelHeight = layout.get_pixel_size()[1];
            const bottom = height - labelHeight - 2;

            // Price labels for the high, middle and low, in a right gutter.
            const levels = [max, (max + min) / 2, min].map(value => {
                layout.set_text(formatPrice(value, data.currency, max >= 100), -1);
                return {value, text: layout.get_text(), width: layout.get_pixel_size()[0]};
            });
            const right = width - Math.max(...levels.map(l => l.width)) - 6;

            // Spread by index, not time, so nights and weekends leave no gaps.
            const x = i => pad + i / (values.length - 1) * (right - 2 * pad);
            const y = v => pad + (max - v) / span * (bottom - 2 * pad);
            const fg = node.get_foreground_color();
            const ink = alpha => cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, alpha);

            // Faint gridlines at each labelled price, the label beside them.
            for (const level of levels) {
                const ly = Math.round(y(level.value)) + 0.5;
                ink(0.12);
                cr.setLineWidth(1);
                cr.moveTo(pad, ly);
                cr.lineTo(right - pad, ly);
                cr.stroke();
                layout.set_text(level.text, -1);
                ink(0.6);
                cr.moveTo(right, Math.min(Math.max(ly - labelHeight / 2, 0), bottom - labelHeight));
                PangoCairo.show_layout(cr, layout);
            }

            const [r, g, b] = values.at(-1) >= values[0]
                ? [0.34, 0.80, 0.45] : [0.93, 0.36, 0.36];

            // Dashed line at the starting price.
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
            cr.setLineWidth(1);
            cr.setDash([3, 3], 0);
            cr.moveTo(pad, y(values[0]));
            cr.lineTo(right - pad, y(values[0]));
            cr.stroke();
            cr.setDash([], 0);

            cr.moveTo(x(0), y(values[0]));
            for (let i = 1; i < values.length; i++)
                cr.lineTo(x(i), y(values[i]));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.strokePreserve();
            cr.lineTo(x(values.length - 1), bottom - pad);
            cr.lineTo(x(0), bottom - pad);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.15);
            cr.fill();

            for (const {index, text} of axisTicks(points, this._range)) {
                layout.set_text(text, -1);
                const [textWidth] = layout.get_pixel_size();
                const tx = x(index);
                ink(0.35);
                cr.setLineWidth(1);
                cr.moveTo(Math.round(tx) + 0.5, bottom - pad);
                cr.lineTo(Math.round(tx) + 0.5, bottom - pad + 3);
                cr.stroke();
                ink(0.6);
                cr.moveTo(Math.min(Math.max(tx - textWidth / 2, 0), right - textWidth), bottom);
                PangoCairo.show_layout(cr, layout);
            }
        } finally {
            cr.$dispose();
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._graphs = null;
        this._rangeButtons = null;
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

// How each range labels its time axis, as GLib.DateTime formats.
const AXIS_FORMATS = {
    '1d': '%H:%M', '1w': '%a', '1m': '%e %b', '1y': '%b', '5y': '%Y', 'max': '%Y',
};
const MAX_TICKS = 6;

/*
 * Ticks where the label changes (a new hour, day, month or year), thinned to
 * at most MAX_TICKS spread evenly, skipping the very first point since it
 * usually sits mid-period. The 1d range ticks whole hours only.
 */
function axisTicks(points, range) {
    const format = AXIS_FORMATS[range] ?? '%e %b';
    const step = range === '1d' ? '%H' : format;
    const at = (i, fmt) => GLib.DateTime.new_from_unix_local(points[i][0]).format(fmt);
    const boundaries = [];
    for (let i = 1; i < points.length; i++) {
        if (at(i, step) !== at(i - 1, step))
            boundaries.push(i);
    }
    const every = Math.ceil(boundaries.length / MAX_TICKS);
    return boundaries
        .filter((_i, n) => n % every === 0)
        .map(index => ({index, text: at(index, format).trim()}));
}
