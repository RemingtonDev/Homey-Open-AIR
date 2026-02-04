'use strict';

const EventEmitter = require('events');
const ClientLegacy = require('esphome-api-legacy').Client;
const { ESPHOME } = require('../constants');
const { delay } = require('../utils');

/**
 * Adapter for the legacy @2colors/esphome-native-api library
 * Works with ESPHome 2023.x
 */
class LegacyAdapter extends EventEmitter {

  constructor(options) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.encryptionKey = options.encryptionKey;
    this.password = options.password;
    this.logger = options.logger;
    this.client = null;
    this.entities = new Map();
  }

  /**
   * Connect to the ESPHome device using the legacy library.
   * @param {boolean} waitForEntities - Whether to wait for entity discovery
   * @returns {{ success: boolean, entities?: EntityInfo[], error?: string }}
   */
  async connect(waitForEntities = true) {
    const version = 'legacy';
    const clientOptions = {
      host: this.host,
      port: this.port,
      clientInfo: 'Homey Open AIR Mini',
      reconnect: false,
    };

    if (this.encryptionKey) {
      clientOptions.encryptionKey = this.encryptionKey;
    }
    if (this.password) {
      clientOptions.password = this.password;
    }

    this.logger.log(`Trying connection with ${version} API...`);

    const client = new ClientLegacy(clientOptions);
    const discoveredEntities = [];
    let disconnectedEarly = false;
    let connectionError = null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.removeAllListeners();
        try { client.disconnect(); } catch (_) { /* ignore */ }
        resolve({ success: false, error: 'Connection timeout' });
      }, ESPHOME.CONNECTION_TIMEOUT_MS);

      client.on('error', (error) => {
        connectionError = error;
        this.logger.error(`[${version}] Error:`, error.message);
      });

      client.on('disconnected', () => {
        disconnectedEarly = true;
        this.logger.log(`[${version}] Disconnected`);
      });

      client.on('newEntity', (entity) => {
        discoveredEntities.push(entity);
        this.logger.log(`[${version}] Entity: ${entity.config?.name}`);
      });

      client.on('deviceInfo', (info) => {
        this.logger.log(`[${version}] Device: ${info.name} v${info.esphomeVersion}`);
      });

      client.on('connected', async () => {
        this.logger.log(`[${version}] Connected!`);

        if (waitForEntities) {
          await delay(ESPHOME.ENTITY_DISCOVERY_WAIT_MS);
        }

        clearTimeout(timeout);

        if (discoveredEntities.length > 0 && !disconnectedEarly) {
          this.client = client;
          client.removeAllListeners();
          // Process discovered entities into our normalized format
          for (const entity of discoveredEntities) {
            this._handleEntityDiscovered(entity);
          }
          // Set up permanent handlers
          this._setupHandlers();
          resolve({ success: true, entities: Array.from(this.entities.values()) });
        } else if (disconnectedEarly || connectionError) {
          try { client.disconnect(); } catch (_) { /* ignore */ }
          resolve({
            success: false,
            error: connectionError?.message || 'Disconnected before entity discovery',
          });
        } else {
          // Connected but no entities
          this.client = client;
          client.removeAllListeners();
          this._setupHandlers();
          resolve({ success: true, entities: [] });
        }
      });

      client.connect();
    });
  }

  disconnect() {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (error) {
        this.logger.log(`Disconnect error (suppressed): ${error.message}`);
      }
      this.client = null;
    }
    this.entities.clear();
  }

  /**
   * Set up permanent event handlers on the legacy client.
   */
  _setupHandlers() {
    this.client.on('newEntity', (entity) => {
      this._handleEntityDiscovered(entity);
    });

    this.client.on('deviceInfo', (info) => {
      this.logger.log(`Device: ${info.name} v${info.esphomeVersion}`);
      this.emit('deviceInfo', info);
    });

    this.client.on('disconnected', () => {
      this.logger.log('Disconnected from ESPHome device');
      this.emit('disconnected');
    });

    this.client.on('error', (error) => {
      this.logger.error('ESPHome client error:', error.message);
      this.emit('error', error);
    });
  }

  /**
   * Handle entity discovery — adapts legacy entity format to internal format.
   */
  _handleEntityDiscovered(entity) {
    const entityType = this._getEntityType(entity);
    const entityInfo = {
      key: entity.config.key,
      name: entity.config.name,
      type: entityType,
      objectId: entity.config.objectId,
      config: entity.config,
      entity,
    };

    this.entities.set(entity.config.key, entityInfo);
    this.logger.log(`Entity: ${entity.config.name} (${entityType}, key: ${entity.config.key})`);

    entity.on('state', (state) => {
      this.emit('stateChanged', { type: entityType, entity: entityInfo, state });
    });

    this.emit('entityDiscovered', entityInfo);
  }

  /**
   * Determine entity type from a legacy library entity object.
   */
  _getEntityType(entity) {
    const constructorName = entity.constructor?.name?.toLowerCase() || '';

    if (constructorName.includes('fan')) return 'fan';
    if (constructorName.includes('sensor')) return 'sensor';
    if (constructorName.includes('binarysensor')) return 'binary_sensor';
    if (constructorName.includes('switch')) return 'switch';
    if (constructorName.includes('climate')) return 'climate';
    if (constructorName.includes('light')) return 'light';
    if (constructorName.includes('cover')) return 'cover';
    if (constructorName.includes('number')) return 'number';
    if (constructorName.includes('select')) return 'select';
    if (constructorName.includes('text')) return 'text';
    if (constructorName.includes('button')) return 'button';

    if (entity.config?.type) {
      return entity.config.type.toLowerCase();
    }

    return 'unknown';
  }

  /**
   * Send a fan command via the legacy library.
   */
  async sendFanCommand(entityKey, command) {
    const legacyCommand = { key: entityKey, ...command };
    this.logger.log(`Sending legacy fan command to key ${entityKey}:`, legacyCommand);

    if (this.client.connection) {
      await this.client.connection.fanCommandService(legacyCommand);
    } else {
      const entityInfo = this.entities.get(entityKey);
      if (entityInfo?.entity) {
        if (typeof command.state === 'boolean' && typeof entityInfo.entity.setState === 'function') {
          entityInfo.entity.setState(command.state);
        }
        if (typeof command.speedLevel === 'number' && typeof entityInfo.entity.setSpeedLevel === 'function') {
          entityInfo.entity.setSpeedLevel(command.speedLevel);
        }
      } else {
        throw new Error('No method available to send fan command');
      }
    }
  }

  /**
   * Send a switch command via the legacy library.
   */
  async sendSwitchCommand(entityKey, state) {
    this.logger.log(`Sending legacy switch command to key ${entityKey}: ${state}`);

    const entityInfo = this.entities.get(entityKey);
    if (entityInfo?.entity && typeof entityInfo.entity.setState === 'function') {
      await entityInfo.entity.setState(state);
    } else if (this.client.connection) {
      await this.client.connection.switchCommandService({ key: entityKey, state });
    } else {
      throw new Error('No method available to send switch command');
    }
  }

}

module.exports = LegacyAdapter;
