#!/usr/bin/env bash
# レセメンを起動する（VM の上で実行する。spec FR-74）。
# API キーは Secret Manager から読み出し、この起動のあいだだけ環境変数で渡す。キーをファイルに書かない。
# VM のサービスアカウントに、各シークレットの「Secret Manager のシークレット アクセサー」権限が要る（docs/deploy-gcp.md）
set -euo pipefail
cd "$(dirname "$0")"

: "${RESEMEN_DOMAIN:?RESEMEN_DOMAIN を指定してください（例：34-84-12-34.sslip.io）}"

secret() {
  gcloud secrets versions access latest --secret="$1" --quiet 2>/dev/null || true
}

ANTHROPIC_API_KEY="$(secret resemen-anthropic-api-key)"
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "Secret Manager の resemen-anthropic-api-key を読めません（シークレットの有無と、VM の権限を確かめてください）" >&2
  exit 1
fi
# 音声（ElevenLabs）は任意。シークレットがなければ空のまま
ELEVENLABS_API_KEY="$(secret resemen-elevenlabs-api-key)"

export RESEMEN_DOMAIN ANTHROPIC_API_KEY ELEVENLABS_API_KEY
docker compose up -d --build "$@"
echo "起動しました：https://${RESEMEN_DOMAIN}"
