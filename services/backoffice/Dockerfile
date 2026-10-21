# Image du back-office. Le contexte de build est la RACINE du dépôt (workspaces npm) :
#   docker build -f services/backoffice/Dockerfile -t resilience-backoffice .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY services services
# pas de scripts d'installation dans l'image (la compilation est explicite ci-dessous)
RUN npm ci --ignore-scripts && npm run build -w services/backoffice

# Image finale : uniquement nginx et les fichiers compilés, sans Node ni sources.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY services/backoffice/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/backoffice/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
