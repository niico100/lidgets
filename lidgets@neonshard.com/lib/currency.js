/*
 * Currency converter backed by Frankfurter's keyless reference-rate API.
 *
 * The amount and pair live in GSettings, so the useful answer is visible in
 * the panel without reopening the popup. Rates change only a few times each
 * working day; a six-hour refresh is deliberately gentler than weather.
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
import {CURRENCIES, MAX_CURRENCY_PAIRS} from './currencies.js';

const API_ROOT = 'https://api.frankfurter.dev/v2/rate';
const HTTP_TIMEOUT_SECONDS = 15;
const REFRESH_SECONDS = 6 * 60 * 60;
const CONVERSION_DISPLAY_SECONDS = 60 * 60;
const CURRENCY_SYMBOLS = '$ £ € ¥';
const MIN_AMOUNT = 0.000001;
const MAX_AMOUNT = 1_000_000_000_000;


function validCurrency(value, fallback) {
    return CURRENCIES.includes(value) ? value : fallback;
}

function validAmount(value) {
    return Number.isFinite(value) && value >= MIN_AMOUNT && value <= MAX_AMOUNT;
}

function parseAmount(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    const value = Number(trimmed.replace(',', '.'));
    return validAmount(value) ? value : null;
}

function formatCurrency(value, currency) {
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

export const CurrencyIndicator = GObject.registerClass(
class CurrencyIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('Currency converter'), false);

        this._settings = settings;
        this._destroyed = false;
        this._rate = null;
        this._rateDate = '';
        this._failed = false;
        this._refreshId = 0;
        this._collapseId = 0;
        this._lastLookupUs = settings.get_int64('currency-last-lookup-us');
        this._pairReloadId = 0;
        this._requestGeneration = 0;
        // Saved pairs share rates by "FROM/TO", so duplicates cost one request.
        this._pairRates = new Map();
        this._pairsSection = null;

        this._label = new St.Label({
            text: '💱 …',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lidgets-label',
        });
        this.add_child(this._label);

        this._session = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        this._cancellable = new Gio.Cancellable();
        this._fetchJson = makeJsonFetcher(this._session, this._cancellable);

        this._settingsIds = [
            settings.connect('changed::currency-amount', () => {
                this._markConversionFresh();
            }),
            settings.connect('changed::currency-from', () => this._queuePairReload()),
            settings.connect('changed::currency-to', () => this._queuePairReload()),
            settings.connect('changed::currency-pairs', () => {
                this._renderPairs();
                this._fetchPairRates(false);
            }),
        ];

        this.connect('destroy', () => this._onDestroy());
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._markConversionFresh();
        });
        this._buildMenu();
        this._scheduleCollapse();
        this._fetchRate();
        this._fetchPairRates(true);
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._fetchRate();
                this._fetchPairRates(true);
                return GLib.SOURCE_CONTINUE;
            });
        this._stopNetworkWatch = watchNetworkRecovery(() => {
            if (this._rate === null || this._failed)
                this._fetchRate();
            this._fetchPairRates(false);
        });
    }

    _pair() {
        return {
            from: validCurrency(this._settings.get_string('currency-from'), 'EUR'),
            to: validCurrency(this._settings.get_string('currency-to'), 'USD'),
        };
    }

    _amount() {
        const value = this._settings.get_double('currency-amount');
        return validAmount(value) ? value : 100;
    }

    _savedPairs() {
        return this._settings.get_value('currency-pairs').deepUnpack()
            .filter(([amount, from, to]) => validAmount(amount) &&
                CURRENCIES.includes(from) && CURRENCIES.includes(to))
            .slice(0, MAX_CURRENCY_PAIRS)
            .map(([amount, from, to]) => ({amount, from, to}));
    }

    /*
     * With force unset, only pairs that have no rate yet or whose last
     * request failed are fetched: enough after an edit or a reconnect.
     */
    _fetchPairRates(force) {
        if (this._destroyed)
            return;
        const keys = new Set(this._savedPairs()
            .filter(pair => pair.from !== pair.to)
            .map(pair => `${pair.from}/${pair.to}`));
        for (const key of keys) {
            const known = this._pairRates.get(key);
            if (!force && known && !known.failed)
                continue;
            const [from, to] = key.split('/');
            const url = `${API_ROOT}/${from.toLowerCase()}/${to.toLowerCase()}`;
            this._fetchJson(url, data => {
                if (this._destroyed)
                    return;
                const rate = Number(data?.rate);
                const previous = this._pairRates.get(key);
                if (Number.isFinite(rate) && rate > 0 &&
                    data?.base === from && data?.quote === to)
                    this._pairRates.set(key, {rate, failed: false});
                else
                    this._pairRates.set(key, {rate: previous?.rate ?? null, failed: true});
                this._renderPairs();
            });
        }
    }

    _loadPair(pair) {
        this._settings.set_string('currency-from', pair.from);
        this._settings.set_string('currency-to', pair.to);
        this._settings.set_double('currency-amount', pair.amount);
        this._amountEntry?.set_text(String(pair.amount));
    }

    _renderPairs() {
        if (!this._pairsSection)
            return;
        this._pairsSection.removeAll();
        const pairs = this._savedPairs();
        if (pairs.length === 0)
            return;

        this._pairsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Saved pairs')));
        for (const pair of pairs) {
            const known = pair.from === pair.to
                ? {rate: 1, failed: false}
                : this._pairRates.get(`${pair.from}/${pair.to}`);
            let result;
            if (known?.rate)
                result = formatCurrency(pair.amount * known.rate, pair.to) +
                    (known.failed ? '*' : '');
            else
                result = known?.failed ? '⚠' : '…';
            const item = this._pairsSection.addAction(
                `${formatCurrency(pair.amount, pair.from)} = ${result}`,
                () => this._loadPair(pair));
            item.accessible_name = _('Load this pair into the converter');
        }
    }

    _queuePairReload() {
        if (this._pairReloadId !== 0)
            return;
        this._pairReloadId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pairReloadId = 0;
            this._rate = null;
            this._clearCollapseTimer();
            this._failed = false;
            this._buildMenu();
            this._markConversionFresh();
            this._fetchRate();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetchRate() {
        if (this._destroyed)
            return;

        const generation = ++this._requestGeneration;
        const {from, to} = this._pair();
        if (from === to) {
            this._rate = 1;
            this._rateDate = '';
            this._failed = false;
            this._render();
            return;
        }

        const url = `${API_ROOT}/${from.toLowerCase()}/${to.toLowerCase()}`;
        this._fetchJson(url, data => {
            if (this._destroyed || generation !== this._requestGeneration)
                return;

            const rate = Number(data?.rate);
            if (Number.isFinite(rate) && rate > 0 &&
                data?.base === from && data?.quote === to) {
                this._rate = rate;
                this._rateDate = typeof data.date === 'string' ? data.date : '';
                this._failed = false;
            } else {
                // Keep a previous answer useful while making its age visible.
                this._failed = true;
            }
            this._render();
        });
    }

    _clearCollapseTimer() {
        if (this._collapseId !== 0)
            GLib.source_remove(this._collapseId);
        this._collapseId = 0;
    }

    _conversionIsRecent() {
        const ageUs = GLib.get_real_time() - this._lastLookupUs;
        return this._lastLookupUs > 0 && ageUs >= 0 &&
            ageUs < CONVERSION_DISPLAY_SECONDS * 1_000_000;
    }

    _scheduleCollapse() {
        this._clearCollapseTimer();
        if (!this._conversionIsRecent())
            return;
        const remainingUs = CONVERSION_DISPLAY_SECONDS * 1_000_000 -
            (GLib.get_real_time() - this._lastLookupUs);
        this._collapseId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.min(30, Math.ceil(remainingUs / 1_000_000))), () => {
                this._collapseId = 0;
                this._render();
                this._scheduleCollapse();
                return GLib.SOURCE_REMOVE;
            });
    }

    _markConversionFresh() {
        this._lastLookupUs = GLib.get_real_time();
        this._settings.set_int64('currency-last-lookup-us', this._lastLookupUs);
        this._scheduleCollapse();
        this._render();
    }

    _buildCurrencyMenu(title, current, settingKey) {
        const submenu = new PopupMenu.PopupSubMenuMenuItem(
            `${title}: ${current}`, false);
        for (const code of CURRENCIES) {
            const item = submenu.menu.addAction(code, () =>
                this._settings.set_string(settingKey, code));
            item.setOrnament(code === current
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
        return submenu;
    }

    _buildMenu() {
        this.menu.removeAll();
        const {from, to} = this._pair();

        const heading = new PopupMenu.PopupMenuItem(
            _('Currency converter'), {reactive: false, can_focus: false});
        heading.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(heading);

        const amountItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        amountItem.add_child(new St.Label({
            text: _('Amount'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._amountEntry = new St.Entry({
            text: String(this._amount()),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'lidgets-currency-entry',
            accessible_name: _('Amount to convert'),
        });
        this._amountEntry.clutter_text.connect('text-changed', () => {
            const amount = parseAmount(this._amountEntry.get_text());
            if (amount === null) {
                this._renderPopup(null);
                return;
            }
            this._settings.set_double('currency-amount', amount);
        });
        amountItem.add_child(this._amountEntry);
        this.menu.addMenuItem(amountItem);

        this.menu.addMenuItem(this._buildCurrencyMenu(
            _('From'), from, 'currency-from'));
        this.menu.addMenuItem(this._buildCurrencyMenu(
            _('To'), to, 'currency-to'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._resultItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._resultItem.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(this._resultItem);

        this._dateItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._dateItem.label.add_style_class_name('lidgets-dim');
        this._dateItem.label.opacity = 160;
        this.menu.addMenuItem(this._dateItem);

        this._pairsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._pairsSection);
        this._renderPairs();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('Swap currencies'), () => {
            const pair = this._pair();
            this._settings.set_string('currency-from', pair.to);
            this._settings.set_string('currency-to', pair.from);
        });
        this.menu.addAction(_('Refresh rate'), () => {
            this._markConversionFresh();
            this._fetchRate();
            this._fetchPairRates(true);
        });
        this._render();
    }

    _renderPopup(amount) {
        if (!this._resultItem || !this._dateItem)
            return;
        const {from, to} = this._pair();
        if (amount === null) {
            this._resultItem.label.text = _('Enter a positive amount');
            this._dateItem.label.text = '';
            return;
        }
        if (this._rate === null) {
            this._resultItem.label.text = this._failed
                ? _('Could not refresh the exchange rate')
                : _('Loading exchange rate…');
            this._dateItem.label.text = '';
            return;
        }

        this._resultItem.label.text =
            `${formatCurrency(amount, from)} = ` +
            formatCurrency(amount * this._rate, to);
        if (from === to)
            this._dateItem.label.text = _('The currencies are the same');
        else if (this._rateDate)
            this._dateItem.label.text = this._failed
                ? `${_('Reference rate')} · ${this._rateDate} · ${_('refresh failed')}`
                : `${_('Reference rate')} · ${this._rateDate}`;
        else
            this._dateItem.label.text = '';
    }

    _render() {
        const amount = this._amount();
        const {from, to} = this._pair();
        if (!this._conversionIsRecent()) {
            this._label.text = CURRENCY_SYMBOLS;
        } else if (this._rate === null) {
            this._label.text = this._failed ? '⚠ FX' : '💱 …';
        } else {
            const stale = this._failed ? '*' : '';
            this._label.text = `${formatCurrency(amount, from)} → ` +
                `${formatCurrency(amount * this._rate, to)}${stale}`;
        }
        this._renderPopup(parseAmount(this._amountEntry?.get_text() ?? String(amount)));
    }

    _onDestroy() {
        this._destroyed = true;
        this._requestGeneration++;
        for (const id of [this._refreshId, this._pairReloadId, this._collapseId]) {
            if (id !== 0)
                GLib.source_remove(id);
        }
        this._refreshId = 0;
        this._pairReloadId = 0;
        this._collapseId = 0;
        this._stopNetworkWatch?.();
        this._stopNetworkWatch = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session = null;
        this._fetchJson = null;
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
});
