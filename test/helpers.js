'use strict';

// Shared harness for driver tests. Require this file before any app code.

const assert = require('node:assert/strict');
const Module = require('node:module');
const net = require('node:net');
const path = require('node:path');

// Hardware guard: installed before any app code loads, so a mistake in a test
// fails the test instead of reaching a device.
let socketConnects = 0;
net.Socket.prototype.connect = function refuseConnect() {
  socketConnects++;
  throw new Error('Tests must not open network connections');
};

function loadDriver(name) {
  const originalLoad = Module._load;
  Module._load = function load(request) {
    if (request === 'homey') return { Device: class {} };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(path.join(__dirname, '..', 'drivers', name, 'device'));
  } finally {
    Module._load = originalLoad;
  }
}

const MESSAGE = {
  LIST_BINARY_SENSOR: 12,
  LIST_COVER: 13,
  LIST_FAN: 14,
  LIST_SENSOR: 16,
  LIST_DONE: 19,
  SUBSCRIBE_STATES: 20,
  BINARY_SENSOR_STATE: 21,
  COVER_STATE: 22,
  FAN_STATE: 23,
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

const listed = (key, objectId, name, ...extra) => Buffer.concat([
  text(1, objectId), fixed32(2, key), text(3, name), ...extra,
]);

// --- Client and device stubs -------------------------------------------------

const clients = [];
const outbound = [];

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

function assertNoHardwareTraffic() {
  assert.equal(socketConnects, 0, 'no test may open a socket');
  assert.deepEqual(
    [...new Set(outbound)],
    [MESSAGE.SUBSCRIBE_STATES],
    'no test may send anything except the protocol state subscription',
  );
}

function stubDevice(device, values, overrides = {}) {
  return Object.assign(device, {
    _destroyed: false,
    _slotTitleFlags: {},
    log() {},
    error(...args) { throw new Error(args.join(' ')); },
    homey: { __: key => key },
    hasCapability: key => key in values,
    addCapability: async key => { values[key] = null; },
    getCapabilityValue: key => values[key],
    setCapabilityValue: async (key, value) => { values[key] = value; },
    setCapabilityOptions: async () => {},
  }, overrides);
}

module.exports = {
  MESSAGE,
  assertNoHardwareTraffic,
  clients,
  fixed32,
  float,
  installClientStubs,
  listed,
  loadDriver,
  optional,
  stubDevice,
  varint,
};
