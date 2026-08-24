/*
 * Place-name lookup via Open-Meteo's geocoder.
 *
 * Shared by the weather widget and the preferences window, which run in
 * different processes with their own HTTP sessions -- hence the injected
 * fetcher rather than a session owned here. Imports nothing from the shell,
 * so preferences can use it too.
 */

import GLib from 'gi://GLib';
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
 * "Los Angeles, California, United States" -- the fields Open-Meteo actually
 * returns vary by place, so empties are dropped rather than left as gaps.
 */
export function describePlace(place) {
    return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}
