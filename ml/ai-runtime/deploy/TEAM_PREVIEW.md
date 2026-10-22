# Brancher les vrais logs avant la validation finale

## Objectif et périmètre

Le Compose DEV inclut désormais les API `detector` et `assistant` ainsi que le
worker `incident-preview`. Suivre [AI_STARTUP.md](AI_STARTUP.md) pour le lancer.
`compose.team-preview.yaml` fournit le checker et un worker séparé facultatif :
ne pas lancer ce dernier si le worker DEV est actif. Ils calculent les anomalies
sans transmettre d'incident à la remédiation en mode preview.
Le modèle et son seuil gardent leur statut provisoire.

Le checker teste les connexions directes, les protections 401, un vrai jeton
`svc-dashboard`, la lecture du modèle et des observations, puis les logs auth.
Un test RAG réel est optionnel. Une connexion réussie ne valide pas la qualité du
ML, la confiance dans l'IP client, le routage WAF ni le blocage effectif.

## Où lancer ces commandes

**Sur le PC qui héberge les piles DEV et INFRA de l'équipe.** Depuis le PC de
Jamal à distance, `localhost` ne permet pas de joindre ces services.
Ce Compose utilise les réseaux Docker internes existants : Loki reste non exposé.

Prérequis :

- Récupérer cette mise à jour dans le dépôt de l'équipe.
- Piles INFRA et DEV déjà démarrées, services `auth`, `remediation`, `detector`,
  `assistant`, `loki` et `promtail` disponibles.
- Modèle et seuil dans `ml/ai-runtime/models`, corpus dans `data/knowledge_base`.
- Réseaux `resilience-alpha_backend`, `resilience-alpha_monitoring` et volume
  `resilience-alpha_ai_detector_storage` déjà créés par ces piles.
- `infra/compose/.env` est le fichier réellement utilisé pour les comptes de service.
  `SVC_DASHBOARD_SECRET` doit correspondre à la valeur enregistrée dans auth.

Ne pas lancer plusieurs workers qui écrivent le même historique. Le présent
worker remplace, sur cette pile, tout observer ML de laboratoire déjà raccordé
à ce même volume. Les services DEV restent gérés par leur propre Compose.

## 1. Construire et vérifier

PowerShell, depuis la racine du dépôt équipe :

```powershell
cd ml/ai-runtime
$teamCompose = @('--env-file', '../../infra/compose/.env', '-f', 'deploy/compose.team-preview.yaml')
docker compose @teamCompose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Configuration Compose invalide' }
docker compose @teamCompose build ai-preview
if ($LASTEXITCODE -ne 0) { throw 'Construction image echouee' }
docker compose @teamCompose run --rm --no-deps ai-check
```

Les rapports affichent `pass`, `fail`, `pending` ou `info`. Un rapport sans échec
peut encore avoir des éléments `pending` (aucun login récent, secret absent ou
IP attaquante inconnue). Le code de sortie vaut 1 si un contrôle échoue.
Les jetons et secrets ne sont ni affichés ni exportés.

Si les logs sont vides, effectuer une connexion normale sur la plateforme,
attendre la collecte Promtail, puis relancer. La requête `{container=~"auth(-2)?"}`
correspond au nom du conteneur et au label créés par la configuration Promtail
du dépôt. Si l'infra change ce label, adapter les deux occurrences dans le Compose.

Les préfixes `/detector` et `/assistant` restent inclus dans les appels.
Les tests directs ne prouvent pas que les mêmes routes passent par le WAF.

## 2. Alimenter le dashboard en preview

```powershell
docker compose @teamCompose up -d --no-build ai-preview
docker compose @teamCompose logs --tail 30 ai-preview
```

Résultat attendu : `mode: preview`, collecte d'événements, `delivery.enabled: false`.
Le worker lit toutes les 5 secondes et calcule des fenêtres de 60 secondes.
Il écrit `/app/.storage/observations.sqlite` dans le même volume que l'API
`detector`. Vérifier ensuite les observations dans le dashboard ou relancer le
checker. Des fenêtres qui se chevauchent ne sont pas des attaques indépendantes.

Arrêt du seul worker ajouté :

```powershell
docker compose @teamCompose stop ai-preview
```

## 3. Exporter les vrais logs pour Jamal

Après du trafic normal puis le scénario d'attaque autorisé, noter les horaires
avec fuseau et l'IP du PC Attaquant. Lancer immédiatement :

```powershell
docker compose @teamCompose run --rm --no-deps ai-check python -m resilience_alpha_ai.anomaly_detection.team_check --lookback-seconds 600 --export-dir /app/.storage/exports
docker cp detector:/app/.storage/exports ./team-ai-exports
```

Envoyer à Jamal le nouveau sous-dossier `team-auth-...` contenant
`loki_snapshot.json` et `capture.json`, avec les horaires normal/attaque et l'IP
attendue. Les exports contiennent des logs applicatifs : les transmettre dans
l'espace de travail de l'équipe, sans les committer.
Un export atteignant la limite de 5000 lignes est refusé plutôt que tronqué :
réduire la période et faire plusieurs exports.

Option : ajouter `--expected-attacker-ip ADRESSE_REELLE` à la commande (remplacer
ADRESSE_REELLE par l'IP connue). Le checker confirme uniquement sa présence.
La provenance de l'IP doit encore être vérifiée avec la configuration WAF/auth.

## 4. Tester le RAG avec le vrai jeton

```powershell
docker compose @teamCompose run --rm --no-deps ai-check python -m resilience_alpha_ai.anomaly_detection.team_check --question "Quelles technologies sont imposees pour l'assistant RAG local et quelle est la taille maximale du modele ?"
```

Ce test peut prendre plusieurs minutes au premier chargement. Lire la réponse et
ses sources dans `rag_manual_review`. Un refus reste une réponse HTTP valide :
vérifier séparément une question documentée et une question sans réponse.

## Conditions avant le mode deliver

- Évaluer les fenêtres normales et d'attaque étiquetées de la vraie plateforme.
- Confirmer la provenance de l'IP attaquante ; ne pas bloquer une passerelle
  Docker, le WAF ou le PC Hôte à sa place.
- Faire confirmer par cyber/infra : volume denylist monté et inclus dans nginx,
  rechargement WAF effectif, et contrôle du refus réel depuis le PC Attaquant.
- Vérifier aussi la continuité des requêtes légitimes et le déblocage/recovery.
- Enregistrer la décision de validation du modèle et du seuil avant un lancement
  deliver. Ne pas changer `status` uniquement pour contourner le contrôle.
- Utiliser une nouvelle base de livraison, jamais la file de preview.

Ce complément n'active pas deliver et ne modifie ni le WAF ni les modèles.

## Validation du complément

Tests locaux : `python -m unittest discover -s tests -p test_team_check.py -v`.
Les tests utilisent des réponses simulées et un serveur HTTP local ; ils ne
contactent pas les services de l'équipe. Les résultats terrain restent à relever.
