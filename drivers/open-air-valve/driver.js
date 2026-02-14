'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME } = require('../../lib/constants');

class OpenAirValveDriver extends Homey.Driver {

  async onInit() {
    this.log('Open AIR Valve driver has been initialized');
  }

  async onPairListDevices() {
    this.log('Listing devices for pairing...');

    const devices = [];

    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    this.log(`Found ${Object.keys(discoveryResults).length} mDNS devices`);

    for (const [id, result] of Object.entries(discoveryResults)) {
      this.log(`Processing discovered device: ${id} (${result.name || result.id} at ${result.address})`);

      const device = {
        name: result.name || result.id || 'Open AIR Valve',
        data: {
          id: result.id,
        },
        settings: {
          host: result.address,
          port: result.port || ESPHOME.DEFAULT_PORT,
        },
        store: {
          address: result.address,
          port: result.port || ESPHOME.DEFAULT_PORT,
        },
      };

      devices.push(device);
    }

    if (devices.length === 0) {
      this.log('No devices discovered via mDNS');
    }

    return devices;
  }

  onPair(session) {
    let selectedDevice = null;
    let credentials = {
      host: '',
      port: ESPHOME.DEFAULT_PORT,
      encryptionKey: '',
      password: '',
    };

    session.setHandler('list_devices', async () => {
      const devices = await this.onPairListDevices();
      this.log(`Returning ${devices.length} devices to pairing list`);
      return devices;
    });

    session.setHandler('showView', async (viewId) => {
      this.log(`Showing view: ${viewId}`);
    });

    session.setHandler('list_devices_selection', async (devices) => {
      this.log('Device selected:', devices?.[0]?.name, 'at', devices?.[0]?.store?.address);
      if (devices && devices.length > 0) {
        selectedDevice = devices[0];
        this.log(`Selected device: ${selectedDevice.name} at ${selectedDevice.store?.address || 'unknown address'}`);

        if (selectedDevice.store?.address) {
          credentials.host = selectedDevice.store.address;
          credentials.port = selectedDevice.store.port || ESPHOME.DEFAULT_PORT;
          this.log(`Pre-filled credentials: ${credentials.host}:${credentials.port}`);
        }
      }
    });

    session.setHandler('getCredentials', () => {
      this.log('getCredentials called, returning:', { ...credentials, encryptionKey: credentials.encryptionKey ? '***' : '', password: credentials.password ? '***' : '' });
      return credentials;
    });

    session.setHandler('setCredentials', async (data) => {
      this.log('=== setCredentials called ===');
      this.log('Received data:', { host: data.host, port: data.port, encryptionKey: data.encryptionKey ? '***' : '(empty)', password: data.password ? '***' : '(empty)' });

      credentials = { ...credentials, ...data };

      this.log(`Testing connection to ${credentials.host}:${credentials.port}...`);

      try {
        const result = await EspHomeClient.testConnection(
          credentials.host,
          credentials.port,
          credentials.encryptionKey || null,
          credentials.password || null,
          this,
        );

        this.log('testConnection result:', { success: result.success, error: result.error, entityCount: result.entities?.length || 0 });

        if (!result.success) {
          const errorMsg = result.error || this.homey.__('pair.credentials.error_connection');
          this.log(`Connection failed: ${errorMsg}`);
          throw new Error(errorMsg);
        }

        const hasValve = result.entities?.some(e => e.type === 'valve');
        if (!hasValve) {
          throw new Error(this.homey.__('pair.credentials.error_wrong_device_type'));
        }

        this.log(`Connection successful! Found ${result.entities?.length || 0} entities`);

        return {
          success: true,
          entities: result.entities,
        };
      } catch (error) {
        this.log(`Connection error: ${error.message}`);
        throw error;
      }
    });

    session.setHandler('createDevice', async () => {
      this.log('=== createDevice called ===');

      if (!credentials.host) {
        this.log('Error: Host is required');
        throw new Error(this.homey.__('pair.credentials.error_host_required'));
      }

      const deviceName = selectedDevice?.name || 'Open AIR Valve';
      const deviceId = selectedDevice?.data?.id || `open-air-valve-${credentials.host.replace(/\./g, '-')}`;

      const device = {
        name: deviceName,
        data: {
          id: deviceId,
        },
        settings: {
          host: credentials.host,
          port: credentials.port,
          encryptionKey: credentials.encryptionKey || '',
          password: credentials.password || '',
        },
        store: {
          address: credentials.host,
          port: credentials.port,
          encryptionKey: credentials.encryptionKey || null,
          password: credentials.password || null,
        },
      };

      this.log('Creating device:', { name: device.name, id: device.data.id, host: device.settings.host, port: device.settings.port });
      return device;
    });
  }

  onRepair(session, device) {
    session.setHandler('getCredentials', async () => {
      const store = device.getStore();
      return {
        host: store.address || device.getSetting('host'),
        port: store.port || device.getSetting('port') || ESPHOME.DEFAULT_PORT,
        encryptionKey: store.encryptionKey || '',
        password: store.password || '',
      };
    });

    session.setHandler('setCredentials', async (data) => {
      const result = await EspHomeClient.testConnection(
        data.host,
        data.port,
        data.encryptionKey || null,
        data.password || null,
        this,
      );

      if (!result.success) {
        throw new Error(result.error || this.homey.__('pair.credentials.error_connection'));
      }

      await device.setStoreValue('address', data.host);
      await device.setStoreValue('port', data.port);
      await device.setStoreValue('encryptionKey', data.encryptionKey || null);
      await device.setStoreValue('password', data.password || null);

      await device.setSettings({
        host: data.host,
        port: data.port,
        encryptionKey: data.encryptionKey || '',
        password: data.password || '',
      });

      await device.reconnect();

      return { success: true };
    });
  }

}

module.exports = OpenAirValveDriver;
