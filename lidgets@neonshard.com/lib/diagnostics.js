/*
 * Small, privacy-safe diagnostics helpers. Messages go to GNOME Shell's
 * journal; repeated anomaly warnings are rate-limited so a fault cannot flood
 * it while still leaving a useful breadcrumb.
 */

import GLib from 'gi://GLib';

const PREFIX = '[Lidgets]';
const WARNING_INTERVAL_US = 60 * GLib.USEC_PER_SEC;
const lastWarningByKey = new Map();

export function log(message) {
    console.log(`${PREFIX} ${message}`);
}

export function warn(message) {
    console.warn(`${PREFIX} ${message}`);
}

export function warnRateLimited(key, message) {
    const now = GLib.get_monotonic_time();
    const last = lastWarningByKey.get(key);
    if (last !== undefined && now - last < WARNING_INTERVAL_US)
        return;

    lastWarningByKey.set(key, now);
    warn(message);
}

export function monotonicMs() {
    return GLib.get_monotonic_time() / 1000;
}
