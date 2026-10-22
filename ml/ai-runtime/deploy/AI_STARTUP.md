# Démarrage et activation de l'IA sur la pile équipe

## Ce qui a été corrigé

- `incident-preview` calculait les anomalies dans sa file privée, sans alimenter
  `observations.sqlite`, le fichier lu par l'API `detector`. Le worker monte
  maintenant le volume des observations et utilise `--observation-db`.
- La requête Loki couvre `auth` et sa réplique `auth-2` si la redondance est utilisée.
- Un seuil explicitement validé était toujours chargé comme provisoire. Le loader
  conserve désormais son statut, sans changer le statut du modèle. Les statuts
  inconnus sont refusés avant d'ouvrir la file de livraison.

Les routes WAF `/assistant/` et `/detector/` existent déjà sur le port dashboard
dans `infra/compose/config/waf/default.conf.template`. Elles gardent les préfixes.

## Démarrer le ML et le RAG

À exécuter **sur le PC Hôte de l'équipe**, depuis la racine du dépôt. Prérequis :
infra et DEV déjà démarrés ; modèle et seuil dans `ml/ai-runtime/models` ; corpus
dans `ml/ai-runtime/data/knowledge_base` ; Ollama accessible depuis `assistant`,
avec `qwen2.5:3b` et `embeddinggemma:300m` téléchargés.

```powershell
cd infra/compose
docker compose --env-file .env -f docker-compose.dev.yml config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Configuration Compose invalide' }
docker compose --env-file .env -f docker-compose.dev.yml up -d --build --no-deps detector assistant incident-preview
if ($LASTEXITCODE -ne 0) { throw 'Demarrage IA echoue' }
docker compose --env-file .env -f docker-compose.dev.yml logs --tail 40 incident-preview
```

`mode: preview` et `delivery.enabled: false` signifient que le ML analyse les logs
et persiste les résultats, mais ne demande pas de blocage. Faire une connexion sur
la plateforme et vérifier les événements puis l'historique de `/detector/v1/anomalies`
avec un jeton opérateur/dashboard. Une fenêtre sans login ne produit pas de ligne par IP.

Ne pas lancer un deuxième observer sur le même historique. Si le service séparé
`ai-preview` a été lancé auparavant, l'arrêter depuis `ml/ai-runtime` :

```powershell
docker compose --env-file ../../infra/compose/.env -f deploy/compose.team-preview.yaml stop ai-preview
```

## Vérifier les connexions et une vraie réponse RAG

Depuis `ml/ai-runtime`, en utilisant le `.env` réel de la pile équipe :

```powershell
$check = @('--env-file', '../../infra/compose/.env', '-f', 'deploy/compose.team-preview.yaml')
docker compose @check build ai-check
if ($LASTEXITCODE -ne 0) { throw 'Construction du checker echouee' }
docker compose @check run --rm --no-deps ai-check python -m resilience_alpha_ai.anomaly_detection.team_check --question "Quelles technologies sont imposees pour l'assistant RAG local et quelle est la taille maximale du modele ?"
```

Le checker demande un jeton avec `SVC_DASHBOARD_SECRET`, teste les API et lit Loki.
Examiner les contrôles `fail`/`pending` et la réponse dans `rag_manual_review`.
Un healthcheck vert prouve uniquement que l'API répond, pas qu'Ollama est disponible
ou que le corpus est présent. Tester également la réponse depuis le dashboard via WAF.

## Pourquoi le ML n'envoie pas encore de blocage

Le modèle livré est `prototype_not_validated` ; son seuil est
`provisional_not_validated`. L'envoi requiert un modèle ET un seuil validés,
avec une évaluation et une décision de validation documentées. Modifier ces
statuts uniquement pour débloquer le démarrage ne constitue pas une validation.
Le seuil doit correspondre au SHA-256 du fichier de modèle effectivement livré.

Le replay du 21 octobre distingue les deux phases de l'export, mais il ne contient
qu'un petit échantillon ; l'IP `192.168.166.1` est une passerelle Docker commune.
Confirmer la provenance de l'IP sur un vrai PC Attaquant, la détection, le blocage
effectif, la continuité d'un client légitime et la reprise avant la livraison automatique.

## Livraison contrôlée, après validation effective

Un overlay est fourni ; le Compose DEV seul reste en preview. Il configure les
endpoints internes, le compte `svc-detector` et une nouvelle base de livraison.
Les artefacts actuels sont encore refusés par les contrôles.

Depuis `infra/compose`, après livraison d'artefacts réellement validés :

```powershell
$delivery = @('--env-file', '.env', '-f', 'docker-compose.dev.yml', '-f', 'docker-compose.ml-delivery.yml')
docker compose @delivery config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Configuration de livraison invalide' }
docker compose @delivery build incident-preview
if ($LASTEXITCODE -ne 0) { throw 'Construction du worker echouee' }
# Verifie les deux statuts, sans transmettre d incident :
docker compose @delivery run --rm --no-deps incident-preview python -c "from pathlib import Path; from resilience_alpha_ai.anomaly_detection.model_loader import load_model, require_validated_delivery; require_validated_delivery(load_model(Path('/app/models/auth_isolation_forest_synthetic.joblib'),Path('/app/models/auth_threshold_candidate.json'))); print('Artefacts valides pour la livraison')"
if ($LASTEXITCODE -ne 0) { throw 'Artefacts non valides : rester en preview' }
# Choisir un seul emetteur pour le test ML ; eviter les bans doubles du detecteur a regles.
docker compose --env-file .env -f docker-compose.dev.yml stop log-detector
if ($LASTEXITCODE -ne 0) { throw 'Arret du detecteur a regles echoue' }
docker compose @delivery up -d --no-build --no-deps incident-preview
```

Le nom historique du service reste `incident-preview`, mais l'overlay remplace
sa commande par `--mode deliver`. Vérifier ses logs et l'effet WAF séparément.
Une acceptation API ne prouve pas à elle seule que le service a été rétabli.
La clôture des épisodes après reprise n'est pas encore raccordée ; ne pas
présenter le réarmement automatique pour plusieurs attaques successives comme validé.

## Autre détecteur déjà ajouté par l'équipe

`ml/log-detector` compte les échecs en base auth et envoie un score fixe `0.95`.
Ses blocages reposent sur une règle ; ils ne prouvent pas une décision du modèle ML.
Relever quel worker a émis l'incident pendant la démonstration.
