Open AIR Mini pour Homey

Contrôlez votre système de ventilation Open AIR Mini directement depuis Homey.

À propos
--------
L'Open AIR Mini est un contrôleur open source basé sur ESP32, conçu pour apporter un
contrôle intelligent aux systèmes de ventilation DucoBox Silent et Orcon MVS-15xx. Il
fonctionne avec le firmware ESPHome et prend en charge les capteurs environnementaux
tels que CO2, température, humidité, COV et NOx.

Matériel : https://github.com/Flamingo-tech/Open-AIR/tree/main/Open%20AIR%20Mini
Acheter sur Tindie : https://www.tindie.com/products/theflamingo/open-air-mini/

Pourquoi cette application ?
----------------------------
En tant qu'heureux propriétaire d'un Open AIR Mini et ayant commencé à bricoler avec
Homey, je voulais voir si je pouvais créer une application dédiée et moderne qui
permettrait l'intégration sans dépendre de l'application ESPHome générique pour Homey,
qui n'est quasiment plus maintenue — son développeur d'origine ne possède plus de Homey.
Cette application communique directement avec l'Open AIR Mini via l'API native ESPHome,
avec découverte automatique, détection automatique des capteurs, et prise en charge du
chiffrement moderne comme de l'authentification legacy.

Fonctionnalités :
- Allumer/éteindre la ventilation
- Régler la vitesse du ventilateur (0-100%)
- Surveiller le régime du ventilateur (RPM)
- Afficher les relevés de température
- Afficher les relevés d'humidité
- Afficher les niveaux de CO2 (ppm) — ajouté dynamiquement lorsqu'un SCD-40 ou Senseair S8 est détecté
- Afficher l'indice COV — ajouté dynamiquement lorsqu'un SGP-41 est détecté
- Afficher l'indice NOx — ajouté dynamiquement lorsqu'un SGP-41 est détecté
- Prise en charge de plusieurs emplacements de capteurs : deux emplacements physiques (SENSOR 1 et SENSOR 2)
  sont détectés automatiquement. Les capteurs de l'emplacement 2+ obtiennent des sous-capacités
  (par ex. « Température 2 », « Humidité 2 »).

Installation :
1. Ajoutez l'appareil Open AIR Mini dans Homey
2. Sélectionnez votre appareil dans la liste découverte, ou entrez l'adresse IP manuellement
3. Entrez votre clé de chiffrement ESPHome ou votre mot de passe (si configuré)
4. L'appareil sera ajouté à votre Homey

Testé avec :
- ESPHome 2023.6.5 : fonctionnel (mot de passe, clé de chiffrement, ou les deux)
- ESPHome 2026.1.4 : fonctionnel (clé de chiffrement uniquement ; l'authentification par mot de passe a été supprimée dans ESPHome 2026.1.0)
- Carte Open AIR Mini v1.4.1
- Capteur Température/Humidité : SHT-20 (SHT2x) dans l'emplacement 1 — testé et confirmé fonctionnel
- Seules les configurations à capteur unique (emplacement 1) ont été testées jusqu'à présent.
  La configuration à deux capteurs (emplacement 1 + emplacement 2) est implémentée mais pas encore testée avec du matériel réel.

Pris en charge mais pas encore testé (capteurs non disponibles) :
- SCD-40 : capteur CO2, Température, Humidité — implémenté, non testé
- SGP-41 : capteur Indice COV et Indice NOx — implémenté, non testé
- Senseair S8 : capteur CO2 — implémenté, non testé
- SHT-31 : capteur Température/Humidité — implémenté, non testé
- SHT-4X : capteur Température/Humidité — implémenté, non testé
- Sous-capacités de l'emplacement 2 (par ex. « Température 2 ») — implémenté, non testé avec du matériel

Remarque : ESPHome 2026.x a supprimé l'authentification par mot de passe API. Seule la clé de
chiffrement est prise en charge pour ESPHome 2026.x et versions ultérieures. L'application détecte
automatiquement la version ESPHome et utilise la bibliothèque de protocole appropriée.

Non pris en charge :
- Open AIR Valve n'est actuellement pas pris en charge et son développement n'est pas prévu.

Prérequis :
- Appareil Open AIR Mini avec firmware ESPHome
- L'appareil doit être sur le même réseau que votre Homey

Pour plus d'informations sur Open AIR Mini, visitez : https://github.com/RemingtonDev/Homey-Open-AIR
