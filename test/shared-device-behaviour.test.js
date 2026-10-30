'use strict';

// Behaviour both drivers must keep: slot titles, connection settings, and the
// valve's reset paths. Only Homey and the client are stubbed.

const assert = require('node:assert/strict');
const { loadDriver, stubDevice } = require('./helpers');
const MiniDevice = loadDriver('open-air-mini');
const ValveDevice = loadDriver('open-air-valve');

function createDevice(Driver, values = {}) {
  const device = new Driver();
  const options = [];
  const errors = [];
  const store = {};
  stubDevice(device, values, {
    entityKeys: { sensorMap: {} },
    _invalidHumidityCapabilities: new Set(),
    error: (...args) => errors.push(args[0]),
    setCapabilityOptions: async (capabilityId, option) => {
      options.push([capabilityId, option]);
    },
    setStoreValue: async (key, value) => { store[key] = value; },
    getStore: () => ({}),
    getSettings: () => ({}),
    setUnavailable: async () => {},
  });
  return { device, values, options, errors, store };
}

const sensor = (name, key) => ({ name, key, type: 'sensor' });
const title = (en, nl, fr, slot) => ({
  title: { en: `${en} ${slot}`, nl: `${nl} ${slot}`, fr: `${fr} ${slot}` },
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

for (const [label, Driver] of [['Mini', MiniDevice], ['Valve', ValveDevice]]) {
  test(`${label}: a second sensor titles both slots, relabelling slot 1 once`, async () => {
    const { device, options } = createDevice(Driver, { measure_temperature: 20 });
    await device._mapEntity(sensor('Sensor 2 Temperature', 1));
    await device._mapEntity(sensor('Sensor 3 Temperature', 2));
    assert.deepEqual(options, [
      ['measure_temperature.2', title('Temperature', 'Temperatuur', 'Température', 2)],
      ['measure_temperature', title('Temperature', 'Temperatuur', 'Température', 1)],
      ['measure_temperature.3', title('Temperature', 'Temperatuur', 'Température', 3)],
    ]);
  });

  test(`${label}: slot 1 keeps its title without a second sensor`, async () => {
    const { device, options } = createDevice(Driver, { measure_humidity: 50 });
    await device._mapEntity(sensor('Sensor 1 Humidity', 1));
    assert.deepEqual(options, []);
  });

  test(`${label}: a missing base capability is not relabelled`, async () => {
    const { device, options } = createDevice(Driver);
    await device._mapEntity(sensor('Sensor 2 Humidity', 1));
    assert.deepEqual(options, [
      ['measure_humidity.2', title('Humidity', 'Vochtigheid', 'Humidité', 2)],
    ]);
  });

  test(`${label}: a failed title is logged and the sensor still maps`, async () => {
    const { device, errors } = createDevice(Driver, { measure_humidity: 50 });
    device.setCapabilityOptions = async () => { throw new Error('rejected'); };
    await device._mapEntity(sensor('Sensor 2 Humidity', 1));
    assert.deepEqual(errors, [
      'Failed to set title for measure_humidity.2:',
      'Failed to set slot 1 title for measure_humidity:',
    ]);
    assert.equal(device.entityKeys.sensorMap[1].capabilityId, 'measure_humidity.2');
  });

  test(`${label}: connection settings are stored, then reconnected once`, async () => {
    const { device, store } = createDevice(Driver);
    let reconnects = 0;
    device.reconnect = async () => { reconnects++; };
    await device.onSettings({
      newSettings: { host: '10.0.0.2', port: 6054, encryptionKey: '', password: '' },
      changedKeys: ['host', 'port', 'encryptionKey', 'password'],
    });
    assert.deepEqual(store, { address: '10.0.0.2', port: 6054, encryptionKey: null, password: null });
    assert.equal(reconnects, 1);
  });

  test(`${label}: only the changed connection setting is stored`, async () => {
    const { device, store } = createDevice(Driver);
    device.reconnect = async () => {};
    await device.onSettings({ newSettings: { host: 'a', port: 1 }, changedKeys: ['port'] });
    assert.deepEqual(store, { port: 1 });
  });

  test(`${label}: other settings neither store nor reconnect`, async () => {
    const { device, store } = createDevice(Driver);
    device.reconnect = async () => { throw new Error('unexpected reconnect'); };
    await device.onSettings({ newSettings: {}, changedKeys: ['humidity_decimals'] });
    assert.deepEqual(store, {});
  });
}

test('Mini: auto-curve settings restart the curve', async () => {
  const { device } = createDevice(MiniDevice);
  let restarts = 0;
  device.homey.setTimeout = fn => fn();
  device._initAutoCurve = () => { restarts++; };
  await device.onSettings({ newSettings: {}, changedKeys: ['auto_curve_enabled'] });
  assert.equal(restarts, 1);
});

test('Valve: a restart switch changes nothing on the device', async () => {
  const { device, values } = createDevice(ValveDevice);
  await device._mapEntity({ name: 'Restart', type: 'switch', key: 1 });
  await device._mapEntity({ name: 'Reboot', type: 'switch', key: 2 });
  assert.deepEqual(values, {});
  assert.equal(device.entityKeys.valve, undefined);
});

test('Valve: reconnect clears mappings and slot flags, even without a host', async () => {
  const { device } = createDevice(ValveDevice);
  let disconnects = 0;
  Object.assign(device, {
    client: { disconnect: () => { disconnects++; } },
    entityKeys: { valve: 1, closedSensor: 2, rehomeButton: 3, sensorMap: { 4: {} } },
    _slotTitleFlags: { humidity: true },
    _valvePosition: 1,
    _valveOperation: 'idle',
    _closedSensorState: false,
  });
  await device.reconnect();
  assert.equal(disconnects, 1);
  assert.equal(device.entityKeys.valve, null);
  assert.equal(device.entityKeys.closedSensor, null);
  assert.equal(device.entityKeys.rehomeButton, null);
  assert.deepEqual(device.entityKeys.sensorMap, {});
  assert.deepEqual(device._slotTitleFlags, {});
  assert.equal(device._valvePosition, null);
  assert.equal(device._valveOperation, null);
  assert.equal(device._closedSensorState, null);
});

test('Valve: startup without a host still has empty mappings', async () => {
  const { device } = createDevice(ValveDevice);
  delete device.entityKeys;
  device._migrateValveDevice = async () => {};
  device._registerCapabilityListeners = () => {};
  await device.onInit();
  assert.equal(device.entityKeys.valve, null);
  assert.deepEqual(device.entityKeys.sensorMap, {});
  assert.deepEqual(device._slotTitleFlags, {});
  assert.equal(device._valvePosition, null);
});

async function main() {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} of ${tests.length} shared device tests failed`);
  }
  console.log(`shared device behaviour tests passed (${tests.length})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
