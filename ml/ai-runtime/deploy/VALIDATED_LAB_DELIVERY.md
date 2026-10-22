# Livraison ML du laboratoire — 22 octobre 2026

Les deux fichiers livrés sont maintenant validés **pour le scénario contrôlé du workshop**. Le modèle conserve ses arbres et son origine d'entraînement synthétique. Ce n'est pas une qualification de production.

## Vérifications réalisées

L'export Loki du 22 octobre est analysé intégralement, messages de démarrage inclus. Trois fenêtres de faible activité servent au calibrage ; seize autres fenêtres servent aux contrôles d'acceptation : huit rafales détectées, huit fenêtres de faible activité ou de récupération sans alerte. Ces catégories sont des attentes de scénario, pas des annotations indépendantes d'incidents. Une fenêtre de faible activité après une attaque peut appartenir à la récupération.

L'ancien seuil 0,62355 signalait un échec isolé. Le nouveau seuil 0,7403054243227413 est calculé uniquement sur les trois fenêtres de calibrage (maximum + 0,01), avant les contrôles séparés. Les métriques de ce petit échantillon ne sont pas une estimation de performance générale.

Le .joblib et le JSON ont `status: validated`, le JSON référence l'empreinte SHA-256 exacte du nouveau binaire. ARTIFACT_MANIFEST.json est actualisé. Le garde-fou demeure actif pour tout autre modèle provisoire. Une nouvelle exécution de train.py crée volontairement un prototype à revalider.

Les tests couvrent le vrai estimateur livré, les messages de démarrage, les erreurs de logs, l'authentification du client, l'envoi automatique d'un incident, les preuves, la déduplication après redémarrage et les reprises après panne. Les API de remédiation sont simulées : aucun WAF distant n'a été exécuté par ces tests.

## Sur le PC Hôte de l'équipe

Après fusion, récupérer main depuis la racine du dépôt, puis revenir dans infra/compose. Utiliser le même projet Compose et les mêmes options de pile que pour vos services déjà lancés. Pour la pile DEV standard :

```powershell
git switch main
git pull --ff-only
cd infra/compose
docker compose -f docker-compose.dev.yml -f docker-compose.ml-delivery.yml build detector incident-preview
```

Si la construction réussit, arrêter le détecteur à règle fixe pour que la preuve provienne uniquement du ML, puis lancer le worker :

```powershell
docker compose -f docker-compose.dev.yml stop log-detector
docker compose -f docker-compose.dev.yml -f docker-compose.ml-delivery.yml up -d --no-deps detector incident-preview
docker logs incident-preview --tail 30
```

La configuration utilise une nouvelle file `incident_delivery_v2.sqlite` afin de ne pas reprendre d'anciens incidents en attente. Ne supprimer aucun volume. Les observations restent partagées avec l'API du dashboard.

Les secrets SVC_DETECTOR_SECRET de votre .env doivent correspondre au service auth. Aucun secret ne figure dans cette livraison.

## Test réseau indispensable

Depuis un PC Attaquant distinct, effectuer le scénario autorisé sur la plateforme laboratoire. Vérifier l'IP effectivement journalisée avant la rafale. Sans clic de blocage : obtenir un incident BRUTE_FORCE, un envoi accepté par la remédiation, puis une requête refusée par le WAF ; vérifier simultanément qu'un autre PC légitime garde accès.

Le worker observe mais ne transmet pas les anomalies inconnues, les adresses loopback et les passerelles partagées connues (dont 192.168.166.1). Compléter DETECTOR_PROTECTED_IPS dans le .env si votre réseau utilise d'autres adresses partagées. Ne pas retirer ces protections pour contourner une mauvaise attribution IP. Le champ `skipped` du rapport permet de constater cette exclusion.

Le fichier reçu contient des adresses loopback, de passerelle et de documentation : il permet une évaluation de détection, pas une preuve de blocage d'un vrai PC attaquant.

## Reproduire l'évaluation (sans envoi)

Depuis ml/ai-runtime avec l'environnement Python du projet :

```powershell
python scripts/validate_lab_release.py --input CHEMIN_VERS_EXPORT_LOKI_JSON
python -m unittest discover -s tests -v
```

L'empreinte du fichier d'entrée est contrôlée. `--publish` ne réexporte les fichiers qu'après réussite de l'acceptation. Rapport : reports/validation/ml_lab_release_20261022.json.

Le RAG et la reconnaissance faciale ne sont pas modifiés par cette livraison. Leur fonctionnement doit être vérifié séparément sur la plateforme.
