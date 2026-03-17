# Sync Cookie Proxy (OAuth + Firebase)

Proxy service để giữ secrets phía backend, gồm 2 nhóm chức năng:

1. GitHub OAuth exchange (`code -> access_token`) không lộ `client_secret`.
2. Firebase auth + sync proxy để extension không phải nhúng `FIREBASE_API_KEY`/`FIREBASE_DB_URL` vào bundle.

## Endpoints

- `GET /healthz`
- `POST /oauth/github/exchange`
- `POST /firebase/auth/register`
- `POST /firebase/auth/login`
- `POST /firebase/auth/refresh`
- `POST /firebase/sync/push`
- `POST /firebase/sync/pull`

## Environment variables

Required:

- `PORT` (default `8787`)
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `FIREBASE_API_KEY`
- `FIREBASE_DB_URL`

Optional hardening:

- `PROXY_ALLOWED_ORIGINS` (comma-separated exact origins)
- `GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES` (comma-separated prefixes)
- `PROXY_RATE_LIMIT_MAX` (default `120` requests/window/IP)
- `PROXY_RATE_LIMIT_WINDOW_MS` (default `60000`)

> Nếu không set `PROXY_ALLOWED_ORIGINS`, service cho phép mặc định origin dạng `chrome-extension://<id>` và localhost để debug.

## Local run

```bash
cd oauth-proxy
cp .env.example .env
export $(grep -v '^#' .env | xargs)
npm run start
```

## Docker run

```bash
cd oauth-proxy
docker build -t sync-cookie-proxy .
docker run --rm -p 8787:8787 \
  -e GITHUB_OAUTH_CLIENT_ID="$GITHUB_OAUTH_CLIENT_ID" \
  -e GITHUB_OAUTH_CLIENT_SECRET="$GITHUB_OAUTH_CLIENT_SECRET" \
  -e FIREBASE_API_KEY="$FIREBASE_API_KEY" \
  -e FIREBASE_DB_URL="$FIREBASE_DB_URL" \
  sync-cookie-proxy
```

## Cloud Run deploy

Chuẩn bị biến môi trường cho script deploy:

```bash
cd oauth-proxy

export PROJECT_ID="<gcp-project-id>"
export REGION="asia-southeast1"
export SERVICE_NAME="sync-cookie-proxy"

export CLIENT_ID_SECRET_NAME="github-oauth-client-id"
export CLIENT_SECRET_SECRET_NAME="github-oauth-client-secret"
export FIREBASE_API_KEY_SECRET_NAME="firebase-web-api-key"
export FIREBASE_DB_URL_SECRET_NAME="firebase-db-url"

# Optional hardening
export ALLOWED_ORIGINS="chrome-extension://<extension_id>,http://localhost:5173"
export ALLOWED_REDIRECT_URI_PREFIXES="https://<extension_id>.chromiumapp.org/"
export PROXY_RATE_LIMIT_MAX="120"
export PROXY_RATE_LIMIT_WINDOW_MS="60000"
```

Deploy:

```bash
npm run deploy:cloudrun
```

Script sẽ build image, deploy Cloud Run, và in URL cho health/smoke.

## Public smoke test

```bash
bash ./scripts/smoke-public-endpoint.sh https://<service-url>
```

Hoặc:

```bash
BASE_URL="https://<service-url>" npm run smoke:public
```

Smoke script kiểm tra:

1. `GET /healthz` trả `ok=true` và `hasFirebaseConfig=true`.
2. `POST /oauth/github/exchange` trả lỗi contract hợp lệ cho dummy payload.
3. `POST /firebase/sync/pull` trả `401` hợp lệ cho dummy token (xác nhận route/proxy wiring hoạt động).

## Firebase sync request contract

`POST /firebase/auth/login`

```json
{
  "email": "user@example.com",
  "password": "your-password"
}
```

Response:

```json
{
  "idToken": "...",
  "refreshToken": "...",
  "uid": "...",
  "email": "user@example.com"
}
```

`POST /firebase/sync/push`

```json
{
  "idToken": "firebase-id-token",
  "payload": "{\"ciphertext\":\"...\"}"
}
```

`POST /firebase/sync/pull`

```json
{
  "idToken": "firebase-id-token"
}
```

## Runtime handoff checklist

Xem checklist copy/paste tại:

- [`RUNTIME_HANDOFF_CHECKLIST.md`](./RUNTIME_HANDOFF_CHECKLIST.md)
