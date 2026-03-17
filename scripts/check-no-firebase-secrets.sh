#!/usr/bin/env bash
set -euo pipefail

target_dir="${1:-dist}"

if [[ ! -d "${target_dir}" ]]; then
  echo "Missing target directory: ${target_dir}" >&2
  exit 1
fi

if rg -n --glob '*.js' 'AIza[0-9A-Za-z_-]{20,}' "${target_dir}" >/tmp/firebase-key-hits.log 2>&1; then
  echo "Found Firebase API key pattern in build artifact." >&2
  cat /tmp/firebase-key-hits.log >&2
  exit 1
fi

if rg -n --glob '*.js' 'identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com' "${target_dir}" >/tmp/firebase-endpoint-hits.log 2>&1; then
  echo "Found direct Firebase Auth endpoint usage in build artifact." >&2
  cat /tmp/firebase-endpoint-hits.log >&2
  exit 1
fi

if rg -n --glob '*.js' 'firebaseio\.com|firebasedatabase\.app' "${target_dir}" >/tmp/firebase-db-hits.log 2>&1; then
  echo "Found direct Firebase DB URL in build artifact." >&2
  cat /tmp/firebase-db-hits.log >&2
  exit 1
fi

echo "Security check passed: no Firebase key/auth/db hardcoded in ${target_dir}."
