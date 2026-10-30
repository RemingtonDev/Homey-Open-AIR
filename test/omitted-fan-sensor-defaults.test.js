'use strict';

// Raw ESPHome fan and sensor packets through the real decoder, ModernAdapter
// and Mini driver. Only the socket layer and Homey itself are stubbed.

const assert = require('node:assert/strict');
const {
  MESSAGE, assertNoHardwareTraffic, clients, fixed32, float, installClientStubs, listed,
  loadDriver, optional, stubDevice, varint,
} = require('./helpers');
const MiniDevice = loadDriver('open-air-mini');
const ModernAdapter = require('../lib/adapters/ModernAdapter');

const FAN_KEY = 1;
const RPM_KEY = 2;
const HUMIDITY_KEY = 3;

const fanState = ({ state, speedLevel } = {}) => Buffer.concat([
  fixed32(1, FAN_KEY),
  ...optional(varint, 2, state),
  ...optional(varint, 6, speedLevel),
]);
const sensorState = (key, { state, missingState } = {}) => Buffer.concat([
  fixed32(1, key),
  ...optional(float, 2, state),
  ...optional(varint, 3, missingState),
]);

const FULL_TILE = {
  onoff: true,
  dim: 0.1,
  measure_fan_speed: 10,
  measure_rpm: 264,
  measure_humidity: 50,
};

function createDevice() {
  const device = new MiniDevice();
  const values = { ...FULL_TILE };
  stubDevice(device, values, {
    _invalidHumidityCapabilities: new Set(),
    entityKeys: { fan: null, fanSpeedLevels: 100, sensorMap: {} },
    getAvailable: () => true,
    setAvailable: async () => {},
    getSetting: () => null,
  });
  return { device, values };
}

/** Connect an adapter to a Mini, then deliver packets around discovery. */
async function run({ supportsSpeed = true, before = [], after = [] }) {
  const { device, values } = createDevice();
  const logger = { log() {}, error() {} };
  const adapter = new ModernAdapter({ host: 'unused.invalid', port: 6053, logger });
  const work = [];
  const received = new Map();
  adapter.on('entityDiscovered', entity => work.push(async () => {
    if (entity.state) received.set(entity.key, entity.state);
    await device._mapEntity(entity);
    if (entity.state) await device._handleStateChange(entity.type, entity, entity.state);
  }));
  adapter.on('stateChanged', ({ type, entity, state }) => work.push(() => {
    received.set(entity.key, state);
    return device._handleStateChange(type, entity, state);
  }));

  const { success } = await adapter.connect(false);
  assert.equal(success, true);
  const client = clients[clients.length - 1];
  const send = ([type, payload]) => client.handleMessage(type, payload);

  before.forEach(send);
  send([MESSAGE.LIST_FAN, listed(FAN_KEY, 'fan', 'Fan',
    ...(supportsSpeed ? [varint(6, 1), varint(8, 100)] : []))]);
  send([MESSAGE.LIST_SENSOR, listed(RPM_KEY, 'fan_rpm', 'Fan RPM')]);
  send([MESSAGE.LIST_SENSOR, listed(HUMIDITY_KEY, 'humidity', 'Humidity')]);
  send([MESSAGE.LIST_DONE, Buffer.alloc(0)]);
  after.forEach(send);

  for (const step of work) await step();
  adapter.disconnect();
  return { device, values, received };
}

const fan = state => [MESSAGE.FAN_STATE, fanState(state)];
const sensor = (key, state) => [MESSAGE.SENSOR_STATE, sensorState(key, state)];

const assertFan = ({ values }, { onoff, dim }) => {
  assert.equal(values.onoff, onoff, 'onoff tile');
  assert.equal(values.dim, dim, 'dim tile');
  assert.equal(values.measure_fan_speed, dim * 100, 'fan speed tile');
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

for (const [flow, packets] of [
  ['before discovery', packet => ({ before: [packet] })],
  ['after discovery', packet => ({ after: [packet] })],
]) {
  test(`${flow}: omitted fan state means off at speed 0`, async () => {
    assertFan(await run(packets(fan())), { onoff: false, dim: 0 });
  });

  test(`${flow}: explicit fan state matches omitted`, async () => {
    assertFan(await run(packets(fan({ state: 0, speedLevel: 0 }))), { onoff: false, dim: 0 });
  });

  test(`${flow}: off fan keeps its reported speed`, async () => {
    assertFan(await run(packets(fan({ speedLevel: 10 }))), { onoff: false, dim: 0.1 });
  });

  test(`${flow}: running fan with omitted speed reports 0`, async () => {
    assertFan(await run(packets(fan({ state: 1 }))), { onoff: true, dim: 0 });
  });

  test(`${flow}: fan without speed support keeps its speed tile`, async () => {
    assertFan(await run({ supportsSpeed: false, ...packets(fan({ state: 1 })) }),
      { onoff: true, dim: 0.1 });
  });

  test(`${flow}: omitted RPM is a reading of 0`, async () => {
    const { values } = await run(packets(sensor(RPM_KEY)));
    assert.equal(values.measure_rpm, 0);
  });

  test(`${flow}: missing RPM keeps the last value`, async () => {
    const { values, received } = await run(packets(sensor(RPM_KEY, { missingState: 1 })));
    assert.equal(values.measure_rpm, FULL_TILE.measure_rpm);
    assert.equal(received.get(RPM_KEY).missingState, true);
    assert.equal('state' in received.get(RPM_KEY), false, 'a missing reading must stay unknown');
  });

  test(`${flow}: omitted humidity matches explicit 0`, async () => {
    for (const reading of [undefined, { state: 0, missingState: 0 }]) {
      const { device, values } = await run(packets(sensor(HUMIDITY_KEY, reading)));
      assert.equal(values.measure_humidity, 0);
      assert.equal(device.getHumidityForControl(), 0);
    }
  });

  test(`${flow}: missing humidity stays invalid for control`, async () => {
    const { device, values } = await run(packets(sensor(HUMIDITY_KEY, { missingState: 1 })));
    assert.equal(values.measure_humidity, FULL_TILE.measure_humidity);
    assert.equal(device.getHumidityForControl(), null);
  });
}

test('no message leaves every tile untouched', async () => {
  const { device, values } = await run({});
  assert.deepEqual(values, FULL_TILE);
  assert.equal(device.getHumidityForControl(), null);
});

async function main() {
  await installClientStubs();

  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`);
    }
  }

  assertNoHardwareTraffic();

  if (failures.length) {
    throw new Error(`${failures.length} of ${tests.length} fan and sensor default tests failed`);
  }
  console.log(`omitted fan and sensor default tests passed (${tests.length})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
