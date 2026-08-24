/*
 * Hardware sampling for the metrics widget.
 *
 * Everything here reads /proc and /sys, which are memory-backed: a read costs
 * a few microseconds and never touches the disk, so sampling synchronously on
 * the compositor thread is safe. The one exception is free space, which can
 * hit a real filesystem, so it is queried asynchronously and cached.
 *
 * This module imports only GLib/Gio -- no shell APIs -- so prefs.js can import
 * it too and offer exactly the metrics this machine can actually provide.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return null;
    }
}

function readNumber(path) {
    const text = readText(path);
    if (text === null)
        return null;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : null;
}

function listDir(path) {
    const names = [];
    try {
        const enumerator = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
        enumerator.close(null);
    } catch {
        // Missing or unreadable directory; callers treat this as "no sensor".
    }
    return names.sort();
}

export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined)
        return '--';
    const units = ['B', 'K', 'M', 'G', 'T', 'P'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const rounded = value >= 100 || unit === 0
        ? Math.round(value).toString()
        : value.toFixed(1);
    return `${rounded}${units[unit]}`;
}

/*
 * nvidia-smi takes on the order of 100-300ms, so it must not run at the
 * panel's own sampling rate. Five seconds is frequent enough for a load
 * readout and cheap enough not to matter.
 */
const NVIDIA_MIN_INTERVAL_US = 5 * 1e6;

function formatRate(bytesPerSecond) {
    return `${formatBytes(bytesPerSecond)}/s`;
}

/*
 * A no-op marker so xgettext collects these titles. They cannot be translated
 * here: this module is imported by the preferences process too, which has no
 * access to the shell's gettext. Callers wrap them with _() at display time.
 */
const N_ = text => text;

/*
 * Every metric the widget knows about. `id` is what lands in the
 * metrics-show setting, `name` is the prefix shown in the panel, and `title`
 * is the longer form used in the dropdown and in prefs.
 */
export const METRIC_DEFS = [
    {id: 'cpu', name: 'CPU', title: N_('CPU load')},
    {id: 'cpu-temp', name: 'CPU', title: N_('CPU temperature')},
    {id: 'gpu', name: 'GPU', title: N_('GPU load')},
    {id: 'gpu-freq', name: 'GPU', title: N_('GPU clock')},
    {id: 'gpu-temp', name: 'GPU', title: N_('GPU temperature')},
    {id: 'vram', name: 'VRAM', title: N_('Video memory used')},
    {id: 'ram', name: 'RAM', title: N_('Memory used')},
    {id: 'swap', name: 'SWAP', title: N_('Swap used')},
    {id: 'disk', name: 'DISK', title: N_('Free space')},
    {id: 'net', name: 'NET', title: N_('Network throughput')},
    {id: 'fan', name: 'FAN', title: N_('Fan speed')},
    {id: 'battery', name: 'BAT', title: N_('Battery')},
];

export class Sensors {
    constructor() {
        this._hwmon = this._findHwmon();
        this._gpu = this._findGpu();
        this._cpuTemp = this._findCpuTemp();
        this._gpuTemp = this._findGpuTemp();
        this._fan = this._findFan();
        this._battery = this._findBattery();

        this._prevCpu = null;
        this._prevNet = null;
        this._diskCache = null;
        this._diskPending = false;
        this._diskMount = '/';
        this._nvidiaCache = null;
        this._nvidiaPending = false;
        this._nvidiaAt = 0;
    }

    /* ------------------------------------------------------------ discovery */

    _findHwmon() {
        const map = {};
        for (const entry of listDir('/sys/class/hwmon')) {
            const path = `/sys/class/hwmon/${entry}`;
            const name = readText(`${path}/name`);
            if (name) {
                // First device wins; duplicate names (multiple nvme, say) are
                // rare and the first is as good a choice as any.
                const key = name.trim();
                if (!(key in map))
                    map[key] = path;
            }
        }
        return map;
    }

