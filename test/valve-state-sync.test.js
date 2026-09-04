'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = relativePath => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8'),
);

function createLogger() {
  return {
    log() {},
    error() {},
  };
}

function loadDevice(relativePath) {
  const originalLoad = Module._load;

  class HomeyDevice {}

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'homey') return { Device: HomeyDevice };
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(relativePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createDevice(DeviceClass, capabilities = [], values = {}) {
  const device = new DeviceClass();
  const capabilitySet = new Set(capabilities);
  const capabilityValues = { ...values };
  const capabilityOptions = {};
  const setCalls = [];
  const listeners = {};

  device.entityKeys = {
    valve: null,
    closedSensor: null,
    rehomeButton: null,
    rebootSwitch: null,
    sensorMap: {},
  };
  device._slotTitleFlags = {};
  device._invalidHumidityCapabilities = new Set();
  device._destroyed = true;
  device.log = () => {};
  device.error = (...args) => {
    throw new Error(args.join(' '));
  };
  device.getAvailable = () => true;
  device.setAvailable = () => {};
  device.hasCapability = capabilityId => capabilitySet.has(capabilityId);
  device.addCapability = async capabilityId => capabilitySet.add(capabilityId);
  device.removeCapability = async capabilityId => capabilitySet.delete(capabilityId);
  device.getCapabilityValue = capabilityId => capabilityValues[capabilityId] ?? null;
  device.setCapabilityValue = async (capabilityId, value) => {
    capabilityValues[capabilityId] = value;
    setCalls.push({ capabilityId, value });
  };
  device.setCapabilityOptions = async (capabilityId, options) => {
    capabilityOptions[capabilityId] = {
      ...(capabilityOptions[capabilityId] || {}),
      ...options,
    };
  };
  device.registerCapabilityListener = (capabilityId, listener) => {
    listeners[capabilityId] = listener;
  };
  device.homey = { __: key => key };
  device.getSetting = settingKey => (settingKey === 'temperature_decimals' ? 1 : 2);
  device.getClass = () => 'blinds';
  device.setClass = async deviceClass => {
    device._testClass = deviceClass;
  };

  return {
    device,
    capabilitySet,
    capabilityValues,
    capabilityOptions,
    setCalls,
    listeners,
  };
}

function testManifestsUseBinaryValveControl() {
  const valveDriver = readJson('drivers/open-air-valve/driver.compose.json');
  const miniDriver = readJson('drivers/open-air-mini/driver.compose.json');
  const valveClosed = readJson('.homeycompose/capabilities/measure_valve_closed.json');
  const app = readJson('.homeycompose/app.json');

  assert.equal(valveDriver.class, 'other');
  assert.deepEqual(valveDriver.capabilities, ['onoff', 'measure_valve_closed']);
  assert.equal('valve_position' in valveDriver.capabilitiesOptions, false);
  assert.equal(valveDriver.capabilitiesOptions.onoff.quickAction, true);
  assert.equal(valveDriver.capabilitiesOptions.onoff.title.en, 'Valve');
  assert.equal(valveClosed.type, 'boolean');
  assert.equal(valveClosed.setable, false);
  assert.equal(valveClosed.uiComponent, 'sensor');
  assert.equal(valveClosed.titleTrue.en, 'Closed');
  assert.equal(valveClosed.titleFalse.en, 'Open');
  assert.equal(app.compatibility, '>=12.2.0');
  assert.equal(app.version, '1.4.0');

  for (const driver of [valveDriver, miniDriver]) {
    const settings = driver.settings.flatMap(group => group.children || []);
    assert.equal(
      settings.some(setting => setting.id === 'co2_decimals'),
      false,
      'CO₂ must not expose a decimal setting',
    );
    assert.equal(driver.capabilitiesOptions.measure_co2.decimals, 0);
  }
}

function testLegacyBinarySensorsAreClassifiedCorrectly() {
  const LegacyAdapter = require('../lib/adapters/LegacyAdapter');
  class BinarySensor extends EventEmitter {}

  const entity = new BinarySensor();
  entity.config = {
    key: 42,
    name: 'Valve Closed Switch',
    objectId: 'valve_closed_switch',
  };
  entity.state = { state: true };

  const adapter = new LegacyAdapter({
    host: '127.0.0.1',
    port: 6053,
    logger: createLogger(),
  });

  adapter._handleEntityDiscovered(entity);
  const entityInfo = adapter.entities.get(42);
  assert.equal(entityInfo.type, 'binary_sensor');
  assert.deepEqual(entityInfo.state, { state: true });

  entity.emit('state', { state: false });
  assert.deepEqual(entityInfo.state, { state: false });
}

function testModernAdapterKeepsStatesBeforeAndAfterDiscovery() {
  const ModernAdapter = require('../lib/adapters/ModernAdapter');
  const adapter = new ModernAdapter({
    host: '127.0.0.1',
    port: 6053,
    logger: createLogger(),
  });

  adapter._handleStateChange('valve', {
    key: 7,
    entity: 'valve_open_air',
    position: 0.72,
  });
  adapter._handleEntityDiscovered({
    type: 'valve',
    key: 7,
    name: 'Open AIR Valve',
    objectId: 'open_air',
  });

  const entityInfo = adapter.entities.get(7);
  assert.equal(entityInfo.state.position, 0.72);

  adapter._handleStateChange('valve', {
    key: 7,
    entity: 'valve_open_air',
    position: 0.31,
  });
  assert.equal(entityInfo.state.position, 0.31);

  adapter._handleStateChange('binary_sensor', {
    key: 8,
    entity: 'valve_homing_switch',
    state: true,
  });
  adapter._handleEntityDiscovered({
    type: 'binary_sensor',
    key: 8,
    name: 'Valve Closed Switch',
    objectId: 'valve_homing_switch',
  });
  assert.equal(adapter.entities.get(8).state.state, true);
}

async function testExistingValveDeviceMigratesWithoutGuessingState() {
  const ValveDevice = loadDevice('../drivers/open-air-valve/device');
  const fixture = createDevice(
    ValveDevice,
    [
      'valve_open',
      'windowcoverings_set',
      'windowcoverings_state',
      'valve_position',
      'measure_valve_position',
    ],
    { valve_position: 0.42 },
  );

  await fixture.device._migrateValveDevice();

  assert.equal(fixture.capabilitySet.has('onoff'), true);
  assert.equal(fixture.capabilitySet.has('measure_valve_closed'), true);
  assert.equal(fixture.capabilityValues.onoff, undefined);
  assert.deepEqual(
    [...fixture.capabilitySet].sort(),
    ['measure_valve_closed', 'onoff'],
  );
  assert.equal(fixture.device._testClass, 'other');
  assert.equal(typeof fixture.device.setValvePositionPercent, 'undefined');
  assert.equal(typeof fixture.device.stopValve, 'undefined');
}

async function testHallSensorStateIsReplayedAndUpdated() {
  const ValveDevice = loadDevice('../drivers/open-air-valve/device');
  const fixture = createDevice(ValveDevice, ['onoff', 'measure_valve_closed']);
  fixture.device.entityKeys.valve = 12;

  await fixture.device._mapEntity({
    type: 'binary_sensor',
    key: 9,
    name: 'Homing Sensor',
    objectId: 'valve_homing_switch',
  });
  await fixture.device._replayInitialStates([
    {
      type: 'binary_sensor',
      key: 9,
      name: 'Homing Sensor',
      objectId: 'valve_homing_switch',
      state: { state: true },
    },
  ]);

  assert.equal(fixture.capabilityValues.measure_valve_closed, true);
  assert.equal(fixture.capabilityValues.onoff, false);

  await fixture.device._handleStateChange(
    'binary_sensor',
    { key: 9 },
    { state: false },
  );
  assert.equal(fixture.capabilityValues.measure_valve_closed, true);
  assert.equal(fixture.capabilityValues.onoff, false);

  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 1.0, currentOperation: 0 },
  );
  assert.equal(fixture.capabilityValues.measure_valve_closed, false);
  assert.equal(fixture.capabilityValues.onoff, true);

  await fixture.device._handleStateChange(
    'binary_sensor',
    { key: 9 },
    { state: 'true' },
  );
  assert.equal(fixture.capabilityValues.measure_valve_closed, true);
  assert.equal(fixture.capabilityValues.onoff, false);
}

