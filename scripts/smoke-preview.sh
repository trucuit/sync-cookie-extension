#!/usr/bin/env bash
set -euo pipefail

required_envs=("VITE_FIREBASE_API_KEY" "VITE_FIREBASE_DB_URL")
for key in "${required_envs[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: ${key}"
    exit 1
  fi
done

if [[ ! -d "dist" ]]; then
  echo "Missing dist/ directory. Run 'pnpm build' before smoke test."
  exit 1
fi

host="127.0.0.1"
port="${SMOKE_PORT:-4173}"
url="http://${host}:${port}/"
log_file="${SMOKE_LOG_FILE:-/tmp/sync-cookie-preview.log}"
html_file="${SMOKE_HTML_FILE:-/tmp/sync-cookie-preview.html}"

pnpm preview --host "${host}" --port "${port}" >"${log_file}" 2>&1 &
preview_pid=$!

cleanup() {
  if kill -0 "${preview_pid}" >/dev/null 2>&1; then
    kill "${preview_pid}" >/dev/null 2>&1 || true
    wait "${preview_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -fsS "${url}" >"${html_file}"; then
    break
  fi
  sleep 1
done

if [[ ! -s "${html_file}" ]]; then
  echo "Smoke failed: preview endpoint did not become ready at ${url}"
  exit 1
fi

if ! grep -qi '<!doctype html>' "${html_file}"; then
  echo "Smoke failed: preview response is not HTML."
  exit 1
fi

echo "Smoke passed: preview served HTML at ${url}"
