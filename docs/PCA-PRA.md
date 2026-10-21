# PCA/PRA — PROJECT RESILIENCE-ALPHA

## Sommaire
- [À retenir en 30 secondes](#à-retenir-en-30-secondes)
- [Cartographie](#cartographie)
- [Matrice de reprise](#matrice-de-reprise)
- [PCA — organisation](#pca--organisation)
- [PRA — procédures](#pra--procédures)
- [Limites assumées et 5 actions prioritaires](#limites-assumées-et-5-actions-prioritaires)
- [Points à valider par l'équipe](#points-à-valider-par-léquipe)
- [Glossaire](#glossaire)
- [Matrice de traçabilité](#matrice-de-traçabilité)

## À retenir en 30 secondes

> Plateforme de paiement fictive, données fictives, laboratoire sur un seul PC Hôte Docker Desktop.  
> **[EN PLACE]** MTTR de remédiation de sécurité : ≈ 0,9 s ; bascule d'une base : ≈ 2 s ; RPO des sauvegardes : ≤ 1 h.  
> **[EN PLACE]** Détection du brute force, blocage WAF et transaction canari de preuve.  
> **Risque principal :** compromission d'un compte puis tentative de virement non autorisé.  
> **Limite principale :** la perte du PC Hôte n'est couverte par aucune bascule ; sauvegardes stockées sur le même poste.  
> Le PCA/PRA formalise les décisions de crise, les procédures disponibles, leurs preuves et les écarts à traiter.

## Cartographie

| Composant | Rôle | Dépend de | Redondé ? | Sauvegardé ? |
|---|---|---|---|---|
| `waf` | Point d'entrée unique, routage et blocage IP | Services ciblés, configuration et liste de déni | Non | [à compléter — sauvegarde de la configuration WAF] |
| `auth` | Authentification | `db-auth`, WAF | Oui : `auth-2` | Base `auth` : dump horaire ; clé JWT non sauvegardée |
| `api` | API de paiement | `db-paiement`, WAF | Oui : `api-2` | Base `paiement` : dump horaire |
| `remediation` | Gestion des incidents et orchestration de remédiation | Base `remediation`, WAF, services `auth` et `api` | [à valider — aucune instance secondaire mentionnée] | Base `remediation` : dump horaire |
| `log-detector` | Détection des échecs de connexion sans ML | Base `auth` (`login_attempts`), endpoint de remédiation | Non | [à compléter — sauvegarde propre du composant non précisée] |
| `front` | Interface de la plateforme | WAF, API et services associés | Oui : `front-2` | [à compléter — sources et configuration à reconstruire depuis le dépôt] |
| `dashboard` | Interface de supervision | Prometheus, Loki et services associés | Oui : `dashboard-2` | [à compléter — sauvegarde propre du composant non précisée] |
| `backoffice` | Interface d'administration | Authentification et services associés | Oui : `backoffice-2` | [à compléter — sauvegarde propre du composant non précisée] |
| `face` | Reconnaissance faciale du back-office | Caméra et intégration du back-office | Non | Visage administrateur non pré-seedé ; ré-enrôlement après chaque reset |
| `db-auth` | Base des données d'authentification | PostgreSQL | Réplique `db-auth-replica` | Dump horaire, rotation de 24 fichiers |
| `db-paiement` | Base des paiements | PostgreSQL | Réplique `db-paiement-replica` | Dump horaire, rotation de 24 fichiers |
| `db-remediation` | Incidents et blocages IP | PostgreSQL | Réplique `db-remediation-replica` | Dump horaire, rotation de 24 fichiers |
| `prometheus` | Collecte des métriques | Cibles instrumentées | Non mentionné | [à compléter — sauvegarde de la configuration non précisée] |
| `loki` | Centralisation des journaux JSON | Services `auth`, `api`, `remediation`, `waf` | Non mentionné | [à compléter — rétention et sauvegarde des journaux non précisées] |
| `grafana` | Dashboards « Securite-WAF-Journaux » et « Remediation » | Prometheus, Loki | Non mentionné | [à compléter — sauvegarde des dashboards non précisée] |
| `mosquitto` | MQTT, notamment pilotage de la LED ESP8266 | Réseau et clients MQTT | Non mentionné | [à compléter — sauvegarde de la configuration non précisée] |

## Matrice de reprise

**Convention :** les valeurs mesurées décrivent le laboratoire, pas des objectifs métier validés. PTMA = période maximale tolérable d'interruption ; RTO = objectif de délai de reprise ; RPO = perte de données maximale tolérable.

| Service / criticité | PTMA | RTO | RPO | Scénario de perte | Procédure | Preuve attendue | Mode dégradé |
|---|---|---|---|---|---|---|---|
| `waf` — critique, point d'entrée unique | [à valider] | [à valider — redémarrage avec coupure de quelques secondes ; cache d'instance morte jusqu'à 5 s et attente possible de 60 s avant bascule] | [à valider — configuration et liste de déni] | Arrêt ou indisponibilité du point d'entrée | P4 ; procédure détaillée [à compléter — commande de reprise du WAF non fournie] | Accès rétabli aux routes attendues et vérification des services | Aucun accès applicatif via le point d'entrée unique pendant la panne |
| `auth` — critique | [à valider] | [à valider — arrêt brutal : environ 1 requête sur 50 échoue, les autres en moins de 70 ms ; ce n'est pas un RTO complet] | Réplique : quasi nulle en panne de primaire ; sauvegarde : ≤ 1 h | Perte d'instance ou de base primaire | P1 pour instance ; P2 pour base ; P3 pour données | Authentification fonctionnelle ; contrôle de réplication si bascule de base | `auth-2` via l'alias réseau ; sinon authentification indisponible |
| `api` — critique | [à valider] | [à valider — arrêt brutal : environ 1 requête sur 50 échoue, les autres en moins de 70 ms] | Réplique : quasi nulle en panne de primaire ; sauvegarde : ≤ 1 h | Perte d'instance ou de base paiement | P1 pour instance ; P2 pour base ; P3 pour données | API à 200 ; transaction canari si procédure de remédiation applicable | `api-2` via l'alias réseau |
| `remediation` — élevée | [à valider] | [à valider] | Réplique : quasi nulle en panne de primaire ; sauvegarde : ≤ 1 h | Perte du service ou de sa base | [à compléter — procédure de reprise du service non fournie] ; P2/P3 pour la base | Incident consultable dans `incidents` ; blocage vérifiable dans `ip_blocks` | Remédiation automatique indisponible ; traitement manuel [à définir] |
| `db-auth` — critique | [à valider] | Bascule mesurée : ≈ 2 s ; objectif RTO [à valider] | Réplication : perte quasi nulle annoncée ; dump : ≤ 1 h | Perte de la primaire | P2 ; commande avec `base=auth` | API/authentification rétablie ; état de réplication contrôlé | Réplique promue manuellement |
| `db-paiement` — critique | [à valider] | Bascule mesurée : ≈ 2 s ; objectif RTO [à valider] | Réplication : perte quasi nulle annoncée ; dump : ≤ 1 h | Perte de la primaire | P2 ; commande avec `base=paiement` | API à 200 ; état de réplication contrôlé | Réplique promue manuellement |
| `db-remediation` — élevée | [à valider] | Bascule mesurée : ≈ 2 s ; objectif RTO [à valider] | Réplication : perte quasi nulle annoncée ; dump : ≤ 1 h | Perte de la primaire | P2 ; commande avec `base=remediation` | Tables `incidents` et `ip_blocks` accessibles | Réplique promue manuellement |

## PCA — organisation

### Rôles en crise

| Rôle | Responsabilité |
|---|---|
| Chef de crise | Qualifie l'incident, fixe la priorité et autorise la sortie de crise. |
| Pilote technique | Coordonne les opérations de bascule, restauration ou reconstruction. |
| Support technique | Exécute les commandes documentées et collecte les preuves. |
| Communication | Diffuse l'alerte, les impacts confirmés et les mises à jour. |

### Escalade en 3 étapes

1. **[CONÇU, NON TESTÉ] Détection et qualification :** confirmer l'impact à partir des journaux, métriques et tables disponibles.
2. **[CONÇU, NON TESTÉ] Décision et action :** choisir P1 à P5 selon le scénario ; éviter toute action susceptible de créer une double primaire.
3. **[CONÇU, NON TESTÉ] Vérification et clôture :** contrôler le service, les données et la preuve attendue ; consigner l'écart restant.

### Scénarios prioritaires

| Scénario | Déclencheur | Impact | Procédure | Critère de sortie |
|---|---|---|---|---|
| Perte d'une base primaire | Primaire indisponible ou perte de connexion confirmée | Service dépendant indisponible ou dégradé | **[EN PLACE]** P2 : playbook `bascule-db.yml` ; vérifier la réplication avant la bascule | Service rétabli et état de réplication vérifié ; retour à la normale effectué selon la procédure |
| Compromission d'un compte | Brute force détecté ou accès frauduleux suspecté | Accès non autorisé et tentative de virement | **[EN PLACE]** Détection `log-detector`, incident, blocage IP WAF, canari de reprise ; vérifier l'autorisation serveur du virement | IP bloquée, incident `RESOLVED` et canari réussi ; tentative de virement non autorisé rejetée |
| Perte du PC Hôte | Poste indisponible ou stockage perdu | Perte de l'ensemble du laboratoire et des sauvegardes locales | **[CONÇU, NON TESTÉ]** P5 : reconstruction depuis le dépôt ; étapes et commandes détaillées [à compléter] | Piles reconstruites et tests de santé réussis ; données non récupérables identifiées |

### Message type d'alerte

> **[CONÇU, NON TESTÉ] Alerte PCA/PRA — RESILIENCE-ALPHA**  
> Scénario : [perte de base / compromission de compte / perte du PC Hôte].  
> Détection : [heure et preuve].  
> Services et données impactés : [à compléter].  
> Procédure déclenchée : [P1–P5]. Pilote : [à compléter].  
> Prochaine mise à jour : [à compléter]. Statut : [en cours / service rétabli / clôturé].

## PRA — procédures

### P1 — Perte d'une instance applicative

- **Objectif :** rétablir le service sans interrompre durablement le routage vers l'instance secondaire.
- **[EN PLACE] Commandes fournies pour `api` :**
  ```bash
  docker stop api
  docker start api
  ```
- **Résultat attendu :** `api-2` continue de servir via l'alias réseau ; après redémarrage, `api` revient.
- **Preuve / fin :** [à compléter — commande ou test exact de validation après redémarrage non fourni]. Pour `auth`, aucune commande équivalente n'est fournie.

### P2 — Perte d'une base primaire : bascule et retour à la normale

- **Objectif :** promouvoir la réplique, maintenir le service puis rétablir la topologie primaire/réplique.
- **[EN PLACE] Bascule — remplacer `paiement` par `auth` ou `remediation` selon la base :**
  ```bash
  docker compose -f docker-compose.infra.yml exec ansible ansible-playbook playbooks/bascule-db.yml -e base=paiement
  ```
- **[EN PLACE] Contrôle de réplication :**
  ```bash
  docker exec db-paiement psql -U api_user -d payments -c "select client_addr, state, replay_lag from pg_stat_replication;"
  ```
- **Résultat attendu :** bascule mesurée à ≈ 2 s ; l'API repasse à 200 sans redémarrage.
- **Retour à la normale :** **[EN PLACE]** recopie du volume de la réplique promue vers celui de la primaire, puis recréation de la réplique. Commandes exactes : [à compléter — non fournies].
- **Critère de fin :** service vérifié, topologie primaire/réplique rétablie et état de réplication contrôlé.
- **Précaution :** ne pas relancer `docker compose up -d` avant le retour à la normale ; risque de double primaire.

### P3 — Perte ou corruption de données : restauration

- **Objectif :** restaurer une base à partir d'un dump horaire.
- **[EN PLACE] Commande fournie pour la base paiement :**
  ```bash
  docker exec -i db-paiement pg_restore -U api_user -d payments --clean --if-exists < redondance/backups/paiement/paiement-AAAAMMJJTHHMMSSZ.dump
  ```
- **Résultat attendu :** données du dump restaurées dans la base cible.
- **Preuve / fin :** [à compléter — contrôles d'intégrité et tests applicatifs après restauration non précisés].
- **Limites :** RPO des sauvegardes ≤ 1 h ; rotation de 24 fichiers ; sauvegardes conservées sur le PC Hôte.

### P4 — Perte du WAF

- **Objectif :** rétablir le point d'entrée unique.
- **Procédure :** [à compléter — commande exacte de redémarrage ou de reconstruction du WAF non fournie].
- **Résultat attendu :** [à compléter — procédure et preuve de retour du routage non précisées].
- **Critère de fin :** [à compléter — test des routes `/auth/*`, `/api/*`, `/remediation/*`, `/`, `:8081` et `:8082` à définir].
- **Limite :** le WAF est un point de défaillance unique ; son redémarrage peut provoquer une coupure de quelques secondes.

### P5 — Perte du PC Hôte

- **Objectif :** reconstruire le laboratoire depuis le dépôt sur un poste disponible.
- **[CONÇU, NON TESTÉ] Éléments à traiter :** images, `.env`, clé JWT, seeds `auth` puis `api`, ordre des piles Docker Compose : [à compléter — commandes exactes et ordre détaillé non fournis].
- **Résultat attendu :** [à compléter — critères de validation après reconstruction non définis].
- **Éléments non récupérables selon l'état décrit :** journaux présents uniquement sur le poste perdu ; visages non pré-seedés et à ré-enrôler après reset ; sessions. **Clé JWT :** fichier sur l'hôte, non sauvegardé ; régénération ou réinjection à définir.
- **Limite :** aucune bascule pour la perte du poste ; aucune sauvegarde hors site. La reconstruction complète n'est pas démontrée.

## Limites assumées et 5 actions prioritaires

| Limite | Impact | Action | Effort | Priorité |
|---|---|---|---|---|
| PC Hôte unique et aucune sauvegarde hors site | Perte simultanée de l'environnement et des dumps | **[À FAIRE]** Définir et tester une reconstruction sur un autre poste ; étudier une copie hors site | L | P1 |
| WAF point de défaillance unique | Perte du point d'entrée de toute la plateforme | **[À FAIRE]** Définir une procédure de reprise testable et mesurer l'indisponibilité | M | P1 |
| Clé JWT non sauvegardée | Sessions/tokens existants potentiellement invalides après reconstruction | **[À FAIRE]** Définir le stockage, la sauvegarde sécurisée et la rotation de la clé | M | P1 |
| Procédures de bascule et restauration incomplètes côté commandes/preuves | Erreur opérationnelle ou double primaire | **[À FAIRE]** Documenter et tester le retour à la normale et les contrôles post-restauration | M | P1 |
| Détecteur ML non activable ; `face`, `detector`, `assistant` non redondés | Détection ML absente ; composants non repris automatiquement | **[À FAIRE]** Documenter la détection réellement active et définir les objectifs de reprise des composants non redondés | M | P2 |

## Points à valider par l'équipe

- [à compléter — quelle PTMA métier est acceptée pour chaque service critique ?]
- [à compléter — quel RTO cible est accepté par service, distinct des temps mesurés ?]
- [à compléter — quel RPO métier est accepté pour chaque base ?]
- [à compléter — les ≈ 2 s de bascule ont-elles été mesurées pour les trois bases ?]
- [à compléter — quelles commandes exactes permettent le retour à la normale après chaque bascule ?]
- [à compléter — quelles commandes exactes redémarrent ou reconstruisent le WAF ?]
- [à compléter — quels contrôles prouvent l'intégrité après `pg_restore` ?]
- [à compléter — quelles commandes et étapes reconstruisent les trois piles sur un autre PC ?]
- [à compléter — comment la clé JWT est-elle régénérée ou réinjectée et comment les sessions sont-elles gérées ?]
- [à compléter — quelle est la rétention des journaux et existe-t-il une sauvegarde ?]
- [à compléter — quels tests de reprise sont exécutés périodiquement et qui les valide ?]
- [à compléter — quel mode manuel est prévu si `remediation` ou `log-detector` est indisponible ?]

## Glossaire

| Terme | Définition |
|---|---|
| PCA | Plan de continuité d'activité : organisation pour maintenir ou gérer l'activité pendant une interruption. |
| PRA | Plan de reprise d'activité : procédures de rétablissement après interruption. |
| PPR | Plan Particulier de Reprise, référentiel institutionnel mentionné dans le cadrage. |
| PTMA | Période maximale tolérable d'interruption d'une activité ou d'un service. |
| RTO | *Recovery Time Objective* : délai cible de rétablissement. |
| RPO | *Recovery Point Objective* : perte de données maximale tolérable exprimée en durée. |
| Canari | Transaction synthétique utilisée ici pour prouver la reprise. |
| Alias réseau | Nom réseau partagé permettant d'atteindre une instance disponible. |
| Réplique | Copie d'une base maintenue par réplication pour permettre une bascule. |
| HUP | Signal Unix utilisé ici pour demander au WAF de recharger sa configuration. |

## Matrice de traçabilité

| Objectif EBIOS RM | Référence | Mesure en place | Preuve | Écart |
|---|---|---|---|---|
| ER1 — Accès frauduleux à un compte | ISO/IEC 27001:2022 A.5.29/A.5.30 ; NIS2 art. 21 (référence de bonnes pratiques uniquement) | **[EN PLACE]** Détection `login_attempts`, blocage WAF après seuil | Incident de remédiation et journaux JSON | Face non redondé ; tests de reprise à documenter |
| ER2 — Virement non autorisé | ISO 22301:2019, clause 8 ; ISO/IEC 27001:2022 A.5.30 | **[EN PLACE]** Contrôle d'autorisation serveur mentionné dans l'analyse EBIOS RM ; canari | Le canari `X-Synthetic` prouve la reprise, pas à lui seul le rejet d'un virement frauduleux | Test explicite de rejet d'un virement non autorisé [à compléter] |
| ER3 — Indisponibilité de l'authentification | ISO 22301:2019, clause 8 ; ISO 22313:2020 | **[EN PLACE]** `auth-2`, réplique DB, bascule manuelle et dumps horaires | Bascule DB ≈ 2 s ; arrêt d'instance : ≈ 1 requête sur 50 échoue, autres < 70 ms | PTMA/RTO non validés ; perte du PC Hôte non couverte |
| ER4 — Altération/absence des journaux | ISO/IEC 27001:2022 A.5.29 ; ISO/IEC 27035:2016 | **[EN PLACE]** Loki reçoit les journaux JSON de `auth`, `api`, `remediation`, `waf` | Dashboards Grafana « Securite-WAF-Journaux » et « Remediation » | Sauvegarde hors site, rétention et reprise des journaux à valider |

### Références méthodologiques

- **ANSSI**, *EBIOS Risk Manager — Guide méthodologique v1.5*.
- **ANSSI**, METEOR — guide d'analyse d'impact métier. Titre/URL exacts : [À VÉRIFIER].
- **ANSSI**, *Plan Particulier de Reprise (PPR)*. Titre/URL exacts : [À VÉRIFIER].
- **ANSSI**, *Principes de conception d'un système d'information résilient*. Titre/URL exacts : [À VÉRIFIER].
- **ISO**, ISO 22301:2019, clause 8 ; ISO 22313:2020 ; ISO/TS 22318:2021.
- **ISO/IEC**, ISO/IEC 27001:2022, A.5.29 et A.5.30 ; ISO/IEC 27035:2016.
- **Union européenne**, directive (UE) 2022/2555, article 21 — référence de bonnes pratiques uniquement ; le laboratoire est hors champ NIS2.

**Statut :** aucune conformité normative n'est revendiquée. Le document décrit les mesures indiquées en place, les preuves annoncées et les écarts à valider.
