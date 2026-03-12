'use strict';

const Homey = require('homey');
const EspHomeClient = require('../../lib/EspHomeClient');
const { ESPHOME } = require('../../lib/constants');
const { detectMeasurementType, extractSensorSlot, computeCapabilityId } = require('../../lib/utils');

class OpenAirMiniDriver extends Homey.Driver {

  async onInit() {
    this.log('Open AIR Mini driver has been initialized');
  }

  /**
   * Called when pairing starts - returns list of discovered devices
   * Always includes a manual entry option so users can enter IP addresses directly
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

    if (devices.length === 0) {
      this.log('No devices discovered via mDNS');
    }

    // Always add manual entry option
    devices.push({
      name: this.homey.__('pair.manual_entry'),
      data: {
        id: '__manual_entry__',
      },
    });

    return devices;
  }

  /**
   * Handle the pairing session
   */
  onPair(session) {
    let selectedDevice = null;
    let discoveredEntities = [];
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
      if (devices && devices.length > 0) {
        // If manual entry is among selections, force manual behavior
        const isManual = devices.some(d => d.data?.id === '__manual_entry__');
        if (isManual) {
          this.log('Manual entry selected, clearing credentials');
          selectedDevice = null;
          credentials = {
            host: '',
            port: ESPHOME.DEFAULT_PORT,
            encryptionKey: '',
            password: '',
          };
          return;
        }

        selectedDevice = devices[0];
        this.log(`Selected device: ${selectedDevice.name} at ${selectedDevice.store?.address || 'unknown address'}`);

        // Pre-fill credentials BEFORE navigation happens
        if (selectedDevice.store?.address) {
          credentials.host = selectedDevice.store.address;
          credentials.port = selectedDevice.store.port || ESPHOME.DEFAULT_PORT;
          this.log(`Pre-filled credentials: ${credentials.host}:${credentials.port}`);
        }
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
          const errorKey = result.errorType
            ? `pair.credentials.error_${result.errorType}`
            : null;
          const errorMsg = (errorKey && this.homey.__(errorKey))
            || result.error
            || this.homey.__('pair.credentials.error_connection');
          this.log(`Connection failed: ${errorMsg}`);
          throw new Error(errorMsg);
        }

        const hasFan = result.entities?.some(e => e.type === 'fan');
        if (!hasFan) {
          throw new Error(this.homey.__('pair.credentials.error_wrong_device_type'));
        }

        this.log(`Connection successful! Found ${result.entities?.length || 0} entities`);

        discoveredEntities = result.entities || [];

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

      // Build capabilities from discovered entities
      const capabilities = ['dim', 'onoff', 'measure_fan_speed'];
      for (const entity of discoveredEntities) {
        if (entity.type !== 'sensor') continue;
        const type = detectMeasurementType(entity.name);
        if (!type) continue;
        const slot = extractSensorSlot(entity.name);
        const capId = computeCapabilityId(type, slot);
        if (!capabilities.includes(capId)) {
          capabilities.push(capId);
        }
      }
      this.log('Built capabilities from discovered entities:', capabilities);

      const deviceName = selectedDevice?.name || 'Open AIR Mini';
      const deviceId = selectedDevice?.data?.id || `open-air-${credentials.host.replace(/\./g, '-')}`;

      const device = {
        name: deviceName,
        data: {
          id: deviceId,
        },
        capabilities,
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
        const errorKey = result.errorType
          ? `pair.credentials.error_${result.errorType}`
          : null;
        const errorMsg = (errorKey && this.homey.__(errorKey))
          || result.error
          || this.homey.__('pair.credentials.error_connection');
        throw new Error(errorMsg);
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
