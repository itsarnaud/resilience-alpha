Analyse de risques EBIOS RM — Plateforme de paiement

**Version :** 1.0
**Périmètre :** Plateforme de paiement conteneurisée composée de dix services
**Scénario principal :** Brute force sur l'API d'authentification, tentative de virement frauduleux et remédiation automatique.

## Objectif de l'étude

Cette analyse vise à identifier les risques cyber susceptibles d'affecter la plateforme de paiement fictive, à évaluer leurs conséquences et à définir des mesures de sécurité adaptées. L'étude se concentre sur la compromission des comptes utilisateurs, l'intégrité des transactions, la disponibilité de l'authentification et la capacité du système à détecter et contenir un incident.

La méthode EBIOS Risk Manager est organisée en cinq ateliers complémentaires. L'analyse présentée ici constitue une étude préliminaire adaptée au projet : les cotations sont proposées à titre indicatif et devront être confirmées à partir de l'architecture réelle, des contrôles effectivement déployés et des résultats des tests.

# Atelier 1 — Cadrage et socle de sécurité

## 1.1. Périmètre de l'étude

La plateforme de paiement est constituée de dix services conteneurisés permettant aux utilisateurs de s'authentifier et d'effectuer des transactions fictives. L'étude porte prioritairement sur l'API d'authentification, le service de transactions, le WAF, le mécanisme de détection par machine learning (ML), le moteur de remédiation et les composants de journalisation et de supervision.

Le scénario d'attaque est exécuté depuis un PC attaquant distinct, dans un environnement autorisé et isolé. Aucun système extérieur au laboratoire ni aucune donnée bancaire réelle ne doivent être concernés.

La cartographie définitive devra préciser les dix services, leurs responsabilités, leurs communications et leurs dépendances. À ce stade, seuls les composants identifiés dans le périmètre sont retenus ; les autres services restent à inventorier.

## 1.2. Valeurs métier et besoins de sécurité

Les valeurs métier correspondent aux activités et informations dont la compromission aurait un impact sur le fonctionnement de la plateforme.


| Valeur métier                    | Besoin de sécurité                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Authentification des utilisateurs | Empêcher les accès non autorisés aux comptes.                                      |
| Réalisation des transactions     | Garantir que les opérations sont autorisées, intègres et correctement exécutées. |
| Disponibilité de la plateforme   | Permettre aux utilisateurs légitimes d'utiliser le service.                          |
| Continuité de l'activité        | Maintenir ou rétablir le fonctionnement après un incident.                          |

Les journaux de sécurité constituent des biens supports contribuant à la détection, à l'investigation et à la réponse aux incidents. Ils ne sont pas assimilés ici à une valeur métier distincte.

## 1.3. Biens supports

Les biens supports identifiés sont le front Web, l'API d'authentification, le service de transactions, le WAF, le modèle ML, le moteur de remédiation, les composants de collecte des événements, les outils de supervision et les mécanismes de gestion des secrets.

Leur criticité dépend de leur rôle dans les scénarios de risque. L'API d'authentification et le service de transactions sont particulièrement sensibles, car leur compromission peut conduire à un accès non autorisé ou à une opération frauduleuse. Le moteur de remédiation est également critique : une mauvaise configuration ou une compromission de ce composant pourrait permettre un blocage abusif ou empêcher l'application des mesures de protection.

## 1.4. Échelle de gravité

Une échelle commune doit être utilisée pour justifier les niveaux attribués aux événements redoutés. La proposition suivante est à valider par l'équipe.


| Niveau        | Signification                                        | Exemple d'impact                                                    |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 1 — Faible   | Impact limité et rapidement réversible             | Perturbation mineure sans conséquence sur les transactions.        |
| 2 — Modéré | Dégradation temporaire d'une fonction               | Indisponibilité courte de l'authentification.                      |
| 3 — Majeur   | Atteinte importante à une fonction métier          | Compromission d'un compte ou interruption significative du service. |
| 4 — Critique | Atteinte grave à l'intégrité ou à la continuité | Exécution d'un virement non autorisé ou indisponibilité majeure. |

