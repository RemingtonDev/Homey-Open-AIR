'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME, COMMAND } = require('../../lib/constants');
const { createEntityKeys, fixCorruptedDimValue, clampDimValue, roundToDecimals, SENSOR_TYPES, extractSensorSlot, detectMeasurementType, computeCapabilityId } = require('../../lib/utils');

// Localized base titles per measurement type for slot labeling
const SLOT_TITLES = {
  temperature: { en: 'Temperature', nl: 'Temperatuur', fr: 'Température' },
  humidity:    { en: 'Humidity',    nl: 'Vochtigheid', fr: 'Humidité' },
  co2:         { en: 'CO2',         nl: 'CO2',         fr: 'CO2' },
  rpm:         { en: 'RPM',         nl: 'Toerental',   fr: 'RPM' },
  voc:         { en: 'VOC Index',   nl: 'VOC Index',   fr: 'Indice COV' },
  nox:         { en: 'NOx Index',   nl: 'NOx Index',   fr: 'Indice NOx' },
};

class OpenAirMiniDevice extends Homey.Device {

  async onInit() {
    this.log('Open AIR Mini device has been initialized');

    // Entity key mappings (numeric keys from @2colors/esphome-native-api)
    this.entityKeys = createEntityKeys();
    this._destroyed = false;
    this._slotTitleFlags = {}; // tracks which measurement types have had slot 1 relabeled

    // Fix corrupted dim value immediately (from previous buggy 0-100 scaling)
    await this._fixCorruptedDimValue();

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

    // Set up event handlers
    this.client.on('connected', async () => {
      this.log('Connected to Open AIR Mini');
      this.setAvailable();

      // Map entities that were discovered during connect() (before event listeners were wired)
      for (const entity of this.client.getEntities()) {
        await this._mapEntity(entity);
      }

      // Fix corrupted dim value if outside 0-1 range (from previous buggy code)
      await this._fixCorruptedDimValue();
    });

    this.client.on('disconnected', () => {
      this.log('Disconnected from Open AIR Mini');
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

    // Connect to device
    try {
      await this.client.connect();
    } catch (error) {
      this.error('Failed to connect:', error);
      this.setUnavailable(this.homey.__('errors.connection_failed') || 'Connection failed');
    }
  }

  /**
   * Fix corrupted dim values that were stored as 0-100 instead of 0-1.
   * Homey `dim` capability should always be 0..1.
   */
  async _fixCorruptedDimValue() {
    try {
      const currentDim = this.getCapabilityValue('dim');
      if (typeof currentDim === 'number' && (currentDim < 0 || currentDim > 1)) {
        const fixedDim = fixCorruptedDimValue(currentDim);
        this.log(`Fixing corrupted dim value: ${currentDim} -> ${fixedDim}`);
        await this.setCapabilityValue('dim', fixedDim);
      }
    } catch (error) {
      this.error('Error fixing dim value:', error);
    }
  }

  /**
   * Throw if the fan entity has not been discovered yet.
   */
  _requireFanEntity() {
    if (this.entityKeys.fan === null) {
      throw new Error(this.homey.__('errors.no_fan_entity') || 'Fan entity not found');
    }
  }

  /**
   * Map discovered ESPHome entity to Homey capability.
   * Fan is a special case; all sensor types use unified sensorMap logic.
   */
  async _mapEntity(entity) {
    const name = entity.name || '';
    const type = entity.type?.toLowerCase() || '';
    const key = entity.key;

    this.log(`Mapping entity: ${name} (type: ${entity.type}, key: ${key})`);

    // Map fan entity (special case — not a sensor)
    if (type === 'fan') {
      this.entityKeys.fan = key;
      this.entityKeys.fanSpeedLevels = entity.config?.supportedSpeedLevels
        || entity.config?.supportedSpeedCount
        || entity.config?.supported_speed_levels
        || entity.config?.supported_speed_count
        || 100;
      this.log(`Mapped fan entity: ${name} (key: ${key}, speedLevels: ${this.entityKeys.fanSpeedLevels}, config: ${JSON.stringify(entity.config)})`);
      return;
    }

    // All sensor types via unified detection
    if (type !== 'sensor') return;

    const measurementType = detectMeasurementType(name);
    if (!measurementType) return;

    const slot = extractSensorSlot(name);
    const capabilityId = computeCapabilityId(measurementType, slot);
    const sensorType = SENSOR_TYPES[measurementType];

    try {
      // Dynamically add capability if not already present
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId);
        this.log(`Dynamically added ${capabilityId} capability`);
      }

      // Set slot title for slot 2+ sensors
      if (slot != null && slot >= 2) {
        await this._setSlotTitle(capabilityId, measurementType, slot);
        // Also relabel slot 1 base capability so users can distinguish
        await this._ensureSlot1Title(measurementType);
      }

      // Store in sensorMap
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
   * Set the title for a slot-specific capability, e.g. "Temperature 2".
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
   * When a slot 2+ sensor is discovered, relabel the slot 1 base capability
   * to include "1" so users can distinguish (e.g. "Temperature" → "Temperature 1").
   * Guarded by _slotTitleFlags to avoid repeated calls.
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
      // Fan state (special case)
      if (key === this.entityKeys.fan && type === 'fan') {
        if (typeof state.state === 'boolean') {
          await this.setCapabilityValue('onoff', state.state);
        }
        if (typeof state.speedLevel === 'number') {
          const normalizedSpeed = state.speedLevel / this.entityKeys.fanSpeedLevels;
          await this.setCapabilityValue('dim', clampDimValue(normalizedSpeed));
        }
        return;
      }

      // All sensors via sensorMap (single lookup replaces individual if-blocks)
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
    // Debounce timer for dim capability
    this._dimDebounceTimer = null;

    // On/Off capability
    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Setting fan state to: ${value}`);

      this._requireFanEntity();

      await this.client.setFanState(this.entityKeys.fan, { state: value });
    });

    // Dim (Fan Speed) capability with debouncing
    this.registerCapabilityListener('dim', async (value) => {
      // Clear any pending debounce timer
      if (this._dimDebounceTimer) {
        clearTimeout(this._dimDebounceTimer);
      }

      return new Promise((resolve, reject) => {
        this._dimDebounceTimer = setTimeout(async () => {
          try {
            // Convert Homey dim (0-1) to ESPHome speedLevel (0-supportedSpeedLevels)
            const speed = Math.round(value * this.entityKeys.fanSpeedLevels);
            this.log(`Setting fan speed to: ${speed} (of ${this.entityKeys.fanSpeedLevels})`);

            this._requireFanEntity();

            await this.client.setFanState(this.entityKeys.fan, {
              state: speed > 0,
              speed,
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        }, COMMAND.DEBOUNCE_MS);
      });
    });
  }

  /**
   * Set fan speed using a 0-100% scale.
   * Converts percentage to ESPHome speed level and handles on/off.
   * @param {number} percent - Fan speed 0-100%
   */
  async setFanSpeedPercent(percent) {
    if (!this.client || !this.client.connected) {
      throw new Error(this.homey.__('errors.not_connected'));
    }

    this._requireFanEntity();

    const speed = Math.round((percent / 100) * this.entityKeys.fanSpeedLevels);

    this.log(`setFanSpeedPercent: ${percent}% → speed level ${speed} (of ${this.entityKeys.fanSpeedLevels})`);

    await this.client.setFanState(this.entityKeys.fan, {
      state: speed > 0,
      speed,
    });
  }

  /**
   * Reconnect to the device (used after repair)
   */
  async reconnect() {
    this.log('Reconnecting to device...');

    if (this.client) {
      this.client.disconnect();
    }

    // Reset entity mappings and slot title flags
    this.entityKeys = createEntityKeys();
    this._slotTitleFlags = {};

    await this._initializeClient();
  }

  /**
   * Called when settings are changed
   */
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

  /**
   * Called when device is deleted
   */
  async onDeleted() {
    this.log('Device deleted, cleaning up...');
    this._destroyed = true;

    if (this._dimDebounceTimer) {
      clearTimeout(this._dimDebounceTimer);
      this._dimDebounceTimer = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  /**
   * Called when device is uninit (app restart, etc.)
   */
  async onUninit() {
    this.log('Device uninit, cleaning up...');
    this._destroyed = true;

    if (this._dimDebounceTimer) {
      clearTimeout(this._dimDebounceTimer);
      this._dimDebounceTimer = null;
    }

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

}

module.exports = OpenAirMiniDevice;
