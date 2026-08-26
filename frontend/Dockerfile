FROM node:26-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@11.7.0
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY schloss-ui/package.json ./schloss-ui/
COPY schloss-server-kit/package.json ./schloss-server-kit/
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile --filter frontend --filter @zudar107/schloss-ui
COPY schloss-ui ./schloss-ui
RUN pnpm --filter @zudar107/schloss-ui build
COPY frontend ./frontend
RUN pnpm --filter frontend build

FROM caddy:2-alpine AS runner
RUN apk add --no-cache jq && mkdir -p /config
COPY --from=builder /app/frontend/dist /srv
COPY frontend/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 frontend/entrypoint.sh /usr/local/bin/frontend-entrypoint
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/frontend-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
