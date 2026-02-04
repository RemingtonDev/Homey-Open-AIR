'use strict';

const EventEmitter = require('events');
const { ESPHOME } = require('../constants');
const { delay } = require('../utils');

// Cache for the dynamically imported ESM module
let _espHomeClientModule = null;

async function getEspHomeClientModule() {
  if (!_espHomeClientModule) {
    _espHomeClientModule = await import('esphome-client');
  }
  return _espHomeClientModule;
}

/**
 * Adapter for the modern esphome-client library (hjdhjd)
 * Works with ESPHome 2025.10+ / 2026.x
 */
class ModernAdapter extends EventEmitter {

  constructor(options) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.encryptionKey = options.encryptionKey;
    this.password = options.password;
    this.logger = options.logger;
    this.client = null;
    this.entities = new Map();
    this._entityIdToKey = new Map();
    this._keyToEntityId = new Map();
  }

  /**
   * Connect to the ESPHome device using the modern library.
   * @param {boolean} waitForEntities - Whether to wait for entity discovery
   * @returns {{ success: boolean, entities?: EntityInfo[], error?: string }}
   */
  async connect(waitForEntities = true) {
    const version = 'modern';
    this.logger.log(`Trying connection with ${version} API (esphome-client)...`);

    let EspHomeClient;
    try {
      const mod = await getEspHomeClientModule();
      EspHomeClient = mod.EspHomeClient;
    } catch (importErr) {
      this.logger.error(`Failed to import esphome-client: ${importErr.message}`);
      return { success: false, error: `Import failed: ${importErr.message}` };
    }

    const clientOptions = {
      clientId: 'Homey Open AIR Mini',
      host: this.host,
      port: this.port,
    };

    if (this.encryptionKey) {
      clientOptions.psk = this.encryptionKey;
    }

    clientOptions.logger = {
      debug: () => {},
      info: (...args) => this.logger.log(`[${version}]`, ...args),
      warn: (...args) => this.logger.log(`[${version}] WARN:`, ...args),
      error: (...args) => this.logger.error(`[${version}]`, ...args),
    };

    const client = new EspHomeClient(clientOptions);

    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        client.removeAllListeners();
        try { client.disconnect(); } catch (_) { /* ignore */ }
        resolve({ success: false, error: 'Connection timeout' });
      }, ESPHOME.CONNECTION_TIMEOUT_MS);

      // Disconnect & error handlers (permanent, for reconnect logic)
      client.on('disconnect', (reason) => {
        this.logger.log(`[${version}] Disconnected: ${reason || 'unknown'}`);
        if (resolved) {
          this.emit('disconnected');
        }
      });

      client.on('error', (error) => {
        this.logger.error(`[${version}] Error:`, error.message || error);
        if (resolved) {
          this.emit('error', error);
        }
      });

      client.on('deviceInfo', (info) => {
        this.logger.log(`[${version}] Device: ${info.name} v${info.esphomeVersion}`);
        if (resolved) {
          this.emit('deviceInfo', info);
        }
      });

      // State handlers (attached early so initial states are captured)
      const stateTypes = ['fan', 'sensor', 'binary_sensor', 'switch', 'climate', 'light', 'cover', 'number', 'select', 'text', 'button'];
      for (const type of stateTypes) {
        client.on(type, (data) => {
          this._handleStateChange(type, data);
        });
      }

      // Entity discovery
      client.on('entities', async (entities) => {
        this.logger.log(`[${version}] Discovered ${entities.length} entities`);
        for (const entity of entities) {
          this._handleEntityDiscovered(entity);
        }

        if (waitForEntities) {
          await delay(ESPHOME.ENTITY_DISCOVERY_WAIT_MS);
        }

        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this.client = client;
        resolve({ success: true, entities: Array.from(this.entities.values()) });
      });

      // Fallback: if connect fires but entities never does
      client.on('connect', async (encrypted) => {
        this.logger.log(`[${version}] Connected! (encrypted: ${encrypted})`);

        if (waitForEntities) {
          await delay(ESPHOME.ENTITY_DISCOVERY_WAIT_MS);
        }

        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        this.client = client;
        resolve({ success: true, entities: Array.from(this.entities.values()) });
      });

      client.connect();
    });
  }

  disconnect() {
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.disconnect();
      } catch (error) {
        this.logger.log(`Disconnect error (suppressed): ${error.message}`);
      }
      this.client = null;
    }
    this.entities.clear();
    this._entityIdToKey.clear();
    this._keyToEntityId.clear();
  }

  /**
   * Handle entity discovery — adapts modern entity format to internal format.
   */
  _handleEntityDiscovered(entity) {
    const entityType = (entity.type || 'unknown').toLowerCase().replace(/ /g, '_');
    const numericKey = entity.key;
    const entityId = `${entityType}-${entity.objectId}`;

    const entityInfo = {
      key: numericKey,
      name: entity.name,
      type: entityType,
      objectId: entity.objectId,
      config: entity,
      entity: null,
    };

    if (entity.supportedSpeedCount !== undefined) {
      entityInfo.config.supportedSpeedCount = entity.supportedSpeedCount;
    }

    this.entities.set(numericKey, entityInfo);
    this._entityIdToKey.set(entityId, numericKey);
    this._keyToEntityId.set(numericKey, entityId);
    this.logger.log(`Entity: ${entity.name} (${entityType}, key: ${numericKey}, id: ${entityId})`);

    this.emit('entityDiscovered', entityInfo);
  }

  /**
   * Handle state changes — normalizes modern state data.
   */
  _handleStateChange(type, data) {
    const entityId = data.entity;
    const numericKey = data.key;

    const entityInfo = this.entities.get(numericKey);
    if (!entityInfo) {
      this.logger.log(`State change for unknown entity: ${entityId} (key: ${numericKey})`);
      return;
    }

    const normalizedState = { ...data };

    if (type === 'fan') {
      normalizedState.state = data.state;
      normalizedState.speedLevel = data.speedLevel;
    }

    if (type === 'sensor') {
      normalizedState.state = data.state;
      normalizedState.missingState = data.missingState || false;
    }

    this.emit('stateChanged', { type, entity: entityInfo, state: normalizedState });
  }

  /**
   * Send a fan command via the modern library.
   */
  sendFanCommand(entityKey, command) {
    const entityId = this._keyToEntityId.get(entityKey);
    if (!entityId) {
      throw new Error(`No entity ID mapping for key ${entityKey}`);
    }
    this.logger.log(`Sending modern fan command to ${entityId}:`, command);
    this.client.sendFanCommand(entityId, command);
  }

  /**
   * Send a switch command via the modern library.
   */
  sendSwitchCommand(entityKey, state) {
    const entityId = this._keyToEntityId.get(entityKey);
    if (!entityId) {
      throw new Error(`No entity ID mapping for key ${entityKey}`);
    }
    this.logger.log(`Sending modern switch command to ${entityId}: ${state}`);
    this.client.sendSwitchCommand(entityId, state);
  }

}

module.exports = ModernAdapter;
