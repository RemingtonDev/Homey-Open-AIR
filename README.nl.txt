Open AIR voor Homey

Bedien je Open AIR ventilatie-apparaten rechtstreeks vanuit Homey.

Over dit project
----------------
Het Open AIR project biedt open-source, op ESP32 gebaseerde controllers die ontworpen zijn
om slimme besturing te bieden voor ventilatiesystemen. Ze draaien op ESPHome-firmware en
verbinden rechtstreeks via de native ESPHome-API, met automatische ontdekking en automatische
sensordetectie.

- Open AIR Mini: slimme controller voor DucoBox Silent en Orcon MVS-15xx ventilatiesystemen,
  met omgevingssensoren (CO2, temperatuur, luchtvochtigheid, VOC, NOx).
- Open AIR Valve: gemotoriseerde klepcontroller voor zone-gebaseerde ventilatieregisters.

Hardware: https://github.com/Flamingo-tech/Open-AIR
Koop op Tindie: https://www.tindie.com/products/theflamingo/open-air-mini/

Waarom deze app?
----------------
Als trotse eigenaar van een Open AIR Mini en beginnend met Homey, wilde ik kijken of
ik een moderne, specifieke app kon bouwen die de integratie mogelijk zou maken zonder
afhankelijk te zijn van de generieke ESPHome-app voor Homey, die nauwelijks nog
onderhouden wordt — de oorspronkelijke ontwikkelaar heeft geen Homey meer. Deze app
communiceert rechtstreeks met je Open AIR apparaten via de native ESPHome-API, met
automatische ontdekking, automatische sensordetectie, en ondersteuning voor zowel
moderne encryptie als legacy-authenticatie.

Functies — Mini (ventilatie):
- Ventilatie aan/uit zetten
- Ventilatorsnelheid aanpassen (0-100%)
- Automatische ventilatorcurve: automatische snelheidsregeling op basis van vochtigheidsdrempels, met pauzeren/hervatten
- Toerental (RPM) monitoren
- Temperatuur aflezen
- Luchtvochtigheid aflezen
- CO2-niveau bekijken (ppm) — dynamisch toegevoegd wanneer een SCD-40 of Senseair S8 wordt gedetecteerd
- VOC Index bekijken — dynamisch toegevoegd wanneer een SGP-41 wordt gedetecteerd
- NOx Index bekijken — dynamisch toegevoegd wanneer een SGP-41 wordt gedetecteerd
- Ondersteuning voor meerdere sensorslots: twee fysieke sensorslots (SENSOR 1 en SENSOR 2) worden
  automatisch gedetecteerd. Slot 2+ sensoren krijgen sub-capabilities (bijv. "Temperatuur 2", "Vochtigheid 2").

Functies — Valve (zoneregister):
- Klep openen / sluiten
- Kleppositie instellen (0-100%)
- Kleppositie en gesloten status monitoren
- Klepbeweging stoppen
- Klep opnieuw kalibreren (re-home)
- Flow-kaartacties: openen, sluiten, stoppen, positie instellen, herkalibreren

Installatie:
1. Voeg je Open AIR apparaat (Mini of Valve) toe in Homey
2. Selecteer je apparaat uit de gevonden lijst, of voer het IP-adres handmatig in
3. Voer je ESPHome encryptiesleutel of wachtwoord in (indien geconfigureerd)
4. Het apparaat wordt toegevoegd aan je Homey

Getest met:
- ESPHome 2023.6.5: werkend (wachtwoord, encryptiesleutel, of beide)
- ESPHome 2026.1.4: werkend (alleen encryptiesleutel; wachtwoordauthenticatie is verwijderd in ESPHome 2026.1.0)
- Open AIR Mini v1.4.1 board
- Temperatuur/Vochtigheid sensor: SHT-20 (SHT2x) in slot 1 — getest en bevestigd werkend

Opmerking: ESPHome 2026.x heeft API-wachtwoordauthenticatie verwijderd. Alleen de encryptiesleutel
wordt ondersteund voor ESPHome 2026.x en nieuwer. De app detecteert automatisch de ESPHome-versie
en gebruikt de juiste protocolbibliotheek.

Vereisten:
- Open AIR apparaat (Mini of Valve) met ESPHome firmware
- Het apparaat moet zich op hetzelfde netwerk bevinden als je Homey

Voor meer informatie over Open AIR, bezoek: https://github.com/RemingtonDev/Homey-Open-AIR
