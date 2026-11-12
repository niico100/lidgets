/* Per-device GPU metrics. Keep remembered devices when removable GPUs vanish. */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const INTERVAL_US = 5 * 1e6;
const TYPES = ['gpu', 'gpu-freq', 'gpu-temp', 'vram'];
const N_ = text => text;
const TITLES = {gpu: N_('GPU load'), 'gpu-freq': N_('GPU clock'),
    'gpu-temp': N_('GPU temperature'), vram: N_('Video memory used')};

export class GpuSensors {
    constructor(settings, io) {
        this._settings = settings;
        this._io = io;
        this._known = new Map();
        this._present = new Map();
        this._cache = new Map();
        this._scanAt = null;
        this._queryAt = null;
        this._pending = false;
        this._proc = null;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._smi = GLib.find_program_in_path('nvidia-smi');
        this._pciIds = null;
        this._pciNames = new Map();
        try {
            const saved = JSON.parse(settings?.get_string('metrics-known-gpus') ?? '[]');
            for (const gpu of saved) {
                if (typeof gpu.id === 'string' && typeof gpu.name === 'string' &&
                    Array.isArray(gpu.types) && gpu.types.every(type => TYPES.includes(type)))
                    this._known.set(gpu.id, {id: gpu.id, name: gpu.name, types: gpu.types});
            }
        } catch {
            // Invalid externally edited metadata must not break the widget.
        }
        this._discover();
        this._migrateSelection();
    }

    _pciName(vendor, device) {
        const key = `${vendor}:${device}`;
        if (this._pciNames.has(key))
            return this._pciNames.get(key);
        if (this._pciIds === null) {
            this._pciIds = this._io.readText('/usr/share/hwdata/pci.ids') ??
                this._io.readText('/usr/share/misc/pci.ids') ?? '';
        }
        let inVendor = false;
        for (const line of this._pciIds.split('\n')) {
            if (/^[0-9a-f]{4}  /i.test(line))
                inVendor = line.slice(0, 4).toLowerCase() === vendor;
            else if (inVendor && line.startsWith(`\t${device}  `)) {
                const name = line.slice(7).trim().match(/\[(.+)\]/)?.[1] ?? line.slice(7).trim();
                this._pciNames.set(key, name);
                return name;
            }
        }
        return `${vendor === '1002' ? 'AMD' : vendor === '8086' ? 'Intel' : 'GPU'} ${device}`;
    }

    /*
     * Integrated GPUs share one PCI id across models ("Radeon 740M / 760M /
     * 780M Graphics"); the CPU name says which one this is.
     */
    _shortName(name) {
        if (name.includes(' / ')) {
            this._cpuGpu ??= this._io.readText('/proc/cpuinfo')
                ?.match(/^model name\s*:.*\bw\/ (Radeon [^\n]+)$/m)?.[1]?.trim() ?? '';
            name = this._cpuGpu || name.split(' / ')[0];
        }
        return name.replace(/ Graphics$/, '');
    }

