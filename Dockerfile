# node:22-alpine (22.23.x / alpine 3.24). Digest pin; Dependabot docker updates it.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN ln -s /app/dist/cli/index.js /usr/local/bin/grane \
  && chmod +x /app/dist/cli/index.js \
  && mkdir -p /project /var/log/grane \
  && chown -R node:node /project /var/log/grane

# Mount the Grane project (grane.yml etc.) at /project. Prefer a read-only
# mount in production and set GRANE_AUDIT_PATH=/var/log/grane/audit.jsonl.
USER node
WORKDIR /project
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/cli/index.js"]
# Published ports need 0.0.0.0. Unauthenticated HTTP on that bind is refused
# unless --allow-anonymous (demo compose) or auth.agents is configured.
CMD ["serve", "--port", "8080", "--host", "0.0.0.0"]
