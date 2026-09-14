# Trafic aérien quotidien — Val-d’Oise

Carte interactive DDT 95 des décollages et atterrissages ADS-B observés pendant une journée complète au-dessus du Val-d’Oise. Première journée publiée : 10 septembre 2026.

## Fonctionnement

- Les archives historiques mondiales d’ADSB.lol sont parcourues en flux, sans être stockées dans le dépôt.
- Seules les trajectoires qui croisent une commune du Val-d’Oise et sont associées à un décollage ou un atterrissage sur un aérodrome du département sont conservées.
- La carte s’ouvre sur un créneau de 30 minutes pour rester lisible ; le cumul journalier reste disponible.
- L’animation avance minute par minute, avec trois vitesses, quatre amplitudes de lecture et des raccourcis horaires.
- Un mode temps réel distinct affiche les appareils à basse ou moyenne altitude autour des aérodromes, avec une qualification indicative montée/descente actualisée toutes les 30 secondes.
- Les avions sont orientés selon le cap ADS-B, avec les décollages en bleu et les atterrissages en rouge.
- Au clic, l’itinéraire indicatif associé à l’indicatif de vol est recherché dans ADSBDB : provenance, destination et compagnie.
- Le PEB de Paris–Charles-de-Gaulle peut être superposé par zone A, B, C ou D pour comparer les trajectoires au zonage réglementaire approuvé le 3 avril 2007.
- Les fichiers web quotidiens sont compressés et les 14 derniers jours restent disponibles.
- Le traitement est lancé chaque matin après la publication de l’archive de la veille.

La carte représente des observations ADS-B. Elle ne constitue ni une mesure de bruit, ni une donnée exhaustive. Le PEB est une couche réglementaire d’urbanisme indépendante des observations aériennes.

## Source et licence

Données aériennes : [ADSB.lol](https://www.adsb.lol/docs/open-data/historical/), licence ODbL 1.0. PEB : DGAC, zones du PEB de Paris–Charles-de-Gaulle. Fond OpenStreetMap. Limites administratives DDT 95.
