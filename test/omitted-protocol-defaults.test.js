'use strict';

// Raw ESPHome packets through the real decoder, ModernAdapter, connection
// wrapper and valve driver. Only the socket layer and Homey itself are stubbed.

const assert = require('node:assert/strict');
const Module = require('node:module');
const net = require('node:net');

// Hardware guard: installed before any app code loads, so a mistake in this
// file fails the test instead of reaching a device.
let socketConnects = 0;
net.Socket.prototype.connect = function refuseConnect() {
  socketConnects++;
  throw new Error('Tests must not open network connections');
};

const originalLoad = Module._load;
Module._load = function load(request) {
  if (request === 'homey') return { Device: class {} };
  return originalLoad.apply(this, arguments);
};
const ValveDevice = require('../drivers/open-air-valve/device');
Module._load = originalLoad;
const Wrapper = require('../lib/EspHomeClient');
const { ESPHOME } = require('../lib/constants');

const VALVE_KEY = 1;
const CLOSED_SENSOR_KEY = 2;
const HUMIDITY_KEY = 3;

const MESSAGE = {
  LIST_BINARY_SENSOR: 12,
  LIST_COVER: 13,
  LIST_SENSOR: 16,
  LIST_DONE: 19,
  SUBSCRIBE_STATES: 20,
  BINARY_SENSOR_STATE: 21,
  COVER_STATE: 22,
  SENSOR_STATE: 25,
  LIST_VALVE: 109,
  VALVE_STATE: 110,
};

// --- Protobuf encoding -------------------------------------------------------

const tag = (field, wireType) => Buffer.from([(field << 3) | wireType]);
const fixed32 = (field, value) => {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(value);
  return Buffer.concat([tag(field, 5), body]);
};
const float = (field, value) => {
  const body = Buffer.alloc(4);
  body.writeFloatLE(value);
  return Buffer.concat([tag(field, 5), body]);
};
const varint = (field, value) => Buffer.concat([tag(field, 0), Buffer.from([value])]);
const text = (field, value) => Buffer.concat([
  tag(field, 2), Buffer.from([Buffer.byteLength(value)]), Buffer.from(value),
]);

// A field left undefined is omitted, as an ESPHome server does for proto3
// zero/false values. An explicit 0 is written, which only tests do.
const optional = (encode, field, value) => (value === undefined ? [] : [encode(field, value)]);

const valveState = ({ position, operation } = {}) => Buffer.concat([
  fixed32(1, VALVE_KEY),
  ...optional(float, 2, position),
  ...optional(varint, 3, operation),
]);
const coverState = ({ position, operation } = {}) => Buffer.concat([
  fixed32(1, VALVE_KEY),
  ...optional(float, 3, position),
  ...optional(varint, 5, operation),
]);
const binaryState = ({ state, missingState } = {}) => Buffer.concat([
  fixed32(1, CLOSED_SENSOR_KEY),
  ...optional(varint, 2, state),
  ...optional(varint, 3, missingState),
]);
const humidityState = value => Buffer.concat([fixed32(1, HUMIDITY_KEY), float(2, value)]);
const listed = (key, objectId, name) => Buffer.concat([
  text(1, objectId), fixed32(2, key), text(3, name),
]);

const VALVE_ENTITIES = [
  [MESSAGE.LIST_VALVE, listed(VALVE_KEY, 'open_air_valve', 'Valve')],
  [MESSAGE.LIST_BINARY_SENSOR, listed(CLOSED_SENSOR_KEY, 'valve_homing_switch', 'Closed Switch')],
  [MESSAGE.LIST_SENSOR, listed(HUMIDITY_KEY, 'humidity', 'Humidity')],
];
const COVER_ENTITIES = [
  [MESSAGE.LIST_COVER, listed(VALVE_KEY, 'open_air_cover', 'Cover')],
];

// --- Harness -----------------------------------------------------------------

const clients = [];
const outbound = [];
const timers = new Map();
let timerId = 0;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

function installTimers() {
  global.setTimeout = (fn, ms) => {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    return id;
  };
  global.clearTimeout = id => timers.delete(id);
}

