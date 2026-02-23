The Open AIR project provides open-source, ESP32-based controllers that bring smart ventilation to DucoBox Silent and Orcon MVS-15xx systems. This app connects directly to your Open AIR devices over the ESPHome native API, with automatic device discovery and sensor detection.

**Open AIR Mini** (ventilation controller): Supports fan on/off, speed control (0–100%), RPM monitoring, and an automatic fan curve that adjusts speed based on humidity thresholds with pause/resume. Sensors are detected automatically, including temperature, humidity, CO2 (SCD-40, Senseair S8), VOC and NOx (SGP-41). Dual sensor slots are supported.

**Open AIR Valve** (zone damper): Supports valve position control (0–100%), open/close, stop, and re-home (recalibrate). Monitors valve position, closed state, temperature, and humidity.

The app works with both modern encryption keys and legacy password authentication.