        _discover() {
        const now = GLib.get_monotonic_time();
        if (this._scanAt !== null && now - this._scanAt < INTERVAL_US)
            return;
        this._scanAt = now;
        const present = new Map();
        for (const card of this._io.listDir('/sys/class/drm')) {
            if (!/^card\d+$/.test(card))
                continue;
            const base = `/sys/class/drm/${card}/device`;
            const event = this._io.readText(`${base}/uevent`) ?? '';
            const slot = event.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
            const pci = event.match(/^PCI_ID=([\da-f]+):([\da-f]+)$/im);
            if (!slot || !pci)
                continue;
            const vendor = pci[1].toLowerCase();
            const device = pci[2].toLowerCase();
            const info = this._io.readText(`/proc/driver/nvidia/gpus/${slot}/information`) ?? '';
            const uuid = info.match(/^GPU UUID:\s*(\S+)/m)?.[1];
            const name = this._shortName((info.match(/^Model:\s*(.+)$/m)?.[1]?.trim() ??
                this._pciName(vendor, device)).replace(/^NVIDIA (?:GeForce )?/, ''));
            const id = uuid ?? `${vendor}-${device}-${slot}`;
            const tempPath = this._io.listDir(`${base}/hwmon`)
                .map(entry => `${base}/hwmon/${entry}/temp1_input`)
                .find(path => this._io.readNumber(path) !== null);
            const freqPath = ['gt_act_freq_mhz', 'gt/gt0/rps_act_freq_mhz']
                .map(rel => `/sys/class/drm/${card}/${rel}`)
                .find(path => this._io.readNumber(path) !== null);
            const kind = vendor === '10de' && this._smi && uuid ? 'nvidia'
                : this._io.readNumber(`${base}/gpu_busy_percent`) !== null ? 'amd'
                    : freqPath ? 'intel' : 'unknown';
            const types = [];
            if (kind === 'nvidia' || kind === 'amd')
                types.push('gpu', 'vram');
            if (freqPath)
                types.push('gpu-freq');
            if (tempPath || kind === 'nvidia')
                types.push('gpu-temp');
            // Even unsupported devices get an explicit unavailable load row.
            if (types.length === 0)
                types.push('gpu');
            // Enabled outputs mark the GPU driving the screens.
            const displays = this._io.listDir('/sys/class/drm')
                .filter(entry => entry.startsWith(`${card}-`))
                .filter(entry => this._io.readText(`/sys/class/drm/${entry}/enabled`)?.trim() === 'enabled')
                .length;
            const previous = this._known.get(id);
            const rememberedTypes = [...new Set([...(previous?.types ?? []), ...types])];
            this._known.set(id, {id, name, types: rememberedTypes});
            present.set(id, {id, name, kind, base, tempPath, freqPath, displays});
        }
        // Dropping cached data prevents a removed/reconnected GPU showing stale load.
        for (const id of this._present.keys()) {
            if (!present.has(id))
                this._cache.delete(id);
        }
        this._present = present;
        const saved = JSON.stringify([...this._known.values()]);
        if (this._settings && saved !== this._settings.get_string('metrics-known-gpus'))
            this._settings.set_string('metrics-known-gpus', saved);
    }

    _migrateSelection() {
        if (!this._settings)
            return;
        const selected = this._settings.get_strv('metrics-show');
        // Preserve the old AMD -> Intel -> NVIDIA preference for existing users.
        const preferred = [...this._present.values()].sort((a, b) =>
            ['amd', 'intel', 'nvidia', 'unknown'].indexOf(a.kind) -
            ['amd', 'intel', 'nvidia', 'unknown'].indexOf(b.kind));
        const migrated = selected.map(id => {
            if (!TYPES.includes(id))
                return id;
            const gpu = preferred.find(candidate => this._known.get(candidate.id).types.includes(id));
            return gpu ? `${id}:${gpu.id}` : id;
        });
        if (JSON.stringify(selected) !== JSON.stringify(migrated))
            this._settings.set_strv('metrics-show', [...new Set(migrated)]);
    }

    /*
     * The GPU to show when no primary is chosen: the one driving the most
     * displays, then a discrete NVIDIA card. Integrated AMD VRAM is a BIOS
     * carve-out, so its size says nothing about which GPU is bigger.
     */
    autoPrimary() {
        const rank = gpu => gpu.displays * 2 + (gpu.kind === 'nvidia' ? 1 : 0);
        return [...this._present.values()].sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
    }

