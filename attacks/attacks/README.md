# Scripts Red Team

Outils offensifs du workshop, a lancer **depuis le PC Attaquant** (ou en local sur le PC Hote).
Ils ne servent qu'a titrer la resilience de la plateforme de laboratoire : toute cible hors
`localhost` doit etre un poste du labo explicitement autorise.

## `lab.py` — attaque par dictionnaire sur la connexion

Teste des couples email / mot de passe contre la route de connexion d'`auth` et mesure ce que la
plateforme en fait (journalisation, detection, blocage d'IP). Chaque tentative est tracee, et
l'attaque produit un rapport JSON.

## Lancement

```bash
cd attacks/attacks
python3 lab.py
```

ou

```bash
cd attacks/attacks
python3 lab.py --host xx.xx.xx.xx/auth/v1/login
```

- Sans option, `python3 lab.py` vise automatiquement `http://localhost/auth/v1/login`
  (le WAF local, prefixe `/auth` retire avant transmission vers le service `auth` :
  `infra/compose/config/waf/waf_api_routes.conf`).
- `--host` accepte un hote nu, un `hote:port`, un `hote/chemin` ou une URL complete :
  `--host 192.168.137.1`, `--host 192.168.137.1:8081`, `--host 192.168.137.1/auth/v1/login`,
  `--host http://192.168.137.1/auth/v1/login`. Sans chemin, `/auth/v1/login` est ajoute.

## Declencher la detection sans dictionnaire (campagne courte)

Pour provoquer la chaine *detection -> incident -> blocage WAF* de facon deterministe,
sans lancer le balayage complet du dictionnaire :

```bash
cd attacks/attacks
python3 lab.py --direct --ip 203.0.113.66 --attempts 6 --email victim@resilience.local
```

- `--direct` vise `http://localhost:3010/v1/login` (service `auth` sans le WAF). C'est
  indispensable : via le WAF, l'adresse reelle du client est ajoutee en fin de
  `X-Forwarded-For` et c'est elle qui compte.
- `--ip` injecte l'IP source. Le service `auth` ne la retient que si la requete vient d'un
  proxy de confiance (`TRUST_PROXY=loopback,uniquelocal`), donc d'une boucle locale.
- `--attempts` enonce N tentatives a mot de passe fixe (`--password`), en serie.
- Equivalent Windows : `brute-force-spam.cmd [IP] [NB] [EMAIL]`.

Le seuil du detecteur est de 5 echecs sur 120 s pour une meme IP : 6 tentatives suffisent.

### Verifier la chaine sur le PC Hote

```bash
docker exec db-auth psql -U auth_user -d auth -c "select ip, count(*), max(created_at) from login_attempts where created_at > now() - interval '3 minutes' group by ip;"
docker exec db-remediation psql -U remediation_user -d remediation -c "select type, source_ip, status from incidents order by created_at desc limit 3;"
docker exec waf sh -c "cat /etc/nginx/denylist/*.conf 2>/dev/null || echo 'liste vide'"
```

La premiere commande est la seule source de verite : c'est elle qui dit quelle IP le service
`auth` a reellement enregistree. Les journaux du WAF montrent, eux, toujours l'adresse reelle
du client.

### Pourquoi la banquise ne se voit pas en local

`PROTECTED_IPS` (`127.0.0.1`, `::1`, `192.168.137.1`, `192.168.65.1`, `172.17.0.1`) n'est
jamais signale ni bloque, cote detecteur et cote remediation : un faux positif ne doit pas
couper la passerelle. Une campagne lancee depuis le PC Hote avec l'IP reelle du client
(`127.0.0.1` ou l'IP du pont Docker) est donc **volontairement sans effet** : il faut
attaquer depuis le PC Attaquant, ou injecter une IP de test (`--ip`).

### Simulation d'observation (`--inject-db`)

Quand l'IP source ne peut pas etre injectee (pair non de confiance, header retirees en
amont), le signal peut etre fabrique directement dans `login_attempts` :

```bash
python3 lab.py --inject-db --ip 203.0.113.66 --attempts 6 --email victim@resilience.local
```

Ce n'est **pas une attaque** : le detecteur recoit un signal fabrique. A utiliser pour
demontrer la partie *detection -> remediation*, jamais pour pretendre qu'une attaque a ete
bloquee.

## Journalisation

Deux fichiers sont produits dans `logs/` (dossier configurable avec `--log-dir`) :

| Fichier | Contenu |
| --- | --- |
| `logs/attaque_<horodatage>.jsonl` | Une ligne JSON par tentative, ecrite **pendant** l'attaque (survit a une interruption) |
| `logs/attaque_<horodatage>.json` | Rapport complet ecrit **apres** l'attaque : cible, options, resume, resultats par compte, traces |

Format d'une trace (`jsonl`) :

```json
{"seq": 17, "at": "2026-10-21T16:47:16.173473+00:00", "email": "victime@resilience.local",
 "password": "123123", "status": 401, "outcome": "invalid_credentials", "elapsed_ms": 71.4}
```

`outcome` vaut `success`, `invalid_credentials`, `blocked_by_waf`, `rate_limited`,
`network_error` ou `http_<code>`.

Le rapport JSON reprend la cible, les options, le resume (duree, tentatives, tentatives/s,
repartition des statuts, comptes compromis), le detail par compte et la trace complete.

## Performance : ce qui a ete optimise

L'attaque doit etre rapide **sans perdre d'essai** : le dictionnaire entier reste teste.

| Optimisation | Effet |
| --- | --- |
| Tentatives reparties sur 24 fils | Les echecs s'enchainent au lieu de s'attendre |
| Connexions HTTP persistantes (keep-alive) | Un seul handshake TCP par fil au lieu d'un par essai |
| Dictionnaire trie par probabilite (chiffres purs, base connue + suffixe, base connue seule, autres) | Le bon mot de passe sort plus tot dans la file : `azerty123` passe du rang 51 au rang 13 |
| Comptes entrelaces (email 1, email 2, email 1, ...) | Les echecs se repartissent sur tous les comptes vises : meme signal pour le detecteur |
| Aucun delai par defaut (`--delay 0`) | La cadence est la limite du serveur, pas du script |

Mesure sur la pile du labo (bcrypt `rounds=10` cote `auth`) : **106 tentatives en ~1,2 s,
soit ~88 essais/s** — le debut du script, lui, plafonnait a ~9 essais/s. Le plafond restant
vient du cout du hachage serveur : augmenter `--threads` au-dela de 24 n'ameliore plus rien.

Aucun essai n'est perdu : le dictionnaire entier est teste, y compris apres un succes
(`--continue-after-success` force le balayage complet de tous les mots pour tous les comptes).

## Options

| Option | Defaut | Role |
| --- | --- | --- |
| `--host` | `http://localhost/auth/v1/login` | Cible : hote, `hote:port`, `hote/chemin` ou URL complete |
| `--direct` | off | Attaquer `auth` sans le WAF (`http://localhost:3010/v1/login`) |
| `--email` | `lab_targets.txt` | Compte vise (repetable) |
| `--targets-file` | `lab_targets.txt` | Fichier des comptes vises |
| `-w`, `--wordlist` | `rockyou.txt` | Liste de mots de passe (repetable) |
| `--threads` | `24` | Tentatives en parallele |
| `--delay` | `0` | Pause entre deux tentatives, en secondes |
| `--timeout` | `15` | Delai de reponse maximal, en secondes |
| `--max-attempts` | illimite | Plafond de tentatives par compte |
| `--continue-after-success` | off | Ne pas s'arreter au premier mot de passe trouve (teste tout le dictionnaire) |
| `--ip` | off | IP source injectee dans `X-Forwarded-For` (retenue par `auth` seulement si le pair est de confiance : passer par `--direct`) |
| `--attempts` | off | Mode campagne courte : N tentatives a mot de passe fixe, sans dictionnaire |
| `--password` | `mauvais-mot-de-passe` | Mot de passe utilise en mode `--attempts` |
| `--inject-db` | off | Simulation : ecrit les echecs directement dans `login_attempts` (ce n'est pas une attaque) |
| `--db-container` | `db-auth` | Conteneur PostgreSQL des tentatives |
| `--db-user` | `auth_user` | Utilisateur PostgreSQL |
| `--db-name` | `auth` | Base PostgreSQL |
| `--quiet` | off | Ne pas afficher le detail des tentatives |
| `--log-dir` | `logs/` | Dossier des journaux JSON |
| `--offline` | off | Auto-test hors ligne (dictionnaire contre empreintes SHA-256) |

## Lecture des codes de reponse

| Code | Signification pour l'attaque |
| --- | --- |
| `200` | Couple valide : jeton renvoye, compte compromis |
| `401` | Couple invalide (`identifiants invalides`) — le defaut du service |
| `403` | IP sur la liste de blocage du WAF, ou requete refusee par ModSecurity : la remediation a agi (trois refus d'affilee arretent l'attaque) |
| `429` | Limitation de debit : ralentir (`--delay`) |
| `0` | Cible injoignable : l'attaque s'arrete aussitot |

## Ce que l'on observe

- `auth` journalise chaque echec (`login_failed` : email, IP, motif) et incremente
  `auth_login_failures_total` : c'est le signal que le detecteur ML surveille.
- A partir de `MIN_FAILURES` echecs (5 par defaut, `services/remediation/src/lib/config.ts`), la
  remediation declare un incident `BRUTE_FORCE` et fait bloquer l'IP source par le WAF.
  En local, l'IP de l'attaquant (`127.0.0.1`) est protegee : le blocage ne se voit pas depuis la
  meme machine, il faut attaquer depuis le PC Attaquant.
- Le compte `admin` ne peut pas se connecter par `/v1/login` (meme avec le bon mot de passe) :
  il a sa porte d'entree renforcee (visage + mot de passe).

## Fichiers

| Fichier | Contenu |
| --- | --- |
| `lab.py` | Script d'attaque (mode reseau + mode hors ligne) |
| `brute-force-spam.cmd` | Equivalent Windows de la campagne courte (`for /L` + curl) |
| `rockyou.txt` | Dictionnaire de l'attaque : 50 mots de passe rockyou + 3 mots de passe faibles du labo (`SEED_*`) |
| `lab_targets.txt` | Comptes vises par l'attaque |
| `logs/` | Journaux JSON des attaques (generes, non versionnes) |
| `comptes.json` | Genere par `--offline` (empreintes des comptes d'auto-test) |
