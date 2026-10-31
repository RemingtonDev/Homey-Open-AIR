'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
const FILE_NAME = 'connection-journal.jsonl';

// Socket errors quote the peer address, so scrub it from free text as well.
const HOST_PATTERN = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[\w-]+\.local)\b/g;

/**
 * Append-only JSON lines file that outlives the app process. Volume is low
 * (connection events and valve reports, not sensors), so writes are
 * synchronous: lines stay in order and a crash cannot lose a buffered line.
 */
class ConnectionJournal {

  constructor({ directory = '/userdata', maxBytes = MAX_BYTES, onError = () => {} } = {}) {
    this.file = path.join(directory, FILE_NAME);
    this.maxBytes = maxBytes;
    this.onError = onError;
    this.failures = 0;
    this.bytes = 0;
    try { this.bytes = fs.statSync(this.file).size; } catch (_) { /* first run */ }
  }

  write(entry) {
    try {
      const line = `${JSON.stringify(entry).replace(HOST_PATTERN, '[host]')}\n`;
      if (this.bytes > 0 && this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        fs.renameSync(this.file, `${this.file}.1`);
        this.bytes = 0;
      }
      fs.appendFileSync(this.file, line);
      this.bytes += Buffer.byteLength(line);
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1) this.onError(error);
    }
  }

}

module.exports = ConnectionJournal;
