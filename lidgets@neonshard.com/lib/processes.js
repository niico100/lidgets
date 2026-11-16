/*
 * Top apps by CPU and RAM, read from /proc. Processes are grouped by name, so
 * a browser's many processes add up to one line.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readText} from './sensors.js';

const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

function listPids() {
    const pids = [];
    try {
        const enumerator = Gio.File.new_for_path('/proc').enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (/^\d+$/.test(name))
                pids.push(name);
        }
        enumerator.close(null);
    } catch {
        // No /proc: report nothing.
    }
    return pids;
}

// The kernel cuts names at 15 characters; recover the rest from the command line.
function fullName(pid, name) {
    if (name.length < 15)
        return name;
    const program = readText(`/proc/${pid}/cmdline`)?.split('\0')[0].split('/').at(-1);
    return program?.startsWith(name) ? program : name;
}

export class ProcessSampler {
    constructor() {
        this._ticks = new Map();
        this._at = null;
        this._cpus = GLib.get_num_processors();
    }

    /*
     * Returns {cpu: [{name, percent}], ram: [{name, bytes}]}, `count` each.
     * CPU is a share of the whole machine since the previous call, so the
     * first call has an empty cpu list.
     */
    sample(count = 5) {
        const now = GLib.get_monotonic_time() / 1e6;
        const elapsed = this._at === null ? 0 : now - this._at;
        const ticks = new Map();
        const cpu = new Map();
        const ram = new Map();

        for (const pid of listPids()) {
            const stat = readText(`/proc/${pid}/stat`);
            if (!stat)
                continue;
            const open = stat.indexOf('(');
            const close = stat.lastIndexOf(')');
            const name = fullName(pid, stat.slice(open + 1, close));
            const fields = stat.slice(close + 2).split(' ');
            const used = Number(fields[11]) + Number(fields[12]);
            ticks.set(pid, used);
            const before = this._ticks.get(pid);
            if (elapsed > 0 && before !== undefined && used > before)
                cpu.set(name, (cpu.get(name) ?? 0) + used - before);

            const pages = Number(readText(`/proc/${pid}/statm`)?.split(' ')[1]);
            if (pages > 0)
                ram.set(name, (ram.get(name) ?? 0) + pages * PAGE_SIZE);
        }

        this._ticks = ticks;
        this._at = now;
        const top = (map, value) => [...map]
            .sort((a, b) => b[1] - a[1])
            .slice(0, count)
            .map(([name, amount]) => ({name, ...value(amount)}));
        return {
            cpu: top(cpu, used => ({percent: used / CLOCK_TICKS / elapsed / this._cpus * 100})),
            ram: top(ram, bytes => ({bytes})),
        };
    }
}
