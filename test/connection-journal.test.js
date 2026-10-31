'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { clients, installClientStubs } = require('./helpers');

const originalLoad = Module._load;
class Client extends EventEmitter {
  constructor() { super(); Client.instances.push(this); this.connected = false; this.apiVersion = 'modern'; this.lastHeartbeatAt = null; this.commands = []; }
  getEntities() { return Client.entities; }
  getEntityByKey(key) { return Client.entities.find(entity => entity.key === key); }
  async connect() { this.connected = true; this.emit('connected'); }
  disconnect() { this.connected = false; }
  async setValvePosition(key, position) { this.commands.push(position); }
}
Client.instances = [];
Client.entities = [];

class BaseDevice {
  constructor() { this.availableNow = false; this.writeError = null; this.values = { onoff: true, measure_valve_closed: false }; }
  getName() { return 'Valve WC Test'; }
  getAvailable() { return this.availableNow; }
  async setAvailable() { this.availableNow = true; }
  async setUnavailable() { this.availableNow = false; }
}

Module._load = function load(request) {
  if (request === 'homey') return { Device: BaseDevice };
  if (request === '../../lib/EspHomeClient') return Client;
  return originalLoad.apply(this, arguments);
};
const Device = require('../drivers/open-air-valve/device');
Module._load = originalLoad;

const ConnectionJournal = require('../lib/connectionJournal');
const diagnostics = require('../lib/runtimeDiagnostics');
const Wrapper = require('../lib/EspHomeClient');
const ModernAdapter = require('../lib/adapters/ModernAdapter');

const VALVE = 1;
const SWITCH = 2;
const SENSOR = 3;
const valve = (state) => ({ key: VALVE, name: 'Valve', type: 'valve', state });
const closedSwitch = { key: SWITCH, name: 'Closed Switch', type: 'binary_sensor', state: { state: false } };
const humidity = { key: SENSOR, name: 'Humidity', type: 'sensor', state: { state: 50 } };
const IDLE_OPEN = { position: 1, currentOperation: 0 };

const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const timers = new Map();
let timerId = 0;
const fakeTimers = () => {
  global.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  global.clearTimeout = id => timers.delete(id);
};
const realTimers = () => {
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
};
const fireTimers = () => {
  const due = [...timers.values()];
  timers.clear();
  due.forEach(timer => timer.fn());
};

let lines = [];
const events = name => lines.filter(line => line.event === name);

async function readyDevice() {
  Client.entities = [valve(IDLE_OPEN), closedSwitch, humidity];
  timers.clear();
  lines = [];
  const device = new Device();
  Object.assign(device, {
    _destroyed: false,
    _slotTitleFlags: {},
    getStore: () => ({ address: 'unused.invalid' }),
    getSettings: () => ({}),
    getSetting: () => null,
    log() {},
    error() {},
    homey: { __: key => key },
    hasCapability: key => key in device.values,
    addCapability: async key => { device.values[key] = null; },
    getCapabilityValue: key => device.values[key],
    setCapabilityValue: async (key, value) => {
      if (device.writeError) throw device.writeError;
      device.values[key] = value;
    },
    setCapabilityOptions: async () => {},
  });
  await device._initializeClient();
  await device._entityQueue;
  return device;
}

const emitState = async (device, entity, state) => {
  device.client.emit('stateChanged', { type: entity.type, entity, state });
  await device._entityQueue;
};

function testJournalFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-air-journal-'));
  const file = path.join(directory, 'connection-journal.jsonl');

  // Rotation keeps the newest lines in order and stays within the limit.
  const journal = new ConnectionJournal({ directory, maxBytes: 100 });
  for (let n = 0; n < 20; n++) journal.write({ n, padding: 'x'.repeat(10) });
  const read = name => fs.readFileSync(name, 'utf8').trim().split('\n').map(JSON.parse).map(line => line.n);
  const older = read(`${file}.1`);
  const newer = read(file);
  assert.deepEqual([...older, ...newer], older.concat(newer).sort((a, b) => a - b));
  assert.equal(newer.at(-1), 19);
  assert.ok(fs.statSync(file).size <= 100);
  assert.ok(fs.statSync(`${file}.1`).size <= 100);

  // A restart continues the size count rather than growing past the limit.
  const reopened = new ConnectionJournal({ directory, maxBytes: 100 });
  assert.equal(reopened.bytes, fs.statSync(file).size);

  // Peer addresses in free text are scrubbed.
  journal.write({ error: 'connect ECONNREFUSED 192.168.1.20:6053', host: 'valve-3.local', version: '1.4.5' });
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').at(-1);
  assert.ok(!last.includes('192.168') && !last.includes('valve-3'));
  assert.ok(last.includes('1.4.5'));

  // A write failure neither throws nor stops later attempts.
  const errors = [];
  const broken = new ConnectionJournal({ directory: path.join(directory, 'missing'), onError: error => errors.push(error) });
  broken.write({ a: 1 });
  broken.write({ a: 2 });
  assert.equal(broken.failures, 2);
  assert.equal(errors.length, 1);

  fs.rmSync(directory, { recursive: true });
}