async function fireTimers(ms) {
  for (const [id, timer] of [...timers]) {
    if (timer.ms !== ms) continue;
    timers.delete(id);
    await timer.fn();
  }
}

async function installClientStubs() {
  const { EspHomeClient } = await import('esphome-client');
  EspHomeClient.prototype.connect = function connect() {
    clients.push(this);
    setImmediate(() => this.emit('connect', false));
  };
  EspHomeClient.prototype.frameAndSend = function frameAndSend(type) {
    outbound.push(type);
  };
}

const flush = async device => {
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await device._entityQueue;
  }
};

const send = (client, type, payload) => client.handleMessage(type, payload);

function discover(client, entities) {
  for (const [type, payload] of entities) send(client, type, payload);
  send(client, MESSAGE.LIST_DONE, Buffer.alloc(0));
}

function createDevice(tile) {
  const device = new ValveDevice();
  const values = { ...tile };
  let available = true;
  Object.assign(device, {
    _destroyed: false,
    _slotTitleFlags: {},
    getStore: () => ({ address: 'unused.invalid' }),
    getSettings: () => ({}),
    getSetting: () => null,
    log() {},
    error(...args) { throw new Error(args.join(' ')); },
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
  return { device, values };
}

/**
 * Connect a device and deliver `packets` in the order named by `flow`:
 * - stateFirst: reconnect path; states arrive before the entity list
 * - discoveryFirst: reconnect path; states arrive after the entity list
 * - startup: first connection; the wrapper only attaches once discovery has
 *   finished, so the driver receives the states through replay
 */
async function connect({ flow, tile, entities = VALVE_ENTITIES, packets }) {
  Wrapper.clearVersionCache();
  if (flow !== 'startup') Wrapper.apiVersionCache.set('unused.invalid:6053', 'modern');

  const fixture = createDevice(tile);
  const { device } = fixture;
  const initializing = device._initializeClient();
  await flush(device);
  const client = clients[clients.length - 1];

  if (flow === 'startup') {
    discover(client, entities);
    for (const [type, payload] of packets) send(client, type, payload);
    await fireTimers(ESPHOME.ENTITY_DISCOVERY_WAIT_MS);
  } else if (flow === 'stateFirst') {
    await initializing;
    for (const [type, payload] of packets) send(client, type, payload);
    discover(client, entities);
  } else {
    await initializing;
    discover(client, entities);
    for (const [type, payload] of packets) send(client, type, payload);
  }

  await initializing;
  await flush(device);
  return { ...fixture, client };
}

function assertReady({ device, values }, isOpen) {
  assert.equal(device.getAvailable(), true, 'device must be available');
  assert.equal(device._valveReady, true, 'valve must be ready');
  assert.equal(device._hasValveState, true, 'valve state must be resolved');
  assert.equal(values.onoff, isOpen, 'onoff tile');
  assert.equal(values.measure_valve_closed, !isOpen, 'closed status');
  assert.doesNotThrow(() => device._requireValveEntity());
}

function assertNotReady({ device, values }, tile) {
  assert.equal(device.getAvailable(), false, 'device must stay unavailable');
  assert.equal(device._valveReady, false, 'valve must not be ready');
  assert.equal(device._hasValveState, false, 'no valve state may be resolved');
  assert.deepEqual(
    { onoff: values.onoff, measure_valve_closed: values.measure_valve_closed },
    tile,
    'tile must keep its last value',
  );
  assert.throws(() => device._requireValveEntity());
}

async function release({ device }) {
  await device.onUninit();
  timers.clear();
}

const OPEN_TILE = { onoff: true, measure_valve_closed: false };
const CLOSED_TILE = { onoff: false, measure_valve_closed: true };
const FLOWS = ['stateFirst', 'discoveryFirst', 'startup'];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- Valve telemetry ---------------------------------------------------------

for (const flow of FLOWS) {
  test(`${flow}: omitted Closed/Idle resolves Closed`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      packets: [[MESSAGE.BINARY_SENSOR_STATE, binaryState()], [MESSAGE.VALVE_STATE, valveState()]],
    });
    assertReady(fixture, false);
    await release(fixture);
  });

  test(`${flow}: explicit Closed/Idle resolves Closed`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      packets: [
        [MESSAGE.BINARY_SENSOR_STATE, binaryState({ state: 0, missingState: 0 })],
        [MESSAGE.VALVE_STATE, valveState({ position: 0, operation: 0 })],
      ],
    });
    assertReady(fixture, false);
    await release(fixture);
  });

  test(`${flow}: Open with omitted Idle resolves Open`, async () => {
    const fixture = await connect({
      flow,
      tile: CLOSED_TILE,
      packets: [[MESSAGE.VALVE_STATE, valveState({ position: 1 })]],
    });
    assertReady(fixture, true);
    assert.equal(fixture.device._valveOperation, 'idle');
    await release(fixture);
  });

  test(`${flow}: movement and intermediate positions stay unresolved`, async () => {
    const states = [
      { position: undefined, operation: 1 }, // leaving Closed: position omitted
      { position: 1, operation: 1 },
      { position: 1, operation: 2 },
      { position: 0.5, operation: 1 },
      { position: 0.5 }, // stopped between endpoints: operation omitted
    ];
    for (const state of states) {
      const fixture = await connect({
        flow,
        tile: OPEN_TILE,
        packets: [[MESSAGE.VALVE_STATE, valveState(state)]],
      });
      assertNotReady(fixture, OPEN_TILE);
      await release(fixture);
    }
  });

  test(`${flow}: omitted cover state resolves Closed`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      entities: COVER_ENTITIES,
      packets: [[MESSAGE.COVER_STATE, coverState()]],
    });
    assertReady(fixture, false);
    await release(fixture);
  });

  test(`${flow}: explicit cover state resolves Closed`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      entities: COVER_ENTITIES,
      packets: [[MESSAGE.COVER_STATE, coverState({ position: 0, operation: 0 })]],
    });
    assertReady(fixture, false);
    await release(fixture);
  });

  test(`${flow}: moving cover stays unresolved`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      entities: COVER_ENTITIES,
      packets: [[MESSAGE.COVER_STATE, coverState({ operation: 2 })]],
    });
    assertNotReady(fixture, OPEN_TILE);
    await release(fixture);
  });

  // --- Closed switch ---------------------------------------------------------

  test(`${flow}: omitted binary false is a received reading`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      packets: [[MESSAGE.BINARY_SENSOR_STATE, binaryState()]],
    });
    assert.equal(fixture.device._closedSensorState, false);
    assertNotReady(fixture, OPEN_TILE);
    await release(fixture);
  });

  test(`${flow}: missing_state stays unknown`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      packets: [[MESSAGE.BINARY_SENSOR_STATE, binaryState({ missingState: 1 })]],
    });
    const { state } = fixture.device.client.getEntityByKey(CLOSED_SENSOR_KEY);
    assert.equal(state.missingState, true);
    assert.equal('state' in state, false);
    assert.equal(fixture.device._closedSensorState, null);
    assertNotReady(fixture, OPEN_TILE);
    await release(fixture);
  });

  test(`${flow}: no state message stays distinct from a zero message`, async () => {
    const fixture = await connect({ flow, tile: OPEN_TILE, packets: [] });
    assert.equal(fixture.device.client.getEntityByKey(VALVE_KEY).state, null);
    assert.equal(fixture.device.client.getEntityByKey(CLOSED_SENSOR_KEY).state, null);
    assert.equal(fixture.device._valvePosition, null);
    assert.equal(fixture.device._closedSensorState, null);
    assertNotReady(fixture, OPEN_TILE);
    await release(fixture);
  });

  test(`${flow}: sensor activity alone does not make the valve ready`, async () => {
    const fixture = await connect({
      flow,
      tile: OPEN_TILE,
      packets: [[MESSAGE.SENSOR_STATE, humidityState(55)]],
    });
    assert.equal(fixture.values.measure_humidity, 55);
    assertNotReady(fixture, OPEN_TILE);
    await release(fixture);
  });
}

