'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME } = require('../../lib/constants');
const { roundToDecimals, isValveOrCover, SENSOR_TYPES, extractSensorSlot, detectMeasurementType, computeCapabilityId } = require('../../lib/utils');

// Localized base titles per measurement type for slot labeling
const SLOT_TITLES = {
  temperature: { en: 'Temperature', nl: 'Temperatuur', fr: 'Température' },
  humidity:    { en: 'Humidity',    nl: 'Vochtigheid', fr: 'Humidité' },
  co2:         { en: 'CO2',         nl: 'CO2',         fr: 'CO2' },
  voc:         { en: 'VOC Index',   nl: 'VOC Index',   fr: 'Indice COV' },
  nox:         { en: 'NOx Index',   nl: 'NOx Index',   fr: 'Indice NOx' },
};

/**
 * Normalize the logical state reported by ESPHome's binary sensor.
 * Hardware polarity is configured in ESPHome (Hall sensor: inverted true;
 * pre-v1.4 switch: inverted false), so the Homey app must not invert it.
 */
function parseBinaryState(state) {
  if (state?.missingState) return null;

  const rawState = typeof state === 'boolean' ? state : state?.state;
  if (typeof rawState === 'boolean') return rawState;
  if (rawState === 'true') return true;
  if (rawState === 'false') return false;
  return null;
}

/**
 * Normalize a valve position to the ESPHome 0..1 range.
 * Older adapters may expose a percentage, so accept 0..100 as well.
 */
function parseValvePosition(state) {
  const rawPosition = state?.position;
  const position = typeof rawPosition === 'number' ? rawPosition : Number(rawPosition);
  if (!Number.isFinite(position)) return null;

  if (position >= 0 && position <= 1) return position;
  if (position >= 0 && position <= 100) return position / 100;
  return null;
}

/**
 * Normalize ESPHome's valve operation enum/name across adapters.
 * ESPHome uses 0=IDLE, 1=OPENING, 2=CLOSING.
 */
function parseValveOperation(state) {
  const rawOperation = state?.currentOperation ?? state?.current_operation;
  if (rawOperation === undefined || rawOperation === null) return null;

  if (typeof rawOperation === 'number') {
    if (rawOperation === 0) return 'idle';
    if (rawOperation === 1) return 'opening';
    if (rawOperation === 2) return 'closing';
    return null;
  }

  const operation = String(rawOperation).toLowerCase().replace(/[^a-z]/g, '');
  if (operation === 'idle') return 'idle';
  if (operation === 'opening' || operation === 'open') return 'opening';
  if (operation === 'closing' || operation === 'closed' || operation === 'close') return 'closing';
  return null;
}

function valveEndpointFromPosition(position) {
  if (position <= 0.01) return false;
  if (position >= 0.99) return true;
  return null;
}

class OpenAirValveDevice extends Homey.Device {

  async onInit() {
    this.log('Open AIR Valve device has been initialized');

    // Entity key mappings (valve-specific, not using shared createEntityKeys)
    this.entityKeys = {
      valve: null,        // numeric key of the valve entity
      closedSensor: null, // numeric key of the "Closed Switch" binary_sensor
      rehomeButton: null, // numeric key of the "Re-home" button
      rebootSwitch: null, // numeric key of the "Restart" switch
      sensorMap: {},      // entityKey → { capabilityId, settingKey, defaultDecimals }
    };
    this._destroyed = false;
    this._slotTitleFlags = {};
    this._valvePosition = null;
    this._valveOperation = null;
    this._closedSensorState = null;

    // Migrate devices paired before the binary valve capability was used.
    await this._migrateValveDevice();

    // Initialize ESPHome client
    await this._initializeClient();

    // Register capability listeners
    this._registerCapabilityListeners();
  }

