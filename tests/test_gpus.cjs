// Exercise device discovery and asynchronous NVIDIA sampling without touching hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 1;
let pending;
let spawnFailure = false;
let commands = [];
const Gio = {
    Cancellable: class { cancel() {} },
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_SILENCE: 2},
    Subprocess: {new(args) {
        if (spawnFailure) throw Error('unplugged');
        commands.push(args);
        return {communicate_utf8_async(_input, _cancel, callback) { pending = callback; },
            force_exit() {}};
    }},
};
const GLib = {get_monotonic_time: () => now, find_program_in_path: () => '/usr/bin/nvidia-smi'};
const source = fs.readFileSync('lidgets@neonshard.com/lib/gpus.js', 'utf8')
    .replace(/^import .*;$/gm, '').replace('export class GpuSensors', 'class GpuSensors');
const context = vm.createContext({Gio, GLib});
vm.runInContext(`${source}\nglobalThis.GpuSensors = GpuSensors;`, context);
const {GpuSensors} = context;
let files = new Map();
let dirs = new Map();
const io = {
    readText: path => files.get(path) ?? null,
    readNumber: path => files.has(path) ? Number(files.get(path)) : null,
    listDir: path => dirs.get(path) ?? [],
    formatBytes: bytes => `${bytes}B`,
};
let values = {'metrics-known-gpus': '[]', 'metrics-show': ['gpu', 'gpu-temp', 'vram', 'cpu']};
const settings = {
    get_string: key => values[key], set_string: (key, value) => { values[key] = value; },
    get_strv: key => [...values[key]], set_strv: (key, value) => { values[key] = [...value]; },
};
function add(card, vendor, device, slot, uuid, name) {
    dirs.set('/sys/class/drm', [...(dirs.get('/sys/class/drm') ?? []), card]);
    const base = `/sys/class/drm/${card}/device`;
    files.set(`${base}/uevent`, `PCI_SLOT_NAME=${slot}\nPCI_ID=${vendor}:${device}\n`);
    if (uuid)
        files.set(`/proc/driver/nvidia/gpus/${slot}/information`, `Model: ${name}\nGPU UUID: ${uuid}\n`);
    else {
        files.set(`${base}/gpu_busy_percent`, '2');
        files.set(`${base}/mem_info_vram_used`, '100');
        files.set(`${base}/mem_info_vram_total`, '1000');
        dirs.set(`${base}/hwmon`, ['hwmon7']);
        files.set(`${base}/hwmon/hwmon7/temp1_input`, '42000');
    }
}
function query(output, successful = true) {
    assert.ok(pending);
    const callback = pending;
    pending = null;
    callback({communicate_utf8_finish: () => [true, output], get_successful: () => successful}, {});
}
function advance() { now += 6e6; }
files.set('/usr/share/hwdata/pci.ids', '1002  AMD\n\t15bf  Radeon 780M\n');
add('card0', '10DE', '2786', '0000:01:00.0', 'GPU-4070', 'NVIDIA GeForce RTX 4070');
add('card1', '1002', '15BF', '0000:65:00.0');
add('card2', '10DE', '2786', '0000:02:00.0', 'GPU-second', 'NVIDIA GeForce RTX 4070');
const sensors = new GpuSensors(settings, io);
assert.equal(sensors.available().length, 9);
assert.ok(sensors.available().some(def => def.gpuName.includes('4070')));
assert.ok(sensors.available().some(def => def.gpuName === 'Radeon 780M'));
assert.equal(values['metrics-show'][0], 'gpu:1002-15bf-0000:65:00.0');
let readings = sensors.sample();
assert.equal(readings['gpu:1002-15bf-0000:65:00.0'].short, '2%');
assert.equal(readings['gpu-temp:1002-15bf-0000:65:00.0'].short, '42°C');
assert.equal(commands.length, 1); // One query for every NVIDIA card.
query('GPU-second, 18, 100, 1000, N/A\nGPU-4070, 64, 500, 8000, 55\n');
readings = sensors.sample();
assert.equal(readings['gpu:GPU-4070'].short, '64%');
assert.equal(readings['gpu:GPU-second'].short, '18%');
assert.equal(readings['gpu-temp:GPU-second'].short, '--');
assert.equal(readings['gpu-temp:GPU-4070'].short, '55°C');
assert.equal(commands.length, 1); // Cache reused between queries.
values['metrics-show'] = ['gpu:GPU-4070'];
dirs.set('/sys/class/drm', ['card1']);
advance();
readings = sensors.sample();
assert.equal(readings['gpu:GPU-4070'].short, 'Disconnected');
assert.equal(readings['gpu:GPU-4070'].disconnected, true);
assert.equal(values['metrics-show'][0], 'gpu:GPU-4070');
const restarted = new GpuSensors(settings, io);
assert.equal(restarted.sample()['gpu:GPU-4070'].short, 'Disconnected');
// Reconnect with a different DRM number and PCI address. UUID preserves selection.
add('card7', '10DE', '2786', '0000:04:00.0', 'GPU-4070', 'NVIDIA GeForce RTX 4070');
advance();
readings = sensors.sample();
assert.equal(readings['gpu:GPU-4070'].short, '--'); // No stale 64%.
query('GPU-4070, 93, 900, 8000, 65\n');
assert.equal(sensors.sample()['gpu:GPU-4070'].short, '93%');
// Failures and malformed output cannot fabricate an idle 0% reading.
advance(); sensors.sample(); query('', false);
assert.equal(sensors.sample()['gpu:GPU-4070'].short, '--');
advance(); sensors.sample(); query('GPU-4070, , N/A, N/A, N/A\n');
assert.equal(sensors.sample()['gpu:GPU-4070'].short, '--');
advance(); spawnFailure = true;
assert.equal(sensors.sample()['gpu:GPU-4070'].short, '--');
spawnFailure = false;
// A query completing after unplug must not resurrect a disconnected GPU.
advance(); sensors.sample();
dirs.set('/sys/class/drm', ['card1']); advance(); sensors.sample();
query('GPU-4070, 88, 500, 8000, 55\n');
assert.equal(sensors.sample()['gpu:GPU-4070'].short, 'Disconnected');
sensors.destroy(); restarted.destroy();
values['metrics-known-gpus'] = '{invalid';
assert.doesNotThrow(() => new GpuSensors(settings, io).destroy());
console.log('GPU discovery, multi-card sampling, migration, unplug/reconnect and failure checks passed.');
