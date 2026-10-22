# IA de supervision : health-checks + lecture Loki + notifications email.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY agent.mjs ./
USER node
CMD ["node", "agent.mjs"]
