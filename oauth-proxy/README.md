# OAuth Proxy for Sync Cookie Extension

Proxy service tối thiểu để exchange GitHub OAuth `code -> access_token` mà không lộ `client_secret` trong extension.

## Endpoint

- `POST /oauth/github/exchange`
- `GET /healthz`

## Environment variables

- `PORT` (default `8787`)
- `GITHUB_OAUTH_CLIENT_ID` (required)
- `GITHUB_OAUTH_CLIENT_SECRET` (required)
- `GITHUB_OAUTH_ALLOWED_ORIGINS` (optional, comma-separated exact origins)
- `GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES` (optional, comma-separated prefixes)

> Nếu không set `GITHUB_OAUTH_ALLOWED_ORIGINS`, service cho phép mặc định origin dạng `chrome-extension://<id>` và localhost để hỗ trợ debug local.

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
docker build -t sync-cookie-oauth-proxy .
docker run --rm -p 8787:8787 \
  -e GITHUB_OAUTH_CLIENT_ID="$GITHUB_OAUTH_CLIENT_ID" \
  -e GITHUB_OAUTH_CLIENT_SECRET="$GITHUB_OAUTH_CLIENT_SECRET" \
  sync-cookie-oauth-proxy
```

## Request contract

`POST /oauth/github/exchange`

```json
{
  "code": "github_authorization_code",
  "clientId": "github_oauth_client_id",
  "redirectUri": "https://<extension_id>.chromiumapp.org/github-callback"
}
```

Success response:

```json
{
  "access_token": "gho_xxx",
  "token_type": "bearer",
  "scope": "gist"
}
```

Error response:

```json
{
  "error": "github_exchange_rejected",
  "message": "The code passed is incorrect or expired."
}
```

## GitHub OAuth callback requirement

Trong GitHub OAuth App, callback URL phải dùng đúng format Chrome Identity:

```text
https://<EXTENSION_ID>.chromiumapp.org/github-callback
```

Nếu muốn lock chặt redirect, set thêm:

```bash
GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES=https://<EXTENSION_ID>.chromiumapp.org/
```

## Smoke test

1. Health check:

```bash
curl -sS http://localhost:8787/healthz
```

2. Exchange route wiring (dùng code giả để kiểm tra route/cấu hình):

```bash
curl -sS -X POST http://localhost:8787/oauth/github/exchange \
  -H 'Content-Type: application/json' \
  -d '{"code":"dummy","clientId":"'$GITHUB_OAUTH_CLIENT_ID'","redirectUri":"https://example.chromiumapp.org/github-callback"}'
```

Kỳ vọng: trả về JSON lỗi hợp lệ từ GitHub hoặc validation (không phải timeout/404).

3. Runtime smoke với extension:

- Set `VITE_GITHUB_OAUTH_PROXY_URL` trỏ tới service đã deploy.
- Build lại extension (`pnpm run build` ở root project).
- Load extension và chạy `Connect GitHub`.
