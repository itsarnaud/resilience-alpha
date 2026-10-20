# face

Service de reconnaissance faciale du back-office (vérification 1:1 : l'identifiant est déjà connu, on vérifie que le visage correspond). Python, Flask, `face_recognition` (dlib). Appelé uniquement par le service `auth`.

## API

| Route                     | Corps (JSON)                                       | Réponse                                                                          |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /enroll`            | `{ "user": "<identifiant>", "image": "<base64>" }` | `{ ok, user, samples }` (5 échantillons conservés au plus par utilisateur)       |
| `POST /recognize`         | `{ "user": "<identifiant>", "image": "<base64>" }` | `{ ok, recognized, distance, threshold }` ou `{ ok, recognized: false, reason }` |
| `GET /users`              |                                                    | Liste des identifiants enregistrés                                               |
| `GET /health`, `/metrics` |                                                    | Santé et métriques Prometheus                                                    |

`recognized` vaut `true` si la distance au meilleur échantillon enregistré est inférieure ou égale à `FACE_THRESHOLD` (0,6 par défaut). Un utilisateur jamais enregistré ou une photo sans visage répondent `recognized: false` avec un code 200.

L'image peut être préfixée (`data:image/jpeg;base64,`) ou non.

## Configuration

| Variable         | Défaut             | Rôle                                       |
| ---------------- | ------------------ | ------------------------------------------ |
| `FACE_THRESHOLD` | `0.6`              | Distance maximale pour être « reconnu »    |
| `FACE_DB`        | `/data/faces.json` | Fichier des vecteurs de visage (un volume) |
| `PORT`           | `5000`             | Port d'écoute                              |

## Lancer

Dans le compose dev (`infra/compose/docker-compose.dev.yml`, service `face`), ou seul :

```bash
docker build -t resilience-face ml/face
docker run -p 5000:5000 -v face_data:/data resilience-face
```

## Limites connues (à traiter avant la démo)

- **Aucune authentification.** `POST /enroll` et `GET /users` sont ouvertes à tout conteneur du même réseau : un conteneur compromis peut enregistrer son visage sous le nom d'un administrateur. À faire : clé d'API vérifiée sur chaque route, et service accessible seulement depuis `auth`.
- **Vecteurs en clair** dans `faces.json` : ce sont des données biométriques. À protéger (accès restreint au volume) et à mentionner dans l'analyse de risques.
- **Pas de suppression** d'un visage ni d'un utilisateur.
- **Pas de détection du vivant** : une photo imprimée ou affichée sur un écran peut tromper la reconnaissance. Limite à documenter.
- Une image qui n'est pas un JPEG ou un PNG valide fait lever une erreur (réponse 500) au lieu d'un refus propre : `auth` la traite comme une panne du service, sans verrouiller le compte.
