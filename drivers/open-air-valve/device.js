'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME, COMMAND } = require('../../lib/constants');
const { roundToDecimals, SENSOR_TYPES, extractSensorSlot, detectMeasurementType, computeCapabilityId } = require('../../lib/utils');

// Localized base titles per measurement type for slot labeling
const SLOT_TITLES = {
  temperature: { en: 'Temperature', nl: 'Temperatuur', fr: 'Température' },
  humidity:    { en: 'Humidity',    nl: 'Vochtigheid', fr: 'Humidité' },
  co2:         { en: 'CO2',         nl: 'CO2',         fr: 'CO2' },
  voc:         { en: 'VOC Index',   nl: 'VOC Index',   fr: 'Indice COV' },
  nox:         { en: 'NOx Index',   nl: 'NOx Index',   fr: 'Indice NOx' },
};

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
      logger: this,
    });

    this.client.on('connected', async () => {
      this.log('Connected to Open AIR Valve');
      this.setAvailable();

      for (const entity of this.client.getEntities()) {
        await this._mapEntity(entity);
      }
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

    this.log(`Mapping entity: ${name} (type: ${entity.type}, key: ${key})`);

    // Map valve entity
    if (type === 'valve') {
      this.entityKeys.valve = key;
      this.log(`Mapped valve entity: ${name} (key: ${key})`);
      return;
    }

    // Map closed switch binary sensor
    if (type === 'binary_sensor' && name.toLowerCase().includes('closed')) {
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

    this.log(`State change for key ${key} (${type}):`, state);

    try {
      // Valve state
      if (key === this.entityKeys.valve && type === 'valve') {
        // Position: 0 (closed) to 1 (open)
        if (typeof state.position === 'number') {
          await this.setCapabilityValue('windowcoverings_set', state.position);
          if (this.hasCapability('measure_valve_position')) {
            await this.setCapabilityValue('measure_valve_position', roundToDecimals(state.position * 100, 0));
          }
        }
        // Current operation: 0=IDLE, 1=IS_OPENING, 2=IS_CLOSING
        if (typeof state.currentOperation === 'number') {
          let windowState = 'idle';
          if (state.currentOperation === 1) windowState = 'up';
          else if (state.currentOperation === 2) windowState = 'down';
          await this.setCapabilityValue('windowcoverings_state', windowState);
        }
        return;
      }

      // Closed switch binary sensor
      if (key === this.entityKeys.closedSensor && type === 'binary_sensor') {
        if (typeof state.state === 'boolean' && this.hasCapability('measure_valve_closed')) {
          await this.setCapabilityValue('measure_valve_closed', state.state);
        }
        return;
      }

      // Sensors via sensorMap
      if (type === 'sensor') {
        const mapping = this.entityKeys.sensorMap[key];
        if (!mapping) return;
        if (typeof state.state === 'number' && !state.missingState) {
          const decimals = parseInt(this.getSetting(mapping.settingKey) ?? String(mapping.defaultDecimals), 10);
          await this.setCapabilityValue(mapping.capabilityId, roundToDecimals(state.state, decimals));
        }
      }
    } catch (error) {
      this.error('Error updating capability:', error);
    }
  }

  /**
   * Register capability listeners for user interactions
   */
  _registerCapabilityListeners() {
    this._positionDebounceTimer = null;

    // Valve position slider (windowcoverings_set) with debouncing
    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      if (this._positionDebounceTimer) {
        clearTimeout(this._positionDebounceTimer);
      }

      return new Promise((resolve, reject) => {
        this._positionDebounceTimer = setTimeout(async () => {
          try {
            this.log(`Setting valve position to: ${value}`);
            this._requireValveEntity();
            await this.client.setValvePosition(this.entityKeys.valve, value);
            resolve();
          } catch (error) {
            reject(error);
          }
        }, COMMAND.DEBOUNCE_MS);
      });
    });

    // Valve control ternary buttons (windowcoverings_state)
    this.registerCapabilityListener('windowcoverings_state', async (value) => {
      this.log(`Valve control action: ${value}`);
      this._requireValveEntity();

      if (value === 'up') {
        await this.client.setValvePosition(this.entityKeys.valve, 1.0);
      } else if (value === 'down') {
        await this.client.setValvePosition(this.entityKeys.valve, 0.0);
      } else if (value === 'idle') {
        await this.client.stopValve(this.entityKeys.valve);
      }
    });
  }

  // --- Flow action methods ---

  /**
   * Set valve position using a 0-100% scale.
   */
  async setValvePositionPercent(percent) {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    this._requireValveEntity();
    const position = percent / 100;
    this.log(`setValvePositionPercent: ${percent}% → position ${position}`);
    await this.client.setValvePosition(this.entityKeys.valve, position);
  }

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
   * Stop valve movement.
   */
  async stopValve() {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }
    this._requireValveEntity();
    this.log('Stopping valve');
    await this.client.stopValve(this.entityKeys.valve);
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

    if (this._positionDebounceTimer) {
      clearTimeout(this._positionDebounceTimer);
      this._positionDebounceTimer = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  async onUninit() {
    this.log('Device uninit, cleaning up...');
    this._destroyed = true;

    if (this._positionDebounceTimer) {
      clearTimeout(this._positionDebounceTimer);
      this._positionDebounceTimer = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

}

module.exports = OpenAirValveDevice;