Ces niveaux sont des critères de travail et non une échelle officielle imposée par EBIOS RM. Ils devront être adaptés aux objectifs et aux exigences du projet.

## 1.5. Événements redoutés


| ID  | Événement redouté                       | Conséquence                                                               | Gravité initiale proposée |
| --- | ------------------------------------------ | -------------------------------------------------------------------------- | --------------------------- |
| ER1 | Accès frauduleux à un compte utilisateur | Utilisation non autorisée du compte et risque d'opérations frauduleuses. | 3 — Majeur                 |
| ER2 | Exécution d'un virement non autorisé     | Atteinte à l'intégrité des transactions et perte financière simulée.  | 4 — Critique               |
| ER3 | Indisponibilité de l'authentification     | Impossibilité pour les utilisateurs légitimes de se connecter.           | 2 — Modéré               |
| ER4 | Altération ou absence des journaux        | Difficulté à détecter, analyser et reconstituer un incident.            | 3 — Majeur                 |

Les cotations proposées devront être validées à partir des conséquences réellement possibles dans l'environnement. Les niveaux de gravité ne sont pas diminués automatiquement par la présence d'un WAF ou d'un modèle ML : ces mesures influencent principalement la vraisemblance ou la maîtrise du scénario.

## 1.6. Socle de sécurité

Le socle de sécurité regroupe les exigences minimales à vérifier indépendamment du scénario d'attaque.


| Domaine                       | Exigence à vérifier                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Authentification              | Les tentatives sont contrôlées et les échecs sont journalisés.                                              |
| Autorisation des transactions | Chaque virement est vérifié côté serveur ; l'accès à un compte ne suffit pas à autoriser une opération. |
| Protection réseau            | Le WAF protège l'application et n'expose que les interfaces nécessaires.                                      |
| Gestion des secrets           | Les secrets ne sont pas stockés en clair dans le code ou les journaux.                                         |
| Contrôle d'accès            | Les composants et interfaces d'administration disposent de permissions minimales.                               |
| Journalisation                | Les événements sont horodatés, corrélables et exploitables.                                                 |
| Supervision                   | Les métriques et les événements nécessaires au diagnostic sont collectés.                                  |
| Remédiation                  | Les actions automatiques sont autorisées, limitées et journalisées.                                          |
| Continuité                   | Le fonctionnement peut être vérifié après un incident et le retour à la normale contrôlé.                |

Le socle devra être évalué en distinguant les exigences déjà satisfaites, celles partiellement satisfaites et celles restant à implémenter. Les écarts constatés alimenteront le plan de traitement de l'atelier 5.

# Atelier 2 — Sources de risque

## 2.1. Sources de risque retenues

La source de risque principale est un cybercriminel cherchant à compromettre un compte utilisateur pour réaliser une opération frauduleuse. Le brute force constitue un mode opératoire possible, mais son succès dépend notamment de la robustesse de l'authentification et de l'efficacité des protections.

Une seconde source de risque est un attaquant cherchant à perturber le fonctionnement de la plateforme en multipliant les tentatives de connexion. Cet objectif vise principalement la disponibilité de l'authentification.

Une troisième hypothèse concerne un attaquant cherchant à contourner ou à détourner le mécanisme de remédiation afin de poursuivre son activité ou de provoquer un blocage abusif. Cette hypothèse concerne directement les interfaces privilégiées et les droits accordés au moteur de remédiation.

Ces profils sont des hypothèses de travail. Leurs motivations, ressources et capacités ne sont pas connues à ce stade et ne doivent pas être présentées comme des faits établis.

## 2.2. Couples source de risque / objectif visé