async function testValveTelemetryResolvesOnlyCompletedEndpoints() {
  const ValveDevice = loadDevice('../drivers/open-air-valve/device');
  const fixture = createDevice(ValveDevice, ['onoff', 'measure_valve_closed']);
  fixture.device.entityKeys.valve = 12;

  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 1.0, currentOperation: 1 },
  );
  assert.equal(fixture.capabilityValues.onoff, undefined);
  assert.equal(fixture.capabilityValues.measure_valve_closed, undefined);

  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 1.0, currentOperation: 0 },
  );
  assert.equal(fixture.capabilityValues.onoff, true);
  assert.equal(fixture.capabilityValues.measure_valve_closed, false);

  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 0.0, currentOperation: 2 },
  );
  assert.equal(fixture.capabilityValues.onoff, true);
  assert.equal(fixture.capabilityValues.measure_valve_closed, false);

  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 0.0, currentOperation: 'IDLE' },
  );
  assert.equal(fixture.capabilityValues.onoff, false);
  assert.equal(fixture.capabilityValues.measure_valve_closed, true);

  // A false Closed Switch state means only "not at the closed endpoint";
  // it must not undo the completed Closed state.
  await fixture.device._mapEntity({
    type: 'binary_sensor',
    key: 9,
    name: 'Closed Switch',
    objectId: 'valve_homing_switch',
  });
  await fixture.device._handleStateChange(
    'binary_sensor',
    { key: 9 },
    { state: false },
  );
  assert.equal(fixture.capabilityValues.onoff, false);
  assert.equal(fixture.capabilityValues.measure_valve_closed, true);

  // When the adapter omits currentOperation, an endpoint is still accepted
  // for compatibility with older protocol adapters.
  await fixture.device._handleStateChange(
    'valve',
    { key: 12 },
    { position: 100 },
  );
  assert.equal(fixture.capabilityValues.onoff, true);
  assert.equal(fixture.capabilityValues.measure_valve_closed, false);
}

