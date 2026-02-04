'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME } = require('../../lib/constants');

class OpenAirMiniDriver extends Homey.Driver {

  async onInit() {
    this.log('Open AIR Mini driver has been initialized');
  }

  /**
   * Called when pairing starts - returns list of discovered devices
   * Note: "Add manually..." option removed - credentials view is used as fallback when no devices found
   */
  async onPairListDevices() {
    this.log('Listing devices for pairing...');

    const devices = [];

    // Get devices from Homey's mDNS discovery
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    this.log(`Found ${Object.keys(discoveryResults).length} mDNS devices`);

    for (const [id, result] of Object.entries(discoveryResults)) {
      this.log(`Processing discovered device: ${id} (${result.name || result.id} at ${result.address})`);

      // ESPHome devices advertise on _esphomelib._tcp
      const device = {
        name: result.name || result.id || 'Open AIR Mini',
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

    // If no devices discovered, we'll show an empty list
    // The pairing flow will navigate to credentials view for manual entry
    if (devices.length === 0) {
      this.log('No devices discovered via mDNS');
    }

    return devices;
  }

  /**
   * Handle the pairing session
   */
  onPair(session) {
    let selectedDevice = null;
    let credentials = {
      host: '',
      port: ESPHOME.DEFAULT_PORT,
      encryptionKey: '',
      password: '',
    };

    // Handle device selection from list
    session.setHandler('list_devices', async () => {
      const devices = await this.onPairListDevices();
      this.log(`Returning ${devices.length} devices to pairing list`);
      return devices;
    });

    // Handle view changes (for logging purposes)
    session.setHandler('showView', async (viewId) => {
      this.log(`Showing view: ${viewId}`);
      // Note: Credentials are pre-filled in list_devices_selection handler
      // BEFORE navigation, not here (this fires after navigation starts)
    });

    // Store selected device and pre-fill credentials BEFORE navigation
    // Navigation to credentials view is handled by driver.compose.json navigation.next
    session.setHandler('list_devices_selection', async (devices) => {
      this.log('Device selected:', devices?.[0]?.name, 'at', devices?.[0]?.store?.address);
      if (devices && devices.length > 0) {
        selectedDevice = devices[0];
        this.log(`Selected device: ${selectedDevice.name} at ${selectedDevice.store?.address || 'unknown address'}`);

        // Pre-fill credentials BEFORE navigation happens
        // This ensures getCredentials returns the correct values when the form loads
        if (selectedDevice.store?.address) {
          credentials.host = selectedDevice.store.address;
          credentials.port = selectedDevice.store.port || ESPHOME.DEFAULT_PORT;
          this.log(`Pre-filled credentials: ${credentials.host}:${credentials.port}`);
        }

        // DO NOT call session.showView('credentials') here!
        // Let driver.compose.json navigation.next handle the navigation naturally
        // Calling showView here causes double navigation and the list flashes away
      }
    });

    // Handle credentials submission
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
        // Test connection with both encryptionKey and password support
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

    // Create device from credentials
    session.setHandler('createDevice', async () => {
      this.log('=== createDevice called ===');

      if (!credentials.host) {
        this.log('Error: Host is required');
        throw new Error(this.homey.__('pair.credentials.error_host_required'));
      }

      const deviceName = selectedDevice?.name || 'Open AIR Mini';
      const deviceId = selectedDevice?.data?.id || `open-air-${credentials.host.replace(/\./g, '-')}`;

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

  /**
   * Handle device repair session
   */
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
      // Test new credentials with both encryptionKey and password support
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

      // Update device store
      await device.setStoreValue('address', data.host);
      await device.setStoreValue('port', data.port);
      await device.setStoreValue('encryptionKey', data.encryptionKey || null);
      await device.setStoreValue('password', data.password || null);

      // Update settings
      await device.setSettings({
        host: data.host,
        port: data.port,
        encryptionKey: data.encryptionKey || '',
        password: data.password || '',
      });

      // Reconnect device
      await device.reconnect();

      return { success: true };
    });
  }

}

module.exports = OpenAirMiniDriver;
