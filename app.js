'use strict';

const Homey = require('homey');

class OpenAirApp extends Homey.App {

  async onInit() {
    this.log('Open AIR app has been initialized');

    this._registerFlowCards();
  }

  _registerFlowCards() {
    // --- Fan flow actions ---
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

    // --- Valve flow actions ---
    const setValvePositionAction = this.homey.flow.getActionCard('set-valve-position');
    setValvePositionAction.registerRunListener(async (args) => {
      this.log(`Flow: Set valve position to ${args.position}%`);
      await args.device.setValvePositionPercent(args.position);
    });

    const openValveAction = this.homey.flow.getActionCard('open-valve');
    openValveAction.registerRunListener(async (args) => {
      this.log('Flow: Open valve fully');
      await args.device.openValve();
    });

    const closeValveAction = this.homey.flow.getActionCard('close-valve');
    closeValveAction.registerRunListener(async (args) => {
      this.log('Flow: Close valve');
      await args.device.closeValve();
    });

    const stopValveAction = this.homey.flow.getActionCard('stop-valve');
    stopValveAction.registerRunListener(async (args) => {
      this.log('Flow: Stop valve movement');
      await args.device.stopValve();
    });

    const rehomeValveAction = this.homey.flow.getActionCard('rehome-valve');
    rehomeValveAction.registerRunListener(async (args) => {
      this.log('Flow: Re-home valve');
      await args.device.rehomeValve();
    });
  }

}

module.exports = OpenAirApp;
