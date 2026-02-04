Open AIR Mini voor Homey

Bedien je Open AIR Mini ventilatiesysteem rechtstreeks vanuit Homey.

Over dit project
----------------
De Open AIR Mini is een open-source, op ESP32 gebaseerde controller die ontworpen is
om slimme besturing te bieden voor DucoBox Silent en Orcon MVS-15xx ventilatiesystemen.
Het draait op ESPHome-firmware en ondersteunt omgevingssensoren waaronder CO2,
temperatuur, luchtvochtigheid, VOC en NOx.

Hardware: https://github.com/Flamingo-tech/Open-AIR/tree/main/Open%20AIR%20Mini
Koop op Tindie: https://www.tindie.com/products/theflamingo/open-air-mini/

Waarom deze app?
----------------
Als trotse eigenaar van een Open AIR Mini en beginnend met Homey, wilde ik kijken of
ik een moderne, specifieke app kon bouwen die de integratie mogelijk zou maken zonder
afhankelijk te zijn van de generieke ESPHome-app voor Homey, die nauwelijks nog
onderhouden wordt — de oorspronkelijke ontwikkelaar heeft geen Homey meer. Deze app
communiceert rechtstreeks met de Open AIR Mini via de native ESPHome-API, met
automatische ontdekking, automatische sensordetectie, en ondersteuning voor zowel
moderne encryptie als legacy-authenticatie.

Functies:
- Ventilatie aan/uit zetten
- Ventilatorsnelheid aanpassen (0-100%)
- Toerental (RPM) monitoren
- Temperatuur aflezen
- Luchtvochtigheid aflezen
- CO2-niveau bekijken (ppm) — dynamisch toegevoegd wanneer een SCD-40 of Senseair S8 wordt gedetecteerd
- VOC Index bekijken — dynamisch toegevoegd wanneer een SGP-41 wordt gedetecteerd
- NOx Index bekijken — dynamisch toegevoegd wanneer een SGP-41 wordt gedetecteerd
- Ondersteuning voor meerdere sensorslots: twee fysieke sensorslots (SENSOR 1 en SENSOR 2) worden
  automatisch gedetecteerd. Slot 2+ sensoren krijgen sub-capabilities (bijv. "Temperatuur 2", "Vochtigheid 2").

Installatie:
1. Voeg het Open AIR Mini apparaat toe in Homey
2. Selecteer je apparaat uit de gevonden lijst, of voer het IP-adres handmatig in
3. Voer je ESPHome encryptiesleutel of wachtwoord in (indien geconfigureerd)
4. Het apparaat wordt toegevoegd aan je Homey

Getest met:
- ESPHome 2023.6.5: werkend (wachtwoord, encryptiesleutel, of beide)
- ESPHome 2026.1.4: werkend (alleen encryptiesleutel; wachtwoordauthenticatie is verwijderd in ESPHome 2026.1.0)
- Open AIR Mini v1.4.1 board
- Temperatuur/Vochtigheid sensor: SHT-20 (SHT2x) in slot 1 — getest en bevestigd werkend
- Alleen single-sensor (slot 1) configuraties zijn tot nu toe getest.
  Dual-sensor (slot 1 + slot 2) is geïmplementeerd maar nog niet getest met echte hardware.

Ondersteund maar nog niet getest (sensoren niet beschikbaar):
- SCD-40: CO2, Temperatuur, Vochtigheid sensor — geïmplementeerd, niet getest
- SGP-41: VOC Index en NOx Index sensor — geïmplementeerd, niet getest
- Senseair S8: CO2 sensor — geïmplementeerd, niet getest
- SHT-31: Temperatuur/Vochtigheid sensor — geïmplementeerd, niet getest
- SHT-4X: Temperatuur/Vochtigheid sensor — geïmplementeerd, niet getest
- Slot 2 sub-capabilities (bijv. "Temperatuur 2") — geïmplementeerd, niet getest met hardware

Opmerking: ESPHome 2026.x heeft API-wachtwoordauthenticatie verwijderd. Alleen de encryptiesleutel
wordt ondersteund voor ESPHome 2026.x en nieuwer. De app detecteert automatisch de ESPHome-versie
en gebruikt de juiste protocolbibliotheek.

Niet ondersteund:
- Open AIR Valve wordt momenteel niet ondersteund en er zijn geen plannen om dit te ontwikkelen.

Vereisten:
- Open AIR Mini apparaat met ESPHome firmware
- Het apparaat moet zich op hetzelfde netwerk bevinden als je Homey

Voor meer informatie over Open AIR Mini, bezoek: https://github.com/RemingtonDev/Homey-Open-AIR
