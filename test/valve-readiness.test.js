'use strict';
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
const originalTimeout = global.setTimeout;
const originalClear = global.clearTimeout;
const timers = new Map();
let timerId = 0;
let initialEntities = [];
class Client extends EventEmitter {
  constructor() { super(); this.entities = initialEntities; this.connected = false; }
  getEntities() { return this.entities; }
  async connect() { this.connected = true; this.emit('connected'); }
  disconnect() { this.connected = false; this.emit('disconnected'); }
}
Module._load = function load(request) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/EspHomeClient') return Client;
  return originalLoad.apply(this, arguments);
};
const Device = require('../drivers/open-air-valve/device');
Module._load = originalLoad;
const Wrapper = require('../lib/EspHomeClient');
global.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
global.clearTimeout = id => timers.delete(id);

const valve = (key, state = { position: 1, currentOperation: 0 }) =>
  ({ key, name: 'Valve', type: 'valve', state });
const sensor = { key: 90, name: 'Humidity', type: 'sensor', state: { state: 55 } };
async function settle(d) { await d._entityQueue; await Promise.resolve(); }
async function fixture(entities = []) {
  initialEntities = entities;
  const d = new Device();
  const values = { onoff: true, measure_valve_closed: false };
  let available = true;
  Object.assign(d, {
    _destroyed: false, _slotTitleFlags: {},
    getStore: () => ({ address: 'unused.invalid' }), getSettings: () => ({}),
    getSetting: () => null, log() {}, error() {},
    homey: { __: key => key },
    getAvailable: () => available,
    setAvailable: async () => { available = true; },
    setUnavailable: async () => { available = false; },
    hasCapability: key => key in values,
    addCapability: async key => { values[key] = null; },
    getCapabilityValue: key => values[key],
    setCapabilityValue: async (key, value) => { values[key] = value; },
    setCapabilityOptions: async () => {},
  });
  await d._initializeClient(); await settle(d);
  return d;
}

