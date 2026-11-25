# レセメンの本番イメージ（spec FR-74）。GCP の VM などで docker compose から動かす（deploy/docker-compose.yml）
# データ（DB・知識・セッション・メンターの会話の記録）はすべて /data に置き、ボリュームで残す
FROM node:22-bookworm-slim AS tools
WORKDIR /app
# better-sqlite3 のビルドに要る道具（プレビルドがないときだけ使われる）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && apt-get clean
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# tools：手で流すスクリプト（保存時の暗号化へ移す・鍵の入れ替え。docs/deploy-gcp.md）を、開発用の依存（tsx）ごと動かすためのイメージ。
# docker build --target tools -t resemen-tools . で作る。アプリの本番イメージには入れない

FROM tools AS build
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
# メンターの会話の記録は、暗号化した app.db に写す（spec FR-214。src/llm/session-store.ts）。
# SDK が手元に置く写し（CLAUDE_CONFIG_DIR）と HOME・一時ファイルは /tmp に置き、/tmp はディスクに残らない場所（tmpfs）にする（deploy/docker-compose.yml）
ENV NODE_ENV=production \
    PORT=3000 \
    RESEMEN_DATA=/data \
    RESEMEN_WORKSPACES=/data/workspaces \
    HOME=/tmp/home \
    CLAUDE_CONFIG_DIR=/tmp/claude
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/config ./config
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/official ./official
COPY --from=build /app/next.config.ts ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
