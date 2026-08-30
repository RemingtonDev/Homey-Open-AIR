'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

const miniDriver = readJson('drivers/open-air-mini/driver.compose.json');
const valveDriver = readJson('drivers/open-air-valve/driver.compose.json');
const miniDiscovery = readJson('.homeycompose/discovery/open-air-mini.json');
const valveDiscovery = readJson('.homeycompose/discovery/open-air-valve.json');

assert.equal(miniDriver.discovery, 'open-air-mini');
assert.equal(valveDriver.discovery, 'open-air-valve');
assert.notEqual(miniDriver.discovery, valveDriver.discovery);

const conditionRegex = (strategy) => new RegExp(strategy.conditions[0][0].match.value);
const miniRegex = conditionRegex(miniDiscovery);
const valveRegex = conditionRegex(valveDiscovery);

assert(miniRegex.test('open-air-mini-06bc04'));
assert(!miniRegex.test('open-air-valve-1-209588'));
assert(valveRegex.test('open-air-valve-1-209588'));
assert(!valveRegex.test('open-air-mini-06bc04'));

console.log('discovery routing tests passed');