  /**
   * Initialize the ESPHome client and connect
   */
  async _initializeClient() {
    const store = this.getStore();
    const settings = this.getSettings();

    const host = store.address || settings.host;
    const port = store.port || settings.port || ESPHOME.DEFAULT_PORT;

    if (!host) {
      this.setUnavailable(this.homey.__('errors.no_host') || 'No host configured');
      return;
    }

    this.client = new EspHomeClient({
      host,
      port,
      encryptionKey: store.encryptionKey || null,
      password: store.password || null,
      diagnosticsLabel: 'open-air-valve-runtime',
      logger: this,
    });

    this.client.on('connected', async () => {
      this.log('Connected to Open AIR Valve');
      this.setAvailable();

      const entities = this.client.getEntities();
      for (const entity of entities) {
        await this._mapEntity(entity);
      }

      // Adapters retain the latest ESPHome state while connecting. Replay it
      // only after capabilities and entity mappings are ready.
      await this._replayInitialStates(entities);
    });

    this.client.on('disconnected', () => {
      this.log('Disconnected from Open AIR Valve');
      if (!this._destroyed) {
        this.setUnavailable(this.homey.__('errors.disconnected') || 'Device disconnected');
      }
    });

    this.client.on('error', (error) => {
      this.error('ESPHome client error:', error);
    });

    this.client.on('reconnectFailed', () => {
      if (!this._destroyed) {
        this.setUnavailable(this.homey.__('errors.reconnect_failed') || 'Failed to reconnect');
      }
    });

    this.client.on('entityDiscovered', async (entity) => {
      await this._mapEntity(entity);
    });

    this.client.on('stateChanged', ({ type, entity, state }) => {
      this._handleStateChange(type, entity, state);
    });

    try {
      await this.client.connect();
    } catch (error) {
      this.error('Failed to connect:', error);
      this.setUnavailable(this.homey.__('errors.connection_failed') || 'Connection failed');
    }
  }

  /**
   * Migrate older valve devices away from window-covering/percentage cards.
   * The standard `onoff` capability gives the tile Homey's normal power
   * quick-action icon while the separate read-only capability shows the
   * resolved Open/Closed status.
   */
  async _migrateValveDevice() {
    const obsoleteCapabilities = [
      'valve_open',
      'windowcoverings_set',
      'windowcoverings_state',
      'valve_position',
      'measure_valve_position',
    ];

    try {
      if (!this.hasCapability('onoff')) {
        await this.addCapability('onoff');
        this.log('Migrated: added onoff capability');
      }
      if (!this.hasCapability('measure_valve_closed')) {
        await this.addCapability('measure_valve_closed');
        this.log('Migrated: added measure_valve_closed capability');
      }

      for (const capabilityId of obsoleteCapabilities) {
        if (this.hasCapability(capabilityId)) {
          await this.removeCapability(capabilityId);
          this.log(`Migrated: removed ${capabilityId} capability`);
        }
      }
    } catch (error) {
      this.error('Failed to migrate valve capabilities:', error);
    }

    // Changing the manifest class affects newly paired devices; update
    // existing devices as well when the SDK exposes the runtime API.
    try {
      if (typeof this.setClass === 'function') {
        const currentClass = typeof this.getClass === 'function' ? this.getClass() : null;
        if (currentClass !== 'other') {
          await this.setClass('other');
          this.log('Migrated: changed valve device class to other');
        }
      }
    } catch (error) {
      this.error('Failed to migrate valve device class:', error);
    }
  }

  /**
   * Replay states captured during the connection handshake.
   */
  async _replayInitialStates(entities) {
    for (const entity of entities) {
      if (!entity || entity.state === null || entity.state === undefined) continue;
      await this._handleStateChange(entity.type, entity, entity.state);
    }
  }

  /**
   * Throw if the valve entity has not been discovered yet.
   */
  _requireValveEntity() {
    if (this.entityKeys.valve === null) {
      throw new Error(this.homey.__('errors.no_valve_entity') || 'Valve entity not found');
    }
  }

  /**
   * Map discovered ESPHome entity to Homey capability.
   */
  async _mapEntity(entity) {
    const name = entity.name || '';
    const type = entity.type?.toLowerCase() || '';
    const key = entity.key;
    const objectId = String(entity.objectId || entity.config?.objectId || '').toLowerCase();

    this.log(`Mapping entity: ${name} (type: ${entity.type}, key: ${key})`);

    // Map valve or cover entity
    if (isValveOrCover(type)) {
      this.entityKeys.valve = key;
      this.log(`Mapped valve entity: ${name} (key: ${key})`);
      return;
    }

    // Map closed switch binary sensor
    if (type === 'binary_sensor' && (
      name.toLowerCase().includes('closed')
      || objectId.includes('valve_homing_switch')
      || objectId.includes('valve_closed')
    )) {
      this.entityKeys.closedSensor = key;
      this.log(`Mapped closed sensor: ${name} (key: ${key})`);
      return;
    }

    // Map re-home button
    if (type === 'button' && name.toLowerCase().includes('re-home')) {
      this.entityKeys.rehomeButton = key;
      this.log(`Mapped re-home button: ${name} (key: ${key})`);
      return;
    }

    // Map reboot/restart switch
    if (type === 'switch' && (name.toLowerCase().includes('reboot') || name.toLowerCase().includes('restart'))) {
      this.entityKeys.rebootSwitch = key;
      this.log(`Mapped reboot switch: ${name} (key: ${key})`);
      return;
    }

    // Sensors — reuse unified detection (skip RPM for valve devices)
    if (type !== 'sensor') return;

    const measurementType = detectMeasurementType(name);
    if (!measurementType || measurementType === 'rpm') return;

    const slot = extractSensorSlot(name);
    const capabilityId = computeCapabilityId(measurementType, slot);
    const sensorType = SENSOR_TYPES[measurementType];

    try {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId);
        this.log(`Dynamically added ${capabilityId} capability`);
      }