function testSink() {
  // Earlier records are delivered, and a failing sink cannot reach the caller.
  diagnostics.record('before_sink');
  const seen = [];
  diagnostics.setSink(entry => seen.push(entry.event));
  assert.ok(seen.includes('before_sink'));
  diagnostics.setSink(() => { throw new Error('disk full'); });
  assert.doesNotThrow(() => diagnostics.record('with_broken_sink'));
}

function testNoSecretsAndIdentity() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-air-journal-'));
  const journal = new ConnectionJournal({ directory });
  diagnostics.setSink(entry => journal.write(entry));
  const client = new Wrapper({
    host: '192.168.1.20',
    encryptionKey: 'c2VjcmV0LWVuY3J5cHRpb24ta2V5',
    password: 'hunter2',
    diagnosticsDevice: 'Valve WC Test',
  });
  client._recordDiagnostic('wrapper_error', { error: new Error('connect ECONNREFUSED 192.168.1.20:6053') });
  const text = fs.readFileSync(journal.file, 'utf8');
  assert.ok(text.includes('"device":"Valve WC Test"'), 'device identity survives sanitising');
  for (const secret of ['c2VjcmV0', 'hunter2', '192.168.1.20']) {
    assert.ok(!text.includes(secret), `${secret} must not reach the journal`);
  }
  fs.rmSync(directory, { recursive: true });
}

async function testAdapterVisibility() {
  await installClientStubs();
  const records = [];
  const adapter = new ModernAdapter({
    host: 'unused.invalid',
    port: 6053,
    logger: { log() {}, error() {} },
    onDiagnostic: (event, details) => records.push({ event, ...details }),
  });
  await adapter.connect(false);
  const library = clients.at(-1);

  library.emit('heartbeat');
  assert.ok(adapter.lastHeartbeatAt > 0);

  library.log.error('Error processing Noise frames: bad tag.');
  library.log.warn('Unusual frame.');
  assert.ok(records.some(r => r.event === 'modern_library_error' && r.message.includes('Noise')));
  assert.ok(records.some(r => r.event === 'modern_library_warning'));

  adapter._handleStateChange('valve', { key: 99, entity: 'valve-unknown' });
  assert.ok(records.some(r => r.event === 'modern_state_unknown_entity'));
  adapter.disconnect();
}

async function testValveRecords() {
  diagnostics.setSink(entry => lines.push(entry));

  // Replayed states after a connect are recorded, the report cause B needs.
  let device = await readyDevice();
  const replayed = events('valve_report_received').find(line => line.type === 'valve');
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.position, 1);
  assert.equal(replayed.device, 'Valve WC Test');
  assert.equal(events('valve_resolved').at(-1).open, true);
  assert.ok(events('availability').some(line => line.available === true));

  // A live report is recorded and is not marked as replayed.
  lines = [];
  await emitState(device, valve({}), IDLE_OPEN);
  assert.equal(events('valve_report_received')[0].replayed, false);

  // A report rejected by a reconnect leaves a drop line.
  lines = [];
  device.client.emit('stateChanged', { type: 'valve', entity: valve({}), state: IDLE_OPEN });
  device.client.emit('disconnected');
  await device._entityQueue;
  assert.equal(events('valve_report_dropped')[0].reason, 'stale connection');
  assert.equal(events('valve_report_dropped')[0].entity, 'Valve');
  assert.equal(events('valve_report_received').length, 0);

  // A failed capability write is recorded rather than only logged.
  device = await readyDevice();
  device.writeError = new Error('capability store failed');
  device.values.onoff = false;
  lines = [];
  await emitState(device, valve({}), IDLE_OPEN);
  assert.equal(events('valve_write_failed')[0].error.message, 'capability store failed');

  // Sensor reports are counted, not journalled.
  device = await readyDevice();
  lines = [];
  await emitState(device, humidity, { state: 51 });
  await emitState(device, humidity, { state: 52 });
  assert.equal(lines.length, 0);
  await emitState(device, valve({}), IDLE_OPEN);
  assert.equal(events('valve_report_received')[0].sensorReports, 2);
  await emitState(device, valve({}), IDLE_OPEN);
  assert.equal(events('valve_report_received')[1].sensorReports, 0);

  // Exhausted discovery retries are recorded.
  device = await readyDevice();
  device._valveReady = false;
  device._discoveryAttempts = 3;
  lines = [];
  device._scheduleDiscoveryRecovery(device.client);
  assert.equal(events('discovery_gave_up')[0].attempts, 3);

  // A journal failure cannot reach the driver.
  device = await readyDevice();
  device.getName = () => { throw new Error('name unavailable'); };
  await assert.doesNotReject(emitState(device, valve({}), IDLE_OPEN));
}