    available() {
        const gpus = [...this._known.values()];
        return gpus.flatMap(gpu => {
            const sameName = gpus.filter(candidate => candidate.name === gpu.name);
            const name = sameName.length > 1
                ? `${gpu.name} (${sameName.indexOf(gpu) + 1})` : gpu.name;
            return gpu.types.map(type => ({
                id: `${type}:${gpu.id}`,
                name: `${type === 'vram' ? 'VRAM' : 'GPU'}: ${name}`,
                title: TITLES[type], gpuName: name, gpuId: gpu.id, type,
                // Panel text stays as short as the CPU label; the dropdown names the device.
                label: type === 'vram' ? 'VRAM' : 'GPU',
                icon: type === 'gpu-temp' ? 'temperature-symbolic.svg'
                    : type === 'vram' ? 'memory-symbolic.svg' : 'gpu-symbolic.svg',
            }));
        });
    }

    _refreshNvidia() {
        if (this._pending || ![...this._present.values()].some(gpu => gpu.kind === 'nvidia'))
            return;
        const now = GLib.get_monotonic_time();
        if (this._queryAt !== null && now - this._queryAt < INTERVAL_US)
            return;
        this._queryAt = now;
        this._pending = true;
        try {
            const proc = Gio.Subprocess.new([this._smi,
                '--query-gpu=uuid,utilization.gpu,memory.used,memory.total,temperature.gpu',
                '--format=csv,noheader,nounits'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._proc = proc;
            proc.communicate_utf8_async(null, this._cancellable, (source, result) => {
                let stdout = '';
                try {
                    const [, output] = source.communicate_utf8_finish(result);
                    if (source.get_successful())
                        stdout = output ?? '';
                } catch {
                    // A removed GPU, failed query or cancellation has no reading.
                }
                this._proc = null;
                this._pending = false;
                if (this._destroyed)
                    return;
                this._cache.clear();
                for (const line of stdout.trim().split('\n')) {
                    const [id, ...fields] = line.split(',').map(field => field.trim());
                    const [util, used, total, temp] = fields.map(field =>
                        field === '' ? NaN : Number(field));
                    if (this._present.has(id))
                        this._cache.set(id, {util, used: used * 1048576, total: total * 1048576, temp});
                }
            });
        } catch {
            this._pending = false;
            this._cache.clear();
        }
    }

    sample() {
        this._discover();
        this._migrateSelection();
        this._refreshNvidia();
        const out = {};
        const {readNumber, formatBytes} = this._io;
        for (const known of this._known.values()) {
            const gpu = this._present.get(known.id);
            const put = (type, short, detail = short) => {
                out[`${type}:${known.id}`] = {short, detail, disconnected: !gpu};
            };
            for (const type of known.types)
                put(type, gpu ? '--' : 'Disconnected');
            if (!gpu)
                continue;
            const nv = this._cache.get(gpu.id);
            const util = gpu.kind === 'nvidia' ? nv?.util : readNumber(`${gpu.base}/gpu_busy_percent`);
            if (Number.isFinite(util))
                put('gpu', `${Math.round(util)}%`);
            const used = gpu.kind === 'nvidia' ? nv?.used : readNumber(`${gpu.base}/mem_info_vram_used`);
            const total = gpu.kind === 'nvidia' ? nv?.total : readNumber(`${gpu.base}/mem_info_vram_total`);
            if (Number.isFinite(used))
                put('vram', formatBytes(used), total > 0
                    ? `${formatBytes(used)} of ${formatBytes(total)}  (${Math.round(100 * used / total)}%)`
                    : formatBytes(used));
            const temp = gpu.tempPath ? readNumber(gpu.tempPath) : null;
            const celsius = temp !== null ? temp / 1000 : nv?.temp;
            if (Number.isFinite(celsius))
                put('gpu-temp', `${Math.round(celsius)}°C`);
            const mhz = gpu.freqPath ? readNumber(gpu.freqPath) : null;
            if (mhz !== null)
                put('gpu-freq', `${Math.round(mhz)}MHz`);
        }
        return out;
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        try {
            this._proc?.force_exit();
        } catch {
            // The process may already have exited.
        }
        this._proc = null;
    }
}