      if (!sensorType.settingKey) {
        await this.setCapabilityOptions(capabilityId, {
          decimals: sensorType.defaultDecimals,
        });
      }

      if (slot != null && slot >= 2) {
        await this._setSlotTitle(capabilityId, measurementType, slot);
        await this._ensureSlot1Title(measurementType);
      }

      this.entityKeys.sensorMap[key] = {
        capabilityId,
        settingKey: sensorType.settingKey,
        defaultDecimals: sensorType.defaultDecimals,
      };

      this.log(`Mapped sensor: ${name} → ${capabilityId} (key: ${key}, slot: ${slot})`);
    } catch (err) {
      this.error(`Failed to map ${measurementType} entity (${name}):`, err);
    }
  }

  /**
   * Set the title for a slot-specific capability.
   */
  async _setSlotTitle(capabilityId, measurementType, slot) {
    const titles = SLOT_TITLES[measurementType];
    if (!titles) return;
    try {
      await this.setCapabilityOptions(capabilityId, {
        title: {
          en: `${titles.en} ${slot}`,
          nl: `${titles.nl} ${slot}`,
          fr: `${titles.fr} ${slot}`,
        },
      });
    } catch (err) {
      this.error(`Failed to set title for ${capabilityId}:`, err);
    }
  }

  /**
   * Relabel slot 1 base capability when slot 2+ is discovered.
   */
  async _ensureSlot1Title(measurementType) {
    if (this._slotTitleFlags[measurementType]) return;
    this._slotTitleFlags[measurementType] = true;

    const baseCapabilityId = SENSOR_TYPES[measurementType].base;
    const titles = SLOT_TITLES[measurementType];
    if (!titles || !this.hasCapability(baseCapabilityId)) return;

    try {
      await this.setCapabilityOptions(baseCapabilityId, {
        title: {
          en: `${titles.en} 1`,
          nl: `${titles.nl} 1`,
          fr: `${titles.fr} 1`,
        },
      });
    } catch (err) {
      this.error(`Failed to set slot 1 title for ${baseCapabilityId}:`, err);
    }
  }

  /**
   * Handle state changes from ESPHome
   */
  async _handleStateChange(type, entity, state) {
    const key = entity?.key;

    // Safety net: if we receive state data but device is marked unavailable, restore it
    if (!this._destroyed && !this.getAvailable()) {
      this.log('Received state while unavailable — restoring availability');
      this.setAvailable();
    }

    this.log(`State change for key ${key} (${type}):`, state);

    try {
      // The valve entity publishes endpoint position and movement completion.
      if (key === this.entityKeys.valve && isValveOrCover(type)) {
        await this._handleValveState(state);
        return;
      }

      // ESPHome publishes the already-normalized logical state of the Hall
      // sensor / homing switch. True confirms the physical closed endpoint;
      // false only means that the switch is not currently active.
      if (key === this.entityKeys.closedSensor && type === 'binary_sensor') {
        const closed = parseBinaryState(state);
        if (closed === null) return;

        this._closedSensorState = closed;
        if (closed) {
          await this._setResolvedValveState(false, 'closed switch');
        } else {
          const endpoint = valveEndpointFromPosition(this._valvePosition);
          if (this._valveOperation === 'idle' && endpoint === true) {
            await this._setResolvedValveState(true, 'valve open endpoint');
          }
        }
        return;
      }

      // Sensors via sensorMap
      if (type === 'sensor') {
        const mapping = this.entityKeys.sensorMap[key];
        if (!mapping) return;
        if (typeof state.state === 'number' && !state.missingState) {
          const configuredDecimals = mapping.settingKey ? this.getSetting(mapping.settingKey) : null;
          const parsedDecimals = Number.parseInt(configuredDecimals, 10);
          const decimals = mapping.settingKey && Number.isInteger(parsedDecimals)
            ? parsedDecimals
            : mapping.defaultDecimals;
          await this.setCapabilityValue(mapping.capabilityId, roundToDecimals(state.state, decimals));
        }
      }
    } catch (error) {
      this.error('Error updating capability:', error);
    }
  }

  /**
   * Resolve the binary valve state from ESPHome's valve telemetry.
   * Position is a target/endpoint value; IDLE confirms that the stepper has
   * completed the move. Intermediate positions are intentionally ignored.
   */
  async _handleValveState(state) {
    const position = parseValvePosition(state);
    if (position === null) return;

    const operation = parseValveOperation(state);
    const endpoint = valveEndpointFromPosition(position);
    this._valvePosition = position;
    this._valveOperation = operation;

    this.log('Valve telemetry:', {
      position,
      operation: operation || 'unknown',
      endpoint: endpoint === null ? 'intermediate' : (endpoint ? 'open' : 'closed'),
    });

    if (endpoint === null) return;

    // When operation is present, only IDLE is a completed endpoint. If an
    // older adapter omits currentOperation, the endpoint position is the
    // best available state and is accepted immediately.
    if (operation && operation !== 'idle') return;

    await this._setResolvedValveState(endpoint, 'valve telemetry');
  }

  /**
   * Update both the standard tile control and the read-only status capability.
   */
  async _setResolvedValveState(isOpen, source) {
    this.log(`Resolved valve state: ${isOpen ? 'Open' : 'Closed'} (${source})`);

    if (this.hasCapability('onoff') && this.getCapabilityValue('onoff') !== isOpen) {
      await this.setCapabilityValue('onoff', isOpen);
    }

    const isClosed = !isOpen;
    if (
      this.hasCapability('measure_valve_closed')
      && this.getCapabilityValue('measure_valve_closed') !== isClosed
    ) {
      await this.setCapabilityValue('measure_valve_closed', isClosed);
    }
  }

  /**
   * Register capability listeners for user interactions
   */
  _registerCapabilityListeners() {
    // Binary control only: true = open, false = closed.
    this.registerCapabilityListener('onoff', async (isOpen) => {
      if (typeof isOpen !== 'boolean') {
        throw new Error('Valve state must be boolean');
      }
      if (!this.client || !this.client.connected) {
        throw new Error(this.homey.__('errors.not_connected'));
      }
      this._requireValveEntity();
      this.log(`${isOpen ? 'Opening' : 'Closing'} valve`);
      await this.client.setValvePosition(this.entityKeys.valve, isOpen ? 1.0 : 0.0);
    });
  }

  // --- Flow action methods ---

  /**
   * Open valve fully.
   */
  async openValve() {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    this._requireValveEntity();
    this.log('Opening valve fully');
    await this.client.setValvePosition(this.entityKeys.valve, 1.0);
  }

  /**
   * Close valve fully.
   */
  async closeValve() {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    this._requireValveEntity();
    this.log('Closing valve fully');
    await this.client.setValvePosition(this.entityKeys.valve, 0.0);
  }

  /**
   * Re-home (recalibrate) the valve.
   */
  async rehomeValve() {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    if (this.entityKeys.rehomeButton === null) {
      throw new Error(this.homey.__('errors.no_rehome_button') || 'Re-home button not found');
    }
    this.log('Re-homing valve');
    await this.client.pressButton(this.entityKeys.rehomeButton);
  }

  /**
   * Restart the controller.
   */
  async restartController() {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    if (this.entityKeys.rebootSwitch === null) {
      throw new Error('Reboot switch not found on device');
    }
    this.log('Restarting controller');
    await this.client.setSwitchState(this.entityKeys.rebootSwitch, true);
  }

  /**
   * Reconnect to the device (used after repair)
   */
  async reconnect() {
    this.log('Reconnecting to device...');

    if (this.client) {
      this.client.disconnect();
    }

    this.entityKeys = {
      valve: null,
      closedSensor: null,
      rehomeButton: null,
      rebootSwitch: null,
      sensorMap: {},
    };
    this._slotTitleFlags = {};
    this._valvePosition = null;
    this._valveOperation = null;
    this._closedSensorState = null;

    await this._initializeClient();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    const connectionKeys = ['host', 'port', 'encryptionKey', 'password'];
    const connectionChanged = changedKeys.some(key => connectionKeys.includes(key));

    if (connectionChanged) {
      if (changedKeys.includes('host')) {
        await this.setStoreValue('address', newSettings.host);
      }
      if (changedKeys.includes('port')) {
        await this.setStoreValue('port', newSettings.port);
      }
      if (changedKeys.includes('encryptionKey')) {
        await this.setStoreValue('encryptionKey', newSettings.encryptionKey || null);
      }
      if (changedKeys.includes('password')) {
        await this.setStoreValue('password', newSettings.password || null);
      }

      await this.reconnect();
    }
  }

  async onDeleted() {
    this.log('Device deleted, cleaning up...');
    this._destroyed = true;

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  async onUninit() {
    this.log('Device uninit, cleaning up...');
    this._destroyed = true;

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

}

module.exports = OpenAirValveDevice;