test('Closed switch releasing with omitted false restores an Open valve', async () => {
  // The valve already reports Open/Idle, then the switch sets the tile Closed.
  // Only its release can correct the tile: no new valve message follows.
  const fixture = await connect({
    flow: 'discoveryFirst',
    tile: OPEN_TILE,
    packets: [
      [MESSAGE.VALVE_STATE, valveState({ position: 1 })],
      [MESSAGE.BINARY_SENSOR_STATE, binaryState({ state: 1 })],
    ],
  });
  assertReady(fixture, false);

  send(fixture.client, MESSAGE.BINARY_SENSOR_STATE, binaryState());
  await flush(fixture.device);
  assertReady(fixture, true);
  await release(fixture);
});

test('valve closing with omitted zeros finishes Closed', async () => {
  const fixture = await connect({
    flow: 'discoveryFirst',
    tile: OPEN_TILE,
    packets: [[MESSAGE.VALVE_STATE, valveState({ position: 1 })]],
  });
  assertReady(fixture, true);

  send(fixture.client, MESSAGE.VALVE_STATE, valveState({ operation: 2 }));
  await flush(fixture.device);
  assertReady(fixture, true); // Closing is not a completed endpoint.

  send(fixture.client, MESSAGE.VALVE_STATE, valveState());
  await flush(fixture.device);
  assertReady(fixture, false);
  await release(fixture);
});

