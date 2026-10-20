FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
RUN test -n "$SOURCE_REVISION" && printf '%s\n' "$SOURCE_REVISION" > /app/source-revision
COPY scheduler/package.json scheduler/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node scheduler/src ./scenarios/scheduler/src
COPY --chown=node:node scheduler/scripts ./scenarios/scheduler/scripts
COPY --chown=node:node payment-ordering/src ./scenarios/payment-ordering/src
COPY --chown=node:node payment-ordering/truth.mjs payment-ordering/verify.mjs ./scenarios/payment-ordering/
WORKDIR /app/scenarios/scheduler
USER node
CMD ["node", "src/server.mjs"]
