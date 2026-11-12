const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Actor {
    constructor(props = {}) { Object.assign(this, {visible: true, children: []}, props); }
    add_child(child) { this.children.push(child); }
    destroy_all_children() { this.children = []; }
}
const context = vm.createContext({
    GObject: {registerClass: cls => cls},
    PanelMenu: {Button: class {}},
    St: {BoxLayout: Actor, Label: Actor, Icon: Actor},
    Clutter: {ActorAlign: {CENTER: 0}},
    GLib: {build_filenamev: parts => parts.join('/')},
    Gio: {File: {new_for_path: path => path}, FileIcon: class {}},
    _: text => text,
});
const source = fs.readFileSync('lidgets@neonshard.com/lib/metrics.js', 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export const MetricsIndicator', 'globalThis.MetricsIndicator');
vm.runInContext(source, context);
for (const symbols of [true, false]) {
    let selected = ['cpu', 'gpu:test'];
    let disconnected = false;
    const defs = [{id: 'cpu', name: 'CPU'}, {id: 'gpu:test', name: 'GPU: RTX 4070', label: 'GPU', gpuName: 'RTX 4070', gpuId: 'test', type: 'gpu'}];
    const widget = Object.create(context.MetricsIndicator.prototype);
    Object.assign(widget, {
        _settings: {get_strv: () => [...selected], get_boolean: () => symbols, get_string: () => ''},
        _available: defs, _panelLabels: new Map(), _detailLabels: new Map([['gpu:test', new Actor()]]),
        _panelBox: new Actor(), _iconPath: '/icons',
        _sensors: {available: () => defs, sample: () => ({
            cpu: {short: '12%', detail: '12%'},
            'gpu:test': {short: disconnected ? 'Disconnected' : '64%', detail: '64%', disconnected},
        })},
    });
    widget._rebuildPanel(); widget._tick();
    const gpu = widget._panelLabels.get('gpu:test');
    assert.equal(gpu.metric.visible, true);
    assert.equal(gpu.label.text, symbols ? '64%' : 'GPU 64%');
    disconnected = true; widget._tick();
    assert.equal(gpu.metric.visible, false); // Both name and icon hide together.
    assert.equal(widget._panelLabels.get('cpu').metric.visible, true);
    assert.equal(widget._detailLabels.get('gpu:test').text, 'Disconnected');
    assert.equal(widget._emptyLabel.visible, false);
    assert.deepEqual(selected, ['cpu', 'gpu:test']); // Selection survives unplug.
    selected = ['gpu:test']; widget._rebuildPanel(); widget._tick();
    assert.equal(widget._panelLabels.get('gpu:test').metric.visible, false);
    assert.equal(widget._emptyLabel.visible, true); // Menu remains reachable.
    disconnected = false; widget._tick();
    assert.equal(widget._panelLabels.get('gpu:test').metric.visible, true);
    assert.equal(widget._panelLabels.get('gpu:test').label.text, symbols ? '64%' : 'GPU 64%');
    assert.equal(widget._emptyLabel.visible, false);
}
// Two GPUs: the primary shows while connected, otherwise the other one does.
{
    let primary = 'egpu';
    const state = {egpu: false, igpu: false};
    const defs = ['igpu', 'egpu'].map(gpuId => ({id: `gpu:${gpuId}`, name: `GPU: ${gpuId}`,
        label: 'GPU', gpuName: gpuId, gpuId, type: 'gpu'}));
    const widget = Object.create(context.MetricsIndicator.prototype);
    Object.assign(widget, {
        _settings: {get_strv: () => ['gpu:igpu', 'gpu:egpu'], get_boolean: () => true,
            get_string: () => primary},
        _available: defs, _panelLabels: new Map(), _detailLabels: new Map(),
        _panelBox: new Actor(), _iconPath: '/icons',
        _sensors: {available: () => defs, sample: () => Object.fromEntries(defs.map(def =>
            [def.id, {short: '5%', detail: '5%', disconnected: state[def.gpuId]}]))},
    });
    widget._rebuildPanel(); widget._tick();
    const visible = () => [...widget._panelLabels].filter(([, {metric}]) => metric.visible).map(([id]) => id);
    assert.deepEqual(visible(), ['gpu:egpu']);
    state.egpu = true; widget._tick();
    assert.deepEqual(visible(), ['gpu:igpu']);
    state.egpu = false; primary = 'igpu'; widget._tick();
    assert.deepEqual(visible(), ['gpu:igpu']);
}
console.log('Panel hides disconnected GPUs, preserves dropdown status and restores reconnected GPUs.');
