'use strict';

/**
 * Classify a connection error into a user-facing error type.
 *
 * @param {Error|string} error - The error object or disconnect reason string
 * @returns {string|null} A classification key (e.g. 'connection_refused') or null if unknown
 */
function classifyConnectionError(error) {
  const msg = (typeof error === 'string' ? error : error?.message || '').toLowerCase();
  const code = error?.code || '';

  // Socket-level errors (Node.js error codes)
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ENOTFOUND') return 'host_not_found';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host_unreachable';
  if (code === 'ETIMEDOUT') return 'timeout';

  // Auth / encryption failures (esphome-client — modern adapter)
  if (msg.includes('invalid psk') || msg.includes('psk must be')) return 'invalid_encryption_key';
  if (msg.includes('encryption key invalid') || msg.includes('encryption key missing')) return 'invalid_encryption_key';
  if (msg.includes('handshake') || msg.includes('noise')) return 'encryption_failed';
  if (msg.includes('auth_failed') || msg.includes('authentication failed')) return 'auth_failed';

  // Auth failures (esphome-native-api — legacy adapter)
  if (msg.includes('invalid password')) return 'invalid_password';
  if (msg.includes('not authorized')) return 'auth_failed';

  // Encryption key format validation
  if (msg.includes('encryption key must be base64')) return 'invalid_encryption_key';

  return null;
}

module.exports = classifyConnectionError;
