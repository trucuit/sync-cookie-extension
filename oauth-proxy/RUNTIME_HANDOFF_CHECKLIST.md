# Runtime Handoff Checklist (Copy/Paste)

Dùng checklist này để điền vào issue runtime owner ([PAT-91](/PAT/issues/PAT-91)) sau khi deploy proxy.

## 5 mục runtime cần điền

1. **Cloud Run service URL**
- `SERVICE_URL`: `https://<service>.a.run.app`
- `EXCHANGE_URL`: `https://<service>.a.run.app/oauth/github/exchange`
- `FIREBASE_LOGIN_URL`: `https://<service>.a.run.app/firebase/auth/login`
- `FIREBASE_SYNC_PULL_URL`: `https://<service>.a.run.app/firebase/sync/pull`
- `HEALTHZ_URL`: `https://<service>.a.run.app/healthz`

2. **Secrets mapping đã set trên Cloud Run**
- `GITHUB_OAUTH_CLIENT_ID` <= Secret Manager: `<secret-name>:latest`
- `GITHUB_OAUTH_CLIENT_SECRET` <= Secret Manager: `<secret-name>:latest`
- `FIREBASE_API_KEY` <= Secret Manager: `<secret-name>:latest`
- `FIREBASE_DB_URL` <= Secret Manager: `<secret-name>:latest`
- Người set secret: `<owner>`

3. **OAuth app callback/redirect đã khớp**
- Callback URL trong GitHub App: `https://<EXTENSION_ID>.chromiumapp.org/github-callback`
- `GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES` (nếu dùng): `https://<EXTENSION_ID>.chromiumapp.org/`

4. **Kết quả smoke test public endpoint**
- `GET /healthz`: `200` + `ok=true`
- `POST /oauth/github/exchange` với mã giả: `400 client_id_mismatch` hoặc `401 github_exchange_rejected`
- `POST /firebase/sync/pull` với token giả: `401 firebase_invalid_token` hoặc `401 firebase_auth_failed`
- Lệnh đã chạy:

```bash
bash oauth-proxy/scripts/smoke-public-endpoint.sh https://<service>.a.run.app
```

5. **Rollback note + trạng thái verify**
- Rollback command (mẫu):

```bash
gcloud run services update-traffic <service-name> --region <region> --to-revisions <previous-revision>=100
```

- Đã verify env: `<liệt kê env đã verify>`
- Chưa verify env: `<liệt kê env chưa verify>`
