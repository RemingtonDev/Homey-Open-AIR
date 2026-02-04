'use strict';

const { FAN, HOMEY } = require('./constants');

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp a dim value to Homey's 0-1 range
 * @param {number} value - Value to clamp
 * @returns {number} Clamped value between 0 and 1
 */
function clampDimValue(value) {
  return clamp(value, HOMEY.DIM_MIN, HOMEY.DIM_MAX);
}

/**
 * Fix corrupted dim values that were stored as 0-100 instead of 0-1
 * @param {number} value - Potentially corrupted dim value
 * @returns {number} Fixed dim value in 0-1 range
 */
function fixCorruptedDimValue(value) {
  return clampDimValue(value / 100);
}

/**
 * Clamp fan speed to valid range (0-100)
 * @param {number} speed - Fan speed to clamp
 * @returns {number} Clamped fan speed
 */
function clampFanSpeed(speed) {
  return clamp(speed, FAN.MIN_SPEED, FAN.MAX_SPEED);
}

/**
 * Sensor type definitions: capability base name, settings key, and default decimals.
 */
const SENSOR_TYPES = {
  temperature: { base: 'measure_temperature', settingKey: 'temperature_decimals', defaultDecimals: 1 },
  humidity:    { base: 'measure_humidity',    settingKey: 'humidity_decimals',    defaultDecimals: 1 },
  co2:         { base: 'measure_co2',         settingKey: 'co2_decimals',         defaultDecimals: 0 },
  rpm:         { base: 'measure_rpm',         settingKey: 'rpm_decimals',         defaultDecimals: 0 },
  voc:         { base: 'measure_voc',         settingKey: 'voc_decimals',         defaultDecimals: 0 },
  nox:         { base: 'measure_nox',         settingKey: 'nox_decimals',         defaultDecimals: 0 },
};

/**
 * Extract the sensor slot number from an entity name.
 * Matches patterns like "Sensor 1", "sensor2", "Sensor  3".
 * @param {string} name - Entity name (case-insensitive)
 * @returns {number|null} Slot number, or null if not found
 */
function extractSensorSlot(name) {
  const match = name.match(/sensor\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Detect the measurement type from an entity name by keyword matching.
 * Order matters: co2 is checked before temperature/humidity because SCD-40
 * entities contain "co2" but not necessarily other keywords.
 * @param {string} name - Entity name (lowercased)
 * @returns {string|null} Key from SENSOR_TYPES, or null
 */
function detectMeasurementType(name) {
  const lower = name.toLowerCase();
  if (lower.includes('co2') || lower.includes('carbon')) return 'co2';
  if (lower.includes('voc')) return 'voc';
  if (lower.includes('nox')) return 'nox';
  if (lower.includes('temperature') || lower.includes('temp')) return 'temperature';
  if (lower.includes('humidity') || lower.includes('humid')) return 'humidity';
  if (lower.includes('rpm') || lower.includes('rotation')) return 'rpm';
  return null;
}

/**
 * Compute the Homey capability ID from measurement type and slot number.
 * Slot 1 or null → base capability (e.g. "measure_temperature").
 * Slot 2+ → sub-capability (e.g. "measure_temperature.2").
 * @param {string} type - Key from SENSOR_TYPES
 * @param {number|null} slot - Sensor slot number
 * @returns {string} Homey capability ID
 */
function computeCapabilityId(type, slot) {
  const base = SENSOR_TYPES[type].base;
  if (slot != null && slot >= 2) {
    return `${base}.${slot}`;
  }
  return base;
}

/**
 * Create a fresh entity keys object for device initialization
 * @returns {Object} Entity keys object with default values
 */
function createEntityKeys() {
  return {
    fan: null,
    fanSpeedLevels: FAN.DEFAULT_SPEED_LEVELS,
    sensorMap: {},  // entityKey → { capabilityId, settingKey, defaultDecimals }
  };
}

/**
 * Promise-based delay helper
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Round a number to a specific number of decimal places
 * @param {number} value - Value to round
 * @param {number} decimals - Number of decimal places (0, 1, or 2)
 * @returns {number} Rounded value
 */
function roundToDecimals(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

module.exports = {
  clampDimValue,
  fixCorruptedDimValue,
  clampFanSpeed,
  createEntityKeys,
  delay,
  roundToDecimals,
  SENSOR_TYPES,
  extractSensorSlot,
  detectMeasurementType,
  computeCapabilityId,
};
