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
| `rockyou.txt` | Dictionnaire de l'attaque : 50 mots de passe rockyou + 3 mots de passe faibles du labo (`SEED_*`) |
| `lab_targets.txt` | Comptes vises par l'attaque |
| `logs/` | Journaux JSON des attaques (generes, non versionnes) |
| `comptes.json` | Genere par `--offline` (empreintes des comptes d'auto-test) |
