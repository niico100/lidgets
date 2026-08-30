/*
 * Timezone naming, shared by the Shell side and the preferences process.
 *
 * A clock is stored as intent -- zone, two switches, and any custom text --
 * rather than as the finished string, so this module is what turns one into
 * the other. Both sides must agree on that composition, which is why it lives
 * here and imports nothing beyond GLib.
 */

import GLib from 'gi://GLib';

let timezoneCountries;

/*
 * tzdata's country table is optional and its two spellings disagree about
 * which zones exist, so a missing entry has to be ordinary rather than fatal:
 * a clock without a known country simply shows no flag.
 */
function loadTimezoneCountries() {
    const countries = new Map();
    for (const path of ['/usr/share/zoneinfo/zone1970.tab',
        '/usr/share/zoneinfo/zone.tab']) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                continue;

            for (const line of new TextDecoder('utf-8').decode(bytes).split('\n')) {
                if (!line || line.startsWith('#'))
                    continue;
                const [countryCodes, , zone] = line.split('\t');
                if (zone && !countries.has(zone))
                    countries.set(zone, countryCodes.split(',')[0]);
            }
            if (countries.size > 0)
                break;
        } catch {
            // A timezone label still works when the optional table is absent.
        }
    }
    return countries;
}

function countryFlag(countryCode) {
    if (!/^[A-Z]{2}$/.test(countryCode ?? ''))
        return '';
    return [...countryCode]
        .map(letter => String.fromCodePoint(letter.codePointAt(0) + 127397))
        .join('');
}

export function timezoneFlag(zone) {
    timezoneCountries ??= loadTimezoneCountries();
    return countryFlag(timezoneCountries.get(zone));
}

// "America/Los_Angeles" -> "Los Angeles"
export function timezoneLocality(zone) {
    return zone.split('/').at(-1).replaceAll('_', ' ');
}

/*
 * The text half of a label: whatever the user typed, or the locality when
 * they typed nothing. Kept separate from clockLabel so the preferences window
 * can show which of the two a clock is currently using.
 */
export function clockText([zone, , , customText]) {
    return customText.trim() || timezoneLocality(zone);
}

export function clockLabel(entry) {
    const [zone, showFlag, showCity] = entry;
    return [showFlag ? timezoneFlag(zone) : '', showCity ? clockText(entry) : '']
        .filter(part => part !== '')
        .join(' ');
}

export function makeClockEntry(zone) {
    return [zone, true, true, ''];
}

/*
 * Read a pre-2.0 label back into intent. The old format stored only the
 * finished string, so this is a best guess -- but it is the same guess the
 * preferences window made when it drew the switches, which is what makes the
 * migration invisible to anyone who looks at their clocks afterwards.
 */
export function clockEntryFromLabel(label, zone) {
    const flag = timezoneFlag(zone);
    let text = label.trim();
    const showFlag = flag !== '' && text.startsWith(flag);
    if (showFlag)
        text = text.slice(flag.length).trim();
    return [
        zone,
        showFlag,
        text !== '',
        text === timezoneLocality(zone) ? '' : text,
    ];
}
