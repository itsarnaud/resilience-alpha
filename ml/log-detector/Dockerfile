# Détecteur brute-force autonome, sans ML : lit les logs d'auth en base et
# signale les IP fautives à la remédiation (qui bannit via le WAF).
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY detector.mjs ./
USER node
CMD ["node", "detector.mjs"]