| ID      | Source de risque                                | Objectif visé                                                                   | Pertinence pour le projet                                                                 |
| ------- | ----------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| SR1/OV1 | Cybercriminel                                   | Obtenir un accès non autorisé à un compte pour tenter un virement frauduleux. | Très forte : correspond au scénario principal.                                          |
| SR1/OV2 | Cybercriminel                                   | Perturber la disponibilité de l'authentification.                               | Forte : correspond à un effet possible des tentatives répétées.                       |
| SR2/OV3 | Attaquant ciblant les mécanismes de sécurité | Contourner ou détourner la remédiation automatique.                            | À étudier : dépend de l'architecture et de l'exposition des interfaces privilégiées. |

La priorité est donnée au couple SR1/OV1, car il est directement lié à l'intégrité des transactions. SR1/OV2 est conservé pour examiner les conséquences sur la disponibilité. SR2/OV3 sera approfondi si le moteur de remédiation expose une interface ou des privilèges pouvant être détournés.

Une caractérisation plus complète des sources de risque devra préciser, pour chaque couple retenu, les ressources nécessaires, les opportunités offertes par l'environnement et les difficultés auxquelles l'attaquant serait confronté.

# Atelier 3 — Scénarios stratégiques

## 3.1. Écosystème et dépendances

La plateforme dépend de plusieurs composants qui concourent à l'authentification, au traitement des transactions, à la détection et à la réponse aux incidents.

Le front Web constitue le point d'entrée utilisateur. Les requêtes sont filtrées par le WAF avant d'atteindre les services applicatifs. L'API d'authentification vérifie les identifiants et produit les événements nécessaires à la détection. Le service de transactions doit contrôler les autorisations indépendamment du statut de connexion. Le modèle ML analyse les événements et fournit un résultat exploitable par le mécanisme de remédiation. Celui-ci transmet une action contrôlée au WAF. Enfin, les composants de journalisation et de supervision permettent de vérifier les événements et les effets de la remédiation.

Cette description représente l'architecture fonctionnelle visée. Les flux exacts, les protocoles, les dépendances entre conteneurs et les points de contrôle devront être confirmés à partir de l'architecture déployée.

## 3.2. Cartographie simplifiée des flux

```
PC attaquant autorisé
        |
        v
     Front Web
        |
        v
       WAF <----------------------+
        |                         |
        v                         |
 API d'authentification           |
        |                         |
        +--> Événements --> Modèle ML
        |                         |
        v                         v
Service de transactions     Moteur de remédiation
                                  |
                                  +--> Action contrôlée sur le WAF

Tous les composants concernés
        |
        v
Journalisation et supervision
```

Ce schéma est fonctionnel et non une représentation définitive des flux réseau. Il devra être ajusté si le modèle ML ou le moteur de remédiation communique directement avec d'autres services.

## 3.3. Scénario stratégique principal

Un attaquant externe cherche à obtenir un accès non autorisé à un compte utilisateur afin d'initier un virement frauduleux. Il cible l'authentification accessible depuis le front Web et tente de contourner les contrôles d'accès par des tentatives répétées de connexion. Si l'authentification est compromise et que le service de transactions ne vérifie pas correctement les autorisations, l'attaquant pourrait initier une opération non autorisée.

L'événement redouté principal est l'exécution d'un virement non autorisé (ER2). L'accès frauduleux au compte (ER1) constitue une étape intermédiaire possible. Le brute force est un mode opératoire envisagé, et non une garantie de compromission.

## 3.4. Scénarios stratégiques secondaires

Un premier scénario secondaire concerne la disponibilité : la multiplication des tentatives de connexion pourrait provoquer une dégradation du service ou empêcher les utilisateurs légitimes de s'authentifier.

Un second scénario concerne la chaîne de sécurité : si le moteur de remédiation ou son interface de commande est insuffisamment protégé, un attaquant pourrait empêcher le blocage, modifier les actions autorisées ou provoquer un blocage excessif.

