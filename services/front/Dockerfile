# Image du front. Le contexte de build est la RACINE du dépôt (workspaces npm) :
#   docker build -f services/front/Dockerfile -t resilience-front .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY services services
# pas de scripts d'installation dans l'image (la compilation est explicite ci-dessous)
RUN npm ci --ignore-scripts && npm run build -w services/front

# Image finale : uniquement nginx et les fichiers compilés, sans Node ni sources.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY services/front/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/front/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
