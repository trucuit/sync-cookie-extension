#!/usr/bin/env bash
set -euo pipefail

# Repeatable Cloud Run deploy script for oauth + Firebase proxy.
# Required env vars:
#   PROJECT_ID, REGION, SERVICE_NAME,
#   CLIENT_ID_SECRET_NAME, CLIENT_SECRET_SECRET_NAME,
#   FIREBASE_API_KEY_SECRET_NAME, FIREBASE_DB_URL_SECRET_NAME
# Optional:
#   IMAGE_REPO (default: oauth-proxy), IMAGE_NAME (default: oauth-proxy), IMAGE_TAG (default: timestamp)
#   ALLOWED_ORIGINS, ALLOWED_REDIRECT_URI_PREFIXES, PROXY_RATE_LIMIT_MAX, PROXY_RATE_LIMIT_WINDOW_MS

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "[ERROR] Missing required env var: $name" >&2
    exit 1
  fi
}

require_env PROJECT_ID
require_env REGION
require_env SERVICE_NAME
require_env CLIENT_ID_SECRET_NAME
require_env CLIENT_SECRET_SECRET_NAME
require_env FIREBASE_API_KEY_SECRET_NAME
require_env FIREBASE_DB_URL_SECRET_NAME

IMAGE_REPO="${IMAGE_REPO:-oauth-proxy}"
IMAGE_NAME="${IMAGE_NAME:-oauth-proxy}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${IMAGE_REPO}/${IMAGE_NAME}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[INFO] Ensuring Artifact Registry repository exists: ${IMAGE_REPO}"
if ! gcloud artifacts repositories describe "${IMAGE_REPO}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${IMAGE_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --description="Docker images for sync-cookie oauth proxy"
fi

echo "[INFO] Building container image: ${IMAGE_URI}"
gcloud builds submit "${PROXY_DIR}" \
  --tag "${IMAGE_URI}" \
  --project="${PROJECT_ID}"

DEPLOY_ARGS=(
  run deploy "${SERVICE_NAME}"
  --image "${IMAGE_URI}"
  --region "${REGION}"
  --project "${PROJECT_ID}"
  --platform managed
  --allow-unauthenticated
  --port 8787
  --set-secrets "GITHUB_OAUTH_CLIENT_ID=${CLIENT_ID_SECRET_NAME}:latest,GITHUB_OAUTH_CLIENT_SECRET=${CLIENT_SECRET_SECRET_NAME}:latest,FIREBASE_API_KEY=${FIREBASE_API_KEY_SECRET_NAME}:latest,FIREBASE_DB_URL=${FIREBASE_DB_URL_SECRET_NAME}:latest"
)

if [[ -n "${ALLOWED_ORIGINS:-}" ]]; then
  DEPLOY_ARGS+=(--set-env-vars "GITHUB_OAUTH_ALLOWED_ORIGINS=${ALLOWED_ORIGINS}")
fi

if [[ -n "${ALLOWED_REDIRECT_URI_PREFIXES:-}" ]]; then
  DEPLOY_ARGS+=(--set-env-vars "GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES=${ALLOWED_REDIRECT_URI_PREFIXES}")
fi

if [[ -n "${PROXY_RATE_LIMIT_MAX:-}" ]]; then
  DEPLOY_ARGS+=(--set-env-vars "PROXY_RATE_LIMIT_MAX=${PROXY_RATE_LIMIT_MAX}")
fi

if [[ -n "${PROXY_RATE_LIMIT_WINDOW_MS:-}" ]]; then
  DEPLOY_ARGS+=(--set-env-vars "PROXY_RATE_LIMIT_WINDOW_MS=${PROXY_RATE_LIMIT_WINDOW_MS}")
fi

echo "[INFO] Deploying to Cloud Run service: ${SERVICE_NAME}"
gcloud "${DEPLOY_ARGS[@]}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)')"

echo "[INFO] Deploy completed"
echo "[INFO] Service URL: ${SERVICE_URL}"
echo "[INFO] Health check: ${SERVICE_URL}/healthz"
echo "[INFO] Exchange endpoint: ${SERVICE_URL}/oauth/github/exchange"
echo "[INFO] Firebase login endpoint: ${SERVICE_URL}/firebase/auth/login"
echo "[INFO] Next step: bash ./scripts/smoke-public-endpoint.sh ${SERVICE_URL}"
