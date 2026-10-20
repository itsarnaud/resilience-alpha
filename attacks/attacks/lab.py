import hashlib
import json
import random
from pathlib import Path

# --- Lecture des 50 mots de passe rockyou ---
with open("rockyou_50.txt", encoding="utf-8") as f:
    mots = [l.strip() for l in f if l.strip()]

# --- Création de 3 comptes fictifs (noms + mots de passe aléatoires) ---
random.seed(42)
noms = ["alice", "bob", "charlie"]
comptes = {}
for nom in noms:
    mdp = random.choice(mots)
    h = hashlib.sha256(mdp.encode("utf-8")).hexdigest()
    comptes[nom] = h

# --- Sauvegarde des credentials ---
with open("comptes.json", "w", encoding="utf-8") as f:
    json.dump(comptes, f, indent=2)
print("Comptes créés :", list(comptes.keys()))

# --- Test : attaque par dictionnaire ---
print("\n--- Attaque ---")
total = 0
for nom, h_attendu in comptes.items():
    trouve = False
    for m in mots:
        total += 1
        if hashlib.sha256(m.encode("utf-8")).hexdigest() == h_attendu:
            print(f"  [TROUVÉ] {nom} : {m}")
            trouve = True
            break
    if not trouve:
        print(f"  [ECHEC] {nom} : non trouve")
print(f"Total comparaisons : {total}")