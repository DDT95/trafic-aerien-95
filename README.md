# Trafic aérien quotidien — Val-d’Oise

Carte interactive DDT 95 des décollages et atterrissages ADS-B observés pendant une journée complète au-dessus du Val-d’Oise. Première journée publiée : 10 septembre 2026.

## Fonctionnement

- Les archives historiques mondiales d’ADSB.lol sont parcourues en flux, sans être stockées dans le dépôt.
- Seules les trajectoires qui croisent une commune du Val-d’Oise et sont associées à un décollage ou un atterrissage sur un aérodrome du département sont conservées.
- La carte s’ouvre sur un créneau de 30 minutes pour rester lisible ; le cumul journalier reste disponible.
- Les avions sont orientés selon le cap ADS-B, avec les décollages en bleu et les atterrissages en rouge.
- Au clic, l’itinéraire indicatif associé à l’indicatif de vol est recherché dans ADSBDB : provenance, destination et compagnie.
- Les fichiers web quotidiens sont compressés et les 14 derniers jours restent disponibles.
- Le traitement est lancé chaque matin après la publication de l’archive de la veille.

La carte représente des observations ADS-B. Elle ne constitue ni une mesure de bruit, ni une donnée exhaustive ou réglementaire.

## Source et licence

Données aériennes : [ADSB.lol](https://www.adsb.lol/docs/open-data/historical/), licence ODbL 1.0. Fond OpenStreetMap. Limites administratives DDT 95.
