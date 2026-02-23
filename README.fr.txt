Open AIR pour Homey

Contrôlez vos appareils de ventilation Open AIR directement depuis Homey.

À propos
--------
Le projet Open AIR propose des contrôleurs open source basés sur ESP32, conçus pour apporter
un contrôle intelligent aux systèmes de ventilation. Ils fonctionnent avec le firmware ESPHome
et se connectent directement via l'API native ESPHome, avec découverte automatique et
détection automatique des capteurs.

- Open AIR Mini : contrôleur intelligent pour les systèmes de ventilation DucoBox Silent et
  Orcon MVS-15xx, avec capteurs environnementaux (CO2, température, humidité, COV, NOx).
- Open AIR Valve : contrôleur de vanne motorisée pour les registres de ventilation par zone.

Matériel : https://github.com/Flamingo-tech/Open-AIR
Acheter sur Tindie : https://www.tindie.com/products/theflamingo/open-air-mini/

Pourquoi cette application ?
----------------------------
En tant qu'heureux propriétaire d'un Open AIR Mini et ayant commencé à bricoler avec
Homey, je voulais voir si je pouvais créer une application dédiée et moderne qui
permettrait l'intégration sans dépendre de l'application ESPHome générique pour Homey,
qui n'est quasiment plus maintenue — son développeur d'origine ne possède plus de Homey.
Cette application communique directement avec vos appareils Open AIR via l'API native
ESPHome, avec découverte automatique, détection automatique des capteurs, et prise en
charge du chiffrement moderne comme de l'authentification legacy.

Fonctionnalités — Mini (ventilation) :
- Allumer/éteindre la ventilation
- Régler la vitesse du ventilateur (0-100%)
- Courbe auto ventilateur : contrôle automatique de la vitesse basé sur des seuils d'humidité, avec pause/reprise
- Surveiller le régime du ventilateur (RPM)
- Afficher les relevés de température
- Afficher les relevés d'humidité
- Afficher les niveaux de CO2 (ppm) — ajouté dynamiquement lorsqu'un SCD-40 ou Senseair S8 est détecté
- Afficher l'indice COV — ajouté dynamiquement lorsqu'un SGP-41 est détecté
- Afficher l'indice NOx — ajouté dynamiquement lorsqu'un SGP-41 est détecté
- Prise en charge de plusieurs emplacements de capteurs : deux emplacements physiques (SENSOR 1 et SENSOR 2)
  sont détectés automatiquement. Les capteurs de l'emplacement 2+ obtiennent des sous-capacités
  (par ex. « Température 2 », « Humidité 2 »).

Fonctionnalités — Valve (registre de zone) :
- Ouvrir / fermer la vanne
- Régler la position de la vanne (0-100%)
- Surveiller la position et l'état de fermeture de la vanne
- Arrêter le mouvement de la vanne
- Recalibrer la vanne (re-home)
- Actions de flux : ouvrir, fermer, arrêter, régler la position, recalibrer

Installation :
1. Ajoutez votre appareil Open AIR (Mini ou Valve) dans Homey
2. Sélectionnez votre appareil dans la liste découverte, ou entrez l'adresse IP manuellement
3. Entrez votre clé de chiffrement ESPHome ou votre mot de passe (si configuré)
4. L'appareil sera ajouté à votre Homey

Testé avec :
- ESPHome 2023.6.5 : fonctionnel (mot de passe, clé de chiffrement, ou les deux)
- ESPHome 2026.1.4 : fonctionnel (clé de chiffrement uniquement ; l'authentification par mot de passe a été supprimée dans ESPHome 2026.1.0)
- Carte Open AIR Mini v1.4.1
- Capteur Température/Humidité : SHT-20 (SHT2x) dans l'emplacement 1 — testé et confirmé fonctionnel

Remarque : ESPHome 2026.x a supprimé l'authentification par mot de passe API. Seule la clé de
chiffrement est prise en charge pour ESPHome 2026.x et versions ultérieures. L'application détecte
automatiquement la version ESPHome et utilise la bibliothèque de protocole appropriée.

Prérequis :
- Appareil Open AIR (Mini ou Valve) avec firmware ESPHome
- L'appareil doit être sur le même réseau que votre Homey

Pour plus d'informations sur Open AIR, visitez : https://github.com/RemingtonDev/Homey-Open-AIR
