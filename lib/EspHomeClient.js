'use strict';

const EventEmitter = require('events');
const ModernAdapter = require('./adapters/ModernAdapter');
const LegacyAdapter = require('./adapters/LegacyAdapter');
const { ESPHOME, RECONNECT } = require('./constants');
const { clampFanSpeed, delay, isValveOrCover } = require('./utils');
const diagnostics = require('./runtimeDiagnostics');

/**
 * ESPHome Native API client wrapper for Homey
 *
 * Orchestrates connection (with automatic version fallback), reconnection,
 * command queuing, and entity queries.  All library-specific logic lives
 * in ModernAdapter / LegacyAdapter.
 *
 * Version compatibility:
 * - ModernAdapter  (esphome-client, hjdhjd v1.2.x): ESPHome 2025.10+ / 2026.x
 * - LegacyAdapter  (@2colors/esphome-native-api 1.2.9): ESPHome 2023.x
 */
class EspHomeClientWrapper extends EventEmitter {

  // Static cache to remember which API version works for each device
  static apiVersionCache = new Map();

  constructor(options = {}) {
    super();
    this.host = options.host;
    this.port = options.port || ESPHOME.DEFAULT_PORT;
    this.encryptionKey = options.encryptionKey || null;
    this.password = options.password || null;
    this.adapter = null;
    this.entities = new Map();
    this.connected = false;
    this.logger = options.logger || console;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = RECONNECT.MAX_ATTEMPTS;
    this.reconnectDelay = RECONNECT.INITIAL_DELAY_MS;
    this.reconnectTimer = null;
    this.intentionalDisconnect = false;
    this.apiVersion = null; // 'modern' or 'legacy'
    this.deviceKey = `${this.host}:${this.port}`;
    this._commandQueue = Promise.resolve();
    this.diagnosticsLabel = options.diagnosticsLabel || 'runtime';
    this.currentAttemptId = null;
    this.connectionPhase = 'idle';

    this._updateDiagnosticContext();
  }

  /**
   * Build the options object passed to adapters.
   */
  _adapterOptions() {
    return {
      host: this.host,
      port: this.port,
      encryptionKey: this.encryptionKey,
      password: this.password,
      logger: this.logger,
      diagnosticsAttemptId: this.currentAttemptId,
      diagnosticsLabel: this.diagnosticsLabel,
      onDiagnostic: (event, details) => this._recordDiagnostic(event, details),
    };
  }

  _recordDiagnostic(event, details = {}) {
    diagnostics.record(event, {
      deviceKey: this.deviceKey,
      label: this.diagnosticsLabel,
      attemptId: this.currentAttemptId,
      apiVersion: this.apiVersion,
      phase: this.connectionPhase,
      connected: this.connected,
      ...details,
    });
  }

  _updateDiagnosticContext(extra = {}) {
    diagnostics.setConnectionContext(this.deviceKey, {
      label: this.diagnosticsLabel,
      host: this.host,
      port: this.port,
      hasEncryptionKey: Boolean(this.encryptionKey),
      hasPassword: Boolean(this.password),
      apiVersion: this.apiVersion,
      connected: this.connected,
      intentionalDisconnect: this.intentionalDisconnect,
      reconnectAttempts: this.reconnectAttempts,
      attemptId: this.currentAttemptId,
      phase: this.connectionPhase,
      ...extra,
    });
  }

  _emitErrorSafely(error, details = {}) {
    this._recordDiagnostic('wrapper_error', {
      error,
      ...details,
    });

    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
      return;
    }

