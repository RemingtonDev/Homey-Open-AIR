'use strict';

/**
 * ESPHome connection settings
 */
const ESPHOME = {
  DEFAULT_PORT: 6053,
  CONNECTION_TIMEOUT_MS: 15000,
  ENTITY_DISCOVERY_WAIT_MS: 3000,
  TEST_CONNECTION_WAIT_MS: 2000,
};

/**
 * Reconnection behavior
 */
const RECONNECT = {
  INITIAL_DELAY_MS: 5000,
  MAX_ATTEMPTS: 10,
  MAX_BACKOFF_MS: 60000,
};

/**
 * Fan speed settings
 */
const FAN = {
  DEFAULT_SPEED_LEVELS: 100,
  MIN_SPEED: 0,
  MAX_SPEED: 100,
};

/**
 * Valve position settings
 */
const VALVE = {
  POSITION_CLOSED: 0,
  POSITION_OPEN: 1,
};

/**
 * Homey capability ranges
 */
const HOMEY = {
  DIM_MIN: 0,
  DIM_MAX: 1,
};

/**
 * Command handling
 */
const COMMAND = {
  DEBOUNCE_MS: 100,
};

/**
 * Auto fan curve settings (humidity-based automatic fan speed)
 */
const AUTO_CURVE = {
  INTERVAL_MS: 30000,                    // 30s — matches ESPHome sensor update interval
  MANUAL_OVERRIDE_TIMEOUT_MS: 1800000,   // 30 minutes
  DEFAULTS: {
    HIGH_HUMIDITY: 75,
    MEDIUM_HUMIDITY: 55,
    HIGH_SPEED: 100,
    MEDIUM_SPEED: 60,
    LOW_SPEED: 25,
  },
};

module.exports = {
  ESPHOME,
  RECONNECT,
  FAN,
  VALVE,
  HOMEY,
  COMMAND,
  AUTO_CURVE,
};
