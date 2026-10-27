# Nodu common Arduino libraries

Bundle `esp32-common-20261026` contains 11 unchanged archives from the official Arduino Library Manager index, 1,229,699 bytes total. `manifest.json` preserves their upstream URL, exact version, size and SHA-256. Full upstream source and licenses are inside each archive; extracted license files are retained under `licenses/` for distribution review.

Validated with Arduino CLI 1.5.1 and Arduino-ESP32 Core 3.3.12 on macOS arm64, for ESP32-C3 and ESP32-S3. The smoke program calls real APIs from every library; both compile and link. This is compilation evidence, not validation of attached physical sensors, displays or servos. OneWire emits two upstream preprocessing warnings; ESP32Servo emits S3 legacy MCPWM deprecation warnings. Neither upstream package was patched or its warning suppressed.

The runtime verifies the archive checksums before copying them into the configured CLI download cache. Where no full library index exists, it seeds the official records for these packages only. A subsequent explicit index refresh replaces that subset. Nodu does not copy into CLI's private extracted profile-cache layout.

New S3/C3 projects declare the bundle's exact direct and transitive dependencies in `sketch.yaml`; old project profiles are not changed. Other ESP32 targets do not automatically receive this bundle because they have not been validated. DallasTemperature 4.0.6 omits OneWire from its upstream dependency metadata, so the Nodu manifest explicitly pins OneWire 2.3.8. This changes resolver metadata only; the distributed archive remains untouched.

Evidence: `docs/design/esp32-library-acceptance-20261026/` at the repository root. This bundle has no tutorial files or Nodu-generated examples; upstream package examples remain part of the original source archives.
