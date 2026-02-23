Open AIR for Homey

Control your Open AIR ventilation devices directly from Homey.

About
-----
The Open AIR project provides open-source, ESP32-based controllers designed to bring smart
control to ventilation systems. They run ESPHome firmware and connect directly via the
ESPHome native API, with auto-discovery and sensor auto-detection.

- Open AIR Mini: smart controller for DucoBox Silent and Orcon MVS-15xx ventilation systems,
  with environmental sensors (CO2, temperature, humidity, VOC, NOx).
- Open AIR Valve: motorized valve controller for zone-based ventilation dampers.

Hardware: https://github.com/Flamingo-tech/Open-AIR
Buy on Tindie: https://www.tindie.com/products/theflamingo/open-air-mini/

Why this app?
-------------
As a proud owner of an Open AIR Mini and starting to fiddle with Homey, I wanted to
see if I could build a modern, dedicated app that would enable the integration without
relying on the generic ESPHome app for Homey, which is barely maintained anymore — its
original developer no longer owns a Homey. This app talks directly to your Open AIR devices
over the ESPHome native API, with auto-discovery, sensor auto-detection, and support for
both modern encryption and legacy authentication.

Features — Mini (ventilation):
- Turn ventilation on/off
- Adjust fan speed (0-100%)
- Auto fan curve: automatic fan speed control based on humidity thresholds, with pause/resume
- Monitor fan RPM
- View temperature readings
- View humidity readings
- View CO2 levels (ppm) — dynamically added when SCD-40 or Senseair S8 is detected
- View VOC Index — dynamically added when SGP-41 is detected
- View NOx Index — dynamically added when SGP-41 is detected
- Multi-sensor slot support: two physical sensor slots (SENSOR 1 and SENSOR 2) are detected
  automatically. Slot 2+ sensors get sub-capabilities (e.g. "Temperature 2", "Humidity 2").

Features — Valve (zone damper):
- Open / close valve
- Set valve position (0-100%)
- Monitor valve position and closed state
- Stop valve movement
- Re-home valve (recalibrate)
- Flow card actions: open, close, stop, set position, re-home

Setup:
1. Add your Open AIR device (Mini or Valve) in Homey
2. Select your device from the discovered list, or enter the IP address manually
3. Enter your ESPHome encryption key or password (if configured)
4. The device will be added to your Homey

Tested with:
- ESPHome 2023.6.5: working (password, encryption key, or both)
- ESPHome 2026.1.4: working (encryption key only; password auth was removed in ESPHome 2026.1.0)
- Open AIR Mini v1.4.1 board
- Temperature/Humidity sensor: SHT-20 (SHT2x) in slot 1 — tested and confirmed working

Note: ESPHome 2026.x removed API password authentication. Only encryption key is supported
for ESPHome 2026.x and newer. The app automatically detects the ESPHome version and uses
the appropriate protocol library.

Requirements:
- Open AIR device (Mini or Valve) with ESPHome firmware
- Device must be on the same network as your Homey

For more information about Open AIR, visit: https://github.com/RemingtonDev/Homey-Open-AIR
