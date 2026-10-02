FROM mcr.microsoft.com/devcontainers/javascript-node:3-24-bookworm@sha256:eac37fbeb0dd1ded8ae31a93f1f3e0defc413715e7541e2ba5a5c10079777f62

USER root
RUN install -d -m 0700 -o node -g node /home/node/sanitized-cases \
    && command -v git \
    && command -v flock \
    && node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
