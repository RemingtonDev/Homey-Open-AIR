'use strict';

const EventEmitter = require('events');
const ClientLegacy = require('esphome-api-legacy').Client;
const { ESPHOME } = require('../constants');
const { delay } = require('../utils');
const classifyConnectionError = require('../classifyConnectionError');

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
    this.diagnosticsAttemptId = options.diagnosticsAttemptId || null;
    this.diagnosticsLabel = options.diagnosticsLabel || 'runtime';
    this.onDiagnostic = options.onDiagnostic || null;
    this.client = null;
    this.entities = new Map();
    this._pendingConnect = null;
  }

  _recordDiagnostic(event, details = {}) {
    if (this.onDiagnostic) {
      this.onDiagnostic(event, {
        adapter: 'legacy',
        attemptId: this.diagnosticsAttemptId,
        label: this.diagnosticsLabel,
        ...details,
      });
    }
  }

  _emitErrorSafely(error, details = {}) {
    this._recordDiagnostic('legacy_adapter_error', {
      error,
      ...details,
    });

    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }

    this.logger.error('Legacy adapter error with no listeners attached:', error);
  }

  _installConnectionErrorGuard(client) {
    const connection = client?.connection;
    if (!connection || connection.__homeyEmitGuardInstalled) {
      return;
    }

    const originalEmit = connection.emit.bind(connection);
    connection.__homeyEmitGuardInstalled = true;
    connection.emit = (eventName, ...args) => {
      if (eventName === 'error' && client.__homeySuppressLateErrors) {
        const error = args[0];
        this.logger.log(`Suppressed late legacy connection error during teardown: ${error?.message || error}`);
        this._recordDiagnostic('legacy_connection_error_suppressed', { error });
        return false;
      }

      return originalEmit(eventName, ...args);
    };
  }

  _disconnectClient(client, reason = 'disconnect') {
    if (!client) {
      return;
    }

    client.__homeySuppressLateErrors = true;
    client.__homeyCancelled = true;
    this._recordDiagnostic('legacy_client_disconnect', { reason });

    try {
      if (typeof client.removeAllListeners === 'function') {
        client.removeAllListeners();
      }
      client.disconnect();
    } catch (error) {
      this.logger.log(`Disconnect error (suppressed): ${error.message}`);
      this._recordDiagnostic('legacy_client_disconnect_error', { reason, error });
    }
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
      clientInfo: 'Homey Open AIR',
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
    client.__homeySuppressLateErrors = false;
    client.__homeyCancelled = false;
    this._installConnectionErrorGuard(client);
    const discoveredEntities = [];
    let disconnectedEarly = false;
    let connectionError = null;

    return new Promise((resolve) => {
      let resolved = false;
      let timeout;

      const finish = (result) => {
        if (resolved) {
          return false;
        }

        resolved = true;
        clearTimeout(timeout);
        if (this._pendingConnect?.client === client) {
          this._pendingConnect = null;
        }
        resolve(result);
        return true;
      };

      this._pendingConnect = {
        client,
        finish,
      };

      timeout = setTimeout(() => {
        this._recordDiagnostic('legacy_connect_timeout', {
          waitForEntities,
        });
        if (!finish({ success: false, error: 'Connection timeout', errorType: 'timeout' })) {
          return;
        }
        this._disconnectClient(client, 'connect_timeout');
      }, ESPHOME.CONNECTION_TIMEOUT_MS);

      client.on('error', (error) => {
        connectionError = error;
        this.logger.error(`[${version}] Error:`, error.message);
        this._recordDiagnostic('legacy_connect_error', { error });
        // Fail fast instead of waiting for timeout
        if (resolved) {
          this._recordDiagnostic('legacy_connect_error_after_resolve', { error });
          return;
        }

        const errorType = classifyConnectionError(error);
        finish({ success: false, error: error.message || String(error), errorType });
        this._disconnectClient(client, 'connect_error');
      });

      client.on('disconnected', () => {
        disconnectedEarly = true;
        this.logger.log(`[${version}] Disconnected`);
        this._recordDiagnostic('legacy_disconnected_early');
      });

      client.on('newEntity', (entity) => {
        discoveredEntities.push(entity);
        this.logger.log(`[${version}] Entity: ${entity.config?.name}`);
      });

      client.on('deviceInfo', (info) => {
        this.logger.log(`[${version}] Device: ${info.name} v${info.esphomeVersion}`);
        this._recordDiagnostic('legacy_device_info', {
          deviceName: info.name,
          esphomeVersion: info.esphomeVersion,
        });
      });

      client.on('connected', async () => {
        this.logger.log(`[${version}] Connected!`);
        this._recordDiagnostic('legacy_connected', {
          waitForEntities,
        });

        if (waitForEntities) {
          await delay(ESPHOME.ENTITY_DISCOVERY_WAIT_MS);
        }

        if (resolved || client.__homeyCancelled) {
          this._recordDiagnostic('legacy_connected_after_cancel', {
            cancelled: client.__homeyCancelled,
            resolved,
          });
          return;
        }

        if (discoveredEntities.length > 0 && !disconnectedEarly) {
          this.client = client;
          client.removeAllListeners();
          // Process discovered entities into our normalized format
          for (const entity of discoveredEntities) {
            this._handleEntityDiscovered(entity);
          }
          // Set up permanent handlers
          this._setupHandlers();
          finish({ success: true, entities: Array.from(this.entities.values()) });
          this._recordDiagnostic('legacy_connect_success', {
            entityCount: this.entities.size,
          });
        } else if (disconnectedEarly || connectionError) {
          const errorType = classifyConnectionError(connectionError);
          finish({
            success: false,
            error: connectionError?.message || 'Disconnected before entity discovery',
            errorType,
          });
          this._disconnectClient(client, 'connected_after_disconnect');
        } else {
          // Connected but no entities
          this.client = client;
          client.removeAllListeners();
          this._setupHandlers();
          finish({ success: true, entities: [] });
          this._recordDiagnostic('legacy_connect_success', {
            entityCount: 0,
          });
        }
      });

      this._recordDiagnostic('legacy_connect_start', {
        waitForEntities,
      });
      client.connect();
    });
  }

  disconnect() {
    if (this._pendingConnect) {
      const { client, finish } = this._pendingConnect;
      this._recordDiagnostic('legacy_pending_connect_cancelled');
      finish({
        success: false,
        error: 'Connection cancelled',
        errorType: 'cancelled',
      });
      this._disconnectClient(client, 'pending_connect_cancelled');
      this._pendingConnect = null;
    }

    if (this.client) {
      this._disconnectClient(this.client, 'adapter_disconnect');
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
      this._emitErrorSafely(error, {
        source: 'client',
      });
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
    if (constructorName.includes('valve')) return 'valve';
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

  /**
   * Send a valve command via the legacy library.
   * @param {number} entityKey - Numeric entity key
   * @param {Object} command - { position?: number, stop?: boolean }
   */
  async sendValveCommand(entityKey, command) {
    this.logger.log(`Sending legacy valve command to key ${entityKey}:`, command);

    if (this.client.connection) {
      // Try valveCommandService first, fall back to coverCommandService (legacy may treat valve as cover)
      if (typeof this.client.connection.valveCommandService === 'function') {
        await this.client.connection.valveCommandService({ key: entityKey, ...command });
      } else if (typeof this.client.connection.coverCommandService === 'function') {
        await this.client.connection.coverCommandService({ key: entityKey, ...command });
      } else {
        throw new Error('No method available to send valve command');
      }
    } else {
      const entityInfo = this.entities.get(entityKey);
      if (entityInfo?.entity) {
        if (typeof command.position === 'number' && typeof entityInfo.entity.setPosition === 'function') {
          await entityInfo.entity.setPosition(command.position);
        } else if (command.stop && typeof entityInfo.entity.stop === 'function') {
          await entityInfo.entity.stop();
        }
      } else {
        throw new Error('No method available to send valve command');
      }
    }
  }

  /**
   * Send a button press command via the legacy library.
   * @param {number} entityKey - Numeric entity key
   */
  async sendButtonCommand(entityKey) {
    this.logger.log(`Sending legacy button command to key ${entityKey}`);

    const entityInfo = this.entities.get(entityKey);
    if (entityInfo?.entity && typeof entityInfo.entity.press === 'function') {
      await entityInfo.entity.press();
    } else if (this.client.connection && typeof this.client.connection.buttonCommandService === 'function') {
      await this.client.connection.buttonCommandService({ key: entityKey });
    } else {
      throw new Error('No method available to send button command');
    }
  }

}

module.exports = LegacyAdapter;