async function testBinaryValveCommandsUseOnlyEndpoints() {
  const ValveDevice = loadDevice('../drivers/open-air-valve/device');
  const fixture = createDevice(ValveDevice, ['onoff', 'measure_valve_closed']);
  const calls = [];

  fixture.device.entityKeys.valve = 12;
  fixture.device.client = {
    connected: true,
    setValvePosition: async (key, position) => calls.push({ key, position }),
  };
  fixture.device._registerCapabilityListeners();

  await fixture.listeners.onoff(true);
  await fixture.listeners.onoff(false);
  await fixture.device.openValve();
  await fixture.device.closeValve();

  assert.deepEqual(calls, [
    { key: 12, position: 1.0 },
    { key: 12, position: 0.0 },
    { key: 12, position: 1.0 },
    { key: 12, position: 0.0 },
  ]);
}

async function testCo2AlwaysUsesWholePpm() {
  const ValveDevice = loadDevice('../drivers/open-air-valve/device');
  const fixture = createDevice(ValveDevice, ['onoff', 'measure_valve_closed']);

  await fixture.device._mapEntity({
    type: 'sensor',
    key: 11,
    name: 'CO2 Sensor',
  });
  await fixture.device._handleStateChange(
    'sensor',
    { key: 11 },
    { state: 678.7 },
  );

  assert.equal(fixture.capabilityValues.measure_co2, 679);
  assert.equal(fixture.capabilityOptions.measure_co2.decimals, 0);
}

async function main() {
  testManifestsUseBinaryValveControl();
  testLegacyBinarySensorsAreClassifiedCorrectly();
  testModernAdapterKeepsStatesBeforeAndAfterDiscovery();
  await testExistingValveDeviceMigratesWithoutGuessingState();
  await testHallSensorStateIsReplayedAndUpdated();
  await testValveTelemetryResolvesOnlyCompletedEndpoints();
  await testBinaryValveCommandsUseOnlyEndpoints();
  await testCo2AlwaysUsesWholePpm();
  console.log('valve state sync tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
