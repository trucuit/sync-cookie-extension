# Sync Cookie Extension

Chrome Extension để đồng bộ cookies giữa các trình duyệt một cách an toàn và hiệu quả.

## 🎯 Phase 1 MVP Features

✅ **Đã implement:**
- ✅ Chrome Extension với Manifest v3
- ✅ Export cookies với AES-256 encryption
- ✅ Import cookies với password protection
- ✅ GitHub OAuth flow (connect/disconnect)
- ✅ GitHub Gist sync flow (Sync Now / Push / Pull)
- ✅ Background auto-sync scheduling bằng `chrome.alarms`
- ✅ Popup UI với Tailwind CSS
- ✅ Validation và conflict handling
- ✅ Modern tech stack (Vite + React + TypeScript)

🚧 **Đang phát triển:**
- ⏳ Onboarding flow
- ⏳ Test coverage cho cloud edge cases

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- pnpm (hoặc npm/yarn)
- Chrome Browser 88+

### Installation

```bash
# Clone repo (hoặc navigate to project directory)
cd sync-cookie-extension

# Install dependencies
pnpm install

# Build extension
pnpm run build
```

### OAuth / Gist env config

Tạo file `.env` (hoặc inject qua CI) trước khi build:

```bash
VITE_GITHUB_CLIENT_ID=your_github_oauth_app_client_id
VITE_GITHUB_OAUTH_PROXY_URL=https://your-backend.example.com/oauth/github/exchange
VITE_GITHUB_GIST_FILENAME=sync-cookie-manifest.json
```

> Lưu ý: `VITE_GITHUB_OAUTH_PROXY_URL` phải trỏ về backend proxy exchange code→token để không lộ `client_secret` trong extension.

### GitHub OAuth callback/redirect requirements

1. Load extension build vào Chrome để lấy `Extension ID` trên `chrome://extensions`.
2. Cấu hình **Authorization callback URL** trong GitHub OAuth App:

```text
https://<EXTENSION_ID>.chromiumapp.org/github-callback
```

3. URL callback phải khớp tuyệt đối với giá trị runtime từ `chrome.identity.getRedirectURL('github-callback')` trong `src/background.ts`.

### Deploy OAuth proxy (artifact có sẵn)

Repo đã có scaffold proxy tại `oauth-proxy/` với endpoint:

```text
POST /oauth/github/exchange
```

Xem hướng dẫn deploy + biến môi trường tại `oauth-proxy/README.md`.

Ví dụ chạy local:

```bash
cd oauth-proxy
cp .env.example .env
export $(grep -v '^#' .env | xargs)
npm run start
```

Sau khi deploy xong, update env build extension:

```bash
VITE_GITHUB_OAUTH_PROXY_URL=https://<your-proxy-domain>/oauth/github/exchange
```

### Smoke test nhanh cho runtime OAuth

1. Health check proxy:

```bash
curl -sS https://<your-proxy-domain>/healthz
```

2. Kiểm tra endpoint exchange có hoạt động (dùng code giả để test wiring):

```bash
curl -sS -X POST https://<your-proxy-domain>/oauth/github/exchange \
  -H 'Content-Type: application/json' \
  -d '{"code":"dummy","clientId":"<github-client-id>","redirectUri":"https://<EXTENSION_ID>.chromiumapp.org/github-callback"}'
```

Kỳ vọng: nhận JSON error hợp lệ (không phải `404`, `500`, hoặc timeout).

3. Rebuild extension và chạy OAuth thật:

```bash
pnpm run build
```

Mở popup → `Connect GitHub`; nếu thành công sẽ thấy trạng thái authenticated và có thể chạy `Sync Now`.

### Load Extension in Chrome

1. Mở Chrome và truy cập `chrome://extensions/`
2. Bật **Developer mode** (góc trên bên phải)
3. Click **Load unpacked**
4. Chọn thư mục `dist/` trong project
5. Extension sẽ xuất hiện trong Chrome toolbar

## 💡 Usage

### Export Cookies

1. Click vào extension icon trong toolbar
2. Click nút **"Export (Encrypted)"**
3. Nhập password để mã hóa cookies
4. File `.encrypted.json` sẽ được download

### Import Cookies

1. Click vào extension icon
2. Click nút **"Import Cookies"**
3. Chọn file `.encrypted.json` đã export
4. Nhập password để giải mã
5. Confirm import dialog

### GitHub OAuth + Gist Sync

1. Mở extension popup
2. Nhập `Sync password`
3. Bấm **Connect GitHub** và hoàn tất OAuth consent
4. Dùng **Sync Now** / **Push** / **Pull** để đồng bộ qua secret gist
5. (Tuỳ chọn) Cấu hình `Auto-sync interval` + domain whitelist và bấm **Save Settings**

## 🔐 Security

- **AES-256-GCM encryption** cho toàn bộ cookie data
- **PBKDF2** key derivation với 100,000 iterations
- **Random salt và IV** cho mỗi lần encryption
- **GitHub OAuth token được lưu dạng encrypted payload trong extension storage**
- **Zero-knowledge architecture** - password không được lưu
- **Permission boundary (MVP)**: chỉ cấp host cho `github.com`, `api.github.com`, `*.atlassian.net`, và OAuth proxy `*.run.app`
- **Không inject content script** trong MVP (không dùng content-script scraping)

## 📁 Project Structure

```
sync-cookie-extension/
├── src/
│   ├── App.tsx                 # Main popup UI
│   ├── background.ts           # Service worker
│   ├── manifest.json           # Chrome Extension manifest
│   ├── components/
│   │   └── PasswordDialog.tsx  # Password input dialog
│   └── lib/
│       └── crypto.ts           # AES-256 encryption utilities
├── oauth-proxy/                # Deployable OAuth code->token exchange proxy
├── public/                     # Static assets (icons)
├── dist/                       # Build output
└── package.json
```

## 🛠️ Development

```bash
# Development mode với HMR
pnpm dev

# Build production
pnpm run build

# Lint
pnpm run lint

# Unit tests
pnpm run test
```

## 📋 TODO

- [ ] Add selective sync (domain whitelist/blacklist)
- [ ] Create onboarding flow
- [ ] Expand unit tests (OAuth/Gist failure paths)
- [ ] Add E2E tests (Playwright)
- [ ] Cross-browser support (Firefox, Edge)
- [ ] Export format v2 with compression

## 🐛 Known Issues

- Icons là placeholder SVG (cần replace bằng proper PNG icons)
- Chưa có error reporting UI
- Chưa hỗ trợ export toàn bộ cookies (all sites)

## 📝 License

MIT

## 🙏 Credits

Built with:
- [Vite](https://vitejs.dev/)
- [React](https://react.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin/)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