    /*
     * The three GPU vendors expose completely different things:
     *
     *   amd    - load and VRAM straight from sysfs, free and instant
     *   intel  - no load counter in sysfs at all (it needs perf counters, the
     *            way intel_gpu_top does), but the actual clock is readable
     *   nvidia - nothing useful in sysfs; only nvidia-smi reports load, and
     *            that costs a subprocess, so it is sampled on a slower clock
     *
     * Detection returns a backend descriptor rather than a path so sample()
     * can branch once, and available() can advertise only what each vendor
     * can really answer.
     */
    _findGpu() {
        for (const entry of listDir('/sys/class/drm')) {
            if (!/^card\d+$/.test(entry))
                continue;
            const base = `/sys/class/drm/${entry}/device`;
            if (GLib.file_test(`${base}/gpu_busy_percent`, GLib.FileTest.EXISTS))
                return {kind: 'amd', base};
        }

        for (const entry of listDir('/sys/class/drm')) {
            if (!/^card\d+$/.test(entry))
                continue;
            // i915 exposes gt_act_freq_mhz; the newer xe driver moved it.
            for (const rel of ['gt_act_freq_mhz', 'gt/gt0/rps_act_freq_mhz']) {
                const path = `/sys/class/drm/${entry}/${rel}`;
                if (GLib.file_test(path, GLib.FileTest.EXISTS))
                    return {kind: 'intel', freqPath: path};
            }
        }

        /*
         * nvidia-smi is often installed on machines with no NVIDIA card at
         * all (it ships with CUDA tooling), so require the driver to have
         * actually bound a GPU before believing it.
         */
        const smi = GLib.find_program_in_path('nvidia-smi');
        if (smi && listDir('/proc/driver/nvidia/gpus').length > 0)
            return {kind: 'nvidia', smi};

        return null;
    }

    /*
     * On AMD, k10temp exposes Tctl (a control value that can read high) and
     * sometimes Tccd. Prefer a die sensor when labelled, otherwise temp1.
     * Intel's coretemp and the ACPI thermal zone are the fallbacks.
     */
    _findCpuTemp() {
        for (const name of ['k10temp', 'coretemp', 'zenpower',
            'cpu_thermal', 'nct6775', 'it87', 'acpitz']) {
            const path = this._hwmon[name];
            if (!path)
                continue;
            const preferred = this._findLabelledTemp(path, /Tccd|Package|Core 0/i);
            if (preferred)
                return preferred;
            const generic = this._findTempInput(path);
            if (generic)
                return generic;
        }
        return null;
    }

    _findLabelledTemp(hwmonPath, pattern) {
        if (!hwmonPath)
            return null;
        for (const entry of listDir(hwmonPath)) {
            const match = entry.match(/^(temp\d+)_label$/);
            if (!match)
                continue;
            const label = readText(`${hwmonPath}/${entry}`);
            if (label && pattern.test(label.trim())) {
                const input = `${hwmonPath}/${match[1]}_input`;
                if (GLib.file_test(input, GLib.FileTest.EXISTS))
                    return input;
            }
        }
        return null;
    }

    /*
     * NVIDIA reports its own temperature through nvidia-smi, so it is absent
     * here on purpose -- sample() fills gpu-temp in from the same query that
     * gives it load and memory.
     */
    _findGpuTemp() {
        for (const name of ['amdgpu', 'i915', 'xe', 'nouveau']) {
            const found = this._findTempInput(this._hwmon[name]);
            if (found)
                return found;
        }
        return null;
    }

    _findTempInput(hwmonPath) {
        if (!hwmonPath)
            return null;
        for (const entry of listDir(hwmonPath)) {
            if (/^temp\d+_input$/.test(entry))
                return `${hwmonPath}/${entry}`;
        }
        return null;
    }

    _findFan() {
        for (const name of ['gpdfan', 'amdgpu', 'thinkpad', 'dell_smm',
            'nct6775', 'it87', 'applesmc', 'acpi_fan']) {
            const path = this._hwmon[name];
            if (!path)
                continue;
            for (const entry of listDir(path)) {
                if (/^fan\d+_input$/.test(entry))
                    return `${path}/${entry}`;
            }
        }
        return null;
    }

