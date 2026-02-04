'use strict';

const Homey = require('homey');

class OpenAirMiniApp extends Homey.App {

  async onInit() {
    this.log('Open AIR Mini app has been initialized');

    this._registerFlowCards();
  }

  _registerFlowCards() {
    const adjustFanSpeedAction = this.homey.flow.getActionCard('adjust-fan-speed-humidity');
    adjustFanSpeedAction.registerRunListener(async (args) => {
      const humidity = args.device.getCapabilityValue('measure_humidity');

      if (humidity === null || humidity === undefined) {
        throw new Error(this.homey.__('errors.no_humidity'));
      }

      let targetSpeed;
      if (humidity >= args.high_humidity) {
        targetSpeed = args.high_speed;
      } else if (humidity >= args.medium_humidity) {
        targetSpeed = args.medium_speed;
      } else {
        targetSpeed = args.low_speed;
      }

      this.log(`Humidity ${humidity}% → fan speed ${targetSpeed}%`);

      await args.device.setFanSpeedPercent(targetSpeed);
    });
  }

}

module.exports = OpenAirMiniApp;
