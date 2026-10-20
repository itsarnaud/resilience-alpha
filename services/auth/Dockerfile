FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY services services

# pas de hooks husky dans l'image
RUN npm ci --ignore-scripts \
 && npm run build -w packages/shared \
 && npm run build -w services/auth \
 && npm prune --omit=dev --ignore-scripts

ENV NODE_ENV=production \
    PORT=3000 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    CHECKPOINT_DISABLE=1

USER node
WORKDIR /repo/services/auth
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
