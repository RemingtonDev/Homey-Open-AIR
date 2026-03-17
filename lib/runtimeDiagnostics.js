'use strict';

const MAX_BREADCRUMBS = 50;
const breadcrumbs = [];
const connectionContexts = new Map();
let attemptCounter = 0;

function sanitizeValue(key, value, includeStacks = false) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const lowerKey = String(key || '').toLowerCase();
  if (
    lowerKey.includes('password')
    || lowerKey.includes('encryption')
    || lowerKey.includes('secret')
    || lowerKey.includes('token')
    || lowerKey.includes('key')
  ) {
    return '[redacted]';
  }

  if (value instanceof Error) {
    const serialized = {
      name: value.name,
      message: value.message,
    };
    if (value.code) serialized.code = value.code;
    if (includeStacks && value.stack) serialized.stack = value.stack;
    return serialized;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(index, item, includeStacks));
  }

  if (typeof value === 'object') {
    return sanitizeObject(value, includeStacks);
  }

  return value;
}

function sanitizeObject(obj, includeStacks = false) {
  const sanitized = {};
  for (const [key, value] of Object.entries(obj || {})) {
    const safeValue = sanitizeValue(key, value, includeStacks);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

function record(event, details = {}) {
  breadcrumbs.push({
    ts: new Date().toISOString(),
    event,
    ...sanitizeObject(details),
  });

  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift();
  }
}

function setConnectionContext(deviceKey, context) {
  connectionContexts.set(deviceKey, {
    updatedAt: new Date().toISOString(),
    ...sanitizeObject(context),
  });
}

function clearConnectionContext(deviceKey) {
  connectionContexts.delete(deviceKey);
}

function nextAttemptId(prefix = 'esphome') {
  attemptCounter += 1;
  return `${prefix}-${attemptCounter}`;
}

function getSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    connections: Array.from(connectionContexts.entries()).map(([deviceKey, context]) => ({
      deviceKey,
      ...context,
    })),
    breadcrumbs: breadcrumbs.slice(-MAX_BREADCRUMBS),
  };
}

function buildFatalReport(type, error, extra = {}) {
  return {
    type,
    error: sanitizeValue('error', error, true),
    extra: sanitizeObject(extra, true),
    snapshot: getSnapshot(),
  };
}

function stringifyFatalReport(type, error, extra = {}) {
  return JSON.stringify(buildFatalReport(type, error, extra), null, 2);
}

module.exports = {
  buildFatalReport,
  clearConnectionContext,
  getSnapshot,
  nextAttemptId,
  record,
  setConnectionContext,
  stringifyFatalReport,
};