    this.logger.error('Unhandled wrapper error (no listeners attached):', error);
  }

  /**
   * Connect to the ESPHome device with automatic version fallback.
   */
  async connect() {
    this.logger.log(`connect() called for ${this.host}:${this.port}`);
    this.currentAttemptId = diagnostics.nextAttemptId('esphome');
    this.connectionPhase = 'connect_start';
    this._recordDiagnostic('wrapper_connect_start', {
      cachedVersion: EspHomeClientWrapper.apiVersionCache.get(this.deviceKey) || null,
    });
    this._updateDiagnosticContext();

    if (this.adapter) {
      this.logger.log('Existing adapter found, disconnecting first...');
      this.disconnect();
    }

    this.intentionalDisconnect = false;
    this.connected = false;
    this._updateDiagnosticContext();

    const cachedVersion = EspHomeClientWrapper.apiVersionCache.get(this.deviceKey);

    const versions = cachedVersion
      ? [cachedVersion]
      : ['modern', 'legacy'];

    const errorTypeRank = (errorType) => {
      switch (errorType) {
        case 'invalid_encryption_key':
        case 'invalid_password':
          return 100;
        case 'auth_failed':
          return 90;
        case 'encryption_failed':
          return 80;
        case 'connection_refused':
        case 'host_not_found':
        case 'host_unreachable':
          return 70;
        case 'timeout':
          return 10;
        default:
          return 0;
      }
    };

    let lastError = null;
    let bestError = null;
    let bestErrorType = null;
    let bestErrorRank = -1;

    for (const version of versions) {
      // Clear stale data from any previous attempt
      this.entities.clear();
      this.connectionPhase = `connect_${version}`;
      this._recordDiagnostic('wrapper_connect_attempt', {
        version,
        cachedVersion: cachedVersion || null,
      });
      this._updateDiagnosticContext();

      const adapter = version === 'modern'
        ? new ModernAdapter(this._adapterOptions())
        : new LegacyAdapter(this._adapterOptions());

      const result = await adapter.connect(!cachedVersion);

      if (result.success) {
        this.adapter = adapter;
        this.apiVersion = version;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.connectionPhase = 'connected';

        // Share the adapter's entity store by reference
        this.entities = adapter.entities;

        EspHomeClientWrapper.apiVersionCache.set(this.deviceKey, version);
        this.logger.log(`Successfully connected using ${version} API`);
        this._recordDiagnostic('wrapper_connect_success', {
          version,
          entityCount: this.entities.size,
        });
        this._updateDiagnosticContext();

        this._wireAdapterEvents(adapter);
        this.emit('connected');
        return;
      }

      // Clean up failed adapter
      adapter.disconnect();

      const failureError = result.error;
      const failureErrorType = result.errorType || null;
      const failureErrorRank = errorTypeRank(failureErrorType);

      lastError = failureError;

      if (
        failureErrorRank > bestErrorRank
        || (failureErrorRank === bestErrorRank && failureErrorRank > 0)
      ) {
        bestError = failureError;
        bestErrorType = failureErrorType;
        bestErrorRank = failureErrorRank;
      }

      this.logger.log(`${version} API failed: ${failureError}`);
      this._recordDiagnostic('wrapper_connect_failure', {
        version,
        error: failureError,
        errorType: failureErrorType,
      });
    }

    const err = new Error(bestError || lastError || 'Failed to connect with any API version');
    err.errorType = bestErrorType || null;
    this.connectionPhase = 'connect_failed';
    this._updateDiagnosticContext({
      lastError: err.message,
      lastErrorType: err.errorType || null,
    });
    throw err;
  }

  /**
   * Forward events from the active adapter to this wrapper.
   */
  _wireAdapterEvents(adapter) {
    adapter.on('entityDiscovered', (entityInfo) => {
      this.emit('entityDiscovered', entityInfo);
    });

    adapter.on('stateChanged', (data) => {
      this.emit('stateChanged', data);
    });

    adapter.on('deviceInfo', (info) => {
      this.emit('deviceInfo', info);
    });

    adapter.on('connected', () => {
      this.logger.log('Adapter reported reconnect (library-level)');
      this.connected = true;
      this.reconnectAttempts = 0;
      this.connectionPhase = 'connected';
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this._recordDiagnostic('wrapper_adapter_connected');
      this._updateDiagnosticContext();
      this.emit('connected');
    });

    adapter.on('disconnected', () => {
      this.logger.log('Adapter reported disconnect');
      this.connected = false;
      this.connectionPhase = this.intentionalDisconnect ? 'disconnecting' : 'disconnected';
      this._recordDiagnostic('wrapper_adapter_disconnected', {
        intentionalDisconnect: this.intentionalDisconnect,
      });
      this._updateDiagnosticContext();
      this.emit('disconnected');

      if (!this.intentionalDisconnect) {
        this._scheduleReconnect();
      }
    });

    adapter.on('error', (error) => {
      this.logger.error('Adapter error:', error.message || error);
      this._emitErrorSafely(error, {
        source: 'adapter',
      });
    });
  }

  /**
   * Disconnect from the ESPHome device.
   */
  disconnect() {
    this.intentionalDisconnect = true;
    this.connectionPhase = 'disconnecting';
    this._recordDiagnostic('wrapper_disconnect_start');
    this._updateDiagnosticContext();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.adapter) {
      const adapter = this.adapter;
      try {
        adapter.disconnect();
      } catch (error) {
        this.logger.error('Adapter disconnect failed:', error);
        this._recordDiagnostic('wrapper_disconnect_error', { error });
      }
      adapter.removeAllListeners();
      this.adapter = null;
    }

    this.connected = false;
    this.entities = new Map();
    this.connectionPhase = 'idle';
    this._recordDiagnostic('wrapper_disconnect_complete');
    this._updateDiagnosticContext();
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  _scheduleReconnect() {
    if (this.reconnectTimer || this.intentionalDisconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached');
      this.connectionPhase = 'reconnect_failed';
      this._recordDiagnostic('wrapper_reconnect_failed');
      this._updateDiagnosticContext();
      this.emit('reconnectFailed');
      return;
    }

    const reconnectDelay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      RECONNECT.MAX_BACKOFF_MS,
    );

    this.reconnectAttempts++;
    this.logger.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${reconnectDelay}ms`);
    this.connectionPhase = 'reconnect_scheduled';
    this._recordDiagnostic('wrapper_reconnect_scheduled', {
      reconnectDelay,
      reconnectAttempt: this.reconnectAttempts,
    });
    this._updateDiagnosticContext();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        this.connectionPhase = 'reconnecting';
        this._recordDiagnostic('wrapper_reconnect_attempt', {
          reconnectAttempt: this.reconnectAttempts,
        });
        this._updateDiagnosticContext();
        await this.connect();
      } catch (error) {
        this.logger.error('Reconnection failed:', error);
        this._recordDiagnostic('wrapper_reconnect_attempt_failed', { error });
      }
    }, reconnectDelay);
  }

  /**
   * Queue a command to serialize execution and prevent racing.
   */
  _queueCommand(fn) {
    this._commandQueue = this._commandQueue.then(fn).catch((err) => {
      this.logger.error('Queued command failed:', err);
      throw err;
    });
    return this._commandQueue;
  }

  /**
   * Set fan state (on/off and optionally speed).
   */
  async setFanState(key, options = {}) {
    return this._queueCommand(async () => {
      if (!this.connected || !this.adapter) {
        throw new Error('Not connected to device');
      }

      const entityInfo = this.entities.get(key);
      if (!entityInfo || entityInfo.type !== 'fan') {
        throw new Error(`Fan entity with key ${key} not found`);
      }

      const command = {};
      if (typeof options.state === 'boolean') {
        command.state = options.state;
      }
      if (typeof options.speed === 'number') {
        command.speedLevel = clampFanSpeed(options.speed);
      }

      await this.adapter.sendFanCommand(key, command);
    });
  }

  /**
   * Set switch state.
   */
  async setSwitchState(key, state) {
    return this._queueCommand(async () => {
      if (!this.connected || !this.adapter) {
        throw new Error('Not connected to device');
      }

      const entityInfo = this.entities.get(key);
      if (!entityInfo || entityInfo.type !== 'switch') {
        throw new Error(`Switch entity with key ${key} not found`);
      }

      await this.adapter.sendSwitchCommand(key, state);
    });
  }

  /**
   * Set valve position (0 = closed, 1 = open).
   */
  async setValvePosition(key, position) {
    return this._queueCommand(async () => {
      if (!this.connected || !this.adapter) {
        throw new Error('Not connected to device');
      }

      const entityInfo = this.entities.get(key);
      if (!entityInfo || !isValveOrCover(entityInfo.type)) {
        throw new Error(`Valve entity with key ${key} not found`);
      }

      await this.adapter.sendValveCommand(key, { position });
    });
  }

  /**
   * Stop valve movement.
   */
  async stopValve(key) {
    return this._queueCommand(async () => {
      if (!this.connected || !this.adapter) {
        throw new Error('Not connected to device');
      }

      const entityInfo = this.entities.get(key);
      if (!entityInfo || !isValveOrCover(entityInfo.type)) {
        throw new Error(`Valve entity with key ${key} not found`);
      }

      await this.adapter.sendValveCommand(key, { stop: true });
    });
  }

  /**
   * Press a button entity.
   */
  async pressButton(key) {
    return this._queueCommand(async () => {
      if (!this.connected || !this.adapter) {
        throw new Error('Not connected to device');
      }

      const entityInfo = this.entities.get(key);
      if (!entityInfo || entityInfo.type !== 'button') {
        throw new Error(`Button entity with key ${key} not found`);
      }

      await this.adapter.sendButtonCommand(key);
    });
  }

  // --- Entity query helpers (unchanged public API) ---

  getEntities() {
    return Array.from(this.entities.values());
  }

  getEntitiesByType(type) {
    return this.getEntities().filter((e) => e.type === type);
  }

  findEntityByName(name) {
    const searchName = name.toLowerCase();
    return this.getEntities().find((e) => e.name?.toLowerCase().includes(searchName));
  }

  findEntity(type, namePattern) {
    const pattern = namePattern.toLowerCase();
    return this.getEntities().find(
      (e) => e.type === type && e.name?.toLowerCase().includes(pattern),
    );
  }

  getEntityByKey(key) {
    return this.entities.get(key);
  }

  // --- Static methods ---

  /**
   * Test connection to a device (used during pairing).
   * Tries both API versions automatically.
   */
  static async testConnection(host, port, encryptionKey, password, logger = console, diagnosticsLabel = 'connection-test') {
    logger.log('=== EspHomeClient.testConnection START ===');
    logger.log(`Host: ${host}, Port: ${port}`);

    const wrapper = new EspHomeClientWrapper({
      host,
      port,
      encryptionKey: encryptionKey || null,
      password: password || null,
      diagnosticsLabel,
      logger: {
        log: (...args) => logger.log('[EspHomeClient]', ...args),
        error: (...args) => logger.error('[EspHomeClient]', ...args),
      },
    });

    wrapper.on('error', (err) => {
      logger.error('[EspHomeClient] Error during test:', err.message);
    });

    try {
      await wrapper.connect();

      await delay(ESPHOME.TEST_CONNECTION_WAIT_MS);

      const entities = wrapper.getEntities();
      logger.log(`Found ${entities.length} entities using ${wrapper.apiVersion} API`);

      wrapper.disconnect();
      logger.log('=== EspHomeClient.testConnection SUCCESS ===');

      return {
        success: true,
        entities,
        apiVersion: wrapper.apiVersion,
      };
    } catch (error) {
      logger.error('[EspHomeClient] Connection failed:', error.message);
      wrapper.disconnect();
      logger.log('=== EspHomeClient.testConnection FAILED ===');

      return {
        success: false,
        error: error.message,
        errorType: error.errorType || null,
      };
    }
  }

  /**
   * Clear the API version cache (useful for testing).
   */
  static clearVersionCache() {
    EspHomeClientWrapper.apiVersionCache.clear();
  }

}

module.exports = EspHomeClientWrapper;
