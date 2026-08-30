'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { createEntityKeys, getHighestHumidityReading } = require('../lib/utils');

function readFrom(values) {
  return (capabilityId) => values[capabilityId];
}

function loadOpenAirMiniDevice() {
  const originalLoad = Module._load;

  class HomeyDevice {}

  Module._load = function(request, parent, isMain) {
    if (request === 'homey') return { Device: HomeyDevice };
    return originalLoad.apply(this, arguments);
  };

  try {
    return require('../drivers/open-air-mini/device');
  } finally {
    Module._load = originalLoad;
  }
}

function testSingleSensorBehavior() {
  const humidity = getHighestHumidityReading(
    readFrom({ measure_humidity: 47 }),
    { sensor1: { capabilityId: 'measure_humidity' } },
  );

  assert.equal(humidity, 47);
}

function testUsesHighestMappedHumiditySensor() {
  const humidity = getHighestHumidityReading(
    readFrom({
      measure_humidity: 46,
      'measure_humidity.2': 81,
      'measure_temperature.2': 99,
    }),
    {
      sensor1: { capabilityId: 'measure_humidity' },
      sensor2: { capabilityId: 'measure_humidity.2' },
      temperature2: { capabilityId: 'measure_temperature.2' },
    },
  );

  assert.equal(humidity, 81);
}

function testSensorTwoDoesNotUseUnmappedBaseValue() {
  const humidity = getHighestHumidityReading(
    readFrom({
      measure_humidity: 99,
      'measure_humidity.2': 62,
    }),
    {
      sensor2: { capabilityId: 'measure_humidity.2' },
    },
  );

  assert.equal(humidity, 62);
}

function testIgnoresInvalidHumidityValues() {
  const humidity = getHighestHumidityReading(
    readFrom({
      measure_humidity: NaN,
      'measure_humidity.2': Infinity,
      'measure_humidity.3': undefined,
      'measure_humidity.4': '88',
      'measure_humidity.5': null,
      'measure_humidity.6': -Infinity,
    }),
    {
      sensor1: { capabilityId: 'measure_humidity' },
      sensor2: { capabilityId: 'measure_humidity.2' },
      sensor3: { capabilityId: 'measure_humidity.3' },
      sensor4: { capabilityId: 'measure_humidity.4' },
      sensor5: { capabilityId: 'measure_humidity.5' },
      sensor6: { capabilityId: 'measure_humidity.6' },
    },
  );

  assert.equal(humidity, null);
}

function testSkipsUnavailableMappedCapabilities() {
  const readCalls = [];
  const humidity = getHighestHumidityReading(
    (capabilityId) => {
      readCalls.push(capabilityId);
      if (capabilityId === 'measure_humidity.2') {
        throw new Error('capability should have been filtered before reading');
      }
      return capabilityId === 'measure_humidity' ? 62 : null;
    },
    {
      sensor1: { capabilityId: 'measure_humidity' },
      sensor2: { capabilityId: 'measure_humidity.2' },
    },
    (capabilityId) => capabilityId !== 'measure_humidity.2',
  );

  assert.equal(humidity, 62);
  assert.deepEqual(readCalls, ['measure_humidity']);
}

function testSkipsStaleHumidityValues() {
  const humidity = getHighestHumidityReading(
    readFrom({
      measure_humidity: 46,
      'measure_humidity.2': 91,
    }),
    {
      sensor1: { capabilityId: 'measure_humidity' },
      sensor2: { capabilityId: 'measure_humidity.2' },
    },
    undefined,
    (capabilityId) => capabilityId !== 'measure_humidity.2',
  );

  assert.equal(humidity, 46);
}

async function testDeviceHumidityFreshnessLifecycle() {
  const OpenAirMiniDevice = loadOpenAirMiniDevice();
  const device = new OpenAirMiniDevice();
  const values = {};

  device.entityKeys = createEntityKeys();
  device._slotTitleFlags = {};
  device._invalidHumidityCapabilities = new Set();
  device._destroyed = true;
  device.log = () => {};
  device.error = (...args) => { throw new Error(args.join(' ')); };
  device.getAvailable = () => true;
  device.setAvailable = () => {};
  device.hasCapability = () => true;
  device.addCapability = async () => {};
  device.setCapabilityOptions = async () => {};
  device.getSetting = () => 1;
  device.getCapabilityValue = capabilityId => values[capabilityId] ?? null;
  device.setCapabilityValue = async (capabilityId, value) => {
    values[capabilityId] = value;
  };

  const sensor1 = { name: 'Sensor 1 Humidity', type: 'sensor', key: 'sensor1' };
  const sensor2 = { name: 'Sensor 2 Humidity', type: 'sensor', key: 'sensor2' };

  await device._mapEntity(sensor1);
  await device._mapEntity(sensor2);
  assert.equal(device.getHumidityForControl(), null);

  await device._handleStateChange('sensor', sensor1, { state: 46, missingState: false });
  await device._handleStateChange('sensor', sensor2, { state: 81, missingState: false });
  assert.equal(device.getHumidityForControl(), 81);

  // Duplicate discovery must not invalidate an already-fresh reading.
  await device._mapEntity(sensor2);
  assert.equal(device.getHumidityForControl(), 81);

  await device._handleStateChange('sensor', sensor2, { state: null, missingState: true });
  assert.equal(device.getHumidityForControl(), 46);

  device._stopAutoCurve = () => {};
  device.client = { disconnect: () => {} };
  device._initializeClient = async () => {};
  device._initAutoCurve = () => {};
  await device.reconnect();

  assert.equal(device._invalidHumidityCapabilities.has('measure_humidity'), true);
  assert.equal(device._invalidHumidityCapabilities.has('measure_humidity.2'), true);
  assert.equal(device.getHumidityForControl(), null);
}

async function main() {
  testSingleSensorBehavior();
  testUsesHighestMappedHumiditySensor();
  testSensorTwoDoesNotUseUnmappedBaseValue();
  testIgnoresInvalidHumidityValues();
  testSkipsUnavailableMappedCapabilities();
  testSkipsStaleHumidityValues();
  await testDeviceHumidityFreshnessLifecycle();
  console.log('humidity reading tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