    _findBattery() {
        for (const entry of listDir('/sys/class/power_supply')) {
            const path = `/sys/class/power_supply/${entry}`;
            const type = readText(`${path}/type`);
            if (type && type.trim() === 'Battery' &&
                GLib.file_test(`${path}/capacity`, GLib.FileTest.EXISTS))
                return path;
        }
        return null;
    }

    /*
     * Metric ids this machine can actually populate. Prefs uses this to hide
     * switches for sensors that would only ever read "--".
     */
    available() {
        const ok = new Set(['cpu', 'ram', 'disk', 'net']);

        // A swapless machine should not get a row that permanently reads "off".
        const mem = this._sampleMem();
        if (mem && mem.swapTotal > 0)
            ok.add('swap');

        switch (this._gpu?.kind) {
        case 'amd':
            ok.add('gpu').add('vram');
            break;
        case 'nvidia':
            ok.add('gpu').add('vram');
            break;
        case 'intel':
            // No load counter available; the clock is the honest substitute.
            ok.add('gpu-freq');
            break;
        }

        if (this._cpuTemp)
            ok.add('cpu-temp');
        if (this._gpuTemp || this._gpu?.kind === 'nvidia')
            ok.add('gpu-temp');
        if (this._fan)
            ok.add('fan');
        if (this._battery)
            ok.add('battery');
        return METRIC_DEFS.filter(def => ok.has(def.id));
    }

    /* -------------------------------------------------------------- sampling */

    setDiskMount(mount) {
        if (mount !== this._diskMount) {
            this._diskMount = mount || '/';
            this._diskCache = null;
        }
    }

    _sampleCpu() {
        const text = readText('/proc/stat');
        if (!text)
            return null;
        const line = text.split('\n', 1)[0];
        const fields = line.trim().split(/\s+/).slice(1).map(Number);
        if (fields.length < 4)
            return null;

        // user nice system idle iowait irq softirq steal ...
        const idle = fields[3] + (fields[4] ?? 0);
        const total = fields.reduce((sum, value) => sum + value, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};

        if (!prev)
            return null;
        const deltaTotal = total - prev.total;
        const deltaIdle = idle - prev.idle;
        if (deltaTotal <= 0)
            return null;
        return Math.max(0, Math.min(100,
            Math.round(100 * (deltaTotal - deltaIdle) / deltaTotal)));
    }

    _sampleMem() {
        const text = readText('/proc/meminfo');
        if (!text)
            return null;
        const values = {};
        for (const line of text.split('\n')) {
            const match = line.match(/^(\w+):\s+(\d+) kB$/);
            if (match)
                values[match[1]] = Number(match[2]) * 1024;
        }
        const memTotal = values.MemTotal ?? 0;
        // MemAvailable is the kernel's own estimate of what a new workload
        // could claim; it is a far better "used" baseline than MemFree.
        const memUsed = memTotal - (values.MemAvailable ?? values.MemFree ?? 0);
        const swapTotal = values.SwapTotal ?? 0;
        const swapUsed = swapTotal - (values.SwapFree ?? 0);
        return {memTotal, memUsed, swapTotal, swapUsed};
    }

    _sampleNet() {
        const text = readText('/proc/net/dev');
        if (!text)
            return null;
        let rx = 0;
        let tx = 0;
        for (const line of text.split('\n').slice(2)) {
            const match = line.match(/^\s*([\w.-]+):\s*(.*)$/);
            if (!match)
                continue;
            // Loopback and virtual bridges are local noise, not throughput.
            if (/^(lo|docker|veth|virbr|br-|podman)/.test(match[1]))
                continue;
            const fields = match[2].trim().split(/\s+/).map(Number);
            rx += fields[0] ?? 0;
            tx += fields[8] ?? 0;
        }

        const now = GLib.get_monotonic_time();
        const prev = this._prevNet;
        this._prevNet = {rx, tx, now};

        if (!prev)
            return null;
        const seconds = (now - prev.now) / 1e6;
        if (seconds <= 0)
            return null;
        return {
            rx: Math.max(0, (rx - prev.rx) / seconds),
            tx: Math.max(0, (tx - prev.tx) / seconds),
        };
    }

