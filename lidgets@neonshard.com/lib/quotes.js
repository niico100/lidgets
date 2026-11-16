/*
 * Stock and crypto quotes from Yahoo Finance's keyless chart and search APIs.
 *
 * One daily chart covering six months answers every question the widget asks:
 * the current price, the 24-hour change Yahoo reports alongside it, and the
 * closes 7 days, 1 month and 6 months back. Crypto pairs such as BTC-USD use
 * the same endpoints as stocks, so there is a single source for both.
 *
 * Imports nothing from the shell, so preferences can use the search too.
 */

const CHART_ROOT = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_ROOT = 'https://query1.finance.yahoo.com/v1/finance/search';
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 100;
const DAY_SECONDS = 24 * 60 * 60;

/*
 * Yahoo answers 429 to requests with no User-Agent, which is what a bare
 * Soup.Session sends. The trailing space makes Soup append its own version.
 */
export const USER_AGENT = 'Lidgets ';

// Futures and options would also match most searches; they only add noise.
const QUOTE_TYPES = new Set(['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'INDEX', 'MUTUALFUND']);

/*
 * Some exchanges quote in minor units. Intl would read "GBp" as pounds,
 * making a 1,234p share look like £1,234, so convert to the major unit.
 */
const MINOR_UNITS = {GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100]};

// Yahoo exchange codes as people know them; others use Yahoo's full name.
const EXCHANGES = {
    NMS: 'Nasdaq', NGM: 'Nasdaq', NCM: 'Nasdaq', NAS: 'Nasdaq', NYQ: 'NYSE',
    ASE: 'NYSE American', PCX: 'NYSE Arca', BTS: 'Cboe', LSE: 'LSE', IOB: 'LSE',
    GER: 'Xetra', FRA: 'Frankfurt', PAR: 'Euronext Paris', AMS: 'Euronext Amsterdam',
    MIL: 'Borsa Italiana', MCE: 'BME', EBS: 'SIX', PRA: 'Prague', TOR: 'TSX',
    JPX: 'Tokyo', HKG: 'HKEX', ASX: 'ASX',
};

export const PERIODS = [
    {id: '7d', label: '7d'},
    {id: '1m', label: '1m'},
    {id: '6m', label: '6m'},
];

// Ranges for the dropdown graph, with an interval that gives ~50-400 points.
export const GRAPH_RANGES = [
    {id: '1d', label: '1d', range: '1d', interval: '5m'},
    {id: '1w', label: '1w', range: '5d', interval: '30m'},
    {id: '1m', label: '1m', range: '1mo', interval: '1h'},
    {id: '1y', label: '1y', range: '1y', interval: '1d'},
    {id: '5y', label: '5y', range: '5y', interval: '1wk'},
    {id: 'max', label: 'max', range: 'max', interval: '1mo'},
];

export function historyUrl(symbol, rangeId) {
    const r = GRAPH_RANGES.find(g => g.id === rangeId) ?? GRAPH_RANGES[0];
    return `${CHART_ROOT}/${encodeURIComponent(symbol)}` +
        `?range=${r.range}&interval=${r.interval}`;
}

/*
 * Returns {currency, points: [[seconds, close]]} with at least two points,
 * or null. Gaps (null closes) are dropped.
 */
export function parseHistory(data) {
    const result = data?.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    let currency = typeof result?.meta?.currency === 'string' ? result.meta.currency : '';
    let divisor = 1;
    if (MINOR_UNITS[currency])
        [currency, divisor] = MINOR_UNITS[currency];

    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
        const close = Number(closes[i]);
        if (Number.isFinite(close) && close > 0 && Number.isFinite(timestamps[i]))
            points.push([timestamps[i], close / divisor]);
    }
    return points.length >= 2 ? {currency, points} : null;
}

