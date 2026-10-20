# Service de reconnaissance faciale — vérification 1:1 (l'identifiant est déjà donné).
# Endpoints : /enroll (enrôler un visage), /recognize (vérifier), /users, /health, /metrics
import os, json, base64, io
import numpy as np
import face_recognition
from flask import Flask, request, jsonify
from prometheus_client import Counter, generate_latest, CONTENT_TYPE_LATEST

DATA = os.environ.get("FACE_DB", "/data/faces.json")
THRESHOLD = float(os.environ.get("FACE_THRESHOLD", "0.6"))  # distance max pour "reconnu"

app = Flask(__name__)
m_enroll = Counter("face_enrollments_total", "Visages enroles")
m_reco = Counter("face_recognitions_total", "Reconnaissances", ["result"])

def load():
    try:
        with open(DATA) as f:
            return json.load(f)
    except Exception:
        return {}

def save(db):
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, "w") as f:
        json.dump(db, f)

def decode_image(b64):
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return face_recognition.load_image_file(io.BytesIO(raw))

def encode_face(img):
    encs = face_recognition.face_encodings(img)
    return encs[0] if encs else None

@app.get("/health")
def health():
    return jsonify(status="ok", enrolled=len(load()))

@app.get("/metrics")
def metrics():
    return generate_latest(), 200, {"Content-Type": CONTENT_TYPE_LATEST}

@app.get("/users")
def users():
    return jsonify(sorted(load().keys()))

@app.post("/enroll")
def enroll():
    d = request.get_json(force=True) or {}
    user, img_b64 = d.get("user"), d.get("image")
    if not user or not img_b64:
        return jsonify(ok=False, error="user et image requis"), 400
    enc = encode_face(decode_image(img_b64))
    if enc is None:
        return jsonify(ok=False, error="aucun visage detecte"), 422
    db = load()
    db.setdefault(user, [])
    db[user].append(enc.tolist())
    db[user] = db[user][-5:]  # on garde au plus 5 échantillons
    save(db)
    m_enroll.inc()
    return jsonify(ok=True, user=user, samples=len(db[user]))

@app.post("/recognize")
def recognize():
    d = request.get_json(force=True) or {}
    user, img_b64 = d.get("user"), d.get("image")
    if not user or not img_b64:
        return jsonify(ok=False, error="user et image requis"), 400
    known = load().get(user)
    if not known:
        m_reco.labels("not_enrolled").inc()
        return jsonify(ok=True, recognized=False, reason="utilisateur non enrole"), 200
    enc = encode_face(decode_image(img_b64))
    if enc is None:
        m_reco.labels("no_face").inc()
        return jsonify(ok=True, recognized=False, reason="aucun visage"), 200
    dists = face_recognition.face_distance([np.array(k) for k in known], enc)
    best = float(np.min(dists))
    recognized = best <= THRESHOLD
    m_reco.labels("match" if recognized else "no_match").inc()
    return jsonify(ok=True, recognized=recognized, distance=round(best, 3), threshold=THRESHOLD)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