Ces scénarios doivent être retenus ou écartés en fonction de l'architecture réelle, de l'exposition des composants et des contrôles observés. Leur présence dans cette analyse ne signifie pas qu'une vulnérabilité correspondante a déjà été constatée.

# Atelier 4 — Scénarios opérationnels

## 4.1. Scénario opérationnel principal : brute force et tentative de virement

Le scénario commence par la vérification du bon fonctionnement de la plateforme et de la collecte des événements. Depuis le PC attaquant autorisé, une série de tentatives de connexion échouées est effectuée sur un compte fictif afin de générer un comportement anormal. Le modèle ML analyse les événements collectés et contribue à la détection de cette activité.

Dans le scénario de démonstration, l'attaquant doit ensuite disposer d'un accès contrôlé au compte fictif pour tenter d'initier un virement vers un bénéficiaire externe fictif. Cette étape doit être explicitement définie : un brute force uniquement composé d'échecs de connexion ne permet pas, à lui seul, d'obtenir un accès au compte. L'opération de virement doit rester bloquée par les contrôles d'autorisation de la plateforme si elle n'est pas légitime.

Lorsqu'une activité malveillante est identifiée, le mécanisme de remédiation déclenche automatiquement une action sur le WAF afin de bloquer temporairement la source des requêtes. L'application de la règle, le rejet des requêtes et l'expiration du blocage doivent être vérifiables dans les journaux. Enfin, le retour à la normale est contrôlé au moyen d'une authentification légitime et d'une transaction fictive autorisée.

Le scénario de test doit distinguer les résultats suivants : détection du comportement anormal, blocage de la source par le WAF et refus du virement non autorisé. Ces résultats correspondent à des contrôles différents et ne doivent pas être confondus.

## 4.2. Scénario opérationnel secondaire : perturbation de l'authentification

Un attaquant multiplie les tentatives de connexion afin de perturber le service d'authentification. Les événements et métriques permettent d'observer l'évolution du volume de requêtes, des échecs et de la disponibilité du service. Les mécanismes de limitation et le WAF doivent réduire l'impact de ces requêtes sans provoquer un blocage excessif des utilisateurs légitimes.

Ce scénario sera testé uniquement dans les limites autorisées du laboratoire. Il ne doit pas être assimilé automatiquement à un déni de service réussi : une perturbation effective doit être observée pour conclure à un impact sur la disponibilité.

## 4.3. Scénario opérationnel secondaire : défaillance de la remédiation

Une erreur de configuration, une indisponibilité du WAF ou une défaillance de communication entre le modèle ML et le moteur de remédiation peut empêcher l'application du blocage. Une interface de remédiation insuffisamment protégée peut également permettre une action non autorisée.

L'analyse doit vérifier que les demandes de blocage sont authentifiées, limitées à des actions autorisées et journalisées. Le système doit distinguer une décision de blocage demandée d'une action effectivement appliquée. En cas d'échec, l'incident doit être visible et une procédure de repli contrôlée doit être définie.

## 4.4. Traces nécessaires à l'analyse

Les événements de sécurité doivent permettre de reconstituer la chronologie de l'incident. Ils comprennent l'horodatage, le type d'événement, le compte fictif ciblé, la source identifiée et le résultat de chaque tentative. Ils doivent également conserver le résultat de la détection ML, la décision de remédiation, l'action demandée au WAF et le résultat observé.

Aucun mot de passe, jeton d'authentification ou secret ne doit être enregistré dans les journaux. L'adresse source doit être déterminée selon une configuration réseau maîtrisée, notamment lorsque des proxies sont utilisés.

Les métriques Prometheus contribuent à la supervision, mais elles ne remplacent pas nécessairement les journaux applicatifs et les événements de sécurité. La collecte et la corrélation des événements doivent donc être vérifiées séparément.

## 4.5. Échelle de vraisemblance

Une échelle de vraisemblance doit être définie afin de comparer les scénarios opérationnels. La proposition suivante est à valider.


