# Sync Cookie Extension

Chrome Extension để đồng bộ cookies giữa các trình duyệt một cách an toàn và hiệu quả.

## 🎯 Phase 1 MVP Features

✅ **Đã implement:**
- ✅ Chrome Extension với Manifest v3
- ✅ Export cookies với AES-256 encryption
- ✅ Import cookies với password protection
- ✅ Popup UI với Tailwind CSS
- ✅ Validation và conflict handling
- ✅ Modern tech stack (Vite + React + TypeScript)

🚧 **Đang phát triển:**
- ⏳ Selective sync (whitelist/blacklist domains)
- ⏳ Onboarding flow
- ⏳ Tests coverage
- ⏳ Cloud sync integration

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

## 🔐 Security

- **AES-256-GCM encryption** cho toàn bộ cookie data
- **PBKDF2** key derivation với 100,000 iterations
- **Random salt và IV** cho mỗi lần encryption
- **Zero-knowledge architecture** - password không được lưu

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
- [ ] Write unit tests (Vitest)
- [ ] Add E2E tests (Playwright)
- [ ] Implement cloud sync (Phase 2)
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
