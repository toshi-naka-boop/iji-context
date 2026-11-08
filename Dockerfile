# レセメンの本番イメージ（spec FR-74）。GCP の VM などで docker compose から動かす（deploy/docker-compose.yml）
# データ（DB・知識・セッション・メンターの会話の記録）はすべて /data に置き、ボリュームで残す
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 のビルドに要る道具（プレビルドがないときだけ使われる）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && apt-get clean
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
# HOME も /data に置く（Claude Code がメンターの会話の記録を ~/.claude に残し、続きの会話で使うため）
ENV NODE_ENV=production \
    PORT=3000 \
    RESEMEN_DATA=/data \
    RESEMEN_WORKSPACES=/data/workspaces \
    HOME=/data/home
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/config ./config
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/next.config.ts ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
