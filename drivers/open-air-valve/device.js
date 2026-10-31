'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const diagnostics = require('../../lib/runtimeDiagnostics');
const applySlotTitles = require('../../lib/slotTitles');
const { ESPHOME } = require('../../lib/constants');
const {
  roundToDecimals,
  isValveOrCover,
  SENSOR_TYPES,
  extractSensorSlot,
  detectMeasurementType,
  computeCapabilityId,
  storeConnectionSettings,
} = require('../../lib/utils');

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

// A re-home reaches its final IDLE report about 4 seconds after the switch.
const REHOME_REPORT_WAIT_MS = 30000;
const OWN_CLOSE_COMMAND_WINDOW_MS = 60000;

function valveEndpointFromPosition(position) {
  if (position <= 0.01) return false;
  if (position >= 0.99) return true;
  return null;
}

class OpenAirValveDevice extends Homey.Device {

  /**
   * Write one line to the connection journal. Each line carries the sensor
   * reports since the previous one, which shows the link was alive between
   * lines without journalling every sensor value.
   */
  _journal(event, details = {}) {
    try {
      diagnostics.record(event, {
        device: this.getName(),
        sensorReports: this._sensorReports || 0,
        ...details,
      });
      this._sensorReports = 0;
    } catch (_) {
      // Diagnostics must never affect the valve.
    }
  }

  async setAvailable() {
    this._journal('availability', { available: true });
    return super.setAvailable();
  }

  async setUnavailable(message) {
    this._journal('availability', { available: false, message });
    return super.setUnavailable(message);
  }

  async onInit() {
    this.log('Open AIR Valve device has been initialized');

    this._destroyed = false;
    this._slotTitleFlags = {};

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

    this._clearDiscoveryTimer();
    this._valveReady = false;
    this._resetValveMappings();

    if (!host) {
      this.setUnavailable(this.homey.__('errors.no_host') || 'No host configured');
      return;
    }

    const client = new EspHomeClient({
      host, port,
      encryptionKey: store.encryptionKey || null,
      password: store.password || null,
      diagnosticsLabel: 'open-air-valve-runtime',
      diagnosticsDevice: this.getName(),
      logger: this,
    });
    this.client = client;
    const current = () => !this._destroyed && this.client === client;
    let epoch = 0;
    const enqueue = (work, label) => {
      const eventEpoch = epoch;
      this._entityQueue = (this._entityQueue || Promise.resolve()).then(async () => {
        if (!current() || eventEpoch !== epoch) {
          this._journal('valve_report_dropped', {
            ...label,
            reason: current() ? 'stale connection' : 'client replaced',
          });
          return;
        }
        await work();
        if (current() && eventEpoch === epoch) await this._updateValveReadiness();
      }).catch(error => this.error('Valve discovery/state processing failed:', error));
    };
    await this.setUnavailable('Discovering valve control and position');

    client.on('connected', () => {
      if (!current()) return;
      epoch++;
      this._valveReady = false;
      this.setUnavailable('Discovering valve control and position').catch(this.error.bind(this));
      enqueue(async () => {
        this._resetValveMappings();
        const entities = client.getEntities();
        for (const entity of entities) await this._mapEntity(entity);
        await this._replayInitialStates(entities);
      }, { source: 'connected' });
      this._scheduleDiscoveryRecovery(client);
    });
    client.on('disconnected', () => {
      if (!current()) return;
      epoch++;
      this._valveReady = false;
      this._clearDiscoveryTimer();
      this.setUnavailable(this.homey.__('errors.disconnected') || 'Device disconnected')
        .catch(this.error.bind(this));
    });
    client.on('error', error => {
      if (current()) this.error('ESPHome client error:', error);
    });
    client.on('reconnectFailed', () => {
      if (current()) this.setUnavailable(this.homey.__('errors.reconnect_failed'))
        .catch(this.error.bind(this));
    });
    client.on('entityDiscovered', entity => enqueue(async () => {
      await this._mapEntity(entity);
      await this._replayInitialStates([entity]);
    }, { source: 'entityDiscovered', entity: entity.name }));
    client.on('stateChanged', ({ type, entity, state }) =>
      enqueue(() => this._handleStateChange(type, entity, state),
        { source: 'stateChanged', type, entity: entity?.name }));
    try {
      await client.connect();
    } catch (error) {
      if (!current()) return;
      this.error('Failed to connect:', error);
      await this.setUnavailable(this.homey.__('errors.connection_failed') || 'Connection failed');
      this._scheduleDiscoveryRecovery(client);
    }
  }

  _resetValveMappings() {
    // Entity key mappings (valve-specific, not using shared createEntityKeys)
    this.entityKeys = {
      valve: null,        // numeric key of the valve entity
      closedSensor: null, // numeric key of the "Closed Switch" binary_sensor
      rehomeButton: null, // numeric key of the "Re-home" button
      sensorMap: {},      // entityKey → { capabilityId, settingKey, defaultDecimals }
    };
    this._valvePosition = null;
    this._valveOperation = null;
    this._closedSensorState = null;
    this._hasValveState = false;
  }

  _clearDiscoveryTimer() {
    if (this._discoveryTimer) clearTimeout(this._discoveryTimer);
    this._discoveryTimer = null;
  }

  async _updateValveReadiness() {
    if (this._destroyed || !this.client?.connected
      || this.entityKeys.valve === null || !this._hasValveState) return;
    this._valveReady = true;
    this._discoveryAttempts = 0;
    this._clearDiscoveryTimer();
    if (!this.getAvailable()) await this.setAvailable();
  }

