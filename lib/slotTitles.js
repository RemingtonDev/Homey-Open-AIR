'use strict';

const { SENSOR_TYPES } = require('./utils');

// Localized base titles per measurement type for slot labeling
const SLOT_TITLES = {
  temperature: { en: 'Temperature', nl: 'Temperatuur', fr: 'Température' },
  humidity:    { en: 'Humidity',    nl: 'Vochtigheid', fr: 'Humidité' },
  co2:         { en: 'CO2',         nl: 'CO2',         fr: 'CO2' },
  rpm:         { en: 'RPM',         nl: 'Toerental',   fr: 'RPM' },
  voc:         { en: 'VOC Index',   nl: 'VOC Index',   fr: 'Indice COV' },
  nox:         { en: 'NOx Index',   nl: 'NOx Index',   fr: 'Indice NOx' },
};

function numberedTitle(titles, slot) {
  return {
    en: `${titles.en} ${slot}`,
    nl: `${titles.nl} ${slot}`,
    fr: `${titles.fr} ${slot}`,
  };
}

/**
 * Title a slot 2+ capability, e.g. "Temperature 2", and relabel the slot 1 base
 * capability so users can distinguish them (e.g. "Temperature" → "Temperature 1").
 * Guarded by device._slotTitleFlags to avoid repeated slot 1 calls.
 */
async function applySlotTitles(device, capabilityId, measurementType, slot) {
  const titles = SLOT_TITLES[measurementType];
  try {
    await device.setCapabilityOptions(capabilityId, { title: numberedTitle(titles, slot) });
  } catch (err) {
    device.error(`Failed to set title for ${capabilityId}:`, err);
  }

  if (device._slotTitleFlags[measurementType]) return;
  device._slotTitleFlags[measurementType] = true;

  const baseCapabilityId = SENSOR_TYPES[measurementType].base;
  if (!device.hasCapability(baseCapabilityId)) return;

  try {
    await device.setCapabilityOptions(baseCapabilityId, { title: numberedTitle(titles, 1) });
  } catch (err) {
    device.error(`Failed to set slot 1 title for ${baseCapabilityId}:`, err);
  }
}

module.exports = applySlotTitles;