| Niveau              | Signification                                   | Critère indicatif                                                                     |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1 — Faible         | Scénario difficile à réaliser                | Plusieurs contrôles indépendants rendent le chemin d'attaque peu accessible.         |
| 2 — Modérée      | Scénario réalisable sous certaines conditions | L'attaque nécessite une opportunité ou une faiblesse spécifique.                    |
| 3 — Élevée       | Scénario relativement accessible               | L'exposition et les faiblesses identifiées facilitent plusieurs étapes de l'attaque. |
| 4 — Très élevée | Scénario particulièrement facile à réaliser | Les contrôles sont absents ou inefficaces et les conditions d'attaque sont réunies.  |

La vraisemblance doit être estimée à partir des caractéristiques de l'environnement, des vulnérabilités identifiées et de l'efficacité des mesures de sécurité. Le fait qu'un scénario soit simulé en laboratoire ne suffit pas à lui attribuer une vraisemblance élevée.

## 4.6. Synthèse initiale des risques

À ce stade, les niveaux de vraisemblance ne sont pas encore cotés, car les tests et la validation de l'architecture n'ont pas été réalisés.


| ID | Scénario de risque                                                            | Événement redouté           | Gravité initiale      | Vraisemblance initiale |
| -- | ------------------------------------------------------------------------------ | ------------------------------ | ---------------------- | ---------------------- |
| R1 | Brute force suivi d'une compromission de compte et d'une tentative de virement | ER1 et ER2                     | 4 — Critique pour ER2 | À évaluer            |
| R2 | Multiplication des tentatives perturbant l'authentification                    | ER3                            | 2 — Modéré          | À évaluer            |
| R3 | Échec ou détournement du mécanisme de remédiation                          | ER1, ER2 ou ER3 selon l'impact | À évaluer            | À évaluer            |
| R4 | Absence ou altération des journaux pendant l'incident                         | ER4                            | 3 — Majeur            | À évaluer            |

La cotation définitive devra être réalisée après l'analyse des contrôles existants et la validation des scénarios. Aucun niveau de risque global n'est attribué ici sans combinaison explicite de la gravité et de la vraisemblance.

# Atelier 5 — Traitement du risque

## 5.1. Stratégie de traitement

La stratégie consiste à réduire les risques prioritaires par des mesures préventives, détectives et correctives. La priorité est donnée à la protection des transactions et des comptes, puis à la disponibilité de l'authentification, à la fiabilité de la remédiation et à l'exploitabilité des journaux.

Les mesures retenues doivent être reliées aux risques identifiés. Leur efficacité doit être démontrée par des tests plutôt que supposée du seul fait de leur présence dans l'architecture.

## 5.2. Plan de traitement


| ID | Risque traité | Mesure envisagée                                                                                                     | Responsable proposé              | Critère de validation                                                                             |
| -- | -------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| M1 | R1             | Limiter les tentatives d'authentification et détecter les comportements anormaux par ML.                             | Développement et IA/Data         | Le comportement anormal est détecté à partir des événements du scénario.                     |
| M2 | R1             | Vérifier côté serveur les droits et l'autorisation de chaque virement.                                             | Développement                    | Un virement non autorisé est refusé, même si un compte est compromis.                           |
| M3 | R1, R2         | Appliquer un blocage temporaire via le WAF lorsque la décision de remédiation est justifiée.                       | Cybersécurité et infrastructure | La règle est appliquée, les requêtes concernées sont rejetées et l'expiration est vérifiée. |
| M4 | R3             | Protéger l'interface de remédiation par une authentification, des permissions minimales et des actions autorisées. | Cybersécurité et infrastructure | Une commande non autorisée est refusée et journalisée.                                          |
| M5 | R4             | Centraliser et corréler les événements de sécurité nécessaires à l'analyse.                                    | Infrastructure et développement  | La chronologie de l'incident peut être reconstituée à partir des traces.                        |
| M6 | R2             | Mettre en place une limitation des requêtes et surveiller les effets sur le service.                                 | Développement et infrastructure  | Les tentatives répétées sont limitées sans dégradation excessive du service.                  |
| M7 | R3, R4         | Définir une procédure de contrôle en cas d'échec de la remédiation ou de la collecte.                            | Cybersécurité et infrastructure | L'échec est visible et une procédure de repli documentée est testée.                           |
| M8 | R1 à R4       | Réaliser des tests de retour à la normale et conserver les preuves.                                                 | Équipe projet                    | L'authentification et une transaction fictive autorisée fonctionnent après le test.              |