  _scheduleDiscoveryRecovery(client) {
    if (this._destroyed || this._valveReady || this._discoveryTimer) return;
    const attempts = this._discoveryAttempts || 0;
    if (attempts >= 3) {
      this._journal('discovery_gave_up', { attempts });
      this.setUnavailable('Valve discovery incomplete after 3 retries; reconnect or repair device')
        .catch(this.error.bind(this));
      return;
    }
    this._discoveryTimer = setTimeout(async () => {
      this._discoveryTimer = null;
      if (this._destroyed || this.client !== client || this._valveReady) return;
      this._discoveryAttempts = attempts + 1;
      this.log(`Retrying incomplete valve discovery (${this._discoveryAttempts}/3)`);
      this._journal('discovery_retry', { attempt: this._discoveryAttempts });
      try { await this.reconnect({ recovery: true }); }
      catch (error) { this.error('Valve discovery retry failed:', error); }
    }, ESPHOME.CONNECTION_TIMEOUT_MS * (attempts + 1));
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
      await this._handleStateChange(entity.type, entity, entity.state, { replayed: true });
    }
  }

  /**
   * Throw if the valve entity has not been discovered yet.
   */
  _requireValveEntity() {
    if (!this._valveReady || this.entityKeys.valve === null) {
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
        await applySlotTitles(this, capabilityId, measurementType, slot);
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
   * Handle state changes from ESPHome
   */
  async _handleStateChange(type, entity, state, { replayed = false } = {}) {
    const key = entity?.key;

    this.log(`State change for key ${key} (${type}):`, state);

    if (isValveOrCover(type) || type === 'binary_sensor') {
      this._lastValveReportAt = Date.now();
      this._journal('valve_report_received', {
        type,
        entity: entity?.name,
        replayed,
        position: state?.position,
        operation: state?.currentOperation ?? state?.current_operation,
        state: state?.state,
        missingState: state?.missingState,
      });
    }

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
          this._watchForRehomeReport();
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
          this._sensorReports = (this._sensorReports || 0) + 1;
          this._lastSensorAt = Date.now();
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
      this._journal('valve_write_failed', { type, entity: entity?.name, error });
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
    if (operation === 'idle') this._clearRehomeWatch();

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
    this._journal('valve_resolved', {
      open: isOpen,
      source,
      onoffBefore: this.hasCapability('onoff') ? this.getCapabilityValue('onoff') : null,
    });

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
    this._hasValveState = true;
  }

  /**
   * Note a re-home that never reports back. During a re-home the valve keeps
   * reporting position 1 and only the final IDLE returns Homey to Open, so the
   * closed switch at position 1 with no IDLE after it is what a miss looks
   * like. This only writes a line and changes no state.
   */
  _watchForRehomeReport() {
    const recentOwnClose = Date.now() - (this._lastCloseCommandAt || 0) < OWN_CLOSE_COMMAND_WINDOW_MS;
    if (this._rehomeWatch || recentOwnClose || !(this._valvePosition >= 0.99)) return;

    this._rehomeWatch = setTimeout(() => {
      this._rehomeWatch = null;
      this._reportMissingRehomeReport();
    }, REHOME_REPORT_WAIT_MS);
  }

  _clearRehomeWatch() {
    if (this._rehomeWatch) clearTimeout(this._rehomeWatch);
    this._rehomeWatch = null;
  }

  _reportMissingRehomeReport() {
    const now = Date.now();
    const age = time => (time ? now - time : null);
    const client = this.client;

    this._journal('rehome_no_final_report', {
      connected: Boolean(client?.connected),
      apiVersion: client?.apiVersion,
      valvePosition: this._valvePosition,
      valveOperation: this._valveOperation,
      lastValveReportAgeMs: age(this._lastValveReportAt),
      lastSensorAgeMs: age(this._lastSensorAt),
      lastHeartbeatAgeMs: age(client?.lastHeartbeatAt),
      cachedValveState: client?.getEntityByKey(this.entityKeys.valve)?.state,
    });
  }

  async _sendValvePosition(position) {
    if (position === 0) this._lastCloseCommandAt = Date.now();
    this._journal('valve_command', { position });
    await this.client.setValvePosition(this.entityKeys.valve, position);
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
      await this._sendValvePosition(isOpen ? 1.0 : 0.0);
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
    await this._sendValvePosition(1.0);
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
    await this._sendValvePosition(0.0);
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
    this._journal('rehome_command');
    await this.client.pressButton(this.entityKeys.rehomeButton);
  }

  /**
   * Reconnect to the device (used after repair)
   */
  async reconnect({ recovery = false } = {}) {
    this._clearDiscoveryTimer();
    this._valveReady = false;
    if (!recovery) this._discoveryAttempts = 0;
    this.log('Reconnecting to device...');

    if (this.client) {
      this.client.disconnect();
    }

    this._slotTitleFlags = {};

    await this._initializeClient();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    if (await storeConnectionSettings(this, newSettings, changedKeys)) {
      await this.reconnect();
    }
  }

  async onDeleted() {
    this.log('Device deleted, cleaning up...');
    this._destroyed = true;
    this._valveReady = false;
    this._clearDiscoveryTimer();
    this._clearRehomeWatch();

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  async onUninit() {
    this.log('Device uninit, cleaning up...');
    this._destroyed = true;
    this._valveReady = false;
    this._clearDiscoveryTimer();
    this._clearRehomeWatch();

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

}

module.exports = OpenAirValveDevice;
