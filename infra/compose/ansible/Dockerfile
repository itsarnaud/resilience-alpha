# Nœud de contrôle Ansible (pas d'image officielle : on la construit)
FROM alpine:3.21
# docker-cli : pour que les playbooks pilotent les conteneurs via le socket-proxy (DOCKER_HOST)
RUN apk add --no-cache ansible docker-cli openssh-client sshpass
WORKDIR /ansible
