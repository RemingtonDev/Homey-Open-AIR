'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('events');
const Module = require('module');

class FakeLegacyClient extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.connection = new EventEmitter();
    this.disconnectCalled = false;
    FakeLegacyClient.instances.push(this);
  }

  connect() {
    setImmediate(() => this.emit('connected'));
  }

  disconnect() {
    this.disconnectCalled = true;
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'esphome-api-legacy') {
    return { Client: FakeLegacyClient };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const LegacyAdapter = require('../lib/adapters/LegacyAdapter');
const EspHomeClient = require('../lib/EspHomeClient');

Module._load = originalLoad;

function createLogger() {
  return {
    log() {},
    error() {},
  };
}

async function testLegacyDisconnectSuppressesLateConnectionErrors() {
  FakeLegacyClient.instances.length = 0;
  const diagnostics = [];
  const adapter = new LegacyAdapter({
    host: '127.0.0.1',
    port: 6053,
    logger: createLogger(),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  const result = await adapter.connect(false);
  assert.equal(result.success, true);

  const client = FakeLegacyClient.instances.at(-1);
  assert.ok(client, 'expected fake legacy client instance');

  assert.doesNotThrow(() => adapter.disconnect());
  assert.doesNotThrow(() => {
    client.connection.emit('error', new Error('sendMessage timeout waiting for HelloResponse'));
  });

  assert.ok(
    diagnostics.some(({ event }) => event === 'legacy_connection_error_suppressed'),
    'expected suppressed late connection error diagnostic',
  );
}

function testWrapperDisconnectHandlesAdapterErrorsWithoutCrashing() {
  const wrapper = new EspHomeClient({
    host: '127.0.0.1',
    port: 6053,
    logger: createLogger(),
    diagnosticsLabel: 'test-runtime',
  });

  class FakeAdapter extends EventEmitter {
    disconnect() {
      this.emit('error', new Error('late adapter error'));
    }
  }

  const adapter = new FakeAdapter();
  wrapper.adapter = adapter;
  wrapper._wireAdapterEvents(adapter);

  assert.doesNotThrow(() => wrapper.disconnect());
}

async function main() {
  await testLegacyDisconnectSuppressesLateConnectionErrors();
  testWrapperDisconnectHandlesAdapterErrorsWithoutCrashing();
  console.log('legacy crash guard tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