    /*
     * Free space can block on a real filesystem, so it is refreshed off the
     * main loop and the previous answer is reused until the new one lands.
     */
    _refreshDiskAsync() {
        if (this._diskPending)
            return;
        this._diskPending = true;
        const file = Gio.File.new_for_path(this._diskMount);
        file.query_filesystem_info_async(
            'filesystem::free,filesystem::size',
            GLib.PRIORITY_LOW, null, (source, result) => {
                this._diskPending = false;
                try {
                    const info = source.query_filesystem_info_finish(result);
                    this._diskCache = {
                        free: info.get_attribute_uint64('filesystem::free'),
                        size: info.get_attribute_uint64('filesystem::size'),
                    };
                } catch {
                    this._diskCache = null;
                }
            });
    }

    /*
     * NVIDIA needs a subprocess, which is far too expensive to run at the
     * panel's sampling rate, so it gets its own slower clock and the last
     * answer is reused in between. One query returns every NVIDIA figure.
     */
    _refreshNvidiaAsync() {
        if (this._nvidiaPending)
            return;

        const now = GLib.get_monotonic_time();
        if (this._nvidiaAt !== 0 && now - this._nvidiaAt < NVIDIA_MIN_INTERVAL_US)
            return;

        this._nvidiaPending = true;
        try {
            const proc = Gio.Subprocess.new([
                this._gpu.smi,
                '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
                '--format=csv,noheader,nounits',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);

            proc.communicate_utf8_async(null, null, (source, result) => {
                this._nvidiaPending = false;
                this._nvidiaAt = GLib.get_monotonic_time();
                try {
                    const [, stdout] = source.communicate_utf8_finish(result);
                    const [util, used, total, temp] = stdout.trim().split('\n')[0]
                        .split(',').map(field => Number(field.trim()));
                    this._nvidiaCache = Number.isFinite(util)
                        ? {util, used: used * 1024 * 1024, total: total * 1024 * 1024, temp}
                        : null;
                } catch {
                    this._nvidiaCache = null;
                }
            });
        } catch {
            // Spawning failed outright; stop trying until the next interval.
            this._nvidiaPending = false;
            this._nvidiaAt = now;
            this._nvidiaCache = null;
        }
    }

    /*
     * Returns {id: {short, detail}} for every available metric. `short` is the
     * compact panel form; `detail` is the fuller dropdown form.
     */
    sample() {
        const out = {};
        const put = (id, short, detail) => {
            out[id] = {short, detail: detail ?? short};
        };

        const cpu = this._sampleCpu();
        put('cpu', cpu === null ? '--' : `${cpu}%`);

        const mem = this._sampleMem();
        if (mem && mem.memTotal > 0) {
            const percent = Math.round(100 * mem.memUsed / mem.memTotal);
            put('ram', `${percent}%`,
                `${percent}%  (${formatBytes(mem.memUsed)} of ${formatBytes(mem.memTotal)})`);
            if (mem.swapTotal > 0) {
                const swapPercent = Math.round(100 * mem.swapUsed / mem.swapTotal);
                put('swap', `${swapPercent}%`,
                    `${swapPercent}%  (${formatBytes(mem.swapUsed)} of ${formatBytes(mem.swapTotal)})`);
            } else {
                put('swap', 'off');
            }
        } else {
            put('ram', '--');
            put('swap', '--');
        }

        this._refreshDiskAsync();
        if (this._diskCache) {
            const {free, size} = this._diskCache;
            const usedPercent = size > 0
                ? Math.round(100 * (size - free) / size) : 0;
            put('disk', formatBytes(free),
                `${formatBytes(free)} free of ${formatBytes(size)}  (${usedPercent}% used)  on ${this._diskMount}`);
        } else {
            put('disk', '--');
        }

        switch (this._gpu?.kind) {
        case 'amd': {
            const busy = readNumber(`${this._gpu.base}/gpu_busy_percent`);
            put('gpu', busy === null ? '--' : `${Math.round(busy)}%`);

            const used = readNumber(`${this._gpu.base}/mem_info_vram_used`);
            const total = readNumber(`${this._gpu.base}/mem_info_vram_total`);
            if (used !== null && total) {
                put('vram', formatBytes(used),
                    `${formatBytes(used)} of ${formatBytes(total)}  (${Math.round(100 * used / total)}%)`);
            } else if (used !== null) {
                put('vram', formatBytes(used));
            } else {
                put('vram', '--');
            }
            break;
        }
        case 'intel': {
            const mhz = readNumber(this._gpu.freqPath);
            put('gpu-freq', mhz === null ? '--' : `${Math.round(mhz)}MHz`);
            break;
        }
        case 'nvidia': {
            this._refreshNvidiaAsync();
            const nv = this._nvidiaCache;
            put('gpu', nv ? `${Math.round(nv.util)}%` : '--');
            if (nv && nv.total > 0) {
                put('vram', formatBytes(nv.used),
                    `${formatBytes(nv.used)} of ${formatBytes(nv.total)}  (${Math.round(100 * nv.used / nv.total)}%)`);
            } else {
                put('vram', '--');
            }
            if (nv && Number.isFinite(nv.temp))
                put('gpu-temp', `${Math.round(nv.temp)}°C`);
            break;
        }
        }

        for (const [id, path] of [['cpu-temp', this._cpuTemp], ['gpu-temp', this._gpuTemp]]) {
            if (!path)
                continue;
            const milli = readNumber(path);
            put(id, milli === null ? '--' : `${Math.round(milli / 1000)}°C`);
        }

        if (this._fan) {
            const rpm = readNumber(this._fan);
            put('fan', rpm === null ? '--' : `${Math.round(rpm)}rpm`);
        }

        const net = this._sampleNet();
        if (net) {
            put('net', `↓${formatBytes(net.rx)} ↑${formatBytes(net.tx)}`,
                `down ${formatRate(net.rx)}   up ${formatRate(net.tx)}`);
        } else {
            put('net', '↓-- ↑--');
        }

        if (this._battery) {
            const capacity = readNumber(`${this._battery}/capacity`);
            const status = (readText(`${this._battery}/status`) ?? '').trim();
            const charging = status === 'Charging' ? '⚡' : '';
            put('battery',
                capacity === null ? '--' : `${charging}${Math.round(capacity)}%`,
                capacity === null ? '--' : `${Math.round(capacity)}%  (${status || 'unknown'})`);
        }

        return out;
    }
}

/*
 * Mount points worth offering in prefs: real, writable filesystems, skipping
 * the pseudo and container mounts that would only confuse the list.
 */
export function listMountPoints() {
    const text = readText('/proc/mounts');
    if (!text)
        return ['/'];

    const skipTypes = new Set([
        'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'securityfs',
        'cgroup', 'cgroup2', 'pstore', 'efivarfs', 'bpf', 'autofs',
        'hugetlbfs', 'mqueue', 'debugfs', 'tracefs', 'fusectl',
        'configfs', 'ramfs', 'binfmt_misc', 'squashfs', 'nsfs', 'overlay',
        'rpc_pipefs', 'selinuxfs', 'fuse.gvfsd-fuse', 'fuse.portal',
    ]);

    const mounts = new Set(['/']);
    for (const line of text.split('\n')) {
        const [, target, type] = line.split(/\s+/);
        if (!target || !type || skipTypes.has(type))
            continue;
        if (target.startsWith('/proc') || target.startsWith('/sys') ||
            target.startsWith('/dev') || target.startsWith('/run'))
            continue;
        // /proc/mounts octal-escapes spaces and friends.
        mounts.add(target.replace(/\\040/g, ' '));
    }
    return [...mounts].sort();
}