async function testMissDetector() {
  const switchOn = { state: true };
  const closing = { position: 1, currentOperation: 2 };
  const opening = { position: 1, currentOperation: 1 };

  // Re-home with no final report: the marker carries the liveness snapshot.
  let device = await readyDevice();
  await emitState(device, humidity, { state: 51 });
  device.client.lastHeartbeatAt = Date.now();
  await emitState(device, valve({}), closing);
  await emitState(device, closedSwitch, switchOn);
  await emitState(device, valve({}), opening);
  await emitState(device, closedSwitch, { state: false });
  assert.equal(device.values.onoff, false, 'Homey shows Closed during the re-home');
  fireTimers();
  const [miss] = events('rehome_no_final_report');
  assert.equal(miss.connected, true);
  assert.equal(miss.apiVersion, 'modern');
  assert.equal(miss.valveOperation, 'opening');
  for (const age of [miss.lastSensorAgeMs, miss.lastHeartbeatAgeMs, miss.lastValveReportAgeMs]) {
    assert.equal(typeof age, 'number');
  }
  assert.equal(device.values.onoff, false, 'the detector changes no state');

  // The final IDLE arriving in time cancels it.
  device = await readyDevice();
  await emitState(device, closedSwitch, switchOn);
  await emitState(device, valve({}), IDLE_OPEN);
  fireTimers();
  assert.equal(events('rehome_no_final_report').length, 0);
  assert.equal(device.values.onoff, true);

  // The app's own close command does not match, even at position 1.
  device = await readyDevice();
  await device.closeValve();
  assert.deepEqual(device.client.commands, [0]);
  await emitState(device, closedSwitch, switchOn);
  fireTimers();
  assert.equal(events('rehome_no_final_report').length, 0);

  // An open command is no reason to stand down.
  device = await readyDevice();
  await device.openValve();
  await emitState(device, closedSwitch, switchOn);
  fireTimers();
  assert.equal(events('rehome_no_final_report').length, 1);

  // A valve already closed does not match.
  device = await readyDevice();
  await emitState(device, valve({}), { position: 0, currentOperation: 0 });
  await emitState(device, closedSwitch, switchOn);
  assert.equal(timers.size, 0);

  // A disconnect does not cancel it: that is part of what it must catch.
  device = await readyDevice();
  await emitState(device, closedSwitch, switchOn);
  device.client.connected = false;
  device.client.emit('disconnected');
  await device._entityQueue;
  fireTimers();
  assert.equal(events('rehome_no_final_report')[0].connected, false);

  // Shutdown cancels it, for both paths.
  for (const shutdown of ['onUninit', 'onDeleted']) {
    device = await readyDevice();
    await emitState(device, closedSwitch, switchOn);
    assert.equal(timers.size, 1);
    await device[shutdown]();
    assert.equal(timers.size, 0);
  }
}

async function testAppStart() {
  Module._load = function load(request) {
    if (request === 'homey') {
      return { App: class { log() {} error() {} } };
    }
    return originalLoad.apply(this, arguments);
  };
  const App = require('../app');
  Module._load = originalLoad;

  const seen = [];
  const app = new App();
  app.homey = {
    manifest: { version: '9.9.9' },
    flow: { getActionCard: () => ({ registerRunListener() {} }) },
  };
  await app.onInit();
  diagnostics.setSink(entry => seen.push(entry));
  assert.ok(seen.some(entry => entry.event === 'app_start' && entry.version === '9.9.9'));

  // The journal must not be able to stop the app from starting.
  delete app.homey.manifest;
  await assert.doesNotReject(app.onInit());
}

async function main() {
  testJournalFile();
  testSink();
  testNoSecretsAndIdentity();
  await testAdapterVisibility();
  await testAppStart();
  fakeTimers();
  await testValveRecords();
  await testMissDetector();
  realTimers();
  console.log('connection journal tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
