/*
 * Place-name lookup via Open-Meteo's geocoder.
 *
 * Shared by the weather widget and the preferences window, which run in
 * different processes with their own HTTP sessions -- hence the injected
 * fetcher rather than a session owned here. Imports nothing from the shell,
 * so preferences can use it too.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 200;

/*
 * `fetchJson` is (url, callback) -> callback(parsedOrNull).
 * `onDone` receives an array of places, or null if the lookup failed.
 */
export function geocode(fetchJson, query, onDone) {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed === '') {
        onDone([]);
        return;
    }

    const url = `${GEOCODER}?name=${encodeURIComponent(trimmed)}` +
        `&count=${MAX_RESULTS}&language=en&format=json`;

    fetchJson(url, data => {
        if (!data) {
            onDone(null);
            return;
        }
        // Open-Meteo omits `results` entirely when nothing matches.
        onDone(data.results ?? []);
    });
}

/*
 * The standard Soup boilerplate, so both callers report failure identically
 * rather than each inventing its own error handling.
 */
export function makeJsonFetcher(session, cancellable) {
    return (url, onDone) => {
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let data = null;
                try {
                    const bytes = source.send_and_read_finish(result);
                    if (message.get_status() === Soup.Status.OK) {
                        data = JSON.parse(
                            new TextDecoder('utf-8').decode(bytes.get_data()));
                    }
                } catch {
                    // Cancelled, offline, or malformed: all "no answer".
                }

                // Keep consumer exceptions out of the transport catch block;
                // otherwise a failing callback would be invoked a second time.
                onDone(data);
            });
    };
}

/*
 * Calls `onOnline` shortly after the network comes back, so a widget that
 * started offline does not sit on its failure until the next slow refresh.
 * The monitor signals on every route or connection change, often in bursts
 * and before DNS is usable, so wait a moment and coalesce. Callers refetch
 * only if their last attempt failed, which keeps this free when all is well.
 * Returns a function that stops watching.
 */
const NETWORK_SETTLE_SECONDS = 3;

export function watchNetworkRecovery(onOnline) {
    const monitor = Gio.NetworkMonitor.get_default();
    let timeoutId = 0;

    const changedId = monitor.connect('network-changed', (_monitor, available) => {
        if (!available || timeoutId !== 0)
            return;
        timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, NETWORK_SETTLE_SECONDS, () => {
                timeoutId = 0;
                onOnline();
                return GLib.SOURCE_REMOVE;
            });
    });

    return () => {
        monitor.disconnect(changedId);
        if (timeoutId !== 0)
            GLib.source_remove(timeoutId);
        timeoutId = 0;
    };
}

/*
 * "Los Angeles, California, United States" -- the fields Open-Meteo actually
 * returns vary by place, so empties are dropped rather than left as gaps.
 */
export function describePlace(place) {
    return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}
