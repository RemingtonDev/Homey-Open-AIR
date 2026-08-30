'use strict';

const assert = require('node:assert/strict');
const NoiseFrameHelper = require('esphome-api-legacy/lib/utils/noiseFrameHelper');
const PlaintextFrameHelper = require('esphome-api-legacy/lib/utils/plaintextFrameHelper');

const HANDSHAKE_READY = 3;
const VALID_MESSAGE_ID = 8; // PingResponse, with an empty valid protobuf payload.
const UNKNOWN_MESSAGE_ID = 0x7fff;
const MALFORMED_PAYLOAD = Buffer.from([0x80]);

function encodeVaruint(value) {
  const bytes = [];

  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);

  return Buffer.from(bytes);
}

function plaintextFrame(messageId, payload = Buffer.alloc(0)) {
  return Buffer.concat([
    Buffer.from([0]),
    encodeVaruint(payload.length),
    encodeVaruint(messageId),
    payload,
  ]);
}

function noiseFrame(messageId, payload = Buffer.alloc(0)) {
  const message = Buffer.alloc(4 + payload.length);
  message.writeUInt16BE(messageId, 0);
  message.writeUInt16BE(payload.length, 2);
  payload.copy(message, 4);

  return Buffer.concat([
    Buffer.from([1, (message.length >> 8) & 0xff, message.length & 0xff]),
    message,
  ]);
}

function createPlaintextHelper() {
  return new PlaintextFrameHelper('127.0.0.1', 6053);
}

function createNoiseHelper() {
  const helper = new NoiseFrameHelper(
    '127.0.0.1',
    6053,
    Buffer.alloc(32).toString('base64'),
  );

  // Bypass the network handshake. The test is for decrypted frame dispatch;
  // the fake decryptor leaves the serialized frame unchanged.
  helper.handshakeState = HANDSHAKE_READY;
  helper.decryptor = {
    DecryptWithAd: (_additionalData, frame) => frame,
  };

  return helper;
}

function observe(helper) {
  const errors = [];
  const messages = [];
  const unsupportedMessages = [];

  // The real helpers report parser failures through EventEmitter's error
  // event. Keeping a listener here lets the test assert controlled handling.
  helper.on('error', error => errors.push(error));
  helper.on('message', message => messages.push(message));
  helper.on('unsupportedMessage', details => unsupportedMessages.push(details));

  return { errors, messages, unsupportedMessages };
}

function closeHelper(helper) {
  helper.removeAllListeners();
  helper.socket.destroy();
}

function withHelper(createHelper, test) {
  const helper = createHelper();

  try {
    return test(helper);
  } finally {
    closeHelper(helper);
  }
}

function assertNoLengthTypeError(errors, label) {
  assert.equal(
    errors.some(error => (
      error &&
      error.name === 'TypeError' &&
      /Cannot set properties of undefined \(setting 'length'\)/.test(error.message)
    )),
    false,
    `${label} must not report the message.length TypeError`,
  );
}

function assertUnknownFrameIsSkipped(createHelper, frame, label) {
  withHelper(createHelper, helper => {
    const { errors, messages, unsupportedMessages } = observe(helper);
    let thrown;

    try {
      helper.onData(Buffer.concat([
        frame(UNKNOWN_MESSAGE_ID, Buffer.from([0x01, 0x02])),
        frame(VALID_MESSAGE_ID),
      ]));
    } catch (error) {
      thrown = error;
    }

    assert.equal(thrown, undefined, `${label} unknown frame must not throw`);
    assert.equal(unsupportedMessages.length, 1, `${label} must report one unsupported frame`);
    assert.equal(unsupportedMessages[0].messageId, UNKNOWN_MESSAGE_ID);
    assert.equal(unsupportedMessages[0].transport, label.toLowerCase());
    assert.equal(unsupportedMessages[0].declaredLength, 2);
    assert.equal(unsupportedMessages[0].actualLength, 2);
    assert.deepEqual(
      messages.map(message => message && Number(message.constructor.id)),
      [VALID_MESSAGE_ID],
      `${label} must process the valid frame after the unsupported frame`,
    );
    assert.equal(helper.buffer.length, 0, `${label} must consume the unsupported frame`);
    assert.equal(errors.length, 0, `${label} unsupported frame must not be reported as a parser error`);
    assertNoLengthTypeError(errors, label);
  });
}

function assertMalformedKnownFrameIsControlled(createHelper, frame, label) {
  withHelper(createHelper, helper => {
    const { errors, messages } = observe(helper);
    let thrown;

    try {
      helper.onData(frame(VALID_MESSAGE_ID, MALFORMED_PAYLOAD));
    } catch (error) {
      thrown = error;
    }

    assert.equal(thrown, undefined, `${label} malformed frame must not escape as a throw`);
    assert.ok(errors.length > 0, `${label} malformed frame must produce a controlled error event`);
    assert.ok(errors.every(error => error instanceof Error), `${label} errors must be Error instances`);
    assert.ok(
      errors.some(error => error.code === 'MALFORMED_MESSAGE'),
      `${label} malformed frame must identify the controlled protocol error`,
    );
    assert.equal(messages.length, 0, `${label} malformed frame must not be emitted as a message`);
    assert.equal(helper.protocolFailed, true, `${label} must enter terminal protocol failure state`);
    assert.equal(helper.buffer.length, 0, `${label} must clear its retained buffer`);
    assert.equal(helper.socket.destroyed, true, `${label} must destroy its socket`);

    helper.onData(frame(VALID_MESSAGE_ID, MALFORMED_PAYLOAD));
    assert.equal(errors.length, 1, `${label} must report a protocol failure only once`);
    assertNoLengthTypeError(errors, label);
  });
}

function testOversizedPlaintextVaruintIsTerminal() {
  withHelper(createPlaintextHelper, helper => {
    const { errors, messages } = observe(helper);
    const oversizedLength = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0x10, 0]);

    assert.doesNotThrow(() => helper.onData(oversizedLength));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'PROTOCOL_ERROR');
    assert.match(errors[0].message, /Varuint exceeds 32 bits/);
    assert.equal(messages.length, 0);
    assert.equal(helper.protocolFailed, true);
    assert.equal(helper.buffer.length, 0);
    assert.equal(helper.socket.destroyed, true);

    helper.onData(oversizedLength);
    assert.equal(errors.length, 1, 'terminal parser must ignore repeated input');
  });
}

function testUnknownNoiseFrameIsConsumedAndNextMessageProcessed() {
  assertUnknownFrameIsSkipped(createNoiseHelper, noiseFrame, 'Noise');
}

function testUnknownPlaintextFrameIsConsumedAndNextMessageProcessed() {
  assertUnknownFrameIsSkipped(createPlaintextHelper, plaintextFrame, 'Plaintext');
}

function testMalformedKnownNoiseFrameProducesControlledError() {
  assertMalformedKnownFrameIsControlled(createNoiseHelper, noiseFrame, 'Noise');
}

function testMalformedKnownPlaintextFrameProducesControlledError() {
  assertMalformedKnownFrameIsControlled(createPlaintextHelper, plaintextFrame, 'Plaintext');
}

function main() {
  testUnknownNoiseFrameIsConsumedAndNextMessageProcessed();
  testUnknownPlaintextFrameIsConsumedAndNextMessageProcessed();
  testMalformedKnownNoiseFrameProducesControlledError();
  testMalformedKnownPlaintextFrameProducesControlledError();
  testOversizedPlaintextVaruintIsTerminal();
  console.log('legacy frame parser tests passed');
}

main();