async function main() {
  // A connected sensor stream must not make an uncontrollable valve available.
  const d = await fixture([sensor]);
  assert.equal(d.getAvailable(), false);
  assert.throws(() => d._requireValveEntity());
  d.client.emit('stateChanged', { type: 'sensor', entity: sensor, state: { state: 56 } });
  await settle(d); assert.equal(d.getAvailable(), false);

  // Discovery alone is insufficient: cached position is not fresh feedback.
  d.client.emit('entityDiscovered', valve(12, null)); await settle(d);
  assert.equal(d.getAvailable(), false);
  d.client.emit('stateChanged', { type: 'valve', entity: valve(12), state: { position: 1, currentOperation: 0 } });
  await settle(d); assert.equal(d.getAvailable(), true);
  assert.equal(timers.size, 0); assert.doesNotThrow(() => d._requireValveEntity());

  // Reconnect replaces mappings; events from the retired client cannot revive them.
  const oldClient = d.client;
  initialEntities = [];
  await d.reconnect(); await settle(d);
  assert.equal(d.getAvailable(), false); assert.equal(d.entityKeys.valve, null);
  oldClient.emit('entityDiscovered', valve(99));
  oldClient.emit('stateChanged', { type: 'valve', entity: valve(99), state: { position: 0 } });
  oldClient.emit('connected'); await settle(d);
  assert.equal(d.entityKeys.valve, null); assert.equal(d.getAvailable(), false);
  d.client.emit('entityDiscovered', valve(22)); await settle(d);
  assert.equal(d.entityKeys.valve, 22); assert.equal(d.getAvailable(), true);
  await d.onUninit(); assert.equal(timers.size, 0);
  d.client?.emit('connected'); assert.equal(d._valveReady, false);

  // Incomplete discovery retries three times, then stops without a restart loop.
  const missing = await fixture([]);
  for (const expected of [1, 2, 3]) {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); await timer.fn(); await settle(missing);
    assert.equal(missing._discoveryAttempts, expected);
    assert.equal(missing.getAvailable(), false);
  }
  assert.equal(timers.size, 0);
  await missing.onDeleted();

  // A delayed asynchronous state operation cannot make a disconnected device ready.
  const racing = await fixture([]);
  let release;
  const writeValue = racing.setCapabilityValue;
  let firstWrite = true;
  racing.setCapabilityValue = async (key, value) => {
    if (firstWrite) { firstWrite = false; await new Promise(resolve => { release = resolve; }); }
    await writeValue(key, value);
  };
  racing.client.emit('entityDiscovered', valve(32, { position: 0, currentOperation: 0 }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  racing.client.connected = false; racing.client.emit('disconnected');
  assert.equal(typeof release, 'function');
  release();
  await settle(racing);
  assert.equal(racing.getAvailable(), false);
  // Cleanup invalidates all queued work, even if a Homey capability write is in flight.
  await racing.onDeleted(); assert.equal(racing._valveReady, false);

  // The wrapper retires disconnected adapters and owns the reconnect timer.
  const w = new Wrapper({ host: 'unused.invalid', logger: { log() {}, error() {} } });
  const adapter = new EventEmitter(); let retired = false; let states = 0;
  adapter.disconnect = () => { retired = true; };
  w.adapter = adapter; w.connected = true; w._wireAdapterEvents(adapter);
  w.on('stateChanged', () => states++);
  adapter.emit('disconnected');
  assert.equal(retired, true); assert.equal(w.adapter, null); assert.equal(w.connected, false);
  adapter.emit('connected'); adapter.emit('stateChanged', {});
  assert.equal(w.connected, false); assert.equal(states, 0);
  let failures = 0;
  w.connect = async () => { failures++; throw new Error('still offline'); };
  w.maxReconnectAttempts = 3;
  let exhausted = false;
  w.on('reconnectFailed', () => { exhausted = true; });
  while (timers.size) {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); await timer.fn();
  }
  assert.equal(failures, 3); assert.equal(exhausted, true);
  w.disconnect(); assert.equal(timers.size, 0);
  // A longer outage eventually recovers rather than abandoning the first failure.
  const retrying = new Wrapper({ host: 'unused.invalid', logger: { log() {}, error() {} } });
  let attempts = 0;
  retrying.connect = async () => {
    if (++attempts < 3) throw new Error('temporary outage');
    retrying.connected = true; retrying.reconnectAttempts = 0;
  };
  retrying._scheduleReconnect();
  while (timers.size) {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); await timer.fn();
  }
  assert.equal(attempts, 3); assert.equal(retrying.connected, true);
  retrying.disconnect();

  // Disposing a pending handshake cannot publish a connection afterward.
  let completeHandshake; let cancelledAdapter;
  class PendingAdapter extends EventEmitter {
    constructor() { super(); this.entities = new Map(); cancelledAdapter = this; }
    connect() { return new Promise(resolve => { completeHandshake = resolve; }); }
    disconnect() { this.retired = true; }
  }
  const wrapperPath = require.resolve('../lib/EspHomeClient');
  delete require.cache[wrapperPath];
  Module._load = function load(request) {
    if (request === './adapters/ModernAdapter' || request === './adapters/LegacyAdapter') return PendingAdapter;
    return originalLoad.apply(this, arguments);
  };
  const PendingWrapper = require('../lib/EspHomeClient');
  Module._load = originalLoad;
  const pending = new PendingWrapper({ host: 'unused.invalid', logger: { log() {}, error() {} } });
  const connection = pending.connect();
  pending.disconnect(); completeHandshake({ success: true });
  await assert.rejects(connection, /cancelled/);
  assert.equal(pending.connected, false); assert.equal(pending.adapter, null);
  assert.equal(cancelledAdapter.retired, true);
  assert.equal(timers.size, 0);
  console.log('valve readiness and recovery tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.setTimeout = originalTimeout; global.clearTimeout = originalClear;
});