// --- Reconnection and stale clients ------------------------------------------

test('device reconnect discards state and ignores the retired client', async () => {
  const fixture = await connect({
    flow: 'discoveryFirst',
    tile: OPEN_TILE,
    packets: [[MESSAGE.VALVE_STATE, valveState()]],
  });
  assertReady(fixture, false);
  const { device, values, client: retired } = fixture;

  const reconnecting = device.reconnect();
  await flush(device);
  await reconnecting;
  await flush(device);
  const next = clients[clients.length - 1];
  assert.notEqual(next, retired);

  send(retired, MESSAGE.VALVE_STATE, valveState({ position: 1 }));
  await flush(device);
  assertNotReady(fixture, CLOSED_TILE);

  discover(next, VALVE_ENTITIES);
  await flush(device);
  assertNotReady(fixture, CLOSED_TILE);

  send(next, MESSAGE.VALVE_STATE, valveState());
  await flush(device);
  assertReady({ device, values }, false);
  await release(fixture);
});

test('connection loss discards state until the new connection reports', async () => {
  const fixture = await connect({
    flow: 'discoveryFirst',
    tile: CLOSED_TILE,
    packets: [[MESSAGE.VALVE_STATE, valveState({ position: 1 })]],
  });
  assertReady(fixture, true);
  const { device, client: retired } = fixture;

  retired.emit('disconnect', 'connection lost');
  await flush(device);
  assert.equal(device.getAvailable(), false);
  assert.equal(device._valveReady, false);

  send(retired, MESSAGE.VALVE_STATE, valveState());
  await flush(device);
  assert.equal(fixture.values.onoff, true, 'retired client must not change the tile');

  await fireTimers(5000);
  await flush(device);
  const next = clients[clients.length - 1];
  assert.notEqual(next, retired);
  discover(next, VALVE_ENTITIES);
  await flush(device);
  assertNotReady(fixture, OPEN_TILE);

  send(next, MESSAGE.VALVE_STATE, valveState());
  await flush(device);
  assertReady(fixture, false);
  await release(fixture);
});

// --- Runner ------------------------------------------------------------------

async function main() {
  installTimers();
  await installClientStubs();

  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      const lines = [...error.stack.matchAll(/omitted-protocol-defaults\.test\.js:(\d+)/g)]
        .map(match => match[1]);
      console.error(`FAIL ${name} (lines ${lines.join(' < ')}): ${error.message.split('\n')[0]}`);
    }
    timers.clear();
  }

  assert.equal(socketConnects, 0, 'no test may open a socket');
  assert.deepEqual(
    [...new Set(outbound)],
    [MESSAGE.SUBSCRIBE_STATES],
    'no test may send anything except the protocol state subscription',
  );

  if (failures.length) {
    throw new Error(`${failures.length} of ${tests.length} omitted-default tests failed`);
  }
  console.log(`omitted protocol default tests passed (${tests.length})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => {
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});
