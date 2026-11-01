'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { clients, installClientStubs } = require('./helpers');
const Wrapper = require('../lib/EspHomeClient');
const ModernAdapter = require('../lib/adapters/ModernAdapter');
const diagnostics = require('../lib/runtimeDiagnostics');
const { LINK } = require('../lib/constants');

let lines = [];
diagnostics.setSink(entry => lines.push(entry));
const eventCount = event => lines.filter(line => line.event === event).length;

const realNow = Date.now;
let now = 1000000;
Date.now = () => now;

class FakeAdapter extends EventEmitter {
  constructor() { super(); this.pings = 0; this.lastReceivedAt = null; this.disconnects = 0; }
  sendPing() { this.pings++; }
  disconnect() { this.disconnects++; }
}

function connectedWrapper(adapter = new FakeAdapter()) {
  lines = [];
  const wrapper = new Wrapper({ host: 'unused.invalid', logger: { log() {}, error() {} } });
  wrapper.on('error', () => {});
  wrapper.adapter = adapter;
  wrapper.connected = true;
  wrapper._wireAdapterEvents(adapter);
  wrapper._startLinkWatch(adapter);
  return { wrapper, adapter };
}

function advance(wrapper, adapter, ms) {
  now += ms;
  wrapper._checkLink(adapter);
}

function testHealthyLinkIsNotPinged() {
  const { wrapper, adapter } = connectedWrapper();
  for (let i = 0; i < 10; i++) {
    adapter.lastReceivedAt = now;
    advance(wrapper, adapter, LINK.QUIET_MS - 1);
  }
  assert.equal(adapter.pings, 0);
  assert.equal(eventCount('link_quiet_ping'), 0);
  wrapper.disconnect();
}

function testFreshConnectionGetsTheFullQuietPeriod() {
  const { wrapper, adapter } = connectedWrapper();
  advance(wrapper, adapter, LINK.QUIET_MS - 1);
  assert.equal(adapter.pings, 0);
  advance(wrapper, adapter, 1);
  assert.equal(adapter.pings, 1);
  wrapper.disconnect();
}

function testAnsweredPingClearsTheCheck() {
  const { wrapper, adapter } = connectedWrapper();
  advance(wrapper, adapter, LINK.QUIET_MS);
  assert.equal(adapter.pings, 1);
  assert.equal(eventCount('link_quiet_ping'), 1);

  // Only one ping per quiet period, while waiting for the answer.
  advance(wrapper, adapter, LINK.PING_TIMEOUT_MS - 1);
  assert.equal(adapter.pings, 1);

  adapter.lastReceivedAt = now;
  advance(wrapper, adapter, 1);
  assert.equal(wrapper._pingSentAt, null);
  assert.equal(wrapper.adapter, adapter);
  assert.equal(eventCount('link_ping_unanswered'), 0);

  // The next quiet period starts again from a ping, not from the old one.
  advance(wrapper, adapter, LINK.QUIET_MS);
  assert.equal(adapter.pings, 2);
  wrapper.disconnect();
}

function testUnansweredPingUsesTheNormalDisconnectPath() {
  const { wrapper, adapter } = connectedWrapper();
  let disconnected = 0;
  wrapper.on('disconnected', () => disconnected++);

  advance(wrapper, adapter, LINK.QUIET_MS);
  advance(wrapper, adapter, LINK.PING_TIMEOUT_MS);

  assert.equal(eventCount('link_ping_unanswered'), 1);
  assert.equal(disconnected, 1);
  assert.equal(wrapper.connected, false);
  assert.equal(wrapper.adapter, null);
  assert.equal(adapter.disconnects, 1);
  assert.ok(wrapper.reconnectTimer, 'a reconnect is scheduled');
  assert.equal(wrapper._linkWatch, null);
  assert.equal(eventCount('wrapper_reconnect_scheduled'), 1);
  wrapper.disconnect();
}

function testPingFailureCannotEscape() {
  const { wrapper, adapter } = connectedWrapper();
  adapter.sendPing = () => { throw new Error('socket gone'); };
  assert.doesNotThrow(() => advance(wrapper, adapter, LINK.QUIET_MS));
  advance(wrapper, adapter, LINK.PING_TIMEOUT_MS);
  assert.equal(eventCount('link_ping_unanswered'), 1);
  wrapper.disconnect();
}

function testWatchEndsWithTheConnection() {
  const { wrapper, adapter } = connectedWrapper();
  assert.ok(wrapper._linkWatch);
  wrapper.disconnect();
  assert.equal(wrapper._linkWatch, null);
  assert.doesNotThrow(() => advance(wrapper, adapter, LINK.QUIET_MS));
  assert.equal(adapter.pings, 0);
}

function testRetiredAdapterIsIgnored() {
  const { wrapper, adapter } = connectedWrapper();
  const next = new FakeAdapter();
  wrapper.adapter = next;
  advance(wrapper, adapter, LINK.QUIET_MS);
  assert.equal(adapter.pings, 0);
  wrapper.adapter = adapter;
  wrapper.disconnect();
}

function testAdapterWithoutPingIsNotWatched() {
  const adapter = new FakeAdapter();
  adapter.sendPing = undefined;
  const { wrapper } = connectedWrapper(adapter);
  assert.equal(wrapper._linkWatch, null);
  wrapper.disconnect();
}

async function testModernAdapterTracksEveryIncomingMessage() {
  await installClientStubs();
  const adapter = new ModernAdapter({
    host: 'unused.invalid', port: 6053, logger: { log() {}, error() {} },
  });
  await adapter.connect(false);
  const library = clients.at(-1);
  library.sendPing = () => { library.pinged = true; };

  now += 1;
  library.emit('heartbeat');
  assert.equal(adapter.lastReceivedAt, now);

  now += 1;
  adapter._handleStateChange('sensor', { key: 99, entity: 'sensor-unknown', state: 1 });
  assert.equal(adapter.lastReceivedAt, now);

  adapter.sendPing();
  assert.equal(library.pinged, true);
  adapter.disconnect();
}

async function main() {
  testHealthyLinkIsNotPinged();
  testFreshConnectionGetsTheFullQuietPeriod();
  testAnsweredPingClearsTheCheck();
  testUnansweredPingUsesTheNormalDisconnectPath();
  testPingFailureCannotEscape();
  testWatchEndsWithTheConnection();
  testRetiredAdapterIsIgnored();
  testAdapterWithoutPingIsNotWatched();
  await testModernAdapterTracksEveryIncomingMessage();
  Date.now = realNow;
  console.log('link watch tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
