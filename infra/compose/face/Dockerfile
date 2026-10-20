# Service de reconnaissance faciale (IA légère, 1:1) — dlib pré-compilé, pas de build long
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir dlib-bin numpy pillow flask prometheus-client click face-recognition-models \
    && pip install --no-cache-dir --no-deps face_recognition
WORKDIR /app
COPY app.py .
EXPOSE 5000
CMD ["python", "app.py"]
