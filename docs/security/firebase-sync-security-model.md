# Firebase Sync Security Model (SEC-001)

## Mục tiêu

- Loại bỏ hoàn toàn Firebase API key/DB URL khỏi extension bundle phát hành.
- Ép buộc truy cập dữ liệu theo `uid` đã xác thực.
- Cung cấp lớp bảo vệ tương đương App Check tại proxy cho đến khi có cơ chế attestation native cho extension.

## Kiến trúc mới

1. Extension chỉ gọi `VITE_FIREBASE_PROXY_URL`.
2. Proxy (`oauth-proxy/server.mjs`) giữ `FIREBASE_API_KEY` + `FIREBASE_DB_URL` trong môi trường runtime.
3. Auth flow (`register/login/refresh`) chạy ở proxy.
4. Sync flow (`push/pull`) bắt buộc gửi Firebase `idToken`.
5. Proxy verify `idToken` qua `accounts:lookup`, lấy `uid`, rồi chỉ đọc/ghi tại `sync/{uid}`.

## Firebase Security Rules (bắt buộc)

File rules chuẩn hoá tại: `firebase/database.rules.json`

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "sync": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        ".validate": "newData.hasChildren(['payload', 'updatedAt']) && newData.child('payload').isString() && newData.child('updatedAt').isString()"
      }
    }
  }
}
```

## Lớp bảo vệ tương đương App Check (proxy-side)

- CORS origin allowlist (`PROXY_ALLOWED_ORIGINS`) hoặc fallback chỉ cho `chrome-extension://<id>` + localhost.
- Rate limiting theo IP (`PROXY_RATE_LIMIT_MAX`, `PROXY_RATE_LIMIT_WINDOW_MS`).
- Kiểm tra token Firebase bắt buộc trước mọi thao tác sync (`accounts:lookup`).
- Ràng buộc truy cập path theo `uid` đã verify, không dùng `uid` do client tự khai báo.

## Threat model / giả định

- Dữ liệu cookie đã được mã hoá bằng sync password trước khi rời client.
- Firebase API key vẫn là public credential theo bản chất web key, nhưng đã tách hoàn toàn khỏi artifact extension.
- Nếu attacker có được `idToken` hợp lệ của user, attacker vẫn có thể gọi proxy trong thời gian token còn hạn.
- Mitigation hiện tại: token TTL ngắn + refresh có kiểm soát + rate limit + security rules + path isolation.
- Rủi ro tồn dư: chưa có attestation thiết bị mạnh như App Check native cho Chrome extension.

## Verify checklist

1. Build extension:

```bash
pnpm run build
```

2. Quét artifact:

```bash
pnpm run security:artifact
```

3. Smoke preview:

```bash
VITE_FIREBASE_PROXY_URL=https://<proxy-domain> pnpm run smoke:preview
```

4. Smoke proxy public endpoint:

```bash
BASE_URL=https://<proxy-domain> bash oauth-proxy/scripts/smoke-public-endpoint.sh
```

5. Log hygiene: không log body chứa token/secret ở proxy và extension background.