Les responsables proposés correspondent aux rôles de l'équipe et devront être confirmés. Les échéances seront fixées en fonction du planning du workshop.

## 5.3. Évaluation du risque résiduel

Le risque résiduel correspond au risque restant après la mise en œuvre et la vérification des mesures de traitement. Il ne peut pas être déterminé de manière fiable avant les tests.


| ID | Risque initial                                 | Mesures appliquées | Résultat des tests | Risque résiduel |
| -- | ---------------------------------------------- | ------------------- | ------------------- | ---------------- |
| R1 | À coter après validation de la vraisemblance | M1, M2, M3          | À renseigner       | À réévaluer   |
| R2 | À coter après validation de la vraisemblance | M3, M6              | À renseigner       | À réévaluer   |
| R3 | À coter après validation de la vraisemblance | M4, M7              | À renseigner       | À réévaluer   |
| R4 | À coter après validation de la vraisemblance | M5, M7              | À renseigner       | À réévaluer   |

Après les tests, chaque risque résiduel devra être évalué selon la même méthode que le risque initial. La décision de l'accepter, de le tolérer sous contrôle ou d'engager des mesures complémentaires devra être justifiée. Dans le cadre du workshop, cette décision sera documentée par l'équipe, sans la présenter comme une acceptation formelle par une direction réelle.

## 5.4. Suivi et amélioration continue

Le suivi repose sur la vérification régulière des mesures de sécurité, la revue des événements, l'analyse des résultats de détection et la vérification de la bonne application des actions de remédiation. Toute modification importante de l'architecture, des règles WAF, du modèle ML ou des droits du moteur de remédiation doit conduire à réexaminer les scénarios concernés.

Les indicateurs de suivi peuvent inclure la proportion d'événements correctement collectés, le résultat des tests de détection, la réussite des actions de blocage, les faux positifs observés et le succès des transactions de test après retour à la normale.

# Synthèse des priorités

La priorité principale est de garantir que les transactions ne peuvent pas être exécutées sans autorisation, indépendamment de la détection ML et du WAF. La deuxième priorité est de démontrer que les événements d'authentification sont correctement collectés, que le modèle ML contribue à la détection et que le blocage temporaire est réellement appliqué. La troisième priorité est de sécuriser le moteur de remédiation et de garantir la traçabilité des actions. Enfin, la continuité du service doit être vérifiée par un retour à la normale observable.

Cette analyse doit être considérée comme un document évolutif. Les cotations, les chemins d'attaque et les risques résiduels seront actualisés lorsque l'architecture des dix services sera connue et que les tests auront fourni des résultats.

# Références méthodologiques

ANSSI, *EBIOS Risk Manager — Guide méthodologique*, version 1.5 : [https://cyber.gouv.fr/sites/default/files/document/20240901\_Guide-EBIOS-RM-V1.5.pdf](https://cyber.gouv.fr/sites/default/files/document/20240901_Guide-EBIOS-RM-V1.5.pdf)

ANSSI, *La méthode EBIOS Risk Manager* : [https://cyber.gouv.fr/securisation/analyse-des-risques/methode-ebios-rm/](https://cyber.gouv.fr/securisation/analyse-des-risques/methode-ebios-rm/)

Les échelles, tableaux et cotations proposés dans ce document constituent une adaptation de travail au projet, à partir des tableaux officiels de l'ANSSI.
