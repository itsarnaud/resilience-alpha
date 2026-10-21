# Analyse de risques EBIOS RM — RESILIENCE-ALPHA

**Version :** 2.0 — mise à jour selon le contexte technique et le PCA/PRA  
**Périmètre :** laboratoire pédagogique de paiement fictif, données synthétiques, trois piles Docker Compose sur un seul PC Hôte Windows/Docker Desktop.  
**Statut :** cotations de travail ; les niveaux de vraisemblance et les risques résiduels restent à valider par les tests.

## Sommaire

- [Atelier 1 — Cadrage et socle de sécurité](#atelier-1--cadrage-et-socle-de-sécurité)
- [Atelier 2 — Sources de risque](#atelier-2--sources-de-risque)
- [Atelier 3 — Scénarios stratégiques](#atelier-3--scénarios-stratégiques)
- [Atelier 4 — Scénarios opérationnels et cotation](#atelier-4--scénarios-opérationnels-et-cotation)
- [Atelier 5 — Traitement du risque](#atelier-5--traitement-du-risque)
- [À retenir](#à-retenir)
- [Références](#références)

## Atelier 1 — Cadrage et socle de sécurité

### 1.1 Périmètre

La plateforme simule des paiements avec des données fictives. Elle comprend trois piles Compose : **infra** (Prometheus, Loki, Grafana, MQTT, Ansible), **dev** (authentification, API, remédiation, interfaces React, reconnaissance faciale, détecteur de journaux, bases PostgreSQL) et **cyber** (WAF Nginx + ModSecurity). Le WAF constitue le point d'entrée applicatif unique. La supervision est exposée sur `:8081` et le back-office sur `:8082`.

Le PC attaquant est distinct du PC Hôte et relié au point d'accès Wi-Fi du groupe, dans le cadre isolé du workshop. Aucun système ni aucune donnée réels ne sont dans le périmètre.

### 1.2 Valeurs métier et biens supports

| Valeur métier | Besoin de sécurité | Biens supports principaux |
|---|---|---|
| Authentification | Confidentialité des identifiants et accès réservé aux utilisateurs autorisés | `auth`, `db-auth`, front, WAF, clé JWT |
| Transactions fictives | Intégrité et autorisation de chaque opération | `api`, `db-paiement`, WAF |
| Disponibilité du service | Maintien ou rétablissement des fonctions critiques | WAF, `auth`, `api`, bases et répliques |
| Continuité et réponse à incident | Détecter, contenir, vérifier et reprendre | `log-detector`, `remediation`, Loki, Prometheus, Grafana, Ansible, sauvegardes |
| Administration | Accès réservé aux personnes autorisées | Back-office, reconnaissance faciale, mot de passe, MQTT, ESP8266 |

### 1.3 Événements redoutés

Échelle de gravité de travail de 1 (faible) à 4 (critique), à valider par l'équipe. Elle est adaptée au laboratoire et n'est pas une échelle officielle de l'ANSSI.

| ID | Événement redouté | Conséquence | Gravité initiale |
|---|---|---|---:|
| ER1 | Accès frauduleux à un compte utilisateur | Utilisation non autorisée d'un compte fictif | 3 — Majeur |
| ER2 | Virement fictif non autorisé exécuté | Atteinte à l'intégrité des transactions | 4 — Critique |
| ER3 | Indisponibilité de l'authentification ou du service | Utilisateurs légitimes empêchés de se connecter ou d'effectuer une opération | 2 — Modéré |
| ER4 | Journaux absents ou altérés | Incident difficile à détecter, expliquer ou reconstituer | 3 — Majeur |
| ER5 | Contournement de l'identification biométrique du back-office | Accès administratif non autorisé | 4 — Critique |
| ER6 | Rejet biométrique injustifié d'un utilisateur autorisé | Blocage temporaire de l'accès au back-office | 2 — Modéré |
| ER7 | Modification non autorisée des habilitations ou des fonctions d'administration | Privilèges excessifs et actions non autorisées | 4 — Critique |
| ER8 | État de la LED ESP8266 trompeur ou communication MQTT détournée | Indication erronée de l'état d'authentification | 2 — Modéré |

**Précision :** ER8 concerne l'indicateur. La LED ne doit jamais constituer une preuve ni un mécanisme d'autorisation. L'accès réel doit dépendre des contrôles du back-office.

### 1.4 Socle de sécurité à vérifier

| Domaine | Exigence |
|---|---|
| Authentification et transactions | Chaque virement est autorisé côté serveur ; une connexion réussie ne suffit pas à autoriser une opération. |
| Détection et WAF | Détecter les échecs répétés, appliquer le blocage prévu et vérifier son effet réel. |
| Back-office et biométrie | Respecter la séquence identifiant → visage → mot de passe ; appliquer les règles de tentative et de temporisation. |
| Habilitations | Appliquer le moindre privilège aux comptes et interfaces d'administration. |
| Secrets | Protéger la clé JWT et les secrets hors du code et des journaux. |
| Journaux et supervision | Conserver des événements exploitables et corrélables ; ne pas journaliser mots de passe ou jetons. |
| Remédiation | Limiter les actions automatiques aux opérations autorisées ; tracer décision, action et résultat. |
| MQTT / ESP8266 | Contrôler les échanges et ne pas utiliser l'état de la LED comme preuve d'autorisation. |
| Continuité | Tester bascule, restauration et reconstruction ; distinguer mesures constatées et objectifs de reprise. |
| Données biométriques | [à compléter — préciser les données biométriques réellement conservées, leur stockage et leur protection] |

## Atelier 2 — Sources de risque

Les profils ci-dessous sont des hypothèses de travail, pas des acteurs observés.

| ID | Source de risque | Objectif visé | Événements concernés |
|---|---|---|---|
| SR1 / OV1 | Cybercriminel simulé | Compromettre un compte et tenter un virement non autorisé | ER1, ER2 |
| SR1 / OV2 | Attaquant simulé | Perturber l'authentification par des tentatives répétées | ER3 |
| SR2 / OV3 | Attaquant ciblant les mécanismes de sécurité | Empêcher, contourner ou détourner la remédiation | ER1, ER2, ER3, ER4 |
| SR1 / OV4 | Attaquant ciblant le back-office | Contourner l'identification faciale ou obtenir un accès administratif | ER5, ER6, ER7 |
| SR2 / OV5 | Attaquant ciblant les communications de contrôle | Manipuler les messages MQTT ou l'indication de la LED | ER8 |

## Atelier 3 — Scénarios stratégiques

### 3.1 Écosystème et dépendances

Le WAF est le point d'entrée unique vers les routes applicatives. `auth` gère les connexions et alimente `login_attempts` ; `api` traite les opérations ; `log-detector` déclenche la remédiation ; `remediation` gère les incidents et le blocage WAF. Prometheus collecte les métriques, Loki centralise les journaux JSON de `auth`, `api`, `remediation` et `waf`, et Grafana fournit les dashboards de sécurité et de remédiation.

Le back-office ajoute une identification en trois étapes (identifiant → visage via caméra USB → mot de passe) et une LED ESP8266 pilotée par MQTT. Les détails de stockage biométrique et les garanties de sécurité MQTT ne sont pas précisés.

### 3.2 Scénarios stratégiques retenus

| ID | Scénario stratégique | Chemin de risque | ER |
|---|---|---|---|
| S1 | Compromission de compte et tentative de fraude | Brute force sur `/auth/v1/login` → accès au compte si les contrôles échouent → tentative de virement | ER1, ER2 |
| S2 | Dégradation de l'authentification | Volume élevé de tentatives → consommation de ressources ou blocage d'utilisateurs légitimes | ER3 |
| S3 | Défaillance ou détournement de la remédiation | Détection ou commande inefficace/non autorisée → blocage non appliqué, excessif ou non traçable | ER1 à ER4 |
| S4 | Accès non autorisé au back-office | Contournement de la reconnaissance faciale, des étapes d'authentification ou des habilitations | ER5, ER7 |
| S5 | Indication de sécurité trompeuse | Message MQTT/état de LED manipulé ou incohérent avec l'état réel du back-office | ER8 |

Un brute force composé uniquement d'échecs de connexion ne donne pas, à lui seul, accès au compte. Le scénario de fraude doit donc tester séparément le contrôle d'autorisation serveur du virement. Le WAF ne remplace ni l'authentification ni l'autorisation métier.

## Atelier 4 — Scénarios opérationnels et cotation

### 4.1 Scénario principal : brute force et blocage WAF

1. **[EN PLACE]** `log-detector` interroge `login_attempts` toutes les 5 secondes.
2. **[EN PLACE]** À partir de 5 échecs en 120 secondes pour une IP, il envoie `POST /remediation/v1/incidents`.
3. **[EN PLACE]** Pour un incident `BRUTE_FORCE`, la politique exige un score ≥ 0,6 et au moins 5 échecs ; le playbook `block_source` écrit l'IP dans la liste de déni et recharge le WAF par signal HUP.
4. **[EN PLACE]** La chaîne vérifie `/readyz` de `auth` et `api`, puis exécute une transaction canari de 1 centime entre deux comptes internes avec l'en-tête `X-Synthetic`. L'incident devient `RESOLVED` ou `FAILED`. Le ban expire après 300 secondes.
5. **[À FAIRE]** Tester séparément le refus d'un virement non autorisé côté serveur. Le canari prouve le fonctionnement de la reprise, pas le rejet d'une fraude.

**Limite ML :** le détecteur ML est livré mais non activable : modèle absent et seuil au statut `provisional_not_validated`. Aucune livraison d'incident n'est réalisée par la voie ML. La détection réellement en place est celle, sans ML, de `log-detector`.

### 4.2 Scénarios opérationnels secondaires

| ID | Scénario | Contrôle / preuve attendue |
|---|---|---|
| O2 | Tentatives répétées dégradant l'authentification | Observer erreurs, métriques et disponibilité ; ne conclure à une indisponibilité que si elle est mesurée. |
| O3 | Échec de remédiation ou action abusive | Vérifier statut `FAILED`, traces de décision/action et comportement si le WAF ne recharge pas. |
| O4 | Contournement ou échec biométrique | Vérifier la séquence d'identification, la remise à zéro de l'identifiant, les temporisations et l'application des habilitations. |
| O5 | Manipulation de l'indicateur ESP8266 | Vérifier que l'état de la LED n'accorde jamais l'accès et reflète l'état réel sans remplacer les contrôles applicatifs. |
| O6 | Perte de base, d'instance, du WAF ou du PC Hôte | Appliquer les procédures PCA/PRA ; conserver les preuves de bascule, restauration ou reconstruction. |

### 4.3 Vraisemblance et synthèse initiale

Échelle de travail : 1 (faible), 2 (modérée), 3 (élevée), 4 (très élevée). La vraisemblance doit être cotée après tests ; aucun niveau n'est inventé ci-dessous.

| Risque | Scénario | ER | Gravité de référence | Vraisemblance initiale |
|---|---|---|---:|---|
| R1 | Compromission de compte puis tentative de virement | ER1, ER2 | 4 — Critique (ER2) | [à valider — tests d'authentification et d'autorisation] |
| R2 | Tentatives répétées perturbant l'authentification | ER3 | 2 — Modéré | [à valider — test de charge autorisé et mesure d'impact] |
| R3 | Échec, détournement ou excès de la remédiation | ER1 à ER4 | 3 — Majeur, à confirmer selon l'impact | [à valider — tests d'échec et d'accès à l'interface] |
| R4 | Journaux absents ou altérés pendant l'incident | ER4 | 3 — Majeur | [à valider — test de collecte et de reconstitution] |
| R5 | Contournement de l'identification faciale | ER5 | 4 — Critique | [à valider — tests d'accès au back-office] |
| R6 | Faux rejet biométrique d'un utilisateur autorisé | ER6 | 2 — Modéré | [à valider — tests de reconnaissance] |
| R7 | Modification non autorisée des habilitations | ER7 | 4 — Critique | [à valider — revue des rôles et tests d'autorisation] |
| R8 | Manipulation de la LED ou des messages MQTT | ER8 | 2 — Modéré | [à valider — tests MQTT et contrôle de l'autorisation réelle] |
| R9 | Perte du PC Hôte et de l'environnement local | ER3, ER4 et continuité | 4 — Critique pour le laboratoire, à valider | [à valider — reconstruction complète non démontrée] |

Le risque R9 est ajouté pour couvrir la limite majeure identifiée dans le PCA/PRA : toutes les piles et sauvegardes sont sur un seul PC Hôte. Ce risque concerne la continuité du laboratoire, pas un événement redouté métier supplémentaire.

## Atelier 5 — Traitement du risque

### 5.1 Plan de traitement

| ID | Risque | Mesure | Statut | Critère de validation |
|---|---|---|---|---|
| M1 | R1, R2 | Limitation et détection des tentatives d'authentification | **[EN PLACE]** Détection sans ML par seuil dans `log-detector` | Déclenchement au seuil prévu ; faux positifs et impact à mesurer |
| M2 | R1 | Contrôle serveur des droits et de chaque virement | **[CONÇU, NON TESTÉ]** Présent dans l'analyse EBIOS ; preuve de test non fournie | Virement non autorisé refusé, même avec compte compromis |
| M3 | R1, R2, R3 | Blocage temporaire de l'IP au WAF | **[EN PLACE]** TTL 300 s, rechargement HUP | Requête de l'IP bloquée ; expiration vérifiée |
| M4 | R3 | Protéger l'interface de remédiation et limiter les actions autorisées | **[À FAIRE — validation technique]** | Commande non autorisée refusée et journalisée |
| M5 | R4 | Centraliser les journaux utiles à l'investigation | **[EN PLACE]** Loki reçoit les journaux JSON de `auth`, `api`, `remediation`, `waf` | Chronologie reconstituable ; rétention et sauvegarde à vérifier |
| M6 | R2 | Surveiller disponibilité et effets des tentatives | **[EN PLACE]** Prometheus, Grafana | Mesures disponibles pendant un test autorisé |
| M7 | R3, R4 | Contrôler l'échec de remédiation et définir le repli | **[CONÇU, NON TESTÉ]** | Échec visible, statut `FAILED`, procédure de repli testée |
| M8 | R1 à R4, R9 | Tester bascule, restauration et reconstruction | **[EN PLACE]** Bascule DB, dumps horaires et procédures PCA/PRA partiellement documentées | Résultats consignés ; reconstruction complète à démontrer |
| M9 | R5, R6 | Tester la séquence biométrique et les règles de nouvelle tentative | **[À FAIRE — tests à documenter]** | Échec et réussite conformes à la consigne ; pas de contournement |
| M10 | R7 | Vérifier les rôles et permissions du back-office côté serveur | **[À FAIRE — preuve non fournie]** | Fonction administrative inaccessible sans habilitation |
| M11 | R8 | Contrôler les messages MQTT et séparer LED et autorisation | **[À FAIRE — preuve non fournie]** | Manipuler la LED ne permet pas d'accéder au back-office |

### 5.2 Risques résiduels

Les risques résiduels ne peuvent pas être cotés correctement avant les tests et la validation des mesures. Ils restent donc ouverts.

| Risque | Mesures associées | État du risque résiduel |
|---|---|---|
| R1 | M1, M2, M3 | [à compléter — résultats des tests d'authentification, de blocage et d'autorisation] |
| R2 | M1, M3, M6 | [à compléter — mesures d'impact sur la disponibilité] |
| R3 | M4, M7 | [à compléter — tests de protection et d'échec de remédiation] |
| R4 | M5, M8 | [à compléter — test de collecte, rétention et reprise des journaux] |
| R5 | M9 | [à compléter — tests de contournement biométrique] |
| R6 | M9 | [à compléter — résultats de reconnaissance et faux rejets] |
| R7 | M10 | [à compléter — revue et tests d'habilitation] |
| R8 | M11 | [à compléter — tests MQTT et vérification de l'autorisation applicative] |
| R9 | M8 | [à compléter — reconstruction depuis le dépôt sur un poste distinct] |

## À retenir

- **[EN PLACE]** La détection opérationnelle est actuellement basée sur les journaux et un seuil fixe ; la voie ML n'est pas activable.
- **[EN PLACE]** La remédiation bloque temporairement une IP au WAF et vérifie la reprise par une transaction canari synthétique.
- **[À FAIRE]** Prouver séparément le refus d'un virement non autorisé côté serveur.
- **[À FAIRE]** Valider les risques du back-office biométrique, des habilitations et de l'ESP8266/MQTT par des tests.
- **Limite majeure :** la perte du PC Hôte n'est couverte par aucune bascule et les sauvegardes restent sur ce poste.

## Références

- ANSSI, *EBIOS Risk Manager — Guide méthodologique v1.5*.
- ANSSI, *La méthode EBIOS Risk Manager*.
- PCA/PRA du projet RESILIENCE-ALPHA : source des mesures de disponibilité, sauvegarde, bascule, reconstruction et limites opérationnelles.

Les échelles et cotations sont des adaptations de travail au projet, à valider par l'équipe. Aucune conformité normative n'est revendiquée.
