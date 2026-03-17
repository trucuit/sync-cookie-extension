#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-}"

if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: $0 <BASE_URL>" >&2
  echo "Example: $0 https://sync-cookie-oauth-proxy-xxxx.a.run.app" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

health_body_file="${TMP_DIR}/health.json"
health_status="$(curl -sS -m 20 -o "${health_body_file}" -w '%{http_code}' "${BASE_URL}/healthz")"
health_ok="$(jq -r '.ok // empty' "${health_body_file}" 2>/dev/null || true)"
health_has_firebase="$(jq -r '.hasFirebaseConfig // empty' "${health_body_file}" 2>/dev/null || true)"

if [[ "${health_status}" != "200" || "${health_ok}" != "true" ]]; then
  echo "[FAIL] GET /healthz" >&2
  echo "  status=${health_status}" >&2
  echo "  body=$(cat "${health_body_file}")" >&2
  exit 1
fi

echo "[PASS] GET /healthz returned 200 and ok=true"
if [[ "${health_has_firebase}" != "true" ]]; then
  echo "[FAIL] healthz indicates Firebase config is missing (hasFirebaseConfig=${health_has_firebase})" >&2
  echo "  body=$(cat "${health_body_file}")" >&2
  exit 1
fi
echo "[PASS] healthz confirms Firebase config is loaded"

exchange_body_file="${TMP_DIR}/exchange.json"
exchange_status="$(curl -sS -m 20 -o "${exchange_body_file}" -w '%{http_code}' \
  -X POST "${BASE_URL}/oauth/github/exchange" \
  -H 'Content-Type: application/json' \
  -d '{"code":"public-smoke-dummy-code","clientId":"public-smoke-dummy-client","redirectUri":"https://example.chromiumapp.org/github-callback"}')"

exchange_error="$(jq -r '.error // empty' "${exchange_body_file}" 2>/dev/null || true)"

# Expected behavior for dummy code without credentials:
# - 400 + client_id_mismatch (most likely)
# - 401 + github_exchange_rejected (if dummy clientId matches server config)
if [[ "${exchange_status}" == "400" && "${exchange_error}" == "client_id_mismatch" ]]; then
  echo "[PASS] POST /oauth/github/exchange returned expected 400 client_id_mismatch"
  echo "[INFO] Endpoint wiring + validation are healthy for public access"
elif [[ "${exchange_status}" == "401" && "${exchange_error}" == "github_exchange_rejected" ]]; then
  echo "[PASS] POST /oauth/github/exchange reached GitHub and rejected dummy code as expected"
else
  echo "[FAIL] POST /oauth/github/exchange unexpected response" >&2
  echo "  status=${exchange_status}" >&2
  echo "  error=${exchange_error}" >&2
  echo "  body=$(cat "${exchange_body_file}")" >&2
  exit 1
fi

firebase_body_file="${TMP_DIR}/firebase.json"
firebase_status="$(curl -sS -m 20 -o "${firebase_body_file}" -w '%{http_code}' \
  -X POST "${BASE_URL}/firebase/sync/pull" \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"public-smoke-dummy-id-token"}')"

firebase_error="$(jq -r '.error // empty' "${firebase_body_file}" 2>/dev/null || true)"

# Expected behavior for dummy Firebase token:
# - 401 firebase_invalid_token (preferred)
# - 401 firebase_auth_failed (Firebase rejects malformed token at lookup layer)
if [[ "${firebase_status}" == "401" && ( "${firebase_error}" == "firebase_invalid_token" || "${firebase_error}" == "firebase_auth_failed" ) ]]; then
  echo "[PASS] POST /firebase/sync/pull reached Firebase proxy and rejected dummy token as expected"
  exit 0
fi

echo "[FAIL] POST /firebase/sync/pull unexpected response" >&2
echo "  status=${firebase_status}" >&2
echo "  error=${firebase_error}" >&2
echo "  body=$(cat "${firebase_body_file}")" >&2
exit 1