export function chartUrl(symbol) {
    return `${CHART_ROOT}/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
}

/*
 * `onDone` receives [{symbol, name, type, exchange}], or null on failure.
 */
export function searchSymbols(fetchJson, query, onDone) {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed === '') {
        onDone([]);
        return;
    }

    const url = `${SEARCH_ROOT}?q=${encodeURIComponent(trimmed)}` +
        `&quotesCount=${MAX_RESULTS}&newsCount=0`;
    fetchJson(url, data => {
        if (!Array.isArray(data?.quotes)) {
            onDone(null);
            return;
        }
        onDone(data.quotes
            .filter(q => typeof q.symbol === 'string' && QUOTE_TYPES.has(q.quoteType))
            .map(q => ({
                symbol: q.symbol,
                name: (q.shortname ?? q.longname ?? q.symbol).replace(/\s+/g, ' ').trim(),
                type: q.quoteType,
                exchange: q.exchDisp ?? '',
            })));
    });
}

// Calendar months back from `seconds`, so "1m" means the same date last month.
function monthsBefore(seconds, months) {
    const date = new Date(seconds * 1000);
    date.setUTCMonth(date.getUTCMonth() - months);
    return date.getTime() / 1000;
}

function percentChange(from, to) {
    return Number.isFinite(from) && Number.isFinite(to) && from > 0
        ? (to - from) / from * 100 : null;
}

/*
 * Returns {symbol, currency, price, time, changes: {'24h', '7d', '1m', '6m'},
 * marketHours: {start, end, offset} or null for crypto, exchange} with each change a
 * percentage or null, or null if the reply is unusable.
 */
export function parseChart(data) {
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    let price = Number(meta?.regularMarketPrice);
    if (!meta || !Number.isFinite(price) || price <= 0)
        return null;

    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const time = Number(meta.regularMarketTime) || timestamps.at(-1) || 0;
    const firstClose = Number(meta.chartPreviousClose);

    /*
     * The last close at or before `seconds`. Before the first bar, fall back
     * to the close just ahead of the range, which is what six months ago lands
     * on when the range starts a day or two after it.
     */
    const closeAt = seconds => {
        let found = null;
        for (let i = 0; i < timestamps.length && timestamps[i] <= seconds; i++) {
            if (Number.isFinite(closes[i]) && closes[i] > 0)
                found = closes[i];
        }
        return found ?? (Number.isFinite(firstClose) ? firstClose : null);
    };

    let change24h = Number(meta.regularMarketChangePercent);
    if (!Number.isFinite(change24h))
        change24h = percentChange(Number(meta.previousClose) || closeAt(time - DAY_SECONDS), price);

    const changes = {
        '24h': change24h,
        '7d': percentChange(closeAt(time - 7 * DAY_SECONDS), price),
        '1m': percentChange(closeAt(monthsBefore(time, 1)), price),
        '6m': percentChange(closeAt(monthsBefore(time, 6)), price),
    };

    let currency = typeof meta.currency === 'string' ? meta.currency : '';
    if (MINOR_UNITS[currency]) {
        const [major, divisor] = MINOR_UNITS[currency];
        currency = major;
        price /= divisor;
    }

    // Today's regular session, or the last one when the market is shut.
    const session = meta.currentTradingPeriod?.regular;
    const marketHours = meta.instrumentType === 'CRYPTOCURRENCY' ? null
        : Number.isFinite(session?.start) && Number.isFinite(session?.end)
            ? {start: session.start, end: session.end, offset: Number(session.gmtoffset) || 0}
            : null;

    const exchange = !marketHours ? ''
        : EXCHANGES[meta.exchangeName] ?? (typeof meta.fullExchangeName === 'string'
            ? meta.fullExchangeName : '');

    return {symbol: meta.symbol ?? '', currency, price, time, changes, marketHours, exchange};
}

/*
 * {open, seconds} where seconds counts down to the next close or open, or is
 * null for markets that never close. Past today's close, the next open is
 * assumed to be the same time on the next weekday; holidays are not known.
 */
export function marketStatus(quote, nowSeconds = Date.now() / 1000) {
    const hours = quote?.marketHours;
    if (!hours)
        return {open: true, seconds: null};
    if (nowSeconds < hours.start)
        return {open: false, seconds: hours.start - nowSeconds};
    if (nowSeconds < hours.end)
        return {open: true, seconds: hours.end - nowSeconds};
    let next = hours.start + DAY_SECONDS;
    const weekday = t => new Date((t + hours.offset) * 1000).getUTCDay();
    while (next <= nowSeconds || weekday(next) === 0 || weekday(next) === 6)
        next += DAY_SECONDS;
    return {open: false, seconds: next - nowSeconds};
}

// "45m", "3h", "2d".
export function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// Crypto pairs are quoted against a currency, e.g. BTC-USD.
export function isCrypto(symbol) {
    return /-(USD|EUR|GBP)$/.test(symbol);
}

// "BTC-USD" reads as "BTC" in the panel; stock symbols stay as they are.
export function shortSymbol(symbol) {
    return symbol.replace(/-(USD|EUR|GBP)$/, '').replace(/^\^/, '');
}

/*
 * Panel prices round to whole units; small coins keep enough digits to show
 * any movement at all.
 */
export function formatPrice(value, currency, compact = false) {
    const digits = value < 1 ? (compact ? 2 : 4) : compact ? 0 : 2;
    const options = {minimumFractionDigits: digits, maximumFractionDigits: digits};
    try {
        if (currency) {
            return new Intl.NumberFormat(undefined, {
                ...options, style: 'currency', currency, currencyDisplay: 'narrowSymbol',
            }).format(value);
        }
    } catch {
        // An unknown code: show it after the number instead.
    }
    const number = new Intl.NumberFormat(undefined, options).format(value);
    return currency ? `${number} ${currency}` : number;
}

export function formatChange(percent, digits = 2) {
    if (!Number.isFinite(percent))
        return '—';
    // Sign the rounded value, so −0.3% at zero digits reads 0%, not −0%.
    const text = Math.abs(percent).toFixed(digits);
    const sign = Number(text) === 0 ? '' : percent > 0 ? '+' : '−';
    return `${sign}${text}%`;
}
